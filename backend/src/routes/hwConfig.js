// src/routes/hwConfig.js — HW Engineering Extension endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb } = require('../db');
const { parseCfg, parseCfgDevices } = require('../services/cfgParser');
const { parseHwExcel, parseRawExcelRows, suggestColumnMappingByLevenshtein }  = require('../services/hwExcelParser');
const { allocateAddresses, findTemplate, defaultIdentifiers } = require('../services/hwAddressEngine');
const { generateCfg, hexToIp } = require('../services/cfgGenerator');
const { parseCfgForCatalogue } = require('../services/cfgCatalogueParser');
const { parseMrpConfig } = require('../services/mrpCfgParser');
const { loadStationAutoSlotConfig } = require('../services/autoSlotResolver');
const ModuleParameterExtractor = require('../services/moduleParameterExtractor');
const ModuleParameterDb = require('../services/moduleParameterDb');
const { findStationConflicts, loadExistingStations, buildConflictTable } = require('../services/stationUniqueness');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function err(res, code, msg, extra) { return res.status(code).json({ error: msg, ...(extra || {}) }); }

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
router.get('/signal-types', async (_req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare('SELECT name FROM hw_signal_types ORDER BY sort_order, name').all();
    res.json(rows.map(r => r.name));
  } catch (e) { err(res, 500, e.message); }
});

// POST /signal-types  — add a new custom signal type (idempotent)
router.post('/signal-types', async (req, res) => {
  try {
    const name = (req.body.name || '').trim().toUpperCase();
    if (!name) return err(res, 400, 'name required');
    const db = getDb();
    await db.prepare('INSERT INTO hw_signal_types (name) VALUES (?) ON CONFLICT (name) DO NOTHING').run(name);
    const rows = await db.prepare('SELECT name FROM hw_signal_types ORDER BY sort_order, name').all();
    res.json(rows.map(r => r.name));
  } catch (e) { err(res, 500, e.message); }
});

// ── Module Templates ──────────────────────────────────────────────────────────

router.get('/module-templates', async (_req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare('SELECT * FROM hw_module_templates ORDER BY family, display_name').all();
    res.json(rows);
  } catch (e) { err(res, 500, e.message); }
});

router.post('/module-templates', async (req, res) => {
  try {
    const db = getDb();
    const {
      id,
      order_no, display_name, family, signal_type, channel_count = 0,
      input_bytes = 0, output_bytes = 0, in_addr_fmt, out_addr_fmt,
      param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config,
      in_identifier, out_identifier,
    } = req.body;
    if (!order_no || !display_name || !family) return err(res, 400, 'order_no, display_name, family required');

    // SYMBOL-line identifiers: keep an explicit value (incl. intentional blank → null);
    // when omitted entirely, fall back to the signal-type default.
    const def = defaultIdentifiers(signal_type);
    const inIdent  = in_identifier  !== undefined ? (in_identifier  || null) : def.in;
    const outIdent = out_identifier !== undefined ? (out_identifier || null) : def.out;

    // Prefer matching by primary-key id when provided (editing a specific row).
    // The same order_no + hw_category can appear on multiple rows (e.g. Port 1 & Port 2
    // are both subslots with the same GSDML path), so order_no is NOT a safe update key.
    // Fall back to (order_no, hw_category) only when no id is given (fresh upsert from import).
    let existing = null;
    if (id != null) {
      existing = await db.prepare('SELECT id FROM hw_module_templates WHERE id=?').get(id);
    } else {
      existing = await db.prepare(
        'SELECT id FROM hw_module_templates WHERE order_no=? AND (hw_category IS NOT DISTINCT FROM ? OR hw_category=?)'
      ).get(order_no, hw_category || null, hw_category || null);
    }
    if (existing) {
      await db.prepare(`UPDATE hw_module_templates SET
        order_no=?, display_name=?, family=?, signal_type=?, channel_count=?,
        input_bytes=?, output_bytes=?, in_addr_fmt=?, out_addr_fmt=?,
        param_template=?, version=?, gsdml_file=?, dap_id=?, hw_category=?, subslot_defaults=?, port_config=?,
        in_identifier=?, out_identifier=?
        WHERE id=?`).run(
        order_no, display_name, family, signal_type, channel_count,
        input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
        param_template, version, gsdml_file, dap_id, hw_category || null, subslot_defaults || null, port_config || null,
        inIdent, outIdent, existing.id
      );
      res.json({ id: existing.id, updated: true });
    } else {
      const r = await db.prepare(`INSERT INTO hw_module_templates
        (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
         in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config,
         in_identifier, out_identifier)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        order_no, display_name, family, signal_type, channel_count,
        input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
        param_template, version, gsdml_file, dap_id, hw_category || null, subslot_defaults || null, port_config || null,
        inIdent, outIdent
      );
      res.status(201).json({ id: r.lastInsertRowid });
    }
  } catch (e) { err(res, 500, e.message); }
});

// GET /module-templates/:id/usage — list every station that uses this module
router.get('/module-templates/:id/usage', async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id, 10);
    const tpl = await db.prepare('SELECT order_no, display_name FROM hw_module_templates WHERE id=?').get(id);
    if (!tpl) return err(res, 404, 'Module template not found');

    const rows = await db.prepare(`
      SELECT hs.hw_import_id, hi.excel_name, p.name AS project_name,
             hs.station_address, hs.station_name, hs.slot,
             COUNT(*) AS row_count
      FROM hw_signals hs
      JOIN hw_imports hi ON hi.id = hs.hw_import_id
      LEFT JOIN projects p ON p.id = hi.project_id
      WHERE hs.module_order_no = ?
      GROUP BY hs.hw_import_id, hi.excel_name, p.name, hs.station_address, hs.station_name, hs.slot
      ORDER BY hs.hw_import_id, hs.station_address, hs.slot
    `).all(tpl.order_no);

    res.json({ order_no: tpl.order_no, display_name: tpl.display_name, usage: rows.map(r => ({ ...r, row_count: Number(r.row_count) })) });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /module-templates/:id — remove a catalogue entry if not referenced in any import
router.delete('/module-templates/:id', async (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id, 10);
    const tpl = await db.prepare('SELECT order_no, display_name FROM hw_module_templates WHERE id=?').get(id);
    if (!tpl) return err(res, 404, 'Module template not found');
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM hw_signals WHERE module_order_no=?').get(tpl.order_no);
    if (Number(n) > 0)
      return err(res, 409, `Cannot delete — "${tpl.order_no}" is used in ${n} signal row(s). Remove it from all stations first.`);
    await db.prepare('DELETE FROM hw_module_templates WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Tier 2 Hardware Resolution (Protocol + SignalType → Card MLFB) ────────────────

// GET /hardware-resolution — List all mappings with pagination
router.get('/hardware-resolution', async (req, res) => {
  try {
    const db = getDb();
    const page = parseInt(req.query.page, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = page * limit;

    const total = Number((await db.prepare('SELECT COUNT(*) AS n FROM hw_hardware_resolution').get()).n);
    const rows = await db.prepare(`
      SELECT hr.id, hr.protocol, hr.signal_type, hr.card_mlfb, hr.station_mlfb, hr.description, hr.created_at,
             ht.display_name, ht.family
      FROM hw_hardware_resolution hr
      LEFT JOIN hw_module_templates ht ON ht.order_no = hr.card_mlfb
      ORDER BY hr.protocol, hr.signal_type
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ rows, total, page, limit });
  } catch (e) { err(res, 500, e.message); }
});

