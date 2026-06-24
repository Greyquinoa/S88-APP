// src/routes/mrpConfig.js — MRP ring configuration endpoints
// Completely separate from existing hw-config routes; no shared state.
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb } = require('../db');
const { parseCfg } = require('../services/cfgParser');
const { extractMrpDevices, parseMrpConfig } = require('../services/mrpCfgParser');
const { applyMrp } = require('../services/mrpApplier');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// ── GET /api/mrp/:importId/devices ───────────────────────────────────────────
// Return all PN-IO capable devices extracted from the baseline CFG of this import.
// Each device includes its alias, ioAddress (or rackSlot for CPU), ifaceSubslot,
// and the list of port subslots it exposes.
router.get('/:importId/devices', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.importId, 10);
    const hwImport = db.prepare('SELECT baseline_cfg, baseline_info FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const generated = db.prepare(
      'SELECT cfg_text FROM hw_generated_cfgs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1'
    ).get(importId);
    const sourceCfg = generated?.cfg_text || hwImport.baseline_cfg;
    if (!sourceCfg) return err(res, 400, 'No CFG available — upload a baseline or generate from HW Config first');

    const parsed    = parseCfg(sourceCfg);
    const extracted = extractMrpDevices(sourceCfg, parsed);

    res.json(extracted);
  } catch (e) { err(res, 500, e.message); }
});

// ── GET /api/mrp/:importId/config ────────────────────────────────────────────
// Load saved MRP config (domain, fieldbus, device roles, port links).
router.get('/:importId/config', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.importId, 10);
    const config   = db.prepare('SELECT * FROM mrp_configs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1').get(importId);
    if (!config) return res.json(null);

    const roles = db.prepare('SELECT * FROM mrp_device_roles WHERE mrp_config_id=?').all(config.id);
    const links = db.prepare('SELECT * FROM mrp_port_links WHERE mrp_config_id=?').all(config.id);
    res.json({ ...config, roles, links });
  } catch (e) { err(res, 500, e.message); }
});

// ── POST /api/mrp/:importId/config ───────────────────────────────────────────
// Save (upsert) MRP config: domain name, fieldbus, device roles, port links.
// Body: { domainName, fieldbusNo, stationName, roles: [{deviceAlias, mrpRole, mrpInstances}], links: [{...}] }
router.post('/:importId/config', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.importId, 10);
    const hwImport = db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const { domainName = 'mrpdomain-1', fieldbusNo, stationName, roles = [], links = [] } = req.body;
    if (fieldbusNo == null) return err(res, 400, 'fieldbusNo required');

    const save = db.transaction(() => {
      // Upsert mrp_configs
      const existing = db.prepare('SELECT id FROM mrp_configs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1').get(importId);
      let configId;
      if (existing) {
        db.prepare(`UPDATE mrp_configs SET domain_name=?, fieldbus_no=?, station_name=?, updated_at=datetime('now') WHERE id=?`)
          .run(domainName, fieldbusNo, stationName || '', existing.id);
        configId = existing.id;
      } else {
        const r = db.prepare(
          'INSERT INTO mrp_configs (hw_import_id, domain_name, fieldbus_no, station_name) VALUES (?,?,?,?)'
        ).run(importId, domainName, fieldbusNo, stationName || '');
        configId = r.lastInsertRowid;
      }

      // Replace roles
      db.prepare('DELETE FROM mrp_device_roles WHERE mrp_config_id=?').run(configId);
      const insRole = db.prepare(
        'INSERT INTO mrp_device_roles (mrp_config_id, device_alias, io_address, subsystem_no, mrp_role, mrp_instances, ring_port_1, ring_port_2) VALUES (?,?,?,?,?,?,?,?)'
      );
      for (const r of roles) {
        insRole.run(configId, r.deviceAlias, r.ioAddress ?? null, r.subsystemNo ?? null, r.mrpRole ?? 0, r.mrpInstances ?? 0, r.ringPort1 ?? null, r.ringPort2 ?? null);
      }

      // Replace links
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

      return configId;
    });

    const configId = save();
    res.json({ ok: true, configId });
  } catch (e) { err(res, 500, e.message); }
});

