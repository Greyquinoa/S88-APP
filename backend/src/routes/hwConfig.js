// src/routes/hwConfig.js — HW Engineering Extension endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb } = require('../db');
const { parseCfg, parseCfgDevices } = require('../services/cfgParser');
const { parseHwExcel }       = require('../services/hwExcelParser');
const { allocateAddresses, findTemplate } = require('../services/hwAddressEngine');
const { generateCfg, hexToIp } = require('../services/cfgGenerator');
const { parseCfgForCatalogue } = require('../services/cfgCatalogueParser');
const { parseMrpConfig } = require('../services/mrpCfgParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// ── Utilities ─────────────────────────────────────────────────────────────────

// GET /utils/hex-to-ip?hex=C0A81B0A
router.get('/utils/hex-to-ip', (req, res) => {
  const { hex } = req.query;
  if (!hex) return err(res, 400, 'hex query param required');
  const ip = hexToIp(hex);
  if (!ip) return err(res, 400, `"${hex}" is not a valid 8-character hex IP`);
  res.json({ hex: hex.trim().toUpperCase(), ip });
});

// ── Signal Types ──────────────────────────────────────────────────────────────

// GET /signal-types  — return all signal types ordered by sort_order
router.get('/signal-types', (_req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare('SELECT name FROM hw_signal_types ORDER BY sort_order, name').all();
    res.json(rows.map(r => r.name));
  } catch (e) { err(res, 500, e.message); }
});

// POST /signal-types  — add a new custom signal type (idempotent)
router.post('/signal-types', (req, res) => {
  try {
    const name = (req.body.name || '').trim().toUpperCase();
    if (!name) return err(res, 400, 'name required');
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO hw_signal_types (name) VALUES (?)').run(name);
    const rows = db.prepare('SELECT name FROM hw_signal_types ORDER BY sort_order, name').all();
    res.json(rows.map(r => r.name));
  } catch (e) { err(res, 500, e.message); }
});

// ── Module Templates ──────────────────────────────────────────────────────────

router.get('/module-templates', (_req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare('SELECT * FROM hw_module_templates ORDER BY family, display_name').all();
    res.json(rows);
  } catch (e) { err(res, 500, e.message); }
});