// POST /hardware-resolution — Add or update a mapping
router.post('/hardware-resolution', async (req, res) => {
  try {
    const db = getDb();
    const { id, protocol, signal_type, card_mlfb, station_mlfb, description } = req.body;

    if (!protocol || !signal_type || !card_mlfb || !station_mlfb) {
      return err(res, 400, 'protocol, signal_type, card_mlfb, and station_mlfb are required');
    }

    // If id provided: update by id
    if (id) {
      await db.prepare('UPDATE hw_hardware_resolution SET protocol=?, signal_type=?, card_mlfb=?, station_mlfb=?, description=? WHERE id=?')
        .run(protocol.trim(), signal_type.trim(), card_mlfb.trim(), station_mlfb.trim(), description?.trim() || null, id);
      return res.json({ ok: true, action: 'updated' });
    }

    // No id: insert or update by unique key
    try {
      await db.prepare('INSERT INTO hw_hardware_resolution (protocol, signal_type, card_mlfb, station_mlfb, description) VALUES (?,?,?,?,?)')
        .run(protocol.trim(), signal_type.trim(), card_mlfb.trim(), station_mlfb.trim(), description?.trim() || null);
      res.status(201).json({ ok: true, action: 'inserted' });
    } catch (e) {
      if (e.message.toLowerCase().includes('unique') || e.code === '23505') {
        await db.prepare('UPDATE hw_hardware_resolution SET card_mlfb=?, station_mlfb=?, description=? WHERE protocol=? AND signal_type=?')
          .run(card_mlfb.trim(), station_mlfb.trim(), description?.trim() || null, protocol.trim(), signal_type.trim());
        res.json({ ok: true, action: 'updated' });
      } else {
        throw e;
      }
    }
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /hardware-resolution/:id — Remove a mapping
router.delete('/hardware-resolution/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const row = await db.prepare('SELECT protocol, signal_type FROM hw_hardware_resolution WHERE id=?').get(id);
    if (!row) return err(res, 404, 'Mapping not found');
    await db.prepare('DELETE FROM hw_hardware_resolution WHERE id=?').run(id);
    res.json({ ok: true, deleted: { protocol: row.protocol, signal_type: row.signal_type } });
  } catch (e) { err(res, 500, e.message); }
});

// GET /hardware-resolution/export — Export all mappings as CSV
router.get('/hardware-resolution/export', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT protocol, signal_type, card_mlfb, station_mlfb, description
      FROM hw_hardware_resolution
      ORDER BY protocol, signal_type
    `).all();

    // Build CSV
    const csv = 'protocol,signal_type,card_mlfb,station_mlfb,description\n' +
      rows.map(r => `"${r.protocol}","${r.signal_type}","${r.card_mlfb}","${r.station_mlfb}","${r.description || ''}"`)
        .join('\n');

    res.type('text/csv').set('Content-Disposition', 'attachment; filename="hw-resolution-mappings.csv"').send(csv);
  } catch (e) { err(res, 500, e.message); }
});

// POST /hardware-resolution/import — Bulk import from CSV
router.post('/hardware-resolution/import', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No CSV file uploaded');
    const db = getDb();
    const text = req.file.buffer.toString('utf8');
    const lines = text.trim().split('\n');
    if (lines.length < 2) return err(res, 400, 'CSV must have header row and at least one data row');

    let imported = 0, skipped = 0, errors = [];

    // Skip header, process data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // skip empty lines

      // Simple CSV parsing (assumes no quotes or commas in values for simplicity)
      const parts = line.split(',').map(p => p.trim().replace(/^"(.*)"$/, '$1'));
      if (parts.length < 4) {
        skipped++;
        continue;
      }

      const [protocol, signal_type, card_mlfb, station_mlfb, description] = parts;
      try {
        // Upsert
        await db.prepare(`
          INSERT INTO hw_hardware_resolution (protocol, signal_type, card_mlfb, station_mlfb, description) VALUES (?,?,?,?,?)
          ON CONFLICT (protocol, signal_type) DO UPDATE SET
            card_mlfb = EXCLUDED.card_mlfb,
            station_mlfb = EXCLUDED.station_mlfb,
            description = EXCLUDED.description
        `).run(protocol?.trim() || '', signal_type?.trim() || '', card_mlfb?.trim() || '', station_mlfb?.trim() || '', description?.trim() || null);
        imported++;
      } catch (e) {
        errors.push(`Row ${i}: ${e.message}`);
        skipped++;
      }
    }

    res.json({ ok: true, imported, skipped, errors });
  } catch (e) { err(res, 500, e.message); }
});

// ── Catalogue — import from .cfg ──────────────────────────────────────────────

// POST /module-templates/parse-cfg
// Upload a .cfg file, parse IOSUBSYSTEM blocks, return candidates + conflict flags.
// Does NOT write to DB — preview only.
router.post('/module-templates/parse-cfg', upload.single('cfg'), async (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No file uploaded');
    const text = req.file.buffer.toString('utf8');
    const { error, candidates } = parseCfgForCatalogue(text);
    if (error && candidates.length === 0) return err(res, 422, error);

    // Check each candidate against existing catalogue
    const db = getDb();
    const withStatus = [];
    for (const c of candidates) {
      if (c.parseError) { withStatus.push({ ...c, status: 'error' }); continue; }
      const existing = await db.prepare('SELECT id, display_name, version FROM hw_module_templates WHERE order_no=?').get(c.order_no);
      withStatus.push({ ...c, status: existing ? 'conflict' : 'new', existingName: existing ? existing.display_name : null });
    }

    res.json({ warning: error, candidates: withStatus });
  } catch (e) { err(res, 500, e.message); }
});

// POST /module-templates/bulk-upsert
// Body: { devices: [{ order_no, display_name, family, ..., action: 'add'|'overwrite'|'skip' }] }
// Writes confirmed devices to the catalogue.
router.post('/module-templates/bulk-upsert', async (req, res) => {
  try {
    const db = getDb();
    const { devices } = req.body;
    if (!Array.isArray(devices) || devices.length === 0)
      return err(res, 400, 'devices array required');

    let added = 0, overwritten = 0, skipped = 0;

    const insSql = db.prepare(`INSERT INTO hw_module_templates
      (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
       in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config,
       in_identifier, out_identifier, mlfb)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const updSql = db.prepare(`UPDATE hw_module_templates SET
      display_name=?, family=?, signal_type=?, channel_count=?,
      input_bytes=?, output_bytes=?, in_addr_fmt=?, out_addr_fmt=?,
      param_template=?, version=?, gsdml_file=?, dap_id=?, hw_category=?, subslot_defaults=?, port_config=?,
      in_identifier=?, out_identifier=?, mlfb=?
      WHERE order_no=? AND (hw_category IS NOT DISTINCT FROM ? OR hw_category=?)`);

    let paramRows = 0;   // ADDITIVE: count of normalized parameter rows written

    const upsert = db.transaction(async (devices) => {
      for (const d of devices) {
        if (d.action === 'skip') { skipped++; continue; }
        // Existence check must match the UNIQUE (order_no, hw_category) constraint.
        // The same order_no can exist as station, slot, and subslot — each is a distinct row.
        const existing = await db.prepare(
          'SELECT id FROM hw_module_templates WHERE order_no=? AND (hw_category IS NOT DISTINCT FROM ? OR hw_category=?)'
        ).get(d.order_no, d.hw_category || null, d.hw_category || null);
        if (existing && d.action !== 'overwrite') { skipped++; continue; }

        // Identifiers: explicit value wins; otherwise default from signal type (so
        // CFG-imported catalogue entries get I/Q/IW/QW automatically).
        const def = defaultIdentifiers(d.signal_type);
        const inIdent  = d.in_identifier  !== undefined ? (d.in_identifier  || null) : def.in;
        const outIdent = d.out_identifier !== undefined ? (d.out_identifier || null) : def.out;

        const vals = [
          d.display_name, d.family, d.signal_type || null, d.channel_count || 0,
          d.input_bytes || 0, d.output_bytes || 0, d.in_addr_fmt || null, d.out_addr_fmt || null,
          d.param_template || null, d.version || null, d.gsdml_file || null, d.dap_id || null,
          d.hw_category || null, d.subslot_defaults || null, d.port_config || null,
          inIdent, outIdent, d.mlfb || null,
        ];

        // Resolve the template id (existing on overwrite, or the new insert's rowid)
        let templateId;
        if (existing) {
          // Update by unique (order_no, hw_category) pair, not order_no alone
          await updSql.run(...vals, d.order_no, d.hw_category || null, d.hw_category || null);
          overwritten++;
          templateId = existing.id;
        } else {
          const r = await insSql.run(d.order_no, ...vals);
          added++;
          templateId = r.lastInsertRowid;
        }

        // ── ADDITIVE: normalize param_template into hw_module_parameters ──────────
        // Existing param_template text column is left untouched; this is a parallel,
        // queryable representation linked to the template via template_id.
        if (templateId && d.param_template) {
          try {
            const extractor = new ModuleParameterExtractor();
            const params = extractor.parseParamTemplate(d.param_template);
            if (params.length > 0) {
              // Clear stale rows first so re-import stays idempotent
              await ModuleParameterDb.deleteParametersForTemplate(templateId);
              paramRows += await ModuleParameterDb.insertModuleParameters(templateId, params);
            }
          } catch (pErr) {
            console.warn(`[Catalogue] Parameter extraction skipped for ${d.order_no}:`, pErr.message);
          }
        }
      }
    });

    await upsert(devices);
    console.log(`[Catalogue] bulk-upsert: added=${added} overwritten=${overwritten} skipped=${skipped} paramRows=${paramRows}`);
    res.json({ ok: true, added, overwritten, skipped, paramRows });
  } catch (e) { err(res, 500, e.message); }
});

// ── HW Imports per project ────────────────────────────────────────────────────