// ── POST /api/mrp/:importId/apply ────────────────────────────────────────────
// Apply saved MRP config to the baseline CFG and return the patched file for download.
router.post('/:importId/apply', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.importId, 10);
    const hwImport = db.prepare('SELECT baseline_cfg FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    // Prefer the generated CFG (which includes all wizard-added IO devices)
    // over the raw baseline, which may only contain the CPU rack.
    const generated = db.prepare(
      'SELECT cfg_text FROM hw_generated_cfgs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1'
    ).get(importId);
    const sourceCfg = generated?.cfg_text || hwImport.baseline_cfg;
    if (!sourceCfg) return err(res, 400, 'No CFG available — upload a baseline or generate from HW Config first');

    const config = db.prepare('SELECT * FROM mrp_configs WHERE hw_import_id=? ORDER BY id DESC LIMIT 1').get(importId);
    if (!config) return err(res, 400, 'No MRP config saved — configure MRP first');

    const roles = db.prepare('SELECT * FROM mrp_device_roles WHERE mrp_config_id=?').all(config.id);
    const links = db.prepare('SELECT * FROM mrp_port_links WHERE mrp_config_id=?').all(config.id);

    // Extract device structure from the source CFG (generated or baseline)
    const parsed    = parseCfg(sourceCfg);
    const extracted = extractMrpDevices(sourceCfg, parsed);

    // Strip sub-row suffix (#N) so switch sub-rings resolve to their real CFG alias.
    // For the interface-level role, use the first sub-ring that has a non-zero role.
    const roleMap = new Map();
    for (const r of roles) {
      const realAlias = r.device_alias.replace(/#\d+$/, '');
      if (!roleMap.has(realAlias) || roleMap.get(realAlias).mrp_role === 0) {
        roleMap.set(realAlias, r);
      }
    }

    // Quick alias → device record lookup for resolving the correct middle number in LINKED_PORT.
    // Format is "STATION\alias.slotOrIface.portSubslot":
    //   - rack-mounted CPU: middle = rackSlot (e.g. 3)
    //   - IO device:        middle = ifaceSubslot (always 1 in generated CFGs)
    const extractedByAlias = new Map(extracted.devices.map(d => [d.alias, d]));

    // Build port link lookup: fromDevice+portSubslot → { toDevice, toIfaceSubslot, toPortSubslot }
    const linkMap = new Map();
    for (const l of links) {
      const realFrom = l.from_device.replace(/#\d+$/, '');
      const realTo   = l.to_device.replace(/#\d+$/, '');
      const toDev    = extractedByAlias.get(realTo);
      // Use rackSlot for CPU devices, ifaceSubslot for IO devices
      const toSlot   = toDev
        ? (toDev.rackSlot != null ? toDev.rackSlot : (toDev.ifaceSubslot ?? l.to_iface_subslot))
        : l.to_iface_subslot;
      linkMap.set(`${realFrom}:${l.from_port_subslot}`, {
        toDevice:       realTo,
        toIfaceSubslot: toSlot,
        toPortSubslot:  l.to_port_subslot,
      });
    }

    const devicesForApplier = extracted.devices.map(dev => {
      // Match by io_address (for IO devices) or subsystem_no (for CPU), falling back to alias
      let role = null;
      if (dev.ioAddress != null) {
        role = roles.find(r => r.io_address === dev.ioAddress);
      } else if (dev.subsystemNo != null) {
        role = roles.find(r => r.subsystem_no === dev.subsystemNo);
      }
      if (!role) role = roleMap.get(dev.alias);
      if (!role || role.mrp_role === 0) return null;

      return {
        alias:        dev.alias,
        ioAddress:    dev.ioAddress,
        rackSlot:     dev.rackSlot,
        ifaceSubslot: dev.ifaceSubslot,
        role:         role.mrp_role,
        isSwitch:     dev.isSwitch,
        ringPorts:    (dev.ports || []).map(p => {
          const link = linkMap.get(`${dev.alias}:${p.subslot}`);
          if (!link) return null;
          return {
            portSubslot:        p.subslot,
            linkedDevice:       link.toDevice,
            linkedIfaceSubslot: link.toIfaceSubslot,
            linkedPortSubslot:  link.toPortSubslot,
          };
        }).filter(Boolean),
      };
    }).filter(Boolean);

    const mrpConfig = {
      domainName:  config.domain_name,
      stationName: config.station_name || parsed.stationName,
      devices:     devicesForApplier,
    };

    const patched = applyMrp(sourceCfg, mrpConfig);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${mrpConfig.stationName}_mrp.cfg"`);
    res.send(patched);
  } catch (e) { err(res, 500, e.message); }
});

// ── POST /api/mrp/:importId/import-from-cfg ───────────────────────────────────
// Accept a configured CFG file, parse MRP roles + port links from it,
// and save them as the MRP config for this import (same as POST /config).
router.post('/:importId/import-from-cfg', upload.single('cfg'), (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No CFG file uploaded');
    const db       = getDb();
    const importId = parseInt(req.params.importId, 10);
    const hwImport = db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    const cfgText = req.file.buffer.toString('utf8');
    const parsed  = parseCfg(cfgText);
    const { domainName, stationName, roles, links } = parseMrpConfig(cfgText, parsed);

    console.log(`[MRP Import] Parsed ${roles.length} devices from CFG:`);
    for (const r of roles) {
      console.log(`  - ${r.alias}: role=${r.mrpRole}, ringPort1=${r.ringPort1}, ringPort2=${r.ringPort2}`);
    }

    // Require at least one participating device
    const activeRoles = roles.filter(r => r.mrpRole !== 0);
    if (activeRoles.length === 0) {
      return err(res, 400, 'No MRP-configured devices found in CFG (all roles are 0 / Off)');
    }

    // Infer fieldbusNo from the first active device that has a subsystemNo
    const fieldbusNo = activeRoles.find(r => r.subsystemNo != null)?.subsystemNo ?? null;

    const save = db.transaction(() => {
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
        const r = db.prepare(
          'INSERT INTO mrp_configs (hw_import_id, domain_name, fieldbus_no, station_name) VALUES (?,?,?,?)'
        ).run(importId, domainName, fieldbusNo, stationName || '');
        configId = r.lastInsertRowid;
      }

      db.prepare('DELETE FROM mrp_device_roles WHERE mrp_config_id=?').run(configId);
      const insRole = db.prepare(
        'INSERT INTO mrp_device_roles (mrp_config_id, device_alias, io_address, subsystem_no, mrp_role, mrp_instances, ring_port_1, ring_port_2) VALUES (?,?,?,?,?,?,?,?)'
      );
      for (const r of roles) {
        insRole.run(configId, r.alias, r.ioAddress, r.subsystemNo,
          r.mrpRole, r.mrpRole === 3 ? 1 : 0, r.ringPort1 ?? null, r.ringPort2 ?? null);
        console.log(`[MRP Import] Saved role: alias=${r.alias}, ring_port_1=${r.ringPort1}, ring_port_2=${r.ringPort2}`);
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

      return configId;
    });

    const configId = save();
    res.json({
      ok: true,
      configId,
      domainName,
      stationName,
      devices:  roles.length,
      active:   activeRoles.length,
      links:    links.length,
    });
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