router.post('/module-templates', (req, res) => {
  try {
    const db = getDb();
    const {
      order_no, display_name, family, signal_type, channel_count = 0,
      input_bytes = 0, output_bytes = 0, in_addr_fmt, out_addr_fmt,
      param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config,
    } = req.body;
    if (!order_no || !display_name || !family) return err(res, 400, 'order_no, display_name, family required');

    const existing = db.prepare('SELECT id FROM hw_module_templates WHERE order_no=?').get(order_no);
    if (existing) {
      db.prepare(`UPDATE hw_module_templates SET
        display_name=?, family=?, signal_type=?, channel_count=?,
        input_bytes=?, output_bytes=?, in_addr_fmt=?, out_addr_fmt=?,
        param_template=?, version=?, gsdml_file=?, dap_id=?, hw_category=?, subslot_defaults=?, port_config=?
        WHERE order_no=?`).run(
        display_name, family, signal_type, channel_count,
        input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
        param_template, version, gsdml_file, dap_id, hw_category || null, subslot_defaults || null, port_config || null, order_no
      );
      res.json({ id: existing.id, updated: true });
    } else {
      const r = db.prepare(`INSERT INTO hw_module_templates
        (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
         in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        order_no, display_name, family, signal_type, channel_count,
        input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
        param_template, version, gsdml_file, dap_id, hw_category || null, subslot_defaults || null, port_config || null
      );
      res.status(201).json({ id: r.lastInsertRowid });
    }
  } catch (e) { err(res, 500, e.message); }
});

// GET /module-templates/:id/usage — list every station that uses this module
router.get('/module-templates/:id/usage', (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id, 10);
    const tpl = db.prepare('SELECT order_no, display_name FROM hw_module_templates WHERE id=?').get(id);
    if (!tpl) return err(res, 404, 'Module template not found');

    const rows = db.prepare(`
      SELECT hs.hw_import_id, hi.excel_name, p.name AS project_name,
             hs.station_address, hs.station_name, hs.slot,
             COUNT(*) AS row_count
      FROM hw_signals hs
      JOIN hw_imports hi ON hi.id = hs.hw_import_id
      LEFT JOIN projects p ON p.id = hi.project_id
      WHERE hs.module_order_no = ?
      GROUP BY hs.hw_import_id, hs.station_address, hs.slot
      ORDER BY hs.hw_import_id, hs.station_address, hs.slot
    `).all(tpl.order_no);

    res.json({ order_no: tpl.order_no, display_name: tpl.display_name, usage: rows });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /module-templates/:id — remove a catalogue entry if not referenced in any import
router.delete('/module-templates/:id', (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id, 10);
    const tpl = db.prepare('SELECT order_no, display_name FROM hw_module_templates WHERE id=?').get(id);
    if (!tpl) return err(res, 404, 'Module template not found');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM hw_signals WHERE module_order_no=?').get(tpl.order_no);
    if (n > 0)
      return err(res, 409, `Cannot delete — "${tpl.order_no}" is used in ${n} signal row(s). Remove it from all stations first.`);
    db.prepare('DELETE FROM hw_module_templates WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Catalogue — import from .cfg ──────────────────────────────────────────────

// POST /module-templates/parse-cfg
// Upload a .cfg file, parse IOSUBSYSTEM blocks, return candidates + conflict flags.
// Does NOT write to DB — preview only.
router.post('/module-templates/parse-cfg', upload.single('cfg'), (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No file uploaded');
    const text = req.file.buffer.toString('utf8');
    const { error, candidates } = parseCfgForCatalogue(text);
    if (error && candidates.length === 0) return err(res, 422, error);

    // Check each candidate against existing catalogue
    const db = getDb();
    const withStatus = candidates.map(c => {
      if (c.parseError) return { ...c, status: 'error' };
      const existing = db.prepare('SELECT id, display_name, version FROM hw_module_templates WHERE order_no=?').get(c.order_no);
      return { ...c, status: existing ? 'conflict' : 'new', existingName: existing ? existing.display_name : null };
    });

    res.json({ warning: error, candidates: withStatus });
  } catch (e) { err(res, 500, e.message); }
});

// POST /module-templates/bulk-upsert
// Body: { devices: [{ order_no, display_name, family, ..., action: 'add'|'overwrite'|'skip' }] }
// Writes confirmed devices to the catalogue.
router.post('/module-templates/bulk-upsert', (req, res) => {
  try {
    const db = getDb();
    const { devices } = req.body;
    if (!Array.isArray(devices) || devices.length === 0)
      return err(res, 400, 'devices array required');

    let added = 0, overwritten = 0, skipped = 0;

    const insSql = db.prepare(`INSERT INTO hw_module_templates
      (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
       in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const updSql = db.prepare(`UPDATE hw_module_templates SET
      display_name=?, family=?, signal_type=?, channel_count=?,
      input_bytes=?, output_bytes=?, in_addr_fmt=?, out_addr_fmt=?,
      param_template=?, version=?, gsdml_file=?, dap_id=?, hw_category=?, subslot_defaults=?, port_config=?
      WHERE order_no=?`);

    const upsert = db.transaction((devices) => {
      for (const d of devices) {
        if (d.action === 'skip') { skipped++; continue; }
        const existing = db.prepare('SELECT id FROM hw_module_templates WHERE order_no=?').get(d.order_no);
        if (existing && d.action !== 'overwrite') { skipped++; continue; }

        const vals = [
          d.display_name, d.family, d.signal_type || null, d.channel_count || 0,
          d.input_bytes || 0, d.output_bytes || 0, d.in_addr_fmt || null, d.out_addr_fmt || null,
          d.param_template || null, d.version || null, d.gsdml_file || null, d.dap_id || null,
          d.hw_category || null, d.subslot_defaults || null, d.port_config || null,
        ];

        if (existing) {
          updSql.run(...vals, d.order_no);
          overwritten++;
        } else {
          insSql.run(d.order_no, ...vals);
          added++;
        }
      }
    });

    upsert(devices);
    res.json({ ok: true, added, overwritten, skipped });
  } catch (e) { err(res, 500, e.message); }
});

// ── HW Imports per project ────────────────────────────────────────────────────

router.get('/project/:id/imports', (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.id, 10);
    const rows = db.prepare(
      'SELECT id, excel_name, status, imported_at, baseline_info, baseline_cfg FROM hw_imports WHERE project_id=? ORDER BY id DESC'
    ).all(projectId);
    res.json(rows.map(r => {
      const info = r.baseline_info ? JSON.parse(r.baseline_info) : null;
      // Back-fill pipMappings for records stored before this feature was added
      if (info && !info.pipMappings && r.baseline_cfg) {
        try {
          const parsed = parseCfg(r.baseline_cfg);
          info.pipMappings = parsed.pipMappings || [];
          // Persist the enriched baseline_info so future loads are instant
          db.prepare('UPDATE hw_imports SET baseline_info=? WHERE id=?')
            .run(JSON.stringify(info), r.id);
        } catch (_) { info.pipMappings = []; }
      }
      return { id: r.id, excel_name: r.excel_name, status: r.status, imported_at: r.imported_at, baseline_info: info };
    }));
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/project/:id/upload-baseline
router.post('/project/:id/upload-baseline', upload.single('baseline'), async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.id, 10);
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
      return err(res, 404, 'Project not found');
    if (!req.file) return err(res, 400, 'No file uploaded');

    const cfgText = req.file.buffer.toString('utf8');
    const parsed  = parseCfg(cfgText);

    // Build a rich baseline_info object for the frontend
    const baselineInfo = {
      stationName:   parsed.stationName,
      stationType:   parsed.stationType,
      subnetNames:   parsed.subnetNames,
      subnets:       parsed.subnets.length,
      racks:         parsed.racks.length,
      rackModules:   parsed.rackModules,
      ioControllers: parsed.ioControllers,
      ioSubsystems:  parsed.ioSubsystemHeaders.map(h => ({ no: h.no })),
      existingDevices: parsed.existingDevices,
      existingAddresses: parsed.existingAddresses,
      pipMappings:   parsed.pipMappings,   // [{pipNo, ob, executionTime, timeScale}]
    };

    const existing = db.prepare('SELECT id FROM hw_imports WHERE project_id=? ORDER BY id DESC LIMIT 1').get(projectId);
    let importId;
    if (existing) {
      db.prepare('UPDATE hw_imports SET baseline_cfg=?, status=?, baseline_info=? WHERE id=?')
        .run(cfgText, 'pending', JSON.stringify(baselineInfo), existing.id);
      importId = existing.id;
    } else {
      const r = db.prepare(
        'INSERT INTO hw_imports (project_id, baseline_cfg, status, baseline_info) VALUES (?,?,?,?)'
      ).run(projectId, cfgText, 'pending', JSON.stringify(baselineInfo));
      importId = r.lastInsertRowid;
    }

    // ── Auto-populate hw_controller + hw_fieldbuses from parsed CFG ────────────
    // Rack chassis is on the RACK header line "RACK N, "orderNo", "name"" — not a SLOT entry
    const rackHeaderMatch = parsed.racks.length > 0
      ? parsed.racks[0].match(/^RACK\s+\d+,\s*"([^"]+)"[^,\n]*,\s*"([^"]+)"/m)
      : null;
    const rackOrderNo = rackHeaderMatch ? rackHeaderMatch[1] : null;
    const rackName    = rackHeaderMatch ? rackHeaderMatch[2] : null;

    // PS is at slot 1 in an S7-400 rack
    const psModule = parsed.rackModules.find(m => m.slot === 1)
                  || parsed.rackModules.find(m => /\bps\b/i.test(m.name));

    const ctrlFields = {
      T16_Controller_TagName: parsed.stationName || null,
      T16_Station_Type:       parsed.stationType || null,
      T15_IP_Address:         (parsed.ioControllers[0] && parsed.ioControllers[0].ip) || null,
      T50_Rack_Order_No:      rackOrderNo,
      T50_Rack_Name:          rackName,
      T50_PS_Order_No:        psModule   ? psModule.orderNo   : null,
      T50_PS_Name:            psModule   ? psModule.name      : null,
    };

    // Match by station name so re-uploading the same CFG updates the same record
    const existingCtrl = parsed.stationName
      ? db.prepare('SELECT id FROM hw_controllers WHERE project_id=? AND T16_Controller_TagName=?')
          .get(projectId, parsed.stationName)
      : db.prepare('SELECT id FROM hw_controllers WHERE project_id=? ORDER BY id LIMIT 1').get(projectId);

    let controllerId;
    if (existingCtrl) {
      db.prepare(`UPDATE hw_controllers SET
        T16_Controller_TagName=?, T16_Station_Type=?,
        T15_IP_Address=?, T50_Rack_Order_No=?, T50_Rack_Name=?,
        T50_PS_Order_No=?, T50_PS_Name=?, updated_at=datetime('now')
        WHERE id=?`).run(
        ctrlFields.T16_Controller_TagName, ctrlFields.T16_Station_Type,
        ctrlFields.T15_IP_Address,
        ctrlFields.T50_Rack_Order_No, ctrlFields.T50_Rack_Name,
        ctrlFields.T50_PS_Order_No, ctrlFields.T50_PS_Name,
        existingCtrl.id
      );
      controllerId = existingCtrl.id;
    } else {
      const r = db.prepare(`INSERT INTO hw_controllers
        (project_id, T16_Controller_TagName, T16_Station_Type, T15_IP_Address,
         T50_Rack_Order_No, T50_Rack_Name, T50_PS_Order_No, T50_PS_Name)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        projectId,
        ctrlFields.T16_Controller_TagName, ctrlFields.T16_Station_Type,
        ctrlFields.T15_IP_Address,
        ctrlFields.T50_Rack_Order_No, ctrlFields.T50_Rack_Name,
        ctrlFields.T50_PS_Order_No, ctrlFields.T50_PS_Name
      );
      controllerId = r.lastInsertRowid;
    }

    // Replace fieldbuses: one row per PN IO controller found in the CFG
    db.prepare('DELETE FROM hw_fieldbuses WHERE hw_controller_id=?').run(controllerId);
    const fbIns = db.prepare(`INSERT INTO hw_fieldbuses
      (hw_controller_id, INT_DP_Subsystem, T50_Fieldbus_Name, T15_IP_Address)
      VALUES (?,?,?,?)`);
    for (const c of parsed.ioControllers) {
      fbIns.run(controllerId, c.no, c.subnetName || null, c.ip || null);
    }

    res.json({ importId, ...baselineInfo });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/backfill-from-cfg
// Accepts a generated CFG file upload and populates hw_signals + hw_slot_subslots
// from its device blocks — a full round-trip import without needing an Excel sheet.
router.post('/imports/:id/backfill-from-cfg', upload.single('cfg'), (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');
    if (!req.file)  return err(res, 400, 'No CFG file uploaded');

    const cfgText = req.file.buffer.toString('utf8');
    const devices = parseCfgDevices(cfgText);
    if (devices.length === 0) {
      const lines   = cfgText.split(/\r?\n/);
      const ioLines = lines.filter(l => /IOSUBSYSTEM/.test(l)).slice(0, 3);
      return err(res, 400, `No IO devices found in uploaded CFG. Sample IOSUBSYSTEM lines: ${JSON.stringify(ioLines)}`);
    }

    // Load template catalogue so we can resolve signal_type from order_no
    const tplRows = db.prepare('SELECT order_no, signal_type FROM hw_module_templates').all();
    const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

    const insertSignal = db.prepare(`
      INSERT INTO hw_signals
        (hw_import_id, station_address, station_name, ip_address, router_address,
         subsystem_no, slot, module_order_no, module_name, signal_type,
         pip_no, potential_group, tag, description)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const insertSubslot = db.prepare(`
      INSERT OR REPLACE INTO hw_slot_subslots
        (hw_import_id, station_address, slot, subslot_no, pa_profile)
      VALUES (?,?,?,?,?)`);

    let stationCount = 0;
    let slotCount    = 0;

    db.transaction(() => {
      // Clear existing signal rows for this import so backfill is idempotent
      db.prepare('DELETE FROM hw_signals WHERE hw_import_id=?').run(importId);
      db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id=?').run(importId);

      for (const dev of devices) {
        stationCount++;

        // Slot 0 = IM/interface module — insert a row so the grid can resolve
        // Device Family and Order Number.
        // For GSDML-based devices the header orderNo is the GSDML filename which
        // won't match the catalogue.  Use mlfbNo (from the SLOT 0 MLFB field)
        // as the effective key instead — it holds the real Siemens order number.
        const slot0OrderNo = (dev.mlfbNo && !tplMap.has(dev.orderNo))
          ? dev.mlfbNo
          : dev.orderNo;
        insertSignal.run(
          importId,
          dev.address, dev.name, dev.ip, dev.routerAddress,
          dev.subsystemNo, 0,
          slot0OrderNo, dev.name,
          null, null, null, null, null,
        );

        for (const slot of dev.slots) {
          // Server module (193-6PA00-0AA0) is auto-added by the generator on every
          // export — skip it on import so it is never stored as a configurable slot.
          if ((slot.orderNo || '').includes('193-6PA00-0AA0')) continue;

          const tpl        = tplMap.get(slot.orderNo);
          const signalType = tpl ? tpl.signal_type : null;

          if (slot.symbols.length === 0) {
            // No SYMBOL lines — insert one representative row for the slot
            insertSignal.run(
              importId,
              dev.address, dev.name, dev.ip, dev.routerAddress,
              dev.subsystemNo, slot.slot,
              slot.orderNo, slot.name,
              signalType,
              slot.pipNo, slot.potentialGroup,
              null, null,
            );
            slotCount++;
          } else {
            // Insert one row per SYMBOL (channel-level tag data)
            for (const sym of slot.symbols) {
              insertSignal.run(
                importId,
                dev.address, dev.name, dev.ip, dev.routerAddress,
                dev.subsystemNo, slot.slot,
                slot.orderNo, slot.name,
                signalType,
                slot.pipNo, slot.potentialGroup,
                sym.tag || null, sym.description || null,
              );
            }
            slotCount++;
          }

          // PA subslots — pass orderNo as pa_profile so CFU_PA function type round-trips
          for (const ss of slot.subslots) {
            insertSubslot.run(importId, dev.address, slot.slot, ss.subslotNo, ss.orderNo || null);
          }
        }
      }
    })();

    // ── Also backfill MRP roles + port links if the uploaded CFG has them ────────
    // Reuses the same parser as the standalone MRP import. Non-destructive: if the
    // CFG has no MRP-configured devices (e.g. a plain baseline), the existing MRP
    // config is left untouched.
    let mrpDevices = 0;
    try {
      const parsed = parseCfg(cfgText);
      const { domainName, stationName, roles, links } = parseMrpConfig(cfgText, parsed);
      const activeRoles = roles.filter(r => r.mrpRole !== 0);
      if (activeRoles.length > 0) {
        const fieldbusNo = activeRoles.find(r => r.subsystemNo != null)?.subsystemNo ?? null;
        db.transaction(() => {
          const existing = db.prepare(
            'SELECT id FROM mrp_configs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1'
          ).get(importId);
          let configId;
          if (existing) {
            db.prepare(
              `UPDATE mrp_configs SET domain_name=?, fieldbus_no=?, station_name=?, updated_at=datetime('now') WHERE id=?`
            ).run(domainName, fieldbusNo, stationName || '', existing.id);
            configId = existing.id;
          } else {
            configId = db.prepare(
              'INSERT INTO mrp_configs (hw_import_id, domain_name, fieldbus_no, station_name) VALUES (?,?,?,?)'
            ).run(importId, domainName, fieldbusNo, stationName || '').lastInsertRowid;
          }

          db.prepare('DELETE FROM mrp_device_roles WHERE mrp_config_id=?').run(configId);
          const insRole = db.prepare(
            'INSERT INTO mrp_device_roles (mrp_config_id, device_alias, io_address, subsystem_no, mrp_role, mrp_instances, ring_port_1, ring_port_2) VALUES (?,?,?,?,?,?,?,?)'
          );
          for (const r of roles) {
            insRole.run(configId, r.alias, r.ioAddress, r.subsystemNo,
              r.mrpRole, r.mrpRole === 3 ? 1 : 0, r.ringPort1 ?? null, r.ringPort2 ?? null);
          }

          db.prepare('DELETE FROM mrp_port_links WHERE mrp_config_id=?').run(configId);
          const insLink = db.prepare(
            `INSERT INTO mrp_port_links
               (mrp_config_id, from_device, from_iface_subslot, from_port_subslot,
                to_device, to_iface_subslot, to_port_subslot)
             VALUES (?,?,?,?,?,?,?)`
          );
          for (const l of links) {
            insLink.run(configId, l.fromDevice, l.fromIfaceSubslot, l.fromPortSubslot,
              l.toDevice, l.toIfaceSubslot, l.toPortSubslot);
          }
        })();
        mrpDevices = activeRoles.length;
      }
    } catch (e) {
      // Don't fail the whole import if MRP parsing hits an edge case.
      console.warn('[backfill-from-cfg] MRP parse skipped:', e.message);
    }

    res.json({ ok: true, stations: stationCount, slots: slotCount, mrpDevices });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/upload-iolist
router.post('/imports/:id/upload-iolist', upload.single('iolist'), async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = db.prepare('SELECT id, project_id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');
    if (!req.file)  return err(res, 400, 'No file uploaded');

    const sheetName = req.query.sheet || null;
    const { rows, stations, colMap } = await parseHwExcel(req.file.buffer, sheetName);

    db.prepare('DELETE FROM hw_signals WHERE hw_import_id=?').run(importId);

    const ins = db.prepare(`
      INSERT INTO hw_signals
        (hw_import_id, row_number, station_address, station_name, ip_address,
         slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertBatch = db.transaction((batch) => {
      for (const r of batch) {
        ins.run(importId, r.rowNum, r.stationAddr, r.stationName, r.ip,
          r.slot, r.channel, r.orderNo, r.moduleName, r.tag, r.desc, r.signalType,
          r.subsystemNo ?? null, r.routerAddress || null);
      }
    });
    for (let i = 0; i < rows.length; i += 500) insertBatch(rows.slice(i, i + 500));

    db.prepare('UPDATE hw_imports SET excel_name=?, status=? WHERE id=?')
      .run(req.file.originalname, 'ready', importId);

    res.json({ importId, stationCount: stations.size, signalCount: rows.length, colMap });
  } catch (e) { err(res, 500, e.message); }
});

// ── Station view ──────────────────────────────────────────────────────────────

router.get('/imports/:id/stations', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);

    const signals = db.prepare(
      `SELECT station_address, station_name, ip_address, router_address, slot, module_order_no, module_name,
              subsystem_no, pip_no, potential_group, pa_profile, COUNT(*) AS signal_count
       FROM hw_signals
       WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'
       GROUP BY station_address, slot, module_order_no
       ORDER BY station_address, slot`
    ).all(importId);

    const allAddrs = db.prepare(
      `SELECT DISTINCT station_address, station_name, ip_address, router_address, subsystem_no,
              MAX(COALESCE(approved,0)) AS approved
       FROM hw_signals WHERE hw_import_id=? GROUP BY station_address ORDER BY station_address`
    ).all(importId);

    // Load per-subslot profiles
    const subslotRows = db.prepare(
      `SELECT station_address, slot, subslot_no, pa_profile
       FROM hw_slot_subslots WHERE hw_import_id=? ORDER BY station_address, slot, subslot_no`
    ).all(importId);

    // Build subslot map: Map<"addr:slot", [{subslotNo, paProfile}]>
    const subslotMap = new Map();
    for (const r of subslotRows) {
      const key = `${r.station_address}:${r.slot}`;
      if (!subslotMap.has(key)) subslotMap.set(key, []);
      subslotMap.get(key).push({ subslotNo: r.subslot_no, paProfile: r.pa_profile || null });
    }

    // Resolve orderNo + family per station from slot 0 row
    const tplRows = db.prepare('SELECT order_no, family, display_name FROM hw_module_templates').all();
    const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

    const slot0Rows = db.prepare(
      `SELECT station_address, module_order_no FROM hw_signals
       WHERE hw_import_id=? AND slot=0 GROUP BY station_address`
    ).all(importId);
    const slot0Map = new Map();
    for (const r of slot0Rows) {
      const orderNo = r.module_order_no;
      // Family comes from catalogue only — no prefix guessing
      const tpl    = tplMap.get(orderNo);
      const family = tpl?.family || null;
      slot0Map.set(r.station_address, { orderNo, family });
    }

    const stationMap = new Map();
    for (const r of allAddrs) {
      const s0 = slot0Map.get(r.station_address) || {};
      stationMap.set(r.station_address, {
        address:       r.station_address,
        name:          r.station_name,
        ip:            r.ip_address,
        routerAddress: r.router_address || null,
        subsystemNo:   r.subsystem_no,
        approved:      !!r.approved,
        orderNo:       s0.orderNo || null,
        family:        s0.family  || null,
        slots:         [],
      });
    }
    for (const row of signals) {
      const st = stationMap.get(row.station_address);
      if (st) st.slots.push({
        slot:           row.slot,
        orderNo:        row.module_order_no,
        name:           row.module_name,
        signalCount:    row.signal_count,
        pipNo:          row.pip_no != null ? row.pip_no : null,
        potentialGroup: row.potential_group != null ? row.potential_group : null,
        paProfile:      row.pa_profile != null ? row.pa_profile : null,
        subslots:       subslotMap.get(`${row.station_address}:${row.slot}`) || [],
      });
    }

    res.json([...stationMap.values()]);
  } catch (e) { err(res, 500, e.message); }
});

// GET /imports/:id/preview-addresses — compute process-image addresses for all slots without generating a full CFG
router.get('/imports/:id/preview-addresses', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = db.prepare('SELECT id, baseline_cfg FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const signals = db.prepare(
      `SELECT station_address, station_name, ip_address, router_address, subsystem_no,
              slot, module_order_no, pip_no, pa_profile
       FROM hw_signals
       WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'
       ORDER BY station_address, slot`
    ).all(importId);

    const tplRows    = db.prepare('SELECT * FROM hw_module_templates').all();
    const templateMap = new Map(tplRows.map(t => [t.order_no, t]));

    // Load per-subslot PA profile assignments
    const subslotRows = db.prepare(
      'SELECT station_address, slot, subslot_no, pa_profile FROM hw_slot_subslots WHERE hw_import_id=? ORDER BY station_address, slot, subslot_no'
    ).all(importId);
    const subslotMap = new Map();
    for (const r of subslotRows) {
      const key = `${r.station_address}:${r.slot}`;
      if (!subslotMap.has(key)) subslotMap.set(key, []);
      subslotMap.get(key).push({ subslotNo: r.subslot_no, paProfile: r.pa_profile || null });
    }

    const stations = new Map();
    for (const sig of signals) {
      const addr = sig.station_address;
      if (!stations.has(addr)) {
        stations.set(addr, { address: addr, name: sig.station_name, ip: sig.ip_address,
          routerAddress: sig.router_address || null, subsystemNo: sig.subsystem_no, slots: new Map() });
      }
      if (!stations.get(addr).slots.has(sig.slot)) {
        stations.get(addr).slots.set(sig.slot, {
          slot: sig.slot, orderNo: sig.module_order_no, pipNo: sig.pip_no != null ? sig.pip_no : null,
          paProfile: sig.pa_profile || null,
          subslots: subslotMap.get(`${addr}:${sig.slot}`) || [],
          channels: [],
        });
      }
    }

    let maxIn = -1, maxOut = -1;
    if (hwImport.baseline_cfg) {
      const parsed = parseCfg(hwImport.baseline_cfg);
      maxIn  = parsed.existingAddresses.maxInput;
      maxOut = parsed.existingAddresses.maxOutput;
    }

    allocateAddresses(stations, templateMap, maxIn, maxOut);

    // Return flat map: { "<stationAddr>:<slot>": { inputAddr, outputAddr, subslotAddrs? } }
    const result = {};
    for (const [stAddr, station] of stations) {
      for (const [slotNo, slot] of station.slots) {
        if (slot.inputAddr != null || slot.outputAddr != null) {
          result[`${stAddr}:${slotNo}`] = {
            inputAddr:    slot.inputAddr,
            outputAddr:   slot.outputAddr,
            subslotAddrs: slot.subslotAddrs || null,
          };
        }
      }
    }
    res.json(result);
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/bulk-delete — delete multiple stations at once
router.post('/imports/:id/stations/bulk-delete', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const { addresses } = req.body;
    if (!Array.isArray(addresses) || addresses.length === 0)
      return err(res, 400, 'addresses array required');

    const del = db.transaction(() => {
      for (const addr of addresses) {
        db.prepare('DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=?')
          .run(importId, parseInt(addr, 10));
      }
    });
    del();
    res.json({ ok: true, deleted: addresses.length });
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/bulk-approve — set approved flag on multiple stations
router.post('/imports/:id/stations/bulk-approve', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const { addresses, approved = true } = req.body;
    if (!Array.isArray(addresses) || addresses.length === 0)
      return err(res, 400, 'addresses array required');

    const upd = db.transaction(() => {
      for (const addr of addresses) {
        db.prepare('UPDATE hw_signals SET approved=? WHERE hw_import_id=? AND station_address=?')
          .run(approved ? 1 : 0, importId, parseInt(addr, 10));
      }
    });
    upd();
    res.json({ ok: true, updated: addresses.length });
  } catch (e) { err(res, 500, e.message); }
});

// GET /api/hw-config/imports/:id/signals?page=0&limit=100
router.get('/imports/:id/signals', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const limit    = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset   = parseInt(req.query.page   || '0',   10) * limit;

    const total   = db.prepare('SELECT COUNT(*) AS n FROM hw_signals WHERE hw_import_id=?').get(importId).n;
    const signals = db.prepare(
      `SELECT * FROM hw_signals WHERE hw_import_id=? ORDER BY station_address, slot, channel, row_number
       LIMIT ? OFFSET ?`
    ).all(importId, limit, offset);

    res.json({ total, signals });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /api/hw-config/imports/:id/stations/:addr — edit station name / ip / subsystemNo
router.patch('/imports/:id/stations/:addr', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const { station_name, ip_address, subsystem_no, router_address } = req.body;

    const sets = [];
    const vals = [];
    if (station_name    !== undefined) { sets.push('station_name=?');    vals.push(station_name); }
    if (ip_address      !== undefined) { sets.push('ip_address=?');      vals.push(ip_address); }
    if (subsystem_no    !== undefined) { sets.push('subsystem_no=?');    vals.push(subsystem_no); }
    if (router_address  !== undefined) { sets.push('router_address=?');  vals.push(router_address); }
    if (!sets.length) return err(res, 400, 'Nothing to update');

    vals.push(importId, addr);
    db.prepare(`UPDATE hw_signals SET ${sets.join(', ')} WHERE hw_import_id=? AND station_address=?`).run(...vals);
    // Invalidate cached generated CFG so next download reflects the updated values
    db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(importId);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /api/hw-config/imports/:id/stations/:addr/slots/:slot — edit module name / order_no
router.patch('/imports/:id/stations/:addr/slots/:slot', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { module_name, module_order_no } = req.body;

    const sets = [];
    const vals = [];
    if (module_name     !== undefined) { sets.push('module_name=?');     vals.push(module_name); }
    if (module_order_no !== undefined) { sets.push('module_order_no=?'); vals.push(module_order_no); }
    if (!sets.length) return err(res, 400, 'Nothing to update');

    vals.push(importId, addr, slot);
    db.prepare(
      `UPDATE hw_signals SET ${sets.join(', ')} WHERE hw_import_id=? AND station_address=? AND slot=?`
    ).run(...vals);
    db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(importId);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/potential-group
router.patch('/imports/:id/stations/:addr/slots/:slot/potential-group', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { potentialGroup } = req.body; // "NEW_GROUP" | "LEFT_MODULE" | null
    const val = potentialGroup === 'NEW_GROUP' || potentialGroup === 'LEFT_MODULE'
      ? potentialGroup : null;
    db.prepare(
      'UPDATE hw_signals SET potential_group=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/pip — assign PIP to a slot
router.patch('/imports/:id/stations/:addr/slots/:slot/pip', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { pipNo } = req.body; // null = "None / Default OB1", integer = PIP number

    const val = pipNo == null ? null : parseInt(pipNo, 10);
    db.prepare(
      'UPDATE hw_signals SET pip_no=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/pa-profile — set PA subslot-1 profile for a CFU_PA device slot
router.patch('/imports/:id/stations/:addr/slots/:slot/pa-profile', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { paProfile } = req.body;

    // Validate against catalogue: must be a known subslot template in the same CFU_PA family
    const known = db.prepare(
      "SELECT order_no FROM hw_module_templates WHERE order_no=? AND hw_category='subslot' AND family='CFU_PA'"
    ).get(paProfile);
    const val = (paProfile && known) ? paProfile : null;
    db.prepare(
      'UPDATE hw_signals SET pa_profile=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/subslots/:ssNo/pa-profile — set per-subslot PA profile
router.patch('/imports/:id/stations/:addr/slots/:slot/subslots/:ssNo/pa-profile', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const ssNo     = parseInt(req.params.ssNo, 10);
    const { paProfile } = req.body;

    const known = paProfile
      ? db.prepare("SELECT order_no FROM hw_module_templates WHERE order_no=? AND hw_category='subslot' AND family='CFU_PA'").get(paProfile)
      : null;
    const val = (paProfile && known) ? paProfile : null;

    db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hw_import_id, station_address, slot, subslot_no) DO UPDATE SET pa_profile=excluded.pa_profile`
    ).run(importId, addr, slot, ssNo, val);

    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Manual station / slot management ─────────────────────────────────────────

// POST /imports/:id/stations — add a station manually
router.post('/imports/:id/stations', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const { address, name, ip, subsystemNo, imOrderNo, imName } = req.body;
    if (address == null) return err(res, 400, 'address required');
    if (!imOrderNo) return err(res, 400, 'imOrderNo (Slot 0 IM type) required');

    const addr = parseInt(address, 10);
    const exists = db.prepare(
      'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? LIMIT 1'
    ).get(importId, addr);
    if (exists) return err(res, 409, `Station ${addr} already exists`);

    const stationName = name || `Station_${addr}`;
    const subsysNo    = subsystemNo ?? 100;

    // Look up the IM template to detect family-specific auto-slots
    const imTpl = db.prepare('SELECT family FROM hw_module_templates WHERE order_no=?').get(imOrderNo);
    const isCfuPa   = imTpl && imTpl.family === 'CFU_PA';
    const isScalance = imTpl && imTpl.family === 'Scalance';

    const insSignal = db.prepare(`INSERT INTO hw_signals
      (hw_import_id, station_address, station_name, ip_address, slot, module_order_no, module_name, subsystem_no)
      VALUES (?,?,?,?,?,?,?,?)`);

    const insertStation = db.transaction(() => {
      // Slot 0 = station head — always inserted (holds IP, name, subsystem)
      insSignal.run(importId, addr, stationName, ip || null, 0, imOrderNo, imName || imOrderNo, subsysNo);

      if (isCfuPa) {
        // Slot 1 — DIQ8 (always present on CFU_PA)
        insSignal.run(importId, addr, stationName, ip || null, 1,
          '_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT', 'DIQ8 DC24V/0.5A', subsysNo);
        // Slot 2 — PA Master (always present on CFU_PA, AUTOCREATED)
        insSignal.run(importId, addr, stationName, ip || null, 2,
          '_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT', 'PROFIBUS PA Master', subsysNo);
      }
      // Scalance: only slot 0 (the device head). Ports are AUTOCREATED subslots under slot 0,
      // derived from port_config on the template at generation time — no separate hw_signals rows.
    });
    insertStation();

    res.status(201).json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/:addr/copy — duplicate a station with next address + incremented IP
router.post('/imports/:id/stations/:addr/copy', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const srcAddr  = parseInt(req.params.addr, 10);

    const srcRows = db.prepare(
      'SELECT * FROM hw_signals WHERE hw_import_id=? AND station_address=? ORDER BY slot, channel, row_number'
    ).all(importId, srcAddr);
    if (srcRows.length === 0) return err(res, 404, `Station ${srcAddr} not found`);

    // Next address = max used address + 1
    const maxRow = db.prepare('SELECT MAX(station_address) AS m FROM hw_signals WHERE hw_import_id=?').get(importId);
    const newAddr = (maxRow.m || 0) + 1;

    // Increment last IP octet
    const srcIp = srcRows[0].ip_address || '';
    let newIp = srcIp;
    if (srcIp) {
      const parts = srcIp.split('.');
      if (parts.length === 4) {
        parts[3] = String(parseInt(parts[3], 10) + 1);
        newIp = parts.join('.');
      }
    }

    if (db.prepare('SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? LIMIT 1').get(importId, newAddr)) {
      return err(res, 409, `Station ${newAddr} already exists`);
    }

    const ins = db.prepare(`INSERT INTO hw_signals
      (hw_import_id, row_number, station_address, station_name, ip_address,
       slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address, potential_group)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const srcSubslots = db.prepare(
      'SELECT slot, subslot_no, pa_profile FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=?'
    ).all(importId, srcAddr);

    const insSubslot = db.prepare(
      `INSERT OR IGNORE INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile)
       VALUES (?, ?, ?, ?, ?)`
    );

    const copy = db.transaction(() => {
      for (const r of srcRows) {
        ins.run(
          importId, r.row_number, newAddr, r.station_name, newIp,
          r.slot, r.channel, r.module_order_no, r.module_name,
          r.tag, r.description, r.signal_type, r.subsystem_no, r.router_address, r.potential_group ?? null
        );
      }
      for (const r of srcSubslots) {
        insSubslot.run(importId, newAddr, r.slot, r.subslot_no, r.pa_profile);
      }
    });
    copy();

    res.status(201).json({ ok: true, newAddress: newAddr, newIp });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /imports/:id/stations/:addr — remove a station and all its signals
router.delete('/imports/:id/stations/:addr', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    db.prepare('DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=?').run(importId, addr);
    db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=?').run(importId, addr);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/:addr/slots — add a slot manually
router.post('/imports/:id/stations/:addr/slots', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const hwImport = db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const { slot, moduleOrderNo, moduleName } = req.body;
    if (slot == null || !moduleOrderNo) return err(res, 400, 'slot and moduleOrderNo required');

    const slotNo = parseInt(slot, 10);

    // CFU_PA: slots 0-2 are reserved system slots — only allow user slots ≥3
    const imRow = db.prepare('SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1').get(importId, addr);
    if (imRow) {
      const imTpl = db.prepare('SELECT family FROM hw_module_templates WHERE order_no=?').get(imRow.module_order_no);
      if (imTpl && imTpl.family === 'CFU_PA' && slotNo < 3) {
        return err(res, 400, 'CFU_PA: Slots 0, 1, and 2 are reserved system slots. Add from Slot 3 onwards.');
      }
    }

    // Carry station-level info from existing rows for this station
    const head = db.prepare(
      'SELECT station_name, ip_address, subsystem_no, router_address FROM hw_signals WHERE hw_import_id=? AND station_address=? LIMIT 1'
    ).get(importId, addr);

    // Auto-default POTENTIAL_GROUP for ET200SP I/O slots (slot > 0).
    // Rule: if the slot immediately to the left (slotNo-1) has the same order_no,
    // default to LEFT_MODULE; otherwise NEW_GROUP.
    const headTpl = db.prepare('SELECT family FROM hw_module_templates WHERE order_no=?')
      .get(db.prepare('SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1')
          .get(importId, addr)?.module_order_no || '');
    const stationFamily = headTpl ? headTpl.family : null;
    let defaultPotentialGroup = null;
    if (stationFamily && stationFamily.startsWith('ET200') && slotNo > 0) {
      const tplForNew = db.prepare('SELECT param_template FROM hw_module_templates WHERE order_no=?').get(moduleOrderNo);
      const hasPotentialGroup = tplForNew
        ? (tplForNew.param_template || '').includes('POTENTIAL_GROUP')
        : true; // unknown modules get the default applied
      if (hasPotentialGroup) {
        const leftSlot = db.prepare(
          'SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1'
        ).get(importId, addr, slotNo - 1);
        defaultPotentialGroup = (leftSlot && leftSlot.module_order_no === moduleOrderNo)
          ? 'LEFT_MODULE'
          : 'NEW_GROUP';
      }
    }

    db.prepare(`INSERT INTO hw_signals
      (hw_import_id, station_address, station_name, ip_address, slot, module_order_no, module_name, subsystem_no, router_address, potential_group)
      VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      importId, addr,
      head ? head.station_name : null,
      head ? head.ip_address   : null,
      slotNo, moduleOrderNo, moduleName || moduleOrderNo,
      head ? head.subsystem_no    : 100,
      head ? head.router_address  : null,
      defaultPotentialGroup,
    );

    res.status(201).json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /imports/:id/stations/:addr/slots/:slot — remove one slot
router.delete('/imports/:id/stations/:addr/slots/:slot', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    db.prepare('DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=?').run(importId, addr, slot);
    db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=? AND slot=?').run(importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Per-slot channel signal assignment ───────────────────────────────────────

// GET /imports/:id/stations/:addr/slots/:slot/channels
// Returns one row per channel (0-indexed), creating missing rows up to channel_count from template.
router.get('/imports/:id/stations/:addr/slots/:slot/channels', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);

    const existing = db.prepare(
      `SELECT id, channel, tag, description, signal_type
       FROM hw_signals
       WHERE hw_import_id=? AND station_address=? AND slot=?
       ORDER BY channel`
    ).all(importId, addr, slot);

    // Get channel_count from template for this slot
    const slotMeta = db.prepare(
      `SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1`
    ).get(importId, addr, slot);

    let channelCount = existing.length;
    let slotSignalType = null;
    if (slotMeta) {
      const tpl = db.prepare('SELECT channel_count, signal_type FROM hw_module_templates WHERE order_no=?').get(slotMeta.module_order_no);
      if (tpl && tpl.channel_count > 0) channelCount = tpl.channel_count;
      if (tpl) slotSignalType = tpl.signal_type;
    }

    // Build a full channel list: existing rows + empty placeholders for gaps.
    // MIXED (DIQ8): channels 0..(half-1) are DI, channels half..(count-1) are DO.
    // PA slots with channel_count > 1: each channel is one PA function subslot.
    const isMixed = slotSignalType === 'MIXED';
    const halfCount = isMixed ? Math.floor(channelCount / 2) : 0;
    const byChannel = new Map(existing.map(r => [r.channel, r]));
    const channels = [];
    for (let ch = 0; ch < channelCount; ch++) {
      const row = byChannel.get(ch);
      let defaultType;
      if (isMixed) {
        defaultType = ch < halfCount ? 'DI' : 'DO';
      } else if (slotSignalType === 'PA' || slotSignalType === 'AI' || slotSignalType === 'AO') {
        defaultType = slotSignalType;
      } else {
        defaultType = null;
      }
      channels.push({
        channel:     ch,
        id:          row ? row.id          : null,
        tag:         row ? row.tag         : null,
        description: row ? row.description : null,
        signal_type: row ? (row.signal_type || defaultType) : defaultType,
      });
    }
    // Also append any extra rows beyond channelCount (e.g. from Excel import)
    for (const row of existing) {
      if (row.channel >= channelCount) channels.push({ channel: row.channel, id: row.id, tag: row.tag, description: row.description, signal_type: row.signal_type });
    }

    res.json(channels);
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/channels/:ch
router.patch('/imports/:id/stations/:addr/slots/:slot/channels/:ch', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const ch       = parseInt(req.params.ch,   10);
    const { tag, description, signal_type } = req.body;

    const existing = db.prepare(
      'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel=?'
    ).get(importId, addr, slot, ch);

    if (existing) {
      const sets = [], vals = [];
      if (tag         !== undefined) { sets.push('tag=?');         vals.push(tag); }
      if (description !== undefined) { sets.push('description=?'); vals.push(description); }
      if (signal_type !== undefined) { sets.push('signal_type=?'); vals.push(signal_type); }
      if (sets.length) {
        vals.push(existing.id);
        db.prepare(`UPDATE hw_signals SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      }
    } else {
      // Row doesn't exist yet — pull station/slot metadata for required FK fields
      const head = db.prepare(
        `SELECT station_name, ip_address, module_order_no, module_name, subsystem_no, router_address
         FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1`
      ).get(importId, addr, slot);
      db.prepare(`INSERT INTO hw_signals
        (hw_import_id, station_address, station_name, ip_address, slot, channel,
         module_order_no, module_name, subsystem_no, router_address, tag, description, signal_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        importId, addr,
        head?.station_name || null, head?.ip_address || null,
        slot, ch,
        head?.module_order_no || null, head?.module_name || null,
        head?.subsystem_no ?? 100, head?.router_address || null,
        tag ?? null, description ?? null, signal_type ?? null
      );
    }
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Generate CFG ──────────────────────────────────────────────────────────────

router.post('/imports/:id/generate', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = db.prepare('SELECT * FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport)           return err(res, 404, 'HW import not found');
    if (!hwImport.baseline_cfg) return err(res, 400, 'No baseline CFG uploaded');

    const tplRows    = db.prepare('SELECT * FROM hw_module_templates').all();
    const templateMap = new Map(tplRows.map(t => [t.order_no, t]));

    // Optional filter: generate only specific station addresses or only approved ones
    const filterMode    = req.body && req.body.filterMode;    // 'selected' | 'approved' | null (all)
    const filterAddrs   = req.body && req.body.addresses ? req.body.addresses.map(Number) : null;

    let signalQuery = "SELECT * FROM hw_signals WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'";
    const queryParams = [importId];

    if (filterMode === 'selected' && filterAddrs && filterAddrs.length > 0) {
      signalQuery += ` AND station_address IN (${filterAddrs.map(() => '?').join(',')})`;
      queryParams.push(...filterAddrs);
    } else if (filterMode === 'approved') {
      signalQuery += ' AND COALESCE(approved,0)=1';
    }
    signalQuery += ' ORDER BY station_address, slot, channel, row_number';

    const signals = db.prepare(signalQuery).all(...queryParams);
    if (signals.length === 0) return err(res, 400, 'No signals or modules configured — add modules in Configuration');

    // Load per-subslot profiles for all stations in this import
    const subslotRows = db.prepare(
      'SELECT station_address, slot, subslot_no, pa_profile FROM hw_slot_subslots WHERE hw_import_id=? ORDER BY station_address, slot, subslot_no'
    ).all(importId);
    const subslotMap = new Map();
    for (const r of subslotRows) {
      const key = `${r.station_address}:${r.slot}`;
      if (!subslotMap.has(key)) subslotMap.set(key, []);
      subslotMap.get(key).push({ subslotNo: r.subslot_no, paProfile: r.pa_profile || null });
    }

    const stations = new Map();
    for (const sig of signals) {
      const addr = sig.station_address;
      if (!stations.has(addr)) {
        stations.set(addr, {
          address: addr, name: sig.station_name, ip: sig.ip_address,
          routerAddress: sig.router_address || null,
          subsystemNo: sig.subsystem_no,
          slots: new Map(),
        });
      }
      const station = stations.get(addr);
      if (!station.name && sig.station_name) station.name = sig.station_name;
      if (!station.ip   && sig.ip_address)   station.ip   = sig.ip_address;
      if (!station.routerAddress && sig.router_address) station.routerAddress = sig.router_address;
      if (station.subsystemNo == null && sig.subsystem_no != null) station.subsystemNo = sig.subsystem_no;

      if (!station.slots.has(sig.slot)) {
        station.slots.set(sig.slot, {
          slot:           sig.slot,
          orderNo:        sig.module_order_no,
          name:           sig.module_name,
          pipNo:          sig.pip_no != null ? sig.pip_no : null,
          potentialGroup: sig.potential_group != null ? sig.potential_group : null,
          paProfile:      sig.pa_profile || null,
          subslots:       subslotMap.get(`${addr}:${sig.slot}`) || [],
          channels:       [],
        });
      }
      if (sig.tag || sig.channel != null) {
        station.slots.get(sig.slot).channels.push({
          channel: sig.channel, tag: sig.tag, desc: sig.description, signalType: sig.signal_type,
        });
      }
    }

    const parsedBaseline = parseCfg(hwImport.baseline_cfg);
    allocateAddresses(stations, templateMap,
      parsedBaseline.existingAddresses.maxInput,
      parsedBaseline.existingAddresses.maxOutput
    );

    const cfgText = generateCfg(parsedBaseline, stations, templateMap);

    let moduleCount = 0;
    for (const st of stations.values()) moduleCount += st.slots.size;
    const stats = JSON.stringify({ stations: stations.size, modules: moduleCount, signals: signals.length });

    db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(importId);
    const r = db.prepare(
      'INSERT INTO hw_generated_cfgs (hw_import_id, cfg_text, stats) VALUES (?,?,?)'
    ).run(importId, cfgText, stats);
    db.prepare('UPDATE hw_imports SET status=? WHERE id=?').run('generated', importId);

    res.json({ cfgId: r.lastInsertRowid, stats: JSON.parse(stats), previewLines: cfgText.split('\n').slice(0, 30) });
  } catch (e) { err(res, 500, e.message); }
});

router.get('/imports/:id/cfgs', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const rows = db.prepare(
      'SELECT id, stats, generated_at FROM hw_generated_cfgs WHERE hw_import_id=? ORDER BY id DESC'
    ).all(importId);
    res.json(rows.map(r => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null })));
  } catch (e) { err(res, 500, e.message); }
});

router.get('/imports/:id/cfgs/:cfgId/download', (req, res) => {
  try {
    const db    = getDb();
    const cfgId = parseInt(req.params.cfgId, 10);
    const row   = db.prepare('SELECT cfg_text FROM hw_generated_cfgs WHERE id=?').get(cfgId);
    if (!row) return err(res, 404, 'CFG not found');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="HW_Config_${cfgId}.cfg"`);
    res.send(row.cfg_text);
  } catch (e) { err(res, 500, e.message); }
});

// ── Slot ↔ Subslot compatibility ─────────────────────────────────────────────

// GET /slot-compat
// Returns all rows: [{ id, slot_order_no, subslot_order_no, is_default }]
router.get('/slot-compat', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, slot_order_no, subslot_order_no, is_default FROM hw_slot_subslot_compat ORDER BY slot_order_no, subslot_order_no').all();
    res.json(rows);
  } catch (e) { err(res, 500, e.message); }
});

// POST /slot-compat
// Body: { slot_order_no, subslot_order_no, is_default? }
router.post('/slot-compat', (req, res) => {
  try {
    const db = getDb();
    const { slot_order_no, subslot_order_no, is_default = 0 } = req.body;
    if (!slot_order_no || !subslot_order_no) return err(res, 400, 'slot_order_no and subslot_order_no required');
    const r = db.prepare(
      'INSERT OR IGNORE INTO hw_slot_subslot_compat (slot_order_no, subslot_order_no, is_default) VALUES (?,?,?)'
    ).run(slot_order_no, subslot_order_no, is_default ? 1 : 0);
    res.status(201).json({ id: r.lastInsertRowid, inserted: r.changes > 0 });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /slot-compat
// Body: { slot_order_no, subslot_order_no }
router.delete('/slot-compat', (req, res) => {
  try {
    const db = getDb();
    const { slot_order_no, subslot_order_no } = req.body;
    if (!slot_order_no || !subslot_order_no) return err(res, 400, 'slot_order_no and subslot_order_no required');
    db.prepare('DELETE FROM hw_slot_subslot_compat WHERE slot_order_no=? AND subslot_order_no=?')
      .run(slot_order_no, subslot_order_no);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