router.get('/project/:id/imports', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.id, 10);
    const rows = await db.prepare(
      'SELECT id, excel_name, status, imported_at, baseline_info, baseline_cfg FROM hw_imports WHERE project_id=? ORDER BY id DESC'
    ).all(projectId);
    const out = [];
    for (const r of rows) {
      const info = r.baseline_info ? JSON.parse(r.baseline_info) : null;
      // Back-fill pipMappings for records stored before this feature was added
      if (info && !info.pipMappings && r.baseline_cfg) {
        try {
          const parsed = parseCfg(r.baseline_cfg);
          info.pipMappings = parsed.pipMappings || [];
          // Persist the enriched baseline_info so future loads are instant
          await db.prepare('UPDATE hw_imports SET baseline_info=? WHERE id=?')
            .run(JSON.stringify(info), r.id);
        } catch (_) { info.pipMappings = []; }
      }
      out.push({ id: r.id, excel_name: r.excel_name, status: r.status, imported_at: r.imported_at, baseline_info: info });
    }
    res.json(out);
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/project/:id/upload-baseline
router.post('/project/:id/upload-baseline', upload.single('baseline'), async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.id, 10);
    if (!(await db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)))
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

    const existing = await db.prepare('SELECT id FROM hw_imports WHERE project_id=? ORDER BY id DESC LIMIT 1').get(projectId);
    let importId;
    if (existing) {
      await db.prepare('UPDATE hw_imports SET baseline_cfg=?, status=?, baseline_info=? WHERE id=?')
        .run(cfgText, 'pending', JSON.stringify(baselineInfo), existing.id);
      importId = existing.id;
    } else {
      const r = await db.prepare(
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
      ? await db.prepare('SELECT id FROM hw_controllers WHERE project_id=? AND T16_Controller_TagName=?')
          .get(projectId, parsed.stationName)
      : await db.prepare('SELECT id FROM hw_controllers WHERE project_id=? ORDER BY id LIMIT 1').get(projectId);

    let controllerId;
    if (existingCtrl) {
      await db.prepare(`UPDATE hw_controllers SET
        T16_Controller_TagName=?, T16_Station_Type=?,
        T15_IP_Address=?, T50_Rack_Order_No=?, T50_Rack_Name=?,
        T50_PS_Order_No=?, T50_PS_Name=?, updated_at=NOW()
        WHERE id=?`).run(
        ctrlFields.T16_Controller_TagName, ctrlFields.T16_Station_Type,
        ctrlFields.T15_IP_Address,
        ctrlFields.T50_Rack_Order_No, ctrlFields.T50_Rack_Name,
        ctrlFields.T50_PS_Order_No, ctrlFields.T50_PS_Name,
        existingCtrl.id
      );
      controllerId = existingCtrl.id;
    } else {
      const r = await db.prepare(`INSERT INTO hw_controllers
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
    await db.prepare('DELETE FROM hw_fieldbuses WHERE hw_controller_id=?').run(controllerId);
    const fbIns = db.prepare(`INSERT INTO hw_fieldbuses
      (hw_controller_id, INT_DP_Subsystem, T50_Fieldbus_Name, T15_IP_Address)
      VALUES (?,?,?,?)`);
    for (const c of parsed.ioControllers) {
      await fbIns.run(controllerId, c.no, c.subnetName || null, c.ip || null);
    }

    res.json({ importId, ...baselineInfo });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/backfill-from-cfg
// Accepts a generated CFG file upload and populates hw_signals + hw_slot_subslots
// from its device blocks — a full round-trip import without needing an Excel sheet.
router.post('/imports/:id/backfill-from-cfg', upload.single('cfg'), async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');
    if (!req.file)  return err(res, 400, 'No CFG file uploaded');

    const cfgText = req.file.buffer.toString('utf8');
    const devices = parseCfgDevices(cfgText);
    if (devices.length === 0) {
      const lines   = cfgText.split(/\r?\n/);
      const ioLines = lines.filter(l => /IOSUBSYSTEM/.test(l)).slice(0, 3);
      return err(res, 400, `No IO devices found in uploaded CFG. Sample IOSUBSYSTEM lines: ${JSON.stringify(ioLines)}`);
    }

    // Additive import: validate the incoming CFG stations against the stations already
    // stored for this import (and each other) for uniqueness of address / name / IP.
    // Reject the whole backfill on any collision; add nothing.
    const incomingCfgStations = new Map();
    for (const dev of devices) {
      if (dev.address == null) continue;
      if (!incomingCfgStations.has(dev.address)) {
        incomingCfgStations.set(dev.address, { address: dev.address, name: dev.name, ip: dev.ip });
      }
    }
    const existingCfgStations = await loadExistingStations(db, importId);
    const cfgConflictStations = [...existingCfgStations, ...incomingCfgStations.values()];
    const cfgConflicts = findStationConflicts(cfgConflictStations);
    if (cfgConflicts.length) {
      return err(res, 400, 'Duplicate stations: ' + cfgConflicts.join('; '), {
        conflictRows: buildConflictTable(cfgConflictStations),
      });
    }

    // Load template catalogue so we can resolve signal_type from order_no
    const tplRows = await db.prepare('SELECT order_no, signal_type FROM hw_module_templates').all();
    const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

    const insertSignal = db.prepare(`
      INSERT INTO hw_signals
        (hw_import_id, station_address, station_name, ip_address, router_address,
         subsystem_no, slot, module_order_no, module_name, signal_type,
         pip_no, potential_group, tag, description, station_mlfb)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const insertSubslot = db.prepare(`
      INSERT INTO hw_slot_subslots
        (hw_import_id, station_address, slot, subslot_no, pa_profile)
      VALUES (?,?,?,?,?)
      ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
        pa_profile = EXCLUDED.pa_profile`);

    let stationCount = 0;
    let slotCount    = 0;

    await db.transaction(async () => {
      // Additive backfill: existing rows are kept. Uniqueness of incoming stations was
      // validated above, so new devices are simply inserted alongside any existing ones.
      // (hw_slot_subslots uses ON CONFLICT DO UPDATE, so re-inserting a subslot is safe.)
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
        await insertSignal.run(
          importId,
          dev.address, dev.name, dev.ip, dev.routerAddress,
          dev.subsystemNo, 0,
          slot0OrderNo, dev.name,
          null, null, null, null, null,
          dev.mlfbNo || null,
        );

        for (const slot of dev.slots) {
          // Server module (193-6PA00-0AA0) is auto-added by the generator on every
          // export — skip it on import so it is never stored as a configurable slot.
          if ((slot.orderNo || '').includes('193-6PA00-0AA0')) continue;

          const tpl        = tplMap.get(slot.orderNo);
          const signalType = tpl ? tpl.signal_type : null;

          if (slot.symbols.length === 0) {
            // No SYMBOL lines — insert one representative row for the slot
            await insertSignal.run(
              importId,
              dev.address, dev.name, dev.ip, dev.routerAddress,
              dev.subsystemNo, slot.slot,
              slot.orderNo, slot.name,
              signalType,
              slot.pipNo, slot.potentialGroup,
              null, null,
              slot.mlfb || null,
            );
            slotCount++;
          } else {
            // Insert one row per SYMBOL (channel-level tag data)
            for (const sym of slot.symbols) {
              await insertSignal.run(
                importId,
                dev.address, dev.name, dev.ip, dev.routerAddress,
                dev.subsystemNo, slot.slot,
                slot.orderNo, slot.name,
                signalType,
                slot.pipNo, slot.potentialGroup,
                sym.tag || null, sym.description || null,
                slot.mlfb || null,
              );
            }
            slotCount++;
          }

          // PA subslots — pass orderNo as pa_profile so CFU_PA function type round-trips
          for (const ss of slot.subslots) {
            await insertSubslot.run(importId, dev.address, slot.slot, ss.subslotNo, ss.orderNo || null);
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
        await db.transaction(async () => {
          const existing = await db.prepare(
            'SELECT id FROM mrp_configs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1'
          ).get(importId);
          let configId;
          if (existing) {
            await db.prepare(
              `UPDATE mrp_configs SET domain_name=?, fieldbus_no=?, station_name=?, updated_at=NOW() WHERE id=?`
            ).run(domainName, fieldbusNo, stationName || '', existing.id);
            configId = existing.id;
          } else {
            const r = await db.prepare(
              'INSERT INTO mrp_configs (hw_import_id, domain_name, fieldbus_no, station_name) VALUES (?,?,?,?)'
            ).run(importId, domainName, fieldbusNo, stationName || '');
            configId = r.lastInsertRowid;
          }

          await db.prepare('DELETE FROM mrp_device_roles WHERE mrp_config_id=?').run(configId);
          const insRole = db.prepare(
            'INSERT INTO mrp_device_roles (mrp_config_id, device_alias, io_address, subsystem_no, mrp_role, mrp_instances, ring_port_1, ring_port_2) VALUES (?,?,?,?,?,?,?,?)'
          );
          for (const r of roles) {
            await insRole.run(configId, r.alias, r.ioAddress, r.subsystemNo,
              r.mrpRole, r.mrpRole === 3 ? 1 : 0, r.ringPort1 ?? null, r.ringPort2 ?? null);
          }

          await db.prepare('DELETE FROM mrp_port_links WHERE mrp_config_id=?').run(configId);
          const insLink = db.prepare(
            `INSERT INTO mrp_port_links
               (mrp_config_id, from_device, from_iface_subslot, from_port_subslot,
                to_device, to_iface_subslot, to_port_subslot)
             VALUES (?,?,?,?,?,?,?)`
          );
          for (const l of links) {
            await insLink.run(configId, l.fromDevice, l.fromIfaceSubslot, l.fromPortSubslot,
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

// POST /api/hw-config/imports/:id/parse-headers
// Extract column headers from an Excel file without parsing data
// Returns: { headers: string[] }
router.post('/imports/:id/parse-headers', upload.single('iolist'), async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');
    if (!req.file)  return err(res, 400, 'No file uploaded');

    const sheetName = req.query.sheet || null;
    const { headers, rawExcelRows } = await parseHwExcel(req.file.buffer, sheetName);

    // Store raw Excel rows so they can be previewed without re-uploading
    await db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id=?').run(importId);
    const insert = db.prepare('INSERT INTO hw_excel_raw (hw_import_id, row_index, row_json) VALUES (?,?,?)');
    for (let i = 0; i < rawExcelRows.length; i++) await insert.run(importId, i, JSON.stringify(rawExcelRows[i]));

    res.json({ headers, rowCount: rawExcelRows.length });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/ingest-io-rows
// Unified import: copy an IO import's raw rows into this HW import's hw_excel_raw
// table so the Hardware column-mapping / preview flow can consume the SAME sheet
// that was uploaded once on the IO Import screen — no file re-upload needed.
// Body: { ioImportId }
router.post('/imports/:id/ingest-io-rows', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const { ioImportId } = req.body || {};

    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');
    if (!ioImportId) return err(res, 400, 'ioImportId required');

    const ioImport = await db.prepare('SELECT id FROM io_imports WHERE id=?').get(parseInt(ioImportId, 10));
    if (!ioImport) return err(res, 404, 'IO import not found');

    // io_tags.raw_data is {column: value} JSON — identical shape to hw_excel_raw.row_json.
    const ioRows = await db.prepare(
      'SELECT raw_data FROM io_tags WHERE import_id=? ORDER BY row_number, id'
    ).all(parseInt(ioImportId, 10));

    if (ioRows.length === 0) {
      return err(res, 400, 'IO import has no rows to ingest');
    }

    await db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id=?').run(importId);
    const insert = db.prepare('INSERT INTO hw_excel_raw (hw_import_id, row_index, row_json) VALUES (?,?,?)');
    const insertBatch = db.transaction(async (rows) => {
      for (let i = 0; i < rows.length; i++) await insert.run(importId, i, rows[i].raw_data || '{}');
    });
    await insertBatch(ioRows);

    // Derive headers from the first row for the response.
    let headers = [];
    try { headers = Object.keys(JSON.parse(ioRows[0].raw_data || '{}')); } catch (_) {}

    res.json({ headers, rowCount: ioRows.length });
  } catch (e) { err(res, 500, e.message); }
});

// GET /api/hw-config/imports/:id/excel-preview
// Returns raw Excel rows stored during parse-headers (no file re-upload needed)
// Optional query: ?limit=N (default 100)
router.get('/imports/:id/excel-preview', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const limit = parseInt(req.query.limit, 10) || 200;
    const stored = await db.prepare(
      'SELECT row_json FROM hw_excel_raw WHERE hw_import_id=? ORDER BY row_index LIMIT ?'
    ).all(importId, limit);

    if (stored.length === 0) {
      return res.json({ rows: [], headers: [], message: 'No Excel data stored — re-upload the file' });
    }

    const rows = stored.map(r => JSON.parse(r.row_json));
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

    res.json({ rows, headers, total: stored.length });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/suggest-column-mappings
// Suggests column mappings using fuzzy matching (Levenshtein distance).
// Request body: { selectedColumns: string[] } — user-selected columns from Excel file
// Response: { suggestions: { [appField]: { column, score } }, mandatory: string[], optional: string[] }
router.post('/imports/:id/suggest-column-mappings', async (req, res) => {
  try {
    const importId = parseInt(req.params.id, 10);
    const { selectedColumns } = req.body;

    if (!Array.isArray(selectedColumns) || selectedColumns.length === 0) {
      return err(res, 400, 'selectedColumns must be a non-empty array');
    }

    // Define mandatory and optional fields that can be mapped
    const MANDATORY_FIELDS = ['station_address', 'module_order_no', 'slot', 'tag', 'channel'];
    const OPTIONAL_FIELDS = [
      'station_name', 'ip_address', 'description', 'signal_type', 'subsystem_no', 'router_address'
    ];
    const ALL_FIELDS = [...MANDATORY_FIELDS, ...OPTIONAL_FIELDS];

    // Get fuzzy match suggestions
    const suggestions = suggestColumnMappingByLevenshtein(ALL_FIELDS, selectedColumns, 0.6);

    // Transform suggestions for response (flatten the score data)
    const suggestionMap = {};
    for (const [field, data] of Object.entries(suggestions)) {
      suggestionMap[field] = data.column; // Return just the column name
    }

    res.json({
      suggestions: suggestionMap,
      mandatory: MANDATORY_FIELDS,
      optional: OPTIONAL_FIELDS,
      selectedColumns,
    });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/upload-iolist
// Optional query params:
//   sheet=<name> — Excel sheet name to parse
//   columnMap=<json> — User-provided column mapping override (JSON string or stringified object)
router.post('/imports/:id/upload-iolist', upload.single('iolist'), async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id, project_id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');
    if (!req.file)  return err(res, 400, 'No file uploaded');

    const sheetName = req.query.sheet || null;

    // Parse columnMap from query string if provided
    let overrideColumnMap = null;
    if (req.query.columnMap) {
      try {
        overrideColumnMap = JSON.parse(req.query.columnMap);
      } catch (e) {
        return err(res, 400, 'Invalid columnMap JSON: ' + e.message);
      }
    }

    const { rows, stations, colMap, resolutionStats } = await parseHwExcel(req.file.buffer, sheetName, overrideColumnMap, db);

    // Additive import: build the incoming station set (one entry per address) and validate
    // it — together with the stations already stored for this import — for uniqueness of
    // address / name / IP. Reject the whole import on any collision; add nothing.
    const incomingStations = new Map();
    for (const r of rows) {
      if (r.stationAddr == null) continue;
      if (!incomingStations.has(r.stationAddr)) {
        incomingStations.set(r.stationAddr, { address: r.stationAddr, name: r.stationName, ip: r.ip });
      }
    }
    const existingStations = await loadExistingStations(db, importId);
    const conflictStations = [...existingStations, ...incomingStations.values()];
    const conflicts = findStationConflicts(conflictStations);
    if (conflicts.length) {
      return err(res, 400, 'Duplicate stations: ' + conflicts.join('; '), {
        conflictRows: buildConflictTable(conflictStations),
      });
    }

    const ins = db.prepare(`
      INSERT INTO hw_signals
        (hw_import_id, row_number, station_address, station_name, ip_address,
         slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
         station_mlfb, resolved_by_tier2, unresolved)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertBatch = db.transaction(async (batch) => {
      for (const r of batch) {
        await ins.run(importId, r.rowNum, r.stationAddr, r.stationName, r.ip,
          r.slot, r.channel, r.orderNo, r.moduleName, r.tag, r.desc, r.signalType,
          r.subsystemNo ?? null, r.routerAddress || null,
          r.stationMlfb || null,
          !!r.resolvedByTier2, !!r.unresolved);
      }
    });
    for (let i = 0; i < rows.length; i += 500) await insertBatch(rows.slice(i, i + 500));

    // Tier 2: Create slot 0 rows for stations with station_mlfb
    // This enables the grid to auto-generate ports (0.2, 0.3) based on the station module's port_config
    const tier2Stations = await db.prepare(`
      SELECT DISTINCT station_address, station_name, ip_address, router_address, subsystem_no, station_mlfb
      FROM hw_signals
      WHERE hw_import_id=? AND resolved_by_tier2=true AND station_mlfb IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hw_signals s2 WHERE s2.hw_import_id=? AND s2.station_address=hw_signals.station_address AND s2.slot=0)
    `).all(importId, importId);

    if (tier2Stations.length > 0) {
      const insSlot0 = db.prepare(`
        INSERT INTO hw_signals
          (hw_import_id, row_number, station_address, station_name, ip_address,
           slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
           station_mlfb, resolved_by_tier2, unresolved)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const s of tier2Stations) {
        await insSlot0.run(
          importId, null, s.station_address, s.station_name, s.ip_address,
          0, null, s.station_mlfb, s.station_name,
          null, null, null, s.subsystem_no, s.router_address,
          s.station_mlfb, true, false
        );
      }
    }

    await db.prepare('UPDATE hw_imports SET excel_name=?, status=? WHERE id=?')
      .run(req.file.originalname, 'ready', importId);

    res.json({ importId, stationCount: stations.size, signalCount: rows.length, colMap, resolutionStats });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/preview-iolist  (parse + diff, NO DB writes)
// If columnMap in query + no file: use stored raw rows from hw_excel_raw table
// If file uploaded: parse it fresh
// Optional query params:
//   sheet=<name> — Excel sheet name to parse
//   columnMap=<json> — User-provided column mapping override (JSON string)
router.post('/imports/:id/preview-iolist', upload.single('iolist'), async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    // Parse columnMap from query string
    let overrideColumnMap = null;
    if (req.query.columnMap) {
      try {
        overrideColumnMap = JSON.parse(req.query.columnMap);
      } catch (e) {
        return err(res, 400, 'Invalid columnMap JSON: ' + e.message);
      }
    }

    let rows, stations, resolutionStats;

    // If no file but columnMap is provided, use stored raw rows from DB
    if (!req.file && overrideColumnMap) {
      const stored = await db.prepare(
        'SELECT row_json FROM hw_excel_raw WHERE hw_import_id=? ORDER BY row_index'
      ).all(importId);

      if (stored.length === 0) {
        return err(res, 400, 'No stored Excel data — upload the file first');
      }

      // Parse using the stored raw rows (simulate as if we just read them from Excel)
      const rawExcelRows = stored.map(r => JSON.parse(r.row_json));
      const parseResult = await parseRawExcelRows(rawExcelRows, overrideColumnMap, db);
      rows = parseResult.rows;
      stations = parseResult.stations;
      resolutionStats = parseResult.resolutionStats;
    } else {
      // File uploaded: parse it
      if (!req.file) return err(res, 400, 'No file uploaded');
      const sheetName = req.query.sheet || null;
      const parseResult = await parseHwExcel(req.file.buffer, sheetName, overrideColumnMap, db);
      rows = parseResult.rows;
      stations = parseResult.stations;
      resolutionStats = parseResult.resolutionStats;
    }

    // Build incoming map: key → parsed row
    const CMP_FIELDS = ['station_address','station_name','ip_address','subsystem_no',
                        'slot','module_order_no','module_name','channel','tag','signal_type','description'];

    // Normalize channel for keying: infra rows (no tag, no signal type) always key as 'null'
    // regardless of whether the DB stored them as NULL or 0, to avoid phantom New+Missing pairs.
    function chKey(channel, tag, signalType) {
      if (!tag && !signalType) return 'null';
      return channel ?? 'null';
    }

    const incoming = new Map();
    for (const r of rows) {
      const key = `${r.stationAddr}:${r.slot}:${chKey(r.channel, r.tag, r.signalType)}`;
      incoming.set(key, r);
    }

    // Load current DB signals
    const dbRows = await db.prepare(
      `SELECT station_address, station_name, ip_address, subsystem_no, router_address,
              slot, channel, module_order_no, module_name, tag, description, signal_type
       FROM hw_signals WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'`
    ).all(importId);

    const current = new Map();
    for (const r of dbRows) {
      const key = `${r.station_address}:${r.slot}:${chKey(r.channel, r.tag, r.signal_type)}`;
      current.set(key, r);
    }

    const items = [];
    const summary = { total: 0, new: 0, modified: 0, missing: 0, unchanged: 0 };

    // For infra rows (no tag, no signal type), channel is not meaningful — normalize to null
    // so that channel=0 and channel=null are treated identically in comparison.
    function normChannel(channel, tag, signalType) {
      if (!tag && !signalType) return null;
      return channel ?? null;
    }

    // Classify incoming rows
    for (const [key, inc] of incoming) {
      const cur = current.get(key);
      const isInfraInc = !inc.tag && !inc.signalType;
      const incomingNorm = {
        station_address: inc.stationAddr,
        station_name:    inc.stationName || null,
        ip_address:      inc.ip || null,
        subsystem_no:    inc.subsystemNo ?? null,
        slot:            inc.slot,
        module_order_no: inc.orderNo || null,
        module_name:     inc.moduleName || null,
        channel:         normChannel(inc.channel, inc.tag, inc.signalType),
        tag:             inc.tag || null,
        signal_type:     inc.signalType || null,
        description:     inc.desc || null,
      };

      let status;
      const changes = [];

      if (!cur) {
        status = 'new';
      } else {
        const curNorm = {
          station_address: cur.station_address,
          station_name:    cur.station_name,
          ip_address:      cur.ip_address,
          subsystem_no:    cur.subsystem_no,
          slot:            cur.slot,
          module_order_no: cur.module_order_no,
          module_name:     cur.module_name,
          channel:         normChannel(cur.channel, cur.tag, cur.signal_type),
          tag:             cur.tag,
          signal_type:     cur.signal_type,
          description:     cur.description,
        };
        for (const f of CMP_FIELDS) {
          const cv = curNorm[f] ?? null;
          const iv = incomingNorm[f] ?? null;
          if (String(cv ?? '') !== String(iv ?? '')) {
            changes.push({ property: f, currentValue: cv, importedValue: iv });
          }
        }
        status = changes.length > 0 ? 'modified' : 'unchanged';
      }

      summary[status]++;
      items.push({
        key, status,
        objectName: incomingNorm.tag || incomingNorm.module_name || key,
        changes,
        current:  cur ? { station_address: cur.station_address, station_name: cur.station_name,
                          ip_address: cur.ip_address, subsystem_no: cur.subsystem_no,
                          slot: cur.slot, module_order_no: cur.module_order_no,
                          module_name: cur.module_name, channel: cur.channel,
                          tag: cur.tag, signal_type: cur.signal_type, description: cur.description } : null,
        incoming: incomingNorm,
      });
    }

    // Missing rows — in DB but not in incoming
    for (const [key, cur] of current) {
      if (!incoming.has(key)) {
        summary.missing++;
        items.push({
          key, status: 'missing',
          objectName: cur.tag || cur.module_name || key,
          changes: [],
          current: { station_address: cur.station_address, station_name: cur.station_name,
                     ip_address: cur.ip_address, subsystem_no: cur.subsystem_no,
                     slot: cur.slot, module_order_no: cur.module_order_no,
                     module_name: cur.module_name, channel: cur.channel,
                     tag: cur.tag, signal_type: cur.signal_type, description: cur.description },
          incoming: null,
        });
      }
    }

    summary.total = items.length;

    // Add station-level conflict warnings to each row. Conflicts are computed once at the
    // station level, then each row belonging to a conflicted station gets annotated so
    // the UI can highlight it in red.
    {
      const incomingStations = new Map();
      for (const r of rows) {
        if (r.stationAddr == null) continue;
        if (!incomingStations.has(r.stationAddr)) {
          incomingStations.set(r.stationAddr, { address: r.stationAddr, name: r.stationName, ip: r.ip });
        }
      }
      const existingStations = await loadExistingStations(db, importId);
      const allConflicts = findStationConflicts([...existingStations, ...incomingStations.values()]);

      // Build a map of station address → conflicts affecting it
      const stationConflictMap = new Map();
      for (const conflictMsg of allConflicts) {
        // Match format 1: "Device Name/IP ... is used by stations 1, 2, 3"
        let addrMatches = conflictMsg.match(/stations (.+)$/);
        if (addrMatches) {
          const addrs = addrMatches[1].split(', ').map(a => parseInt(a, 10));
          for (const addr of addrs) {
            if (!stationConflictMap.has(addr)) stationConflictMap.set(addr, []);
            stationConflictMap.get(addr).push(conflictMsg);
          }
          continue;
        }
        // Match format 2: "Device Number X is used by N stations" — lookup all incoming stations
        // to find which ones have that device number
        addrMatches = conflictMsg.match(/^Device Number (\d+)/);
        if (addrMatches) {
          const deviceNum = parseInt(addrMatches[1], 10);
          for (const r of rows) {
            if (r.stationAddr === deviceNum) {
              if (!stationConflictMap.has(deviceNum)) stationConflictMap.set(deviceNum, []);
              stationConflictMap.get(deviceNum).push(conflictMsg);
              break;
            }
          }
        }
      }

      // Annotate each row-item with its station's conflicts
      for (const item of items) {
        const stationAddr = item.incoming?.station_address ?? item.current?.station_address;
        if (stationAddr != null && stationConflictMap.has(stationAddr)) {
          item.stationConflicts = stationConflictMap.get(stationAddr);
        }
      }
    }

    res.json({
      summary,
      items,
      parsedRows: rows,
      fileName: req.file.originalname,
      stationCount: stations.size,
      resolutionStats,
    });
  } catch (e) { err(res, 500, e.message); }
});

// GET /api/hw-config/imports/:id/preview-mapped
// Preview with stored raw rows + user-provided column mapping (no file upload)
// Query params:
//   columnMap=<json> — Column mapping {appField: "excelColumnName", ...}
router.get('/imports/:id/preview-mapped', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    // Parse columnMap from query
    if (!req.query.columnMap) {
      return err(res, 400, 'columnMap query param required');
    }

    let columnMap;
    try {
      columnMap = JSON.parse(req.query.columnMap);
    } catch (e) {
      return err(res, 400, 'Invalid columnMap JSON: ' + e.message);
    }

    // Load stored raw rows from DB
    const stored = await db.prepare(
      'SELECT row_json FROM hw_excel_raw WHERE hw_import_id=? ORDER BY row_index'
    ).all(importId);

    if (stored.length === 0) {
      return err(res, 400, 'No stored Excel data — upload the file first');
    }

    const rawExcelRows = stored.map(r => JSON.parse(r.row_json));
    const { rows, stations, resolutionStats } = await parseRawExcelRows(rawExcelRows, columnMap, db);

    // Build diff against current DB (same logic as preview-iolist)
    const CMP_FIELDS = ['station_address','station_name','ip_address','subsystem_no',
                        'slot','module_order_no','module_name','channel','tag','signal_type','description'];

    function chKey(channel, tag, signalType) {
      if (!tag && !signalType) return 'null';
      return channel ?? 'null';
    }

    const incoming = new Map();
    for (const r of rows) {
      const key = `${r.stationAddr}:${r.slot}:${chKey(r.channel, r.tag, r.signalType)}`;
      incoming.set(key, r);
    }

    const dbRows = await db.prepare(
      `SELECT station_address, station_name, ip_address, subsystem_no, router_address,
              slot, channel, module_order_no, module_name, tag, description, signal_type
       FROM hw_signals WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'`
    ).all(importId);

    const current = new Map();
    for (const r of dbRows) {
      const key = `${r.station_address}:${r.slot}:${chKey(r.channel, r.tag, r.signal_type)}`;
      current.set(key, r);
    }

    const items = [];
    const summary = { total: 0, new: 0, modified: 0, missing: 0, unchanged: 0 };

    // Classify incoming rows
    for (const [key, inc] of incoming) {
      const cur = current.get(key);
      const isInfraInc = !inc.tag && !inc.signalType;
      const incomingNorm = {
        station_address: inc.stationAddr,
        station_name:    inc.stationName || null,
        ip_address:      inc.ip || null,
        subsystem_no:    inc.subsystemNo ?? null,
        slot:            inc.slot,
        module_order_no: inc.orderNo || null,
        module_name:     inc.moduleName || null,
        channel:         chKey(inc.channel, inc.tag, inc.signalType),
        tag:             inc.tag || null,
        signal_type:     inc.signalType || null,
        description:     inc.desc || null,
      };

      let status;
      const changes = [];

      if (!cur) {
        status = 'new';
      } else {
        const curNorm = {
          station_address: cur.station_address,
          station_name:    cur.station_name,
          ip_address:      cur.ip_address,
          subsystem_no:    cur.subsystem_no,
          slot:            cur.slot,
          module_order_no: cur.module_order_no,
          module_name:     cur.module_name,
          channel:         chKey(cur.channel, cur.tag, cur.signal_type),
          tag:             cur.tag,
          signal_type:     cur.signal_type,
          description:     cur.description,
        };
        for (const f of CMP_FIELDS) {
          const cv = curNorm[f] ?? null;
          const iv = incomingNorm[f] ?? null;
          if (String(cv ?? '') !== String(iv ?? '')) {
            changes.push({ property: f, currentValue: cv, importedValue: iv });
          }
        }
        status = changes.length > 0 ? 'modified' : 'unchanged';
      }

      summary[status]++;
      items.push({
        key, status,
        objectName: incomingNorm.tag || incomingNorm.module_name || key,
        changes,
        current:  cur ? { station_address: cur.station_address, station_name: cur.station_name,
                          ip_address: cur.ip_address, subsystem_no: cur.subsystem_no,
                          slot: cur.slot, module_order_no: cur.module_order_no,
                          module_name: cur.module_name, channel: cur.channel,
                          tag: cur.tag, signal_type: cur.signal_type, description: cur.description } : null,
        incoming: incomingNorm,
        resolvedByTier2: !!inc.resolvedByTier2,
        unresolved: !!inc.unresolved,
      });
    }

    // Missing rows — in DB but not in incoming
    for (const [key, cur] of current) {
      if (!incoming.has(key)) {
        summary.missing++;
        items.push({
          key, status: 'missing',
          objectName: cur.tag || cur.module_name || key,
          changes: [],
          current: { station_address: cur.station_address, station_name: cur.station_name,
                     ip_address: cur.ip_address, subsystem_no: cur.subsystem_no,
                     slot: cur.slot, module_order_no: cur.module_order_no,
                     module_name: cur.module_name, channel: cur.channel,
                     tag: cur.tag, signal_type: cur.signal_type, description: cur.description },
          incoming: null,
        });
      }
    }

    summary.total = items.length;

    // Add station-level conflict warnings to each row (same logic as preview-iolist)
    {
      const incomingStations = new Map();
      for (const r of rows) {
        if (r.stationAddr == null) continue;
        if (!incomingStations.has(r.stationAddr)) {
          incomingStations.set(r.stationAddr, { address: r.stationAddr, name: r.stationName, ip: r.ip });
        }
      }
      const existingStations = await loadExistingStations(db, importId);
      const allConflicts = findStationConflicts([...existingStations, ...incomingStations.values()]);

      const stationConflictMap = new Map();
      for (const conflictMsg of allConflicts) {
        // Match format 1: "Device Name/IP ... is used by stations 1, 2, 3"
        let addrMatches = conflictMsg.match(/stations (.+)$/);
        if (addrMatches) {
          const addrs = addrMatches[1].split(', ').map(a => parseInt(a, 10));
          for (const addr of addrs) {
            if (!stationConflictMap.has(addr)) stationConflictMap.set(addr, []);
            stationConflictMap.get(addr).push(conflictMsg);
          }
          continue;
        }
        // Match format 2: "Device Number X is used by N stations" — lookup all incoming stations
        // to find which ones have that device number
        addrMatches = conflictMsg.match(/^Device Number (\d+)/);
        if (addrMatches) {
          const deviceNum = parseInt(addrMatches[1], 10);
          for (const r of rows) {
            if (r.stationAddr === deviceNum) {
              if (!stationConflictMap.has(deviceNum)) stationConflictMap.set(deviceNum, []);
              stationConflictMap.get(deviceNum).push(conflictMsg);
              break;
            }
          }
        }
      }

      for (const item of items) {
        const stationAddr = item.incoming?.station_address ?? item.current?.station_address;
        if (stationAddr != null && stationConflictMap.has(stationAddr)) {
          item.stationConflicts = stationConflictMap.get(stationAddr);
        }
      }
    }

    res.json({
      summary,
      items,
      parsedRows: rows,
      fileName: 'Excel import',
      stationCount: stations.size,
      resolutionStats,
    });
  } catch (e) { err(res, 500, e.message); }
});

// ── Hardware Column Mapping Persistence ──────────────────────────────────────

// GET /api/hw-config/imports/:id/column-mapping
// Load the saved column mapping for this import
router.get('/imports/:id/column-mapping', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT column_map FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    let mapping = {};
    if (hwImport.column_map) {
      try {
        mapping = JSON.parse(hwImport.column_map);
      } catch (e) {
        console.error(`Failed to parse column_map for import ${importId}:`, e);
      }
    }
    res.json({ mapping });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/column-mapping
// Save the column mapping for this import
router.post('/imports/:id/column-mapping', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const { mapping } = req.body;
    if (!mapping) return err(res, 400, 'mapping object required');

    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const mappingJson = JSON.stringify(mapping);
    await db.prepare('UPDATE hw_imports SET column_map=? WHERE id=?')
      .run(mappingJson, importId);

    res.json({ ok: true, mapping });
  } catch (e) { err(res, 500, e.message); }
});

// POST /api/hw-config/imports/:id/apply-iolist  (commit approved changes)
router.post('/imports/:id/apply-iolist', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const { approvedKeys, parsedRows, fileName, missingKeys } = req.body;
    if (!Array.isArray(approvedKeys)) return err(res, 400, 'approvedKeys must be an array');
    if (!Array.isArray(parsedRows))   return err(res, 400, 'parsedRows must be an array');

    const approvedSet = new Set(approvedKeys);
    const missingSet  = new Set(missingKeys || []);

    // Same key normalization as preview route
    function chKey(channel, tag, signalType) {
      if (!tag && !signalType) return 'null';
      return channel ?? 'null';
    }

    // Load current DB signals (need tag + signal_type to normalize key)
    const dbRows = await db.prepare(
      `SELECT station_address, slot, channel, tag, signal_type FROM hw_signals
       WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'`
    ).all(importId);

    // Validate the post-apply station set for uniqueness of address / name / IP.
    // Final stations = existing DB stations (identity from their slot-0 rows) overridden
    // by any approved incoming station of the same address, plus new approved stations.
    // Reject the whole apply on any collision.
    {
      const finalStations = new Map();
      for (const s of await loadExistingStations(db, importId)) {
        finalStations.set(String(s.address), s);
      }
      for (const r of parsedRows) {
        if (r.stationAddr == null) continue;
        const key = `${r.stationAddr}:${r.slot}:${chKey(r.channel, r.tag, r.signalType)}`;
        if (!approvedSet.has(key)) continue;
        // Approved incoming row defines/overrides this station's identity.
        finalStations.set(String(r.stationAddr), { address: r.stationAddr, name: r.stationName, ip: r.ip });
      }
      const conflicts = findStationConflicts([...finalStations.values()]);
      if (conflicts.length) {
        return err(res, 400, 'Duplicate stations: ' + conflicts.join('; '), {
          conflictRows: buildConflictTable([...finalStations.values()]),
        });
      }
    }

    const apply = db.transaction(async () => {
      // Delete approved missing rows
      for (const r of dbRows) {
        const key = `${r.station_address}:${r.slot}:${chKey(r.channel, r.tag, r.signal_type)}`;
        if (missingSet.has(key) && approvedSet.has(key)) {
          await db.prepare(
            `DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel IS NOT DISTINCT FROM ?`
          ).run(importId, r.station_address, r.slot, r.channel ?? null);
        }
      }

      // Upsert approved incoming rows (new + modified)
      const ins = db.prepare(`
        INSERT INTO hw_signals
          (hw_import_id, row_number, station_address, station_name, ip_address,
           slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
           station_mlfb, resolved_by_tier2, unresolved)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      let rowIdx = 0;
      for (const r of parsedRows) {
        const key = `${r.stationAddr}:${r.slot}:${chKey(r.channel, r.tag, r.signalType)}`;
        if (!approvedSet.has(key)) { rowIdx++; continue; }

        // Delete existing row for this key before inserting (upsert)
        await db.prepare(
          `DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel IS NOT DISTINCT FROM ?`
        ).run(importId, r.stationAddr, r.slot, r.channel ?? null);

        await ins.run(importId, r.rowNum ?? rowIdx, r.stationAddr, r.stationName, r.ip,
          r.slot, r.channel ?? null, r.orderNo, r.moduleName, r.tag, r.desc,
          r.signalType, r.subsystemNo ?? null, r.routerAddress || null,
          r.stationMlfb || null,
          !!r.resolvedByTier2, !!r.unresolved);
        rowIdx++;
      }

      if (fileName) {
        await db.prepare('UPDATE hw_imports SET excel_name=?, status=? WHERE id=?')
          .run(fileName, 'ready', importId);
      }
    });

    await apply();

    // Tier 2: Create slot 0 rows for stations with station_mlfb
    // This enables the grid to auto-generate ports (0.2, 0.3) based on the station module's port_config
    const tier2Stations = await db.prepare(`
      SELECT DISTINCT station_address, station_name, ip_address, router_address, subsystem_no, station_mlfb
      FROM hw_signals
      WHERE hw_import_id=? AND resolved_by_tier2=true AND station_mlfb IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hw_signals s2 WHERE s2.hw_import_id=? AND s2.station_address=hw_signals.station_address AND s2.slot=0)
    `).all(importId, importId);

    if (tier2Stations.length > 0) {
      const insSlot0 = db.prepare(`
        INSERT INTO hw_signals
          (hw_import_id, row_number, station_address, station_name, ip_address,
           slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
           station_mlfb, resolved_by_tier2, unresolved)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const s of tier2Stations) {
        await insSlot0.run(
          importId, null, s.station_address, s.station_name, s.ip_address,
          0, null, s.station_mlfb, s.station_name,
          null, null, null, s.subsystem_no, s.router_address,
          s.station_mlfb, true, false
        );
      }
    }

    const signalCount = Number((await db.prepare(
      'SELECT COUNT(*) AS cnt FROM hw_signals WHERE hw_import_id=?'
    ).get(importId)).cnt);
    const stationCount = Number((await db.prepare(
      'SELECT COUNT(DISTINCT station_address) AS cnt FROM hw_signals WHERE hw_import_id=?'
    ).get(importId)).cnt);

    res.json({ importId, stationCount, signalCount, appliedKeys: approvedKeys.length });
  } catch (e) { err(res, 500, e.message); }
});

// ── Station view ──────────────────────────────────────────────────────────────

router.get('/imports/:id/stations', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);

    const signals = await db.prepare(
      `SELECT station_address, MIN(station_name) AS station_name, MIN(ip_address) AS ip_address,
              MIN(router_address) AS router_address, slot, module_order_no,
              MIN(module_name) AS module_name, MIN(subsystem_no) AS subsystem_no,
              MIN(pip_no) AS pip_no, MIN(potential_group) AS potential_group,
              MIN(pa_profile) AS pa_profile, COUNT(*) AS signal_count
       FROM hw_signals
       WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'
       GROUP BY station_address, slot, module_order_no
       ORDER BY station_address, slot`
    ).all(importId);

    const allAddrs = await db.prepare(
      `SELECT station_address, MIN(station_name) AS station_name, MIN(ip_address) AS ip_address,
              MIN(router_address) AS router_address, MIN(subsystem_no) AS subsystem_no,
              BOOL_OR(COALESCE(approved,false)) AS approved
       FROM hw_signals WHERE hw_import_id=? GROUP BY station_address ORDER BY station_address`
    ).all(importId);

    // Load per-subslot profiles
    const subslotRows = await db.prepare(
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
    const tplRows = await db.prepare('SELECT order_no, family, display_name FROM hw_module_templates').all();
    const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

    const slot0Rows = await db.prepare(
      `SELECT station_address, MIN(module_order_no) AS module_order_no FROM hw_signals
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
router.get('/imports/:id/preview-addresses', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id, baseline_cfg FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const signals = await db.prepare(
      `SELECT station_address, station_name, ip_address, router_address, subsystem_no,
              slot, module_order_no, pip_no, pa_profile
       FROM hw_signals
       WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'
       ORDER BY station_address, slot`
    ).all(importId);

    const tplRows    = await db.prepare('SELECT * FROM hw_module_templates').all();
    const templateMap = new Map(tplRows.map(t => [t.order_no, t]));

    // Load per-subslot PA profile assignments
    const subslotRows = await db.prepare(
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
router.post('/imports/:id/stations/bulk-delete', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const { addresses } = req.body;
    if (!Array.isArray(addresses) || addresses.length === 0)
      return err(res, 400, 'addresses array required');

    const del = db.transaction(async () => {
      for (const addr of addresses) {
        const addrInt = parseInt(addr, 10);
        // First delete dependent instance_ios rows that reference these hw_signals
        const hwIds = await db.prepare(
          'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=?'
        ).all(importId, addrInt);
        for (const row of hwIds) {
          await db.prepare('DELETE FROM instance_ios WHERE hw_signal_id=?').run(row.id);
        }
        // Then delete the hw_signals
        await db.prepare('DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=?')
          .run(importId, addrInt);
      }
    });
    await del();
    res.json({ ok: true, deleted: addresses.length });
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/bulk-approve — set approved flag on multiple stations
router.post('/imports/:id/stations/bulk-approve', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const { addresses, approved = true } = req.body;
    if (!Array.isArray(addresses) || addresses.length === 0)
      return err(res, 400, 'addresses array required');

    const upd = db.transaction(async () => {
      for (const addr of addresses) {
        await db.prepare('UPDATE hw_signals SET approved=? WHERE hw_import_id=? AND station_address=?')
          .run(!!approved, importId, parseInt(addr, 10));
      }
    });
    await upd();
    res.json({ ok: true, updated: addresses.length });
  } catch (e) { err(res, 500, e.message); }
});

// GET /api/hw-config/imports/:id/signals?page=0&limit=100
router.get('/imports/:id/signals', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const limit    = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset   = parseInt(req.query.page   || '0',   10) * limit;

    const total   = Number((await db.prepare('SELECT COUNT(*) AS n FROM hw_signals WHERE hw_import_id=?').get(importId)).n);
    const signals = await db.prepare(
      `SELECT * FROM hw_signals WHERE hw_import_id=? ORDER BY station_address, slot, channel, row_number
       LIMIT ? OFFSET ?`
    ).all(importId, limit, offset);

    res.json({ total, signals });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /api/hw-config/imports/:id/stations/:addr — edit station name / ip / subsystemNo
router.patch('/imports/:id/stations/:addr', async (req, res) => {
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

    // Validate device name uniqueness if station_name is being updated
    if (station_name !== undefined && station_name.trim()) {
      const duplicate = await db.prepare(
        'SELECT COUNT(*) AS cnt FROM hw_signals WHERE hw_import_id=? AND station_address != ? AND station_name=?'
      ).get(importId, addr, station_name);
      if (Number(duplicate.cnt) > 0) {
        return err(res, 400, `Device name "${station_name}" already exists. Device names must be unique.`);
      }
    }

    // Validate IP uniqueness if ip_address is being updated
    if (ip_address !== undefined && String(ip_address).trim()) {
      const duplicate = await db.prepare(
        'SELECT COUNT(*) AS cnt FROM hw_signals WHERE hw_import_id=? AND station_address != ? AND ip_address=?'
      ).get(importId, addr, ip_address);
      if (Number(duplicate.cnt) > 0) {
        return err(res, 400, `IP "${ip_address}" already exists. Station IPs must be unique.`);
      }
    }

    vals.push(importId, addr);
    await db.prepare(`UPDATE hw_signals SET ${sets.join(', ')} WHERE hw_import_id=? AND station_address=?`).run(...vals);
    // Invalidate cached generated CFG so next download reflects the updated values
    await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(importId);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /api/hw-config/imports/:id/stations/:addr/slots/:slot — edit module name / order_no
router.patch('/imports/:id/stations/:addr/slots/:slot', async (req, res) => {
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

    // Validate device name uniqueness if module_name is being updated
    if (module_name !== undefined && module_name.trim()) {
      const duplicate = await db.prepare(
        'SELECT COUNT(*) AS cnt FROM hw_signals WHERE hw_import_id=? AND (station_address != ? OR slot != ?) AND module_name=?'
      ).get(importId, addr, slot, module_name);
      if (Number(duplicate.cnt) > 0) {
        return err(res, 400, `Device name "${module_name}" already exists. Device names must be unique.`);
      }
    }

    vals.push(importId, addr, slot);
    await db.prepare(
      `UPDATE hw_signals SET ${sets.join(', ')} WHERE hw_import_id=? AND station_address=? AND slot=?`
    ).run(...vals);
    await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(importId);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/potential-group
router.patch('/imports/:id/stations/:addr/slots/:slot/potential-group', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { potentialGroup } = req.body; // "NEW_GROUP" | "LEFT_MODULE" | null
    const val = potentialGroup === 'NEW_GROUP' || potentialGroup === 'LEFT_MODULE'
      ? potentialGroup : null;
    await db.prepare(
      'UPDATE hw_signals SET potential_group=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/pip — assign PIP to a slot
router.patch('/imports/:id/stations/:addr/slots/:slot/pip', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { pipNo } = req.body; // null = "None / Default OB1", integer = PIP number

    const val = pipNo == null ? null : parseInt(pipNo, 10);
    await db.prepare(
      'UPDATE hw_signals SET pip_no=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/pa-profile — set PA subslot-1 profile for a CFU_PA device slot
router.patch('/imports/:id/stations/:addr/slots/:slot/pa-profile', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { paProfile } = req.body;

    // Validate against catalogue: must be a known subslot template in the same CFU_PA family
    const known = await db.prepare(
      "SELECT order_no FROM hw_module_templates WHERE order_no=? AND hw_category='subslot' AND family='CFU_PA'"
    ).get(paProfile);
    const val = (paProfile && known) ? paProfile : null;
    await db.prepare(
      'UPDATE hw_signals SET pa_profile=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/subslots/:ssNo/pa-profile — set per-subslot PA profile
router.patch('/imports/:id/stations/:addr/slots/:slot/subslots/:ssNo/pa-profile', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const ssNo     = parseInt(req.params.ssNo, 10);
    const { paProfile } = req.body;

    const known = paProfile
      ? await db.prepare("SELECT order_no FROM hw_module_templates WHERE order_no=? AND hw_category='subslot' AND family='CFU_PA'").get(paProfile)
      : null;
    const val = (paProfile && known) ? paProfile : null;

    await db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hw_import_id, station_address, slot, subslot_no) DO UPDATE SET pa_profile=excluded.pa_profile`
    ).run(importId, addr, slot, ssNo, val);

    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Manual station / slot management ─────────────────────────────────────────

// POST /imports/:id/stations — add a station manually
router.post('/imports/:id/stations', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const { address, name, ip, subsystemNo, imOrderNo, imName } = req.body;
    if (address == null) return err(res, 400, 'address required');
    if (!imOrderNo) return err(res, 400, 'imOrderNo (Slot 0 IM type) required');

    const addr = parseInt(address, 10);
    const exists = await db.prepare(
      'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? LIMIT 1'
    ).get(importId, addr);
    if (exists) return err(res, 409, `Station ${addr} already exists`);

    const stationName = name || `Station_${addr}`;
    const subsysNo    = subsystemNo ?? 100;

    // Reject if the new station's address / name / IP collides with an existing station.
    {
      const existingStations = await loadExistingStations(db, importId);
      const conflictStations = [
        ...existingStations,
        { address: addr, name: stationName, ip: ip || null },
      ];
      const conflicts = findStationConflicts(conflictStations);
      if (conflicts.length) {
        return err(res, 400, 'Duplicate stations: ' + conflicts.join('; '), {
          conflictRows: buildConflictTable(conflictStations),
        });
      }
    }

    // Load the auto-slot configuration for this station (keyed by IM order_no).
    // This is completely generic — whatever slots are defined in the config get created,
    // regardless of hardware family (ET200, CFU, Scalance, Festo, etc.)
    const autoSlotConfig = await loadStationAutoSlotConfig(db, imOrderNo);

    const insSignal = db.prepare(`INSERT INTO hw_signals
      (hw_import_id, station_address, station_name, ip_address, slot, module_order_no, module_name, subsystem_no)
      VALUES (?,?,?,?,?,?,?,?)`);

    const insertStation = db.transaction(async () => {
      // Slot 0 = station head — always inserted (holds IP, name, subsystem)
      await insSignal.run(importId, addr, stationName, ip || null, 0, imOrderNo, imName || imOrderNo, subsysNo);

      // Create all additional slots (slot ≥ 1) from the auto-slot config.
      // Slot 0's subslots (ports/interface) are AUTOCREATED at generation time from
      // the config/port_config — they are not stored as separate hw_signals rows.
      if (autoSlotConfig && Array.isArray(autoSlotConfig.slots)) {
        for (const slotCfg of autoSlotConfig.slots) {
          if (slotCfg.slot == null || slotCfg.slot === 0) continue; // skip head; already inserted
          if (!slotCfg.order_no) continue; // no module defined for this slot
          await insSignal.run(
            importId, addr, stationName, ip || null,
            slotCfg.slot, slotCfg.order_no,
            slotCfg.label || slotCfg.order_no, subsysNo
          );
        }
      }
    });
    await insertStation();

    res.status(201).json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/:addr/copy — duplicate a station with next address + incremented IP
router.post('/imports/:id/stations/:addr/copy', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const srcAddr  = parseInt(req.params.addr, 10);

    const srcRows = await db.prepare(
      'SELECT * FROM hw_signals WHERE hw_import_id=? AND station_address=? ORDER BY slot, channel, row_number'
    ).all(importId, srcAddr);
    if (srcRows.length === 0) return err(res, 404, `Station ${srcAddr} not found`);

    // Next address = max used address + 1
    const maxRow = await db.prepare('SELECT MAX(station_address) AS m FROM hw_signals WHERE hw_import_id=?').get(importId);
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

    if (await db.prepare('SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? LIMIT 1').get(importId, newAddr)) {
      return err(res, 409, `Station ${newAddr} already exists`);
    }

    // The copy reuses the source Device Name verbatim, which violates the per-import
    // uniqueness rule (name must be unique). Reject with a clear message so the user
    // renames the copy instead of silently creating a duplicate.
    {
      const existingStations = await loadExistingStations(db, importId);
      const conflicts = findStationConflicts([
        ...existingStations,
        { address: newAddr, name: srcRows[0].station_name, ip: newIp || null },
      ]);
      if (conflicts.length) {
        return err(res, 400, 'Cannot copy — duplicate stations: ' + conflicts.join('; ')
          + '. Rename the source or edit the copy afterwards.');
      }
    }

    const ins = db.prepare(`INSERT INTO hw_signals
      (hw_import_id, row_number, station_address, station_name, ip_address,
       slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address, potential_group)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const srcSubslots = await db.prepare(
      'SELECT slot, subslot_no, pa_profile FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=?'
    ).all(importId, srcAddr);

    const insSubslot = db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO NOTHING`
    );

    const copy = db.transaction(async () => {
      for (const r of srcRows) {
        await ins.run(
          importId, r.row_number, newAddr, r.station_name, newIp,
          r.slot, r.channel, r.module_order_no, r.module_name,
          r.tag, r.description, r.signal_type, r.subsystem_no, r.router_address, r.potential_group ?? null
        );
      }
      for (const r of srcSubslots) {
        await insSubslot.run(importId, newAddr, r.slot, r.subslot_no, r.pa_profile);
      }
    });
    await copy();

    res.status(201).json({ ok: true, newAddress: newAddr, newIp });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /imports/:id/stations/:addr — remove a station and all its signals
router.delete('/imports/:id/stations/:addr', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);

    const del = db.transaction(async () => {
      // First delete dependent instance_ios rows that reference these hw_signals
      const hwIds = await db.prepare(
        'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=?'
      ).all(importId, addr);
      for (const row of hwIds) {
        await db.prepare('DELETE FROM instance_ios WHERE hw_signal_id=?').run(row.id);
      }
      // Then delete the hw_signals and subslots
      await db.prepare('DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=?').run(importId, addr);
      await db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=?').run(importId, addr);
    });
    await del();
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// POST /imports/:id/stations/:addr/slots — add a slot manually
router.post('/imports/:id/stations/:addr/slots', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const { slot, moduleOrderNo, moduleName } = req.body;
    if (slot == null || !moduleOrderNo) return err(res, 400, 'slot and moduleOrderNo required');

    const slotNo = parseInt(slot, 10);

    // CFU_PA: slots 0-2 are reserved system slots — only allow user slots ≥3
    const imRow = await db.prepare('SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1').get(importId, addr);
    if (imRow) {
      const imTpl = await db.prepare('SELECT family FROM hw_module_templates WHERE order_no=?').get(imRow.module_order_no);
      if (imTpl && imTpl.family === 'CFU_PA' && slotNo < 3) {
        return err(res, 400, 'CFU_PA: Slots 0, 1, and 2 are reserved system slots. Add from Slot 3 onwards.');
      }
    }

    // Carry station-level info from existing rows for this station
    const head = await db.prepare(
      'SELECT station_name, ip_address, subsystem_no, router_address FROM hw_signals WHERE hw_import_id=? AND station_address=? LIMIT 1'
    ).get(importId, addr);

    // Auto-default POTENTIAL_GROUP for ET200SP I/O slots (slot > 0).
    // Rule: if the slot immediately to the left (slotNo-1) has the same order_no,
    // default to LEFT_MODULE; otherwise NEW_GROUP.
    const slot0 = await db.prepare('SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1')
          .get(importId, addr);
    const headTpl = await db.prepare('SELECT family FROM hw_module_templates WHERE order_no=?')
      .get(slot0?.module_order_no || '');
    const stationFamily = headTpl ? headTpl.family : null;
    let defaultPotentialGroup = null;
    if (stationFamily && stationFamily.startsWith('ET200') && slotNo > 0) {
      const tplForNew = await db.prepare('SELECT param_template FROM hw_module_templates WHERE order_no=?').get(moduleOrderNo);
      const hasPotentialGroup = tplForNew
        ? (tplForNew.param_template || '').includes('POTENTIAL_GROUP')
        : true; // unknown modules get the default applied
      if (hasPotentialGroup) {
        const leftSlot = await db.prepare(
          'SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1'
        ).get(importId, addr, slotNo - 1);
        defaultPotentialGroup = (leftSlot && leftSlot.module_order_no === moduleOrderNo)
          ? 'LEFT_MODULE'
          : 'NEW_GROUP';
      }
    }

    await db.prepare(`INSERT INTO hw_signals
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

// DELETE /imports/:id/stations/:addr/slots/:slot — remove one slot and renumber remaining
router.delete('/imports/:id/stations/:addr/slots/:slot', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);

    await db.transaction(async () => {
      // First delete dependent instance_ios rows that reference these hw_signals
      const hwIds = await db.prepare(
        'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=?'
      ).all(importId, addr, slot);
      for (const row of hwIds) {
        await db.prepare('DELETE FROM instance_ios WHERE hw_signal_id=?').run(row.id);
      }
      // Then delete the hw_signals and subslots
      await db.prepare('DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=?').run(importId, addr, slot);
      await db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=? AND slot=?').run(importId, addr, slot);

      // Renumber remaining user slots to be contiguous.
      // CFU_PA reserves slots 0-2 (head + DIQ8 + PA Master); all others start user slots at 1.
      const imRow = await db.prepare(
        'SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1'
      ).get(importId, addr);
      const imTpl = imRow
        ? await db.prepare('SELECT family FROM hw_module_templates WHERE order_no=?').get(imRow.module_order_no)
        : null;
      const firstUser = (imTpl && imTpl.family === 'CFU_PA') ? 3 : 1;

      // Distinct user slot numbers still present, sorted ascending
      const userSlotRows = await db.prepare(
        'SELECT DISTINCT slot FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot>=? ORDER BY slot'
      ).all(importId, addr, firstUser);
      const userSlots = userSlotRows.map(r => r.slot);

      if (userSlots.length === 0) return;
      const isContiguous = userSlots.every((s, i) => s === firstUser + i);
      if (isContiguous) return;

      // Two-pass renumber through temporary negative slots to avoid unique-key conflicts.
      for (let i = userSlots.length - 1; i >= 0; i--) {
        const tmp = -(i + 1);
        await db.prepare('UPDATE hw_signals SET slot=? WHERE hw_import_id=? AND station_address=? AND slot=?').run(tmp, importId, addr, userSlots[i]);
        await db.prepare('UPDATE hw_slot_subslots SET slot=? WHERE hw_import_id=? AND station_address=? AND slot=?').run(tmp, importId, addr, userSlots[i]);
      }
      for (let i = 0; i < userSlots.length; i++) {
        const tmp    = -(i + 1);
        const newSlot = firstUser + i;
        await db.prepare('UPDATE hw_signals SET slot=? WHERE hw_import_id=? AND station_address=? AND slot=?').run(newSlot, importId, addr, tmp);
        await db.prepare('UPDATE hw_slot_subslots SET slot=? WHERE hw_import_id=? AND station_address=? AND slot=?').run(newSlot, importId, addr, tmp);
      }
    })();

    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Per-slot channel signal assignment ───────────────────────────────────────

// GET /imports/:id/stations/:addr/slots/:slot/channels
// Returns one row per channel (0-indexed), creating missing rows up to channel_count from template.
router.get('/imports/:id/stations/:addr/slots/:slot/channels', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);

    const existing = await db.prepare(
      `SELECT id, channel, tag, description, signal_type
       FROM hw_signals
       WHERE hw_import_id=? AND station_address=? AND slot=?
       ORDER BY channel`
    ).all(importId, addr, slot);

    // Get channel_count from template for this slot
    const slotMeta = await db.prepare(
      `SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1`
    ).get(importId, addr, slot);

    let channelCount = existing.length;
    let slotSignalType = null;
    if (slotMeta && slotMeta.module_order_no) {
      const tpl = await db.prepare('SELECT channel_count, signal_type FROM hw_module_templates WHERE order_no=?').get(slotMeta.module_order_no);
      console.log(`[Channels] slot=${slot} order_no="${slotMeta.module_order_no}" found_template=${!!tpl} channel_count=${tpl?.channel_count || 'N/A'}`);
      if (tpl && tpl.channel_count > 0) channelCount = tpl.channel_count;
      if (tpl) slotSignalType = tpl.signal_type;
    } else {
      console.log(`[Channels] slot=${slot} no slotMeta or module_order_no is null`);
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
router.patch('/imports/:id/stations/:addr/slots/:slot/channels/:ch', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const ch       = parseInt(req.params.ch,   10);
    const { tag, description, signal_type } = req.body;

    const existing = await db.prepare(
      'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel=?'
    ).get(importId, addr, slot, ch);

    if (existing) {
      const sets = [], vals = [];
      if (tag         !== undefined) { sets.push('tag=?');         vals.push(tag); }
      if (description !== undefined) { sets.push('description=?'); vals.push(description); }
      if (signal_type !== undefined) { sets.push('signal_type=?'); vals.push(signal_type); }
      if (sets.length) {
        vals.push(existing.id);
        await db.prepare(`UPDATE hw_signals SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      }
    } else {
      // Row doesn't exist yet — pull station/slot metadata for required FK fields
      const head = await db.prepare(
        `SELECT station_name, ip_address, module_order_no, module_name, subsystem_no, router_address
         FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1`
      ).get(importId, addr, slot);
      await db.prepare(`INSERT INTO hw_signals
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
    const hwImport = await db.prepare('SELECT * FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport)           return err(res, 404, 'HW import not found');
    if (!hwImport.baseline_cfg) return err(res, 400, 'No baseline CFG uploaded');

    const tplRows    = await db.prepare('SELECT * FROM hw_module_templates').all();
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
      signalQuery += ' AND COALESCE(approved,false)=true';
    }
    signalQuery += ' ORDER BY station_address, slot, channel, row_number';

    const signals = await db.prepare(signalQuery).all(...queryParams);
    if (signals.length === 0) return err(res, 400, 'No signals or modules configured — add modules in Configuration');

    // Load per-subslot profiles for all stations in this import
    const subslotRows = await db.prepare(
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
          mlfb:           sig.station_mlfb || null,
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

    const { cfg: cfgText, warnings } = await generateCfg(parsedBaseline, stations, templateMap, db);

    let moduleCount = 0;
    for (const st of stations.values()) moduleCount += st.slots.size;
    // Persist warnings in stats so they survive a reload of the generated CFG list.
    const stats = JSON.stringify({ stations: stations.size, modules: moduleCount, signals: signals.length, warnings });

    await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(importId);
    const r = await db.prepare(
      'INSERT INTO hw_generated_cfgs (hw_import_id, cfg_text, stats) VALUES (?,?,?)'
    ).run(importId, cfgText, stats);
    await db.prepare('UPDATE hw_imports SET status=? WHERE id=?').run('generated', importId);

    res.json({ cfgId: r.lastInsertRowid, stats: JSON.parse(stats), warnings, previewLines: cfgText.split('\n').slice(0, 30) });
  } catch (e) { err(res, 500, e.message); }
});

router.get('/imports/:id/cfgs', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const rows = await db.prepare(
      'SELECT id, stats, generated_at FROM hw_generated_cfgs WHERE hw_import_id=? ORDER BY id DESC'
    ).all(importId);
    res.json(rows.map(r => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null })));
  } catch (e) { err(res, 500, e.message); }
});

router.get('/imports/:id/cfgs/:cfgId/download', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const cfgId    = parseInt(req.params.cfgId, 10);
    const row      = await db.prepare(`
      SELECT cfg.cfg_text, ctrl.T16_Controller_TagName
      FROM hw_generated_cfgs cfg
      JOIN hw_imports imp ON imp.id = cfg.hw_import_id
      LEFT JOIN hw_controllers ctrl ON ctrl.project_id = imp.project_id
      WHERE cfg.id = ?`).get(cfgId);
    if (!row) return err(res, 404, 'CFG not found');

    const tagName = row.T16_Controller_TagName || 'HW_Config';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tagName}.cfg"`);
    res.send(row.cfg_text);
  } catch (e) { err(res, 500, e.message); }
});

// ── Slot ↔ Subslot compatibility ─────────────────────────────────────────────

// GET /slot-compat
// Returns all rows: [{ id, slot_order_no, subslot_order_no, is_default }]
router.get('/slot-compat', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare('SELECT id, slot_order_no, subslot_order_no, is_default FROM hw_slot_subslot_compat ORDER BY slot_order_no, subslot_order_no').all();
    res.json(rows);
  } catch (e) { err(res, 500, e.message); }
});

// POST /slot-compat
// Body: { slot_order_no, subslot_order_no, is_default? }
router.post('/slot-compat', async (req, res) => {
  try {
    const db = getDb();
    const { slot_order_no, subslot_order_no, is_default = 0 } = req.body;
    if (!slot_order_no || !subslot_order_no) return err(res, 400, 'slot_order_no and subslot_order_no required');
    const r = await db.prepare(
      'INSERT INTO hw_slot_subslot_compat (slot_order_no, subslot_order_no, is_default) VALUES (?,?,?) ON CONFLICT (slot_order_no, subslot_order_no) DO NOTHING'
    ).run(slot_order_no, subslot_order_no, !!is_default);
    res.status(201).json({ id: r.lastInsertRowid, inserted: r.rowCount > 0 });
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /slot-compat
// Body: { slot_order_no, subslot_order_no }
router.delete('/slot-compat', async (req, res) => {
  try {
    const db = getDb();
    const { slot_order_no, subslot_order_no } = req.body;
    if (!slot_order_no || !subslot_order_no) return err(res, 400, 'slot_order_no and subslot_order_no required');
    await db.prepare('DELETE FROM hw_slot_subslot_compat WHERE slot_order_no=? AND subslot_order_no=?')
      .run(slot_order_no, subslot_order_no);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── Station Auto-Slot Configuration ───────────────────────────────────────────

// Infer each slot/subslot's `type` from the catalogue + structural position, so the
// UI never has to expose a "type" field. The generator relies on subslot.type==='port'
// to emit PORT blocks; everything else is descriptive.
async function inferAutoSlotTypes(db, config) {
  if (!config || !Array.isArray(config.slots)) return config;

  const tplRows = await db.prepare('SELECT order_no, hw_category, signal_type, display_name FROM hw_module_templates').all();
  const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

  // A subslot is a network port if the catalogue marks it INFRA/port-ish, its order_no
  // matches a known PN port MLFB, or it already carries a port_label.
  const isPort = (ss) => {
    const tpl = tplMap.get(ss.order_no);
    const on  = (ss.order_no || '').toUpperCase();
    if (ss.port_label) return true;
    if (/6AR00|193-6AR|PORT/.test(on)) return true;
    if (tpl && /port/i.test(tpl.display_name || '')) return true;
    return false;
  };

  for (const slot of config.slots) {
    const slotTpl = tplMap.get(slot.order_no);
    slot.type = slotTpl?.hw_category === 'station' ? 'interface' : (slotTpl?.hw_category || slot.type || '');
    if (Array.isArray(slot.subslots)) {
      for (const ss of slot.subslots) {
        ss.type = isPort(ss) ? 'port' : (tplMap.get(ss.order_no)?.hw_category || ss.type || 'submodule');
      }
    }
  }
  return config;
}

// GET /station-auto-slots — List all stations + their auto-slot configs (by order_no)
router.get('/station-auto-slots', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(
      'SELECT order_no, auto_slots_config, created_at, updated_at FROM hw_station_auto_slots ORDER BY order_no'
    ).all();

    const stations = rows.map(r => ({
      order_no: r.order_no,
      config: JSON.parse(r.auto_slots_config),
      created_at: r.created_at,
      updated_at: r.updated_at
    }));

    res.json(stations);
  } catch (e) { err(res, 500, e.message); }
});

// GET /station-auto-slots/:orderNo — Get config for a specific station (by order_no)
// If config doesn't exist, return an empty template with default rules instead of 404.
// This allows users to create configurations for new station order numbers.
router.get('/station-auto-slots/:orderNo', async (req, res) => {
  try {
    const db = getDb();
    const orderNo = (req.params.orderNo || '').trim();
    if (!orderNo) return err(res, 400, 'orderNo parameter required');

    const row = await db.prepare(
      'SELECT order_no, auto_slots_config, created_at, updated_at FROM hw_station_auto_slots WHERE order_no=?'
    ).get(orderNo);

    // If no existing config, return an empty template with default rules
    // Default rules: ET200* enables server module, CFU_PA disables it
    if (!row) {
      const defaultRules = {};
      if (/^6ES7 1[3589]\d-6/.test(orderNo) || /ET200SP/.test(orderNo)) {
        // ET200SP family — enable server module by default
        defaultRules.server_module_enabled = true;
      } else if (/^V.*:6ES7 655-5PX11|CFU_PA/.test(orderNo)) {
        // CFU_PA family — disable server module
        defaultRules.server_module_enabled = false;
      }
      return res.json({
        order_no: orderNo,
        config: { slots: [], rules: defaultRules },
        created_at: null,
        updated_at: null,
        isNew: true
      });
    }

    res.json({
      order_no: row.order_no,
      config: JSON.parse(row.auto_slots_config),
      created_at: row.created_at,
      updated_at: row.updated_at,
      isNew: false
    });
  } catch (e) { err(res, 500, e.message); }
});

// POST /station-auto-slots — Create or update auto-slot config for a station
// Body: { order_no, config: {...} }
router.post('/station-auto-slots', async (req, res) => {
  try {
    const db = getDb();
    const { order_no, config } = req.body;

    if (!order_no || !order_no.trim()) {
      return err(res, 400, 'order_no is required');
    }

    if (!config || typeof config !== 'object') {
      return err(res, 400, 'config must be a valid JSON object');
    }

    // Infer slot/subslot types from the catalogue so the UI never needs a type field
    await inferAutoSlotTypes(db, config);

    // Validate JSON-serializability
    let configJson;
    try {
      configJson = JSON.stringify(config);
    } catch (e) {
      return err(res, 400, `Invalid config JSON: ${e.message}`);
    }

    const existing = await db.prepare('SELECT id FROM hw_station_auto_slots WHERE order_no=?').get(order_no.trim());

    if (existing) {
      await db.prepare(
        'UPDATE hw_station_auto_slots SET auto_slots_config=?, updated_at=NOW() WHERE order_no=?'
      ).run(configJson, order_no.trim());
      return res.json({ ok: true, action: 'updated', order_no: order_no.trim() });
    } else {
      const r = await db.prepare(
        'INSERT INTO hw_station_auto_slots (order_no, auto_slots_config) VALUES (?, ?)'
      ).run(order_no.trim(), configJson);
      return res.status(201).json({ ok: true, action: 'created', order_no: order_no.trim(), id: r.lastInsertRowid });
    }
  } catch (e) { err(res, 500, e.message); }
});

// PUT /station-auto-slots/:orderNo — Update auto-slot config (full replace)
// If config doesn't exist, creates a new one. This allows users to save
// configurations for any station order_no, not just pre-seeded ones.
// Body: config JSON object
router.put('/station-auto-slots/:orderNo', async (req, res) => {
  try {
    const db = getDb();
    const orderNo = (req.params.orderNo || '').trim();
    const config = req.body;

    if (!orderNo) return err(res, 400, 'orderNo parameter required');
    if (!config || typeof config !== 'object') {
      return err(res, 400, 'Request body must be a valid JSON object');
    }

    // Infer slot/subslot types from the catalogue so the UI never needs a type field
    await inferAutoSlotTypes(db, config);

    // Validate JSON-serializability
    let configJson;
    try {
      configJson = JSON.stringify(config);
    } catch (e) {
      return err(res, 400, `Invalid JSON: ${e.message}`);
    }

    const existing = await db.prepare('SELECT id FROM hw_station_auto_slots WHERE order_no=?').get(orderNo);

    if (existing) {
      // Update existing config
      await db.prepare(
        'UPDATE hw_station_auto_slots SET auto_slots_config=?, updated_at=NOW() WHERE order_no=?'
      ).run(configJson, orderNo);
      res.json({ ok: true, action: 'updated', order_no: orderNo });
    } else {
      // Create new config if it doesn't exist
      const r = await db.prepare(
        'INSERT INTO hw_station_auto_slots (order_no, auto_slots_config) VALUES (?, ?)'
      ).run(orderNo, configJson);
      res.status(201).json({ ok: true, action: 'created', order_no: orderNo, id: r.lastInsertRowid });
    }
  } catch (e) { err(res, 500, e.message); }
});

// DELETE /station-auto-slots/:orderNo — Delete auto-slot config for a station
router.delete('/station-auto-slots/:orderNo', async (req, res) => {
  try {
    const db = getDb();
    const orderNo = (req.params.orderNo || '').trim();

    if (!orderNo) return err(res, 400, 'orderNo parameter required');

    const existing = await db.prepare('SELECT id FROM hw_station_auto_slots WHERE order_no=?').get(orderNo);

    if (!existing) {
      return err(res, 404, `No auto-slot config found for station order_no "${orderNo}"`);
    }

    await db.prepare('DELETE FROM hw_station_auto_slots WHERE order_no=?').run(orderNo);

    res.json({ ok: true, deleted: orderNo });
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
