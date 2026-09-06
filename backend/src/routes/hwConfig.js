// src/routes/hwConfig.js — HW Engineering Extension endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const ExcelJS = require('exceljs');
const { getDb } = require('../db');
const { parseCfg, parseCfgDevices } = require('../services/cfgParser');
const { parseHwExcel, parseRawExcelRows, suggestColumnMappingByLevenshtein }  = require('../services/hwExcelParser');
const { allocateAddresses, findTemplate, defaultIdentifiers } = require('../services/hwAddressEngine');
const { buildAllocatedStations } = require('../services/slotAddressMap');
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

// ── Generic default-tree helpers (hw_default_children) ───────────────────────
// Family-free: driven entirely by parent_order_no/position rows captured from
// catalogue CFGs (via cfgCatalogueParser + bulk-upsert auto-seed, or the
// station-auto-slots CRUD below). Same lookup at every depth: station head
// order_no → slot rows; a slot's own order_no → its subslot rows.

// First slot number a user may add for this station head order_no — one past
// the highest is_autocreated (fixed/shipped) slot position. Generic replacement
// for any hardcoded "reserved slots" constant.
async function firstAddableSlot(db, headOrderNo) {
  if (!headOrderNo) return 1;
  const rows = await db.prepare(
    `SELECT position FROM hw_default_children WHERE parent_order_no=? AND position_kind='slot' AND is_autocreated=TRUE`
  ).all(headOrderNo);
  if (!rows.length) return 1;
  return Math.max(...rows.map(r => r.position)) + 1;
}

// Materialize a station head's default slot/subslot tree into hw_slot_subslots
// (subslot_no NULL = the slot's own identity row). Additive/idempotent — safe to
// call even when the head has no hw_default_children rows (no-op). Does NOT touch
// hw_signals; slot module assignment for rendering purposes remains as-is.
async function materializeDefaultTree(db, importId, addr, headOrderNo) {
  if (!headOrderNo) return;
  const slotRows = await db.prepare(
    `SELECT position AS slot, child_order_no, hw_category, label
     FROM hw_default_children WHERE parent_order_no=? AND position_kind='slot' ORDER BY position`
  ).all(headOrderNo);
  for (const s of slotRows) {
    await db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, child_order_no, hw_category, label)
       VALUES (?,?,?,NULL,?,?,?)
       ON CONFLICT (hw_import_id, station_address, slot) WHERE subslot_no IS NULL
       DO UPDATE SET child_order_no=EXCLUDED.child_order_no, hw_category=EXCLUDED.hw_category, label=EXCLUDED.label`
    ).run(importId, addr, s.slot, s.child_order_no, s.hw_category, s.label);

    await materializeSlotDefaultSubslots(db, importId, addr, s.slot, s.child_order_no);
  }
}

// Materialize a single slot's own default subslot tree (hw_default_children keyed by the
// slot's own order_no as parent_order_no/position_kind='subslot') into hw_slot_subslots for
// one real station instance. Shared by materializeDefaultTree (station-level, above) and
// station-creation from an Excel/IO-list import (upload-iolist, below), where slots come
// from the sheet itself rather than a station-level hw_default_children tree.
// Non-autocreated children get pa_profile set too, matching onSaveSlotSubslotProfile's own
// insert shape — this is what makes the project HW Config screen show the default profile as
// already selected (and still user-replaceable via its existing uncheck/reselect UI), not
// just "known" to the catalogue. Every default child is written, Service/AUTOCREATED ones
// included: the HW Config grid renders subslot rows from this table, so a position with no
// row here is a position the user cannot see.
async function materializeSlotDefaultSubslots(db, importId, addr, slotNo, slotOrderNo) {
  if (!slotOrderNo) return;
  const subRows = await db.prepare(
    `SELECT position AS subslot_no, child_order_no, hw_category, label, is_autocreated
     FROM hw_default_children WHERE parent_order_no=? AND position_kind='subslot' ORDER BY position`
  ).all(slotOrderNo);
  for (const ss of subRows) {
    await db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, child_order_no, hw_category, label, pa_profile)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
         child_order_no=EXCLUDED.child_order_no, hw_category=EXCLUDED.hw_category, label=EXCLUDED.label,
         pa_profile=EXCLUDED.pa_profile`
    ).run(importId, addr, slotNo, ss.subslot_no, ss.child_order_no, ss.hw_category, ss.label,
      ss.is_autocreated ? null : ss.child_order_no);
  }
}

// Explode a station-auto-slots JSON config ({slots:[{slot,order_no,label,subslots:[...]}]})
// into hw_default_children rows for headOrderNo. Family-free — driven purely by the
// config's own order_no/position fields plus each order_no's catalogue is_autocreated flag.
async function explodeConfigIntoDefaultChildren(db, headOrderNo, config) {
  if (!headOrderNo || !config || !Array.isArray(config.slots)) return;
  const tplRows = await db.prepare('SELECT order_no, is_autocreated FROM hw_module_templates').all();
  const autoMap = new Map(tplRows.map(t => [t.order_no, !!t.is_autocreated]));

  for (const slot of config.slots) {
    if (slot.slot == null) continue;
    const slotOrderNo = slot.order_no || `${headOrderNo}::slot${slot.slot}`;
    await db.prepare(
      `INSERT INTO hw_default_children (parent_order_no, position, position_kind, child_order_no, hw_category, is_autocreated, label, sort_order)
       VALUES (?, ?, 'slot', ?, 'slot', ?, ?, ?)
       ON CONFLICT (parent_order_no, position_kind, position) DO UPDATE SET
         child_order_no=EXCLUDED.child_order_no, is_autocreated=EXCLUDED.is_autocreated,
         label=EXCLUDED.label, sort_order=EXCLUDED.sort_order`
    ).run(headOrderNo, slot.slot, slotOrderNo, autoMap.get(slot.order_no) || false, slot.label || null, slot.slot);

    const subslots = Array.isArray(slot.subslots) ? slot.subslots : [];
    await explodeSubslotsIntoDefaultChildren(db, slotOrderNo, subslots, autoMap);
  }
}

// Write hw_default_children subslot rows for a single parent (a slot's own order_no).
// Shared by explodeConfigIntoDefaultChildren (per-slot, station-nested config) and the
// slot-category auto-seed path in POST /module-templates/bulk-upsert.
async function explodeSubslotsIntoDefaultChildren(db, parentOrderNo, subslots, autoMap) {
  if (!parentOrderNo || !Array.isArray(subslots)) return;
  for (const ss of subslots) {
    if (ss.subslot == null || !ss.order_no) continue;
    await db.prepare(
      `INSERT INTO hw_default_children (parent_order_no, position, position_kind, child_order_no, hw_category, is_autocreated, label, sort_order)
       VALUES (?, ?, 'subslot', ?, 'subslot', ?, ?, ?)
       ON CONFLICT (parent_order_no, position_kind, position) DO UPDATE SET
         child_order_no=EXCLUDED.child_order_no, is_autocreated=EXCLUDED.is_autocreated,
         label=EXCLUDED.label, sort_order=EXCLUDED.sort_order`
    ).run(parentOrderNo, ss.subslot, ss.order_no, autoMap.get(ss.order_no) || false, ss.label || ss.port_label || null, ss.subslot);
  }
}

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
      in_identifier, out_identifier, default_datatype,
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
        in_identifier=?, out_identifier=?, default_datatype=?
        WHERE id=?`).run(
        order_no, display_name, family, signal_type, channel_count,
        input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
        param_template, version, gsdml_file, dap_id, hw_category || null, subslot_defaults || null, port_config || null,
        inIdent, outIdent, default_datatype || null, existing.id
      );
      res.json({ id: existing.id, updated: true });
    } else {
      const r = await db.prepare(`INSERT INTO hw_module_templates
        (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
         in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category, subslot_defaults, port_config,
         in_identifier, out_identifier, default_datatype)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        order_no, display_name, family, signal_type, channel_count,
        input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
        param_template, version, gsdml_file, dap_id, hw_category || null, subslot_defaults || null, port_config || null,
        inIdent, outIdent, default_datatype || null
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
       in_identifier, out_identifier, mlfb, is_autocreated, is_removable)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const updSql = db.prepare(`UPDATE hw_module_templates SET
      display_name=?, family=?, signal_type=?, channel_count=?,
      input_bytes=?, output_bytes=?, in_addr_fmt=?, out_addr_fmt=?,
      param_template=?, version=?, gsdml_file=?, dap_id=?, hw_category=?, subslot_defaults=?, port_config=?,
      in_identifier=?, out_identifier=?, mlfb=?, is_autocreated=?, is_removable=?
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
          !!d.is_autocreated, d.is_removable === undefined ? true : !!d.is_removable,
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

    // ── Auto-seed hw_station_auto_slots from the CFG's parsed slot/subslot tree ──
    // Only seeds stations that don't already have a config, so a user's hand-edited
    // Auto-Slots Config is never overwritten by a re-import.
    let autoSlotsSeeded = 0;
    for (const d of devices) {
      if (d.action === 'skip' || d.hw_category !== 'station' || !d.auto_slots_seed) continue;
      try {
        const existingAutoSlots = await db.prepare('SELECT id FROM hw_station_auto_slots WHERE order_no=?').get(d.order_no);
        if (existingAutoSlots) continue;
        const seedConfig = JSON.parse(d.auto_slots_seed);
        if (!seedConfig.rules) seedConfig.rules = {};
        await inferAutoSlotTypes(db, seedConfig);
        await db.prepare('INSERT INTO hw_station_auto_slots (order_no, auto_slots_config) VALUES (?, ?)')
          .run(d.order_no, JSON.stringify(seedConfig));
        await explodeConfigIntoDefaultChildren(db, d.order_no, seedConfig);
        autoSlotsSeeded++;
      } catch (seedErr) {
        console.warn(`[Catalogue] Auto-slot seed skipped for ${d.order_no}:`, seedErr.message);
      }
    }

    // ── Auto-seed a slot's own default subslot tree (hw_default_children) ───────
    // Parallel to the station seed above, one level shallower — a slot's function
    // subslots + trailing Service module. Only seeds slots with no existing subslot
    // rows, so a user's hand-edited config is never overwritten by a re-import.
    for (const d of devices) {
      if (d.action === 'skip' || d.hw_category !== 'slot' || !d.default_subslots_seed) continue;
      try {
        const seedConfig = JSON.parse(d.default_subslots_seed);
        const tplRows = await db.prepare('SELECT order_no, is_autocreated FROM hw_module_templates').all();
        const autoMap = new Map(tplRows.map(t => [t.order_no, !!t.is_autocreated]));

        const existingSubslots = await db.prepare(
          `SELECT id FROM hw_default_children WHERE parent_order_no=? AND position_kind='subslot' LIMIT 1`
        ).get(d.order_no);
        if (!existingSubslots) {
          await explodeSubslotsIntoDefaultChildren(db, d.order_no, seedConfig.subslots, autoMap);
        }

        // Register the non-Service (user-selectable) function subslot(s) as compat options
        // for this slot, so the project HW Config screen's PA-profile dropdown (sourced from
        // hw_slot_subslot_compat) has something to offer. Independent of the hw_default_children
        // guard above (idempotent via ON CONFLICT DO NOTHING) — a slot whose default tree was
        // captured before this seeding existed must still get its compat rows backfilled on
        // the next re-import.
        // The Service module is identified positionally (highest subslot number, same rule
        // cfgCatalogueParser itself uses to flag it) rather than via hw_module_templates'
        // is_autocreated — that order_no is shared/reused across many different device
        // profiles' CFG blocks, and it is not AUTOCREATED at every one of them, so the
        // catalogue-wide flag isn't a reliable signal for "is this THIS slot's Service row."
        const subslots = seedConfig.subslots || [];
        const maxPos = subslots.length > 1 ? Math.max(...subslots.map(s => s.subslot)) : null;
        for (const ss of subslots) {
          if (!ss.order_no || ss.subslot === maxPos) continue; // skip trailing Service position
          await db.prepare(
            'INSERT INTO hw_slot_subslot_compat (slot_order_no, subslot_order_no, is_default) VALUES (?,?,false) ON CONFLICT (slot_order_no, subslot_order_no) DO NOTHING'
          ).run(d.order_no, ss.order_no);
        }
      } catch (seedErr) {
        console.warn(`[Catalogue] Default-subslots seed skipped for ${d.order_no}:`, seedErr.message);
      }
    }

    console.log(`[Catalogue] bulk-upsert: added=${added} overwritten=${overwritten} skipped=${skipped} paramRows=${paramRows} autoSlotsSeeded=${autoSlotsSeeded}`);
    res.json({ ok: true, added, overwritten, skipped, paramRows, autoSlotsSeeded });
  } catch (e) { err(res, 500, e.message); }
});

// ── HW Imports per project ────────────────────────────────────────────────────

router.get('/project/:id/imports', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.id, 10);
    const rows = await db.prepare(`
      SELECT i.id, i.excel_name, i.status, i.imported_at, i.baseline_info, i.baseline_cfg,
             i.hw_controller_id, c.T16_Controller_TagName AS controller_name
      FROM hw_imports i
      LEFT JOIN hw_controllers c ON c.id = i.hw_controller_id
      WHERE i.project_id=? ORDER BY i.id DESC`
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
      out.push({
        id: r.id,
        excel_name: r.excel_name,
        status: r.status,
        imported_at: r.imported_at,
        baseline_info: info,
        hw_controller_id: r.hw_controller_id,
        controller_name: r.controller_name,
      });
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

    // ── Hoist controller upsert BEFORE import upsert (Phase 1 fix) ────────────
    // This ensures the import is scoped to the correct controller. Must run before
    // the import lookup so we have a controllerId to key the import by.
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

    // ── Now lookup the import, keyed by (project_id, hw_controller_id) ────────
    const existingImport = await db.prepare(
      'SELECT id FROM hw_imports WHERE project_id=? AND hw_controller_id=?'
    ).get(projectId, controllerId);

    let importId;
    if (existingImport) {
      // Update in place, preserving status (don't reset to 'pending' on re-upload)
      await db.prepare('UPDATE hw_imports SET baseline_cfg=?, baseline_info=?, imported_at=NOW() WHERE id=?')
        .run(cfgText, JSON.stringify(baselineInfo), existingImport.id);
      importId = existingImport.id;
    } else {
      const r = await db.prepare(
        'INSERT INTO hw_imports (project_id, hw_controller_id, baseline_cfg, status, baseline_info) VALUES (?,?,?,?,?)'
      ).run(projectId, controllerId, cfgText, 'pending', JSON.stringify(baselineInfo));
      importId = r.lastInsertRowid;
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
    const tplRows = await db.prepare(
      'SELECT order_no, signal_type, input_bytes, output_bytes, channel_count FROM hw_module_templates'
    ).all();
    const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

    // SYMBOL lines in a CFG carry the channel's byte offset, not its 0-based index
    // (e.g. a 4-channel AI module: offsets 0,2,4,6). The renderer's buildSymbolLines
    // does the opposite conversion (index * bytesPerChannel) when generating, so a
    // backfilled signal must store the index it expects, or re-generation drifts.
    function byteOffsetToChannelIndex(tpl, byteOffset) {
      if (byteOffset == null) return null;
      const totalBytes = tpl ? (tpl.input_bytes > 0 ? tpl.input_bytes : (tpl.output_bytes || 0)) : 0;
      const channelCount = tpl ? (tpl.channel_count || 0) : 0;
      const bytesPerCh = channelCount > 0 ? totalBytes / channelCount : 0;
      return bytesPerCh >= 1 ? Math.round(byteOffset / bytesPerCh) : byteOffset;
    }

    const insertSignal = db.prepare(`
      INSERT INTO hw_signals
        (hw_import_id, station_address, station_name, ip_address, router_address, as_assignment,
         subsystem_no, slot, subslot_no, module_order_no, module_name, signal_type,
         pip_no, potential_group, tag, description, station_mlfb, channel)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const insertSubslot = db.prepare(`
      INSERT INTO hw_slot_subslots
        (hw_import_id, station_address, slot, subslot_no, pa_profile, child_order_no, label, pip_no, local_address)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
        pa_profile     = EXCLUDED.pa_profile,
        child_order_no = EXCLUDED.child_order_no,
        label          = EXCLUDED.label,
        pip_no         = EXCLUDED.pip_no,
        local_address  = EXCLUDED.local_address`);

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
        // Slot 0 can carry its own order_no distinct from the device header's
        // (e.g. CFU_PA: head "V_2_0_PA:..." vs slot 0 "V_2_0_PA_ETER:...") — prefer
        // slot 0's own catalogue-valid order_no when it exists, falling back to the
        // header's for devices where they're identical (ET200SP, IO-Link).
        // For GSDML-based devices the header orderNo is the GSDML filename which
        // won't match the catalogue.  Use mlfbNo (from the SLOT 0 MLFB field)
        // as the effective key instead — it holds the real Siemens order number.
        const slot0Rec = dev.slots.find(s => s.slot === 0);
        const slot0CatalogueOrderNo = (slot0Rec && slot0Rec.orderNo && tplMap.has(slot0Rec.orderNo))
          ? slot0Rec.orderNo
          : dev.orderNo;
        const slot0OrderNo = (dev.mlfbNo && !tplMap.has(slot0CatalogueOrderNo))
          ? dev.mlfbNo
          : slot0CatalogueOrderNo;
        await insertSignal.run(
          importId,
          dev.address, dev.name, dev.ip, dev.routerAddress, dev.asAssignment || null,
          dev.subsystemNo, 0, null,
          slot0OrderNo, dev.name,
          null, null, null, null, null,
          dev.mlfbNo || null, null,
        );

        for (const slot of dev.slots) {
          // Server module (193-6PA00-0AA0) is auto-added by the generator on every
          // export — skip it on import so it is never stored as a configurable slot.
          if ((slot.orderNo || '').includes('193-6PA00-0AA0')) continue;

          // Slot 0 hw_signals row already inserted above as the station placeholder — skip re-insert,
          // but still fall through to process its subslots into hw_slot_subslots.
          if (slot.slot !== 0) {
            const tpl        = tplMap.get(slot.orderNo);
            const signalType = tpl ? tpl.signal_type : null;

            if (slot.symbols.length === 0) {
              // No SYMBOL lines — insert one representative row for the slot
              await insertSignal.run(
                importId,
                dev.address, dev.name, dev.ip, dev.routerAddress, dev.asAssignment || null,
                dev.subsystemNo, slot.slot, null,
                slot.orderNo, slot.name,
                signalType,
                slot.pipNo, slot.potentialGroup,
                null, null,
                slot.mlfb || null, null,
              );
              slotCount++;
            } else {
              // Insert one row per SYMBOL (channel-level tag data). `channel` is the
              // symbol's own byte offset from the CFG (SYMBOL I|O, <offset>, tag, desc)
              // — carrying it through keeps regeneration ordering/addressing lossless.
              for (const sym of slot.symbols) {
                await insertSignal.run(
                  importId,
                  dev.address, dev.name, dev.ip, dev.routerAddress, dev.asAssignment || null,
                  dev.subsystemNo, slot.slot, null,
                  slot.orderNo, slot.name,
                  signalType,
                  slot.pipNo, slot.potentialGroup,
                  sym.tag || null, sym.description || null,
                  slot.mlfb || null, byteOffsetToChannelIndex(tpl, sym.channel),
                );
              }
              slotCount++;
            }
          }

          // Subslots for all slots including slot 0
          for (const ss of slot.subslots) {
            await insertSubslot.run(
              importId, dev.address, slot.slot, ss.subslotNo,
              ss.orderNo || null, ss.orderNo || null, ss.name || null, ss.pipNo ?? null,
              ss.localAddress ?? null,
            );

            // Subslot-level SYMBOL lines (e.g. IO-Link port channels, PA subslot
            // signals) were previously dropped entirely — emit one hw_signals row
            // per symbol, tagged with subslot_no so it doesn't collide with the
            // parent slot's own rows.
            const ssTpl        = tplMap.get(ss.orderNo);
            const ssSignalType = ssTpl ? ssTpl.signal_type : null;
            for (const sym of (ss.symbols || [])) {
              await insertSignal.run(
                importId,
                dev.address, dev.name, dev.ip, dev.routerAddress, dev.asAssignment || null,
                dev.subsystemNo, slot.slot, ss.subslotNo,
                ss.orderNo || slot.orderNo, ss.name || slot.name,
                ssSignalType,
                ss.pipNo, ss.potentialGroup,
                sym.tag || null, sym.description || null,
                slot.mlfb || null, byteOffsetToChannelIndex(ssTpl, sym.channel),
              );
            }
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

// Controller tag names are stored verbatim from the CFG STATION line (see
// cfgParser.js) — nothing trims or case-folds them on the way in. Matching a
// spreadsheet cell against one therefore has to normalise both sides, but only
// by trim + casefold: anything fuzzier risks routing a row to the wrong AS.
// Shared with the workflow's per-controller sync via hwExcelParser.
const { normAs } = require('../services/hwExcelParser');

// POST /api/hw-config/project/:id/ingest-io-rows-split
// Multi-controller unified import: split one IO import's rows across the project's
// HW imports by an "AS assignment" column, staging each group into its own
// hw_excel_raw so the existing preview/apply flow can run once per controller.
// Rows whose AS value matches no controller are skipped and reported back.
// Body: { ioImportId, asColumn }
router.post('/project/:id/ingest-io-rows-split', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.id, 10);
    const { ioImportId, asColumn, orderNoColumn } = req.body || {};
    if (!ioImportId) return err(res, 400, 'ioImportId required');
    if (!asColumn)   return err(res, 400, 'asColumn required');

    // ── 1. Build the AS index: normalised controller name → hw_import ──────────
    const imports = await db.prepare(`
      SELECT i.id AS import_id, c.T16_Controller_TagName AS name
      FROM hw_imports i
      JOIN hw_controllers c ON c.id = i.hw_controller_id
      WHERE i.project_id = ?
      ORDER BY i.hw_controller_id`).all(projectId);

    const index     = new Map();  // norm → { importId, name }
    const ambiguous = new Map();  // norm → [name, ...]
    for (const r of imports) {
      const n = normAs(r.name);
      if (!n) continue;                       // unnamed controller: unroutable
      if (index.has(n)) {
        const list = ambiguous.get(n) || [index.get(n).name];
        list.push(r.name);
        ambiguous.set(n, list);
        continue;                             // first (lowest controller id) wins
      }
      index.set(n, { importId: r.import_id, name: r.name });
    }
    if (index.size === 0) {
      return err(res, 400, 'No controllers with a station name found for this project. Upload a baseline CFG first.');
    }

    // ── 1b. Load catalogue order numbers for missing-device detection ──────────
    const catalogueRows = await db.prepare(
      `SELECT DISTINCT order_no FROM hw_module_templates`
    ).all();
    const catalogueOrderNos = new Set(catalogueRows.map(r => String(r.order_no).trim()));

    // ── 2. Bucket the IO rows by AS value ──────────────────────────────────────
    const ioRows = await db.prepare(
      'SELECT row_number, raw_data FROM io_tags WHERE import_id=? ORDER BY row_number, id'
    ).all(parseInt(ioImportId, 10));
    if (ioRows.length === 0) return err(res, 400, 'IO import has no rows to ingest');

    const buckets           = new Map();  // importId → [row_json, ...]
    // skipped entries carry warningType: 'wrong_as' | 'missing_catalogue'
    const skippedWrongAs    = new Map();  // raw AS value → { rowCount, sampleRowNumbers, warningType }
    const skippedMissingCat = new Map();  // orderNo → { rowCount, sampleRowNumbers, warningType }

    for (const row of ioRows) {
      let obj;
      try { obj = JSON.parse(row.raw_data || '{}'); } catch (_) { obj = {}; }
      const hit = index.get(normAs(obj[asColumn]));
      if (!hit) {
        const rawAs   = String(obj[asColumn] ?? '').trim();
        const orderNo = orderNoColumn ? String(obj[orderNoColumn] ?? '').trim() : '';

        // Blank AS + known order number → station head row with unrecognised station
        // Blank AS + unknown order number → station head with device not in catalogue
        // Non-blank AS → genuinely wrong AS value
        if (!rawAs && orderNo && !catalogueOrderNos.has(orderNo)) {
          // Missing from catalogue
          const s = skippedMissingCat.get(orderNo) || { rowCount: 0, sampleRowNumbers: [], warningType: 'missing_catalogue' };
          s.rowCount++;
          if (s.sampleRowNumbers.length < 5) s.sampleRowNumbers.push(row.row_number);
          skippedMissingCat.set(orderNo, s);
        } else {
          // Wrong or blank AS value
          const key = rawAs || '(blank)';
          const s = skippedWrongAs.get(key) || { rowCount: 0, sampleRowNumbers: [], warningType: 'wrong_as' };
          s.rowCount++;
          if (s.sampleRowNumbers.length < 5) s.sampleRowNumbers.push(row.row_number);
          skippedWrongAs.set(key, s);
        }
        continue;
      }
      if (!buckets.has(hit.importId)) buckets.set(hit.importId, []);
      buckets.get(hit.importId).push(row.raw_data || '{}');
    }

    // ── 3. Stage each bucket, all in one transaction ───────────────────────────
    // Only imports that received rows are cleared: a controller matching nothing
    // this run keeps whatever it had staged, so re-importing a partial sheet
    // never silently blanks another controller.
    const del    = db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id=?');
    const insert = db.prepare('INSERT INTO hw_excel_raw (hw_import_id, row_index, row_json) VALUES (?,?,?)');
    const writeAll = db.transaction(async (entries) => {
      for (const [impId, rows] of entries) {
        await del.run(impId);
        for (let i = 0; i < rows.length; i++) await insert.run(impId, i, rows[i]);
      }
    });
    await writeAll([...buckets.entries()]);

    // ── 4. Respond, ordered by controller so the review sequence is stable ─────
    const groups = [];
    for (const r of imports) {
      const rows = buckets.get(r.import_id);
      if (rows && rows.length) {
        groups.push({ hwImportId: r.import_id, controllerName: r.name, rowCount: rows.length });
      }
    }

    const skipped = [
      ...[...skippedWrongAs.entries()].map(([asValue, s]) => ({ asValue, ...s })),
      ...[...skippedMissingCat.entries()].map(([orderNo, s]) => ({ orderNo, ...s })),
    ];

    res.json({
      groups,
      skipped,
      ambiguous: [...ambiguous.entries()].map(([normalized, controllerNames]) => ({ normalized, controllerNames })),
      totalRows: ioRows.length,
    });
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
      'station_name', 'module_name', 'ip_address', 'description', 'signal_type', 'subsystem_no', 'router_address',
      'as_assignment'
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

    const { rows, stations, colMap, resolutionStats, slotConflicts } =
      await parseHwExcel(req.file.buffer, sheetName, overrideColumnMap, db);

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
         station_mlfb, resolved_by_tier2, unresolved, as_assignment)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertBatch = db.transaction(async (batch) => {
      for (const r of batch) {
        await ins.run(importId, r.rowNum, r.stationAddr, r.stationName, r.ip,
          r.slot, r.channel, r.orderNo, r.moduleName, r.tag, r.desc, r.signalType,
          r.subsystemNo ?? null, r.routerAddress || null,
          r.stationMlfb || null,
          !!r.resolvedByTier2, !!r.unresolved, r.asAssignment || null);
      }
    });
    for (let i = 0; i < rows.length; i += 500) await insertBatch(rows.slice(i, i + 500));

    // Tier 2: Create slot 0 rows for stations with station_mlfb
    // This enables the grid to auto-generate ports (0.2, 0.3) based on the station module's port_config
    const tier2Stations = await db.prepare(`
      SELECT DISTINCT station_address, station_name, ip_address, router_address, subsystem_no, station_mlfb,
             as_assignment
      FROM hw_signals
      WHERE hw_import_id=? AND resolved_by_tier2=true AND station_mlfb IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hw_signals s2 WHERE s2.hw_import_id=? AND s2.station_address=hw_signals.station_address AND s2.slot=0)
    `).all(importId, importId);

    if (tier2Stations.length > 0) {
      const insSlot0 = db.prepare(`
        INSERT INTO hw_signals
          (hw_import_id, row_number, station_address, station_name, ip_address,
           slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
           station_mlfb, resolved_by_tier2, unresolved, as_assignment)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const s of tier2Stations) {
        await insSlot0.run(
          importId, null, s.station_address, s.station_name, s.ip_address,
          0, null, s.station_mlfb, s.station_name,
          null, null, null, s.subsystem_no, s.router_address,
          s.station_mlfb, true, false, s.as_assignment || null
        );
      }
    }

    // Additive: materialize each newly-created slot's own default subslot tree (a PA-profile
    // slot's default function profile + Service module) into hw_slot_subslots, generically,
    // from hw_default_children. No-op for slots with no such catalogue seed captured.
    const newSlots = await db.prepare(
      `SELECT DISTINCT station_address, slot, module_order_no FROM hw_signals
       WHERE hw_import_id=? AND slot >= 1 AND module_order_no IS NOT NULL`
    ).all(importId);
    for (const s of newSlots) {
      await materializeSlotDefaultSubslots(db, importId, s.station_address, s.slot, s.module_order_no);
    }

    await db.prepare('UPDATE hw_imports SET excel_name=?, status=? WHERE id=?')
      .run(req.file.originalname, 'ready', importId);

    res.json({ importId, stationCount: stations.size, signalCount: rows.length, colMap, resolutionStats,
               slotConflicts: slotConflicts || [] });
  } catch (e) { err(res, e.statusCode || 500, e.message); }
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
      // Delete approved missing rows (clear FK refs to instance_ios first)
      for (const r of dbRows) {
        const key = `${r.station_address}:${r.slot}:${chKey(r.channel, r.tag, r.signal_type)}`;
        if (missingSet.has(key) && approvedSet.has(key)) {
          const hwSigs = await db.prepare(
            `SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel IS NOT DISTINCT FROM ?`
          ).all(importId, r.station_address, r.slot, r.channel ?? null);
          for (const sig of hwSigs) {
            await db.prepare('UPDATE instance_ios SET hw_signal_id=NULL WHERE hw_signal_id=?').run(sig.id);
          }
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
           station_mlfb, resolved_by_tier2, unresolved, as_assignment)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      let rowIdx = 0;
      for (const r of parsedRows) {
        const key = `${r.stationAddr}:${r.slot}:${chKey(r.channel, r.tag, r.signalType)}`;
        if (!approvedSet.has(key)) { rowIdx++; continue; }

        // Delete existing row for this key before inserting (upsert). Clear FK refs first.
        const hwSigs = await db.prepare(
          `SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel IS NOT DISTINCT FROM ?`
        ).all(importId, r.stationAddr, r.slot, r.channel ?? null);
        for (const sig of hwSigs) {
          await db.prepare('UPDATE instance_ios SET hw_signal_id=NULL WHERE hw_signal_id=?').run(sig.id);
        }
        await db.prepare(
          `DELETE FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel IS NOT DISTINCT FROM ?`
        ).run(importId, r.stationAddr, r.slot, r.channel ?? null);

        await ins.run(importId, r.rowNum ?? rowIdx, r.stationAddr, r.stationName, r.ip,
          r.slot, r.channel ?? null, r.orderNo, r.moduleName, r.tag, r.desc,
          r.signalType, r.subsystemNo ?? null, r.routerAddress || null,
          r.stationMlfb || null,
          !!r.resolvedByTier2, !!r.unresolved, r.asAssignment || null);
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
      SELECT DISTINCT station_address, station_name, ip_address, router_address, subsystem_no, station_mlfb,
             as_assignment
      FROM hw_signals
      WHERE hw_import_id=? AND resolved_by_tier2=true AND station_mlfb IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hw_signals s2 WHERE s2.hw_import_id=? AND s2.station_address=hw_signals.station_address AND s2.slot=0)
    `).all(importId, importId);

    if (tier2Stations.length > 0) {
      const insSlot0 = db.prepare(`
        INSERT INTO hw_signals
          (hw_import_id, row_number, station_address, station_name, ip_address,
           slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
           station_mlfb, resolved_by_tier2, unresolved, as_assignment)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const s of tier2Stations) {
        await insSlot0.run(
          importId, null, s.station_address, s.station_name, s.ip_address,
          0, null, s.station_mlfb, s.station_name,
          null, null, null, s.subsystem_no, s.router_address,
          s.station_mlfb, true, false, s.as_assignment || null
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
              MIN(router_address) AS router_address, MIN(as_assignment) AS as_assignment, MIN(subsystem_no) AS subsystem_no,
              BOOL_OR(COALESCE(approved,false)) AS approved
       FROM hw_signals WHERE hw_import_id=? GROUP BY station_address ORDER BY station_address`
    ).all(importId);

    // Load per-subslot profiles
    const subslotRows = await db.prepare(
      `SELECT station_address, slot, subslot_no, pa_profile, child_order_no, hw_category, label
       FROM hw_slot_subslots WHERE hw_import_id=? ORDER BY station_address, slot, subslot_no`
    ).all(importId);

    // Resolve orderNo + family per station from slot 0 row
    const tplRows = await db.prepare('SELECT order_no, family, display_name, hw_category, is_removable FROM hw_module_templates').all();
    const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

    // Generic default-tree lookup: is a given (parent_order_no, position_kind, position)
    // fixed/AUTOCREATED per the catalogue? Family-free — same map serves slot and subslot
    // depth (ground-truth rule 2/3: the recursive default-tree model).
    const defaultChildRows = await db.prepare(
      `SELECT parent_order_no, position_kind, position, is_autocreated FROM hw_default_children`
    ).all();
    const defaultChildMap = new Map(
      defaultChildRows.map(r => [`${r.parent_order_no}::${r.position_kind}::${r.position}`, !!r.is_autocreated])
    );
    const isAutocreatedAt = (parentOrderNo, positionKind, position) =>
      !!parentOrderNo && !!defaultChildMap.get(`${parentOrderNo}::${positionKind}::${position}`);

    // Build subslot map: Map<"addr:slot", [{subslotNo, paProfile, childOrderNo, hwCategory, label, isAutocreated}]>
    // isAutocreated is resolved once station orderNos are known (needs the slot's own
    // order_no as the subslot's parent), so fill it in below after stationMap/slots exist.
    const subslotMap = new Map();
    for (const r of subslotRows) {
      const key = `${r.station_address}:${r.slot}`;
      if (!subslotMap.has(key)) subslotMap.set(key, []);
      subslotMap.get(key).push({
        subslotNo:   r.subslot_no,
        paProfile:   r.pa_profile || null,
        childOrderNo: r.child_order_no || r.pa_profile || null,
        hwCategory:  r.hw_category || null,
        label:       r.label || null,
      });
    }

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
        asAssignment:  r.as_assignment || null,
        subsystemNo:   r.subsystem_no,
        approved:      !!r.approved,
        orderNo:       s0.orderNo || null,
        family:        s0.family  || null,
        slots:         [],
      });
    }
    for (const row of signals) {
      const st = stationMap.get(row.station_address);
      if (!st) continue;
      const tpl = tplMap.get(row.module_order_no);
      // Subslots of this slot are family-free "children" — resolve each one's
      // isAutocreated against hw_default_children using THIS slot's own order_no
      // as the parent (recursive default-tree lookup, ground-truth rule 2/3).
      const subslots = (subslotMap.get(`${row.station_address}:${row.slot}`) || []).map(ss => ({
        ...ss,
        hwCategory:   ss.hwCategory || (tplMap.get(ss.childOrderNo)?.hw_category) || null,
        isAutocreated: isAutocreatedAt(row.module_order_no, 'subslot', ss.subslotNo),
      }));
      st.slots.push({
        slot:           row.slot,
        orderNo:        row.module_order_no,
        childOrderNo:   row.module_order_no,
        name:           row.module_name,
        signalCount:    row.signal_count,
        pipNo:          row.pip_no != null ? row.pip_no : null,
        potentialGroup: row.potential_group != null ? row.potential_group : null,
        paProfile:      row.pa_profile != null ? row.pa_profile : null,
        hwCategory:     tpl?.hw_category || null,
        isRemovable:    tpl ? !!tpl.is_removable : true,
        // Fixed/AUTOCREATED slot ⇒ locked, never user-addable/removable — resolved
        // against the station head's own default-tree row for this slot position.
        isAutocreated:  isAutocreatedAt(st.orderNo, 'slot', row.slot),
        subslots,
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
    const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(importId);
    if (!hwImport) return err(res, 404, 'HW import not found');

    // Same allocation the IOTag/CFG export paths use — see services/slotAddressMap.js.
    const stations = await buildAllocatedStations(db, importId);

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

// PATCH /api/hw-config/imports/:id/stations/:addr — edit station name / ip / subsystemNo / router_address / as_assignment
router.patch('/imports/:id/stations/:addr', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const { station_name, ip_address, subsystem_no, router_address, as_assignment } = req.body;

    const sets = [];
    const vals = [];
    if (station_name    !== undefined) { sets.push('station_name=?');    vals.push(station_name); }
    if (ip_address      !== undefined) { sets.push('ip_address=?');      vals.push(ip_address); }
    if (subsystem_no    !== undefined) { sets.push('subsystem_no=?');    vals.push(subsystem_no); }
    if (router_address  !== undefined) { sets.push('router_address=?');  vals.push(router_address); }
    if (as_assignment   !== undefined) { sets.push('as_assignment=?');   vals.push(as_assignment); }
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

// PATCH /imports/:id/stations/:addr/slots/:slot/pa-profile — set PA subslot-1 profile for a device slot
// Generic: legal on any node whose module has known hw_slot_subslot_compat children —
// no family gate.
router.patch('/imports/:id/stations/:addr/slots/:slot/pa-profile', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const { paProfile } = req.body;

    // Validate against catalogue: must be a known subslot template, generically
    // (any hw_category='subslot' order_no — the compat table further narrows this
    // per parent when available; here we accept any catalogued subslot type).
    const known = paProfile
      ? await db.prepare("SELECT order_no FROM hw_module_templates WHERE order_no=? AND hw_category='subslot'").get(paProfile)
      : null;
    const val = (paProfile && known) ? paProfile : null;
    await db.prepare(
      'UPDATE hw_signals SET pa_profile=? WHERE hw_import_id=? AND station_address=? AND slot=?'
    ).run(val, importId, addr, slot);
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/subslots/:ssNo/pa-profile — set per-subslot PA profile
// Legacy path — kept for existing frontend callers; see the generic
// /subslots/:subslot route below for the recommended replacement, which also
// updates hw_slot_subslots.child_order_no and validates against hw_slot_subslot_compat.
router.patch('/imports/:id/stations/:addr/slots/:slot/subslots/:ssNo/pa-profile', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const ssNo     = parseInt(req.params.ssNo, 10);
    const { paProfile } = req.body;

    const known = paProfile
      ? await db.prepare("SELECT order_no, display_name FROM hw_module_templates WHERE order_no=? AND hw_category='subslot'").get(paProfile)
      : null;
    const val = (paProfile && known) ? paProfile : null;
    // `label` is denormalized display text; leaving it behind on a profile change
    // makes the row (and the generated CFG) describe the previous profile.
    const labelVal = (val && known && known.display_name) ? known.display_name : null;

    await db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile, child_order_no, label)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
         pa_profile=excluded.pa_profile, child_order_no=excluded.child_order_no, label=excluded.label`
    ).run(importId, addr, slot, ssNo, val, val, labelVal);

    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/subslots/:subslot — generic node replace.
// Body: { child_order_no }. Validated against hw_slot_subslot_compat for the parent's own
// order_no (looked up from the slot's own hw_slot_subslots identity row, or its
// module_order_no when no identity row exists yet); refused when the current node is
// is_autocreated (fixed/locked). This is the family-free replacement for the PA-profile-only
// PATCH and any hardcoded per-family subslot-swap paths.
router.patch('/imports/:id/stations/:addr/slots/:slot/subslots/:subslot', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const subslot  = parseInt(req.params.subslot, 10);
    const { child_order_no } = req.body;
    if (!child_order_no) return err(res, 400, 'child_order_no required');

    // Refuse when the current row is is_autocreated (fixed/locked node).
    const current = await db.prepare(
      'SELECT child_order_no, hw_category FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=? AND slot=? AND subslot_no=?'
    ).get(importId, addr, slot, subslot);
    const currentDefault = current
      ? await db.prepare(
          `SELECT is_autocreated FROM hw_default_children
           WHERE position_kind='subslot' AND position=? AND child_order_no=?`
        ).get(subslot, current.child_order_no)
      : null;
    if (currentDefault && currentDefault.is_autocreated) {
      return err(res, 400, 'This subslot is a fixed (AUTOCREATED) node and cannot be replaced.');
    }

    // Resolve the parent's own order_no (the slot's module) to validate compatibility.
    const slotIdentity = await db.prepare(
      `SELECT child_order_no FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=? AND slot=? AND subslot_no IS NULL`
    ).get(importId, addr, slot);
    const slotSignal = await db.prepare(
      'SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1'
    ).get(importId, addr, slot);
    const parentOrderNo = (slotIdentity && slotIdentity.child_order_no) || (slotSignal && slotSignal.module_order_no) || null;

    if (parentOrderNo) {
      const compat = await db.prepare(
        'SELECT id FROM hw_slot_subslot_compat WHERE slot_order_no=? AND subslot_order_no=?'
      ).get(parentOrderNo, child_order_no);
      if (!compat) {
        return err(res, 400, `"${child_order_no}" is not a known compatible child for "${parentOrderNo}".`);
      }
    }

    // `label` is denormalized display text; leaving it behind on a profile change
    // makes the row (and the generated CFG) describe the previous profile.
    const newTpl = await db.prepare(
      "SELECT display_name FROM hw_module_templates WHERE order_no=? AND hw_category='subslot' LIMIT 1"
    ).get(child_order_no);
    await db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, child_order_no, pa_profile, label)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
         child_order_no=EXCLUDED.child_order_no, pa_profile=EXCLUDED.pa_profile, label=EXCLUDED.label`
    ).run(importId, addr, slot, subslot, child_order_no, child_order_no, (newTpl && newTpl.display_name) || null);

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
      // Additive: also materialize hw_slot_subslots identity/subslot rows from
      // hw_default_children, generically (no family gate). No-op if none captured yet.
      await materializeDefaultTree(db, importId, addr, imOrderNo);
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
      'SELECT slot, subslot_no, pa_profile, child_order_no, hw_category, pip_no, label FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=?'
    ).all(importId, srcAddr);

    const insSubslot = db.prepare(
      `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile, child_order_no, hw_category, pip_no, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        await insSubslot.run(importId, newAddr, r.slot, r.subslot_no, r.pa_profile, r.child_order_no, r.hw_category, r.pip_no, r.label);
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

    // Generic reserved-slot gate: derive the first addable slot number from this
    // station head's hw_default_children (is_autocreated fixed slots), not a
    // hardcoded family constant.
    const imRow = await db.prepare('SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1').get(importId, addr);
    if (imRow) {
      const minSlot = await firstAddableSlot(db, imRow.module_order_no);
      if (slotNo < minSlot) {
        return err(res, 400, `Slots below ${minSlot} are reserved system slots for this station type. Add from Slot ${minSlot} onwards.`);
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

      // Renumber remaining user slots to be contiguous. First user slot is derived
      // generically from this station head's hw_default_children (fixed/reserved
      // slots), not a hardcoded family constant.
      const imRow = await db.prepare(
        'SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=0 LIMIT 1'
      ).get(importId, addr);
      const firstUser = imRow ? await firstAddableSlot(db, imRow.module_order_no) : 1;

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
// GET /imports/:id/stations/:addr/slots/:slot/subslots/:subslot/channels
// Returns one row per channel (0-indexed), creating missing rows up to channel_count from template.
// The slot-only route is keyed to subslot_no IS NULL (today's behavior, unchanged); the
// subslot-scoped variant filters/creates against that specific subslot_no instead, so
// channels on different subslots of the same slot no longer collide.
async function handleGetSlotChannels(req, res) {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const subslot  = req.params.subslot != null ? parseInt(req.params.subslot, 10) : null;

    const existing = await db.prepare(
      `SELECT id, channel, tag, description, signal_type
       FROM hw_signals
       WHERE hw_import_id=? AND station_address=? AND slot=? AND subslot_no IS NOT DISTINCT FROM ?
       ORDER BY channel`
    ).all(importId, addr, slot, subslot);

    // Get channel_count from template for this slot/subslot. Prefer a hw_signals row's
    // module_order_no (today's behavior); when the subslot has no hw_signals row of its
    // own (e.g. a PA/port subslot whose identity lives only in hw_slot_subslots), fall
    // back to hw_slot_subslots.child_order_no for that subslot.
    let slotMeta = await db.prepare(
      `SELECT module_order_no FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND subslot_no IS NOT DISTINCT FROM ? LIMIT 1`
    ).get(importId, addr, slot, subslot);
    if (!slotMeta && subslot != null) {
      const ss = await db.prepare(
        `SELECT child_order_no AS module_order_no FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=? AND slot=? AND subslot_no=?`
      ).get(importId, addr, slot, subslot);
      if (ss && ss.module_order_no) slotMeta = ss;
    }

    let channelCount = existing.length;
    let slotSignalType = null;
    let slotDefaultDatatype = null;
    if (slotMeta && slotMeta.module_order_no) {
      const tpl = await db.prepare('SELECT channel_count, signal_type, default_datatype FROM hw_module_templates WHERE order_no=?').get(slotMeta.module_order_no);
      console.log(`[Channels] slot=${slot} order_no="${slotMeta.module_order_no}" found_template=${!!tpl} channel_count=${tpl?.channel_count || 'N/A'}`);
      if (tpl && tpl.channel_count > 0) channelCount = tpl.channel_count;
      if (tpl) { slotSignalType = tpl.signal_type; slotDefaultDatatype = tpl.default_datatype; }
    } else {
      console.log(`[Channels] slot=${slot} no slotMeta or module_order_no is null`);
    }

    // Build a full channel list: existing rows + empty placeholders for gaps.
    // MIXED just means "has both input and output bytes" (see deriveSignalType) — it is not
    // necessarily digital DI/DO. Only split channels 0..(half-1)=DI / half..(count-1)=DO when
    // the module has no declared datatype (today's DIQ8-style boolean modules); a module with a
    // real datatype (e.g. an IO-Link byte channel, default_datatype='Byte') keeps one flat
    // channel list tagged with that datatype instead.
    // PA slots with channel_count > 1: each channel is one PA function subslot.
    const isMixed = slotSignalType === 'MIXED';
    const isDigitalMixed = isMixed && !slotDefaultDatatype;
    const halfCount = isDigitalMixed ? Math.floor(channelCount / 2) : 0;
    const byChannel = new Map(existing.map(r => [r.channel, r]));
    const channels = [];
    for (let ch = 0; ch < channelCount; ch++) {
      const row = byChannel.get(ch);
      let defaultType;
      if (isDigitalMixed) {
        defaultType = ch < halfCount ? 'DI' : 'DO';
      } else if (slotSignalType === 'PA' || slotSignalType === 'AI' || slotSignalType === 'AO') {
        defaultType = slotSignalType;
      } else if (isMixed && slotDefaultDatatype) {
        defaultType = slotDefaultDatatype.toUpperCase();
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
}
router.get('/imports/:id/stations/:addr/slots/:slot/channels', handleGetSlotChannels);
router.get('/imports/:id/stations/:addr/slots/:slot/subslots/:subslot/channels', handleGetSlotChannels);

// ── Batch load all channels for all slots in an import (for Symbol Table) ────
// Uses symbol_table_flat view for database-side processing instead of JavaScript grouping
router.get('/imports/:id/all-slot-channels', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);

    // Query pre-computed view (all grouping done by PostgreSQL)
    const rows = await db.prepare(`
      SELECT station_address, station_name, slot, channel, tag, description, signal_type
      FROM symbol_table_flat
      WHERE hw_import_id = ?
    `).all(importId);

    if (rows.length === 0) {
      return res.json([]);
    }

    // Single pass to build result structure (minimal processing)
    const stationMap = new Map();

    for (const row of rows) {
      if (!stationMap.has(row.station_address)) {
        stationMap.set(row.station_address, {
          stationAddress: row.station_address,
          stationName: row.station_name,
          slots: new Map(),
        });
      }

      const station = stationMap.get(row.station_address);
      if (!station.slots.has(row.slot)) {
        station.slots.set(row.slot, { slot: row.slot, channels: [] });
      }

      station.slots.get(row.slot).channels.push({
        channel: row.channel,
        tag: row.tag,
        description: row.description,
        signal_type: row.signal_type,
      });
    }

    // Convert to arrays
    const result = Array.from(stationMap.values())
      .map(station => ({
        stationAddress: station.stationAddress,
        stationName: station.stationName,
        slots: Array.from(station.slots.values()).sort((a, b) => a.slot - b.slot),
      }));

    res.json(result);
  } catch (e) { err(res, 500, e.message); }
});

// PATCH /imports/:id/stations/:addr/slots/:slot/channels/:ch
// PATCH /imports/:id/stations/:addr/slots/:slot/subslots/:subslot/channels/:ch
// Slot-only route stays keyed to subslot_no IS NULL (backwards compatible, unchanged
// behavior); the subslot-scoped variant filters/creates against that subslot_no so a
// channel number on one subslot never collides with the same channel number on another.
async function handlePatchSlotChannel(req, res) {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id,   10);
    const addr     = parseInt(req.params.addr, 10);
    const slot     = parseInt(req.params.slot, 10);
    const ch       = parseInt(req.params.ch,   10);
    const subslot  = req.params.subslot != null ? parseInt(req.params.subslot, 10) : null;
    const { tag, description, signal_type } = req.body;

    const existing = await db.prepare(
      'SELECT id FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? AND channel=? AND subslot_no IS NOT DISTINCT FROM ?'
    ).get(importId, addr, slot, ch, subslot);

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
      // Row doesn't exist yet — pull station/slot metadata for required FK fields.
      const head = await db.prepare(
        `SELECT station_name, ip_address, module_order_no, module_name, subsystem_no, router_address
         FROM hw_signals WHERE hw_import_id=? AND station_address=? AND slot=? LIMIT 1`
      ).get(importId, addr, slot);
      // When scoped to a subslot, prefer that subslot's own child_order_no (from
      // hw_slot_subslots) for module_order_no/module_name over the slot's own module —
      // e.g. an IO-Link port or PA function subslot has a different order_no than its
      // parent slot's module.
      let moduleOrderNo = head?.module_order_no || null;
      let moduleName    = head?.module_name || null;
      if (subslot != null) {
        const ss = await db.prepare(
          `SELECT child_order_no FROM hw_slot_subslots WHERE hw_import_id=? AND station_address=? AND slot=? AND subslot_no=?`
        ).get(importId, addr, slot, subslot);
        if (ss && ss.child_order_no) {
          moduleOrderNo = ss.child_order_no;
          moduleName    = ss.child_order_no;
        }
      }
      await db.prepare(`INSERT INTO hw_signals
        (hw_import_id, station_address, station_name, ip_address, slot, subslot_no, channel,
         module_order_no, module_name, subsystem_no, router_address, tag, description, signal_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        importId, addr,
        head?.station_name || null, head?.ip_address || null,
        slot, subslot, ch,
        moduleOrderNo, moduleName,
        head?.subsystem_no ?? 100, head?.router_address || null,
        tag ?? null, description ?? null, signal_type ?? null
      );
    }
    res.json({ ok: true });
  } catch (e) { err(res, 500, e.message); }
}
router.patch('/imports/:id/stations/:addr/slots/:slot/channels/:ch', handlePatchSlotChannel);
router.patch('/imports/:id/stations/:addr/slots/:slot/subslots/:subslot/channels/:ch', handlePatchSlotChannel);

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

    // A controller with no stations yet (e.g. just baselined/pasted, no IO
    // added) still has a valid RACK/CPU/PS/PN-IO header to generate — the CFG
    // just has no device blocks appended. generateCfg() and allocateAddresses()
    // both handle an empty stations map correctly, so there is no need to
    // block generation here; only a genuinely missing baseline (checked above)
    // makes the output meaningless.
    const signals = await db.prepare(signalQuery).all(...queryParams);

    // Load per-subslot profiles for all stations in this import
    const subslotRows = await db.prepare(
      'SELECT station_address, slot, subslot_no, pa_profile, label, local_address FROM hw_slot_subslots WHERE hw_import_id=? ORDER BY station_address, slot, subslot_no'
    ).all(importId);
    const subslotMap = new Map();
    for (const r of subslotRows) {
      const key = `${r.station_address}:${r.slot}`;
      if (!subslotMap.has(key)) subslotMap.set(key, []);
      subslotMap.get(key).push({ subslotNo: r.subslot_no, paProfile: r.pa_profile || null, label: r.label || null, localAddress: r.local_address != null ? r.local_address : null, symbols: [] });
    }

    const controllerId = hwImport.hw_controller_id || null;
    const stations = new Map();
    for (const sig of signals) {
      const addr = sig.station_address;
      if (!stations.has(addr)) {
        stations.set(addr, {
          address: addr, name: sig.station_name, ip: sig.ip_address,
          routerAddress: sig.router_address || null,
          subsystemNo: sig.subsystem_no,
          controllerId: controllerId,
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
          orderNo:        null,
          name:           null,
          pipNo:          null,
          potentialGroup: null,
          paProfile:      null,
          mlfb:           null,
          subslots:       subslotMap.get(`${addr}:${sig.slot}`) || [],
          channels:       [],
        });
      }
      const slotObj = station.slots.get(sig.slot);
      // The slot's own identity must come only from its own header row
      // (subslot_no IS NULL) — a subslot's symbol rows share the same `slot`
      // value but carry the SUBSLOT's order_no/name, which must never
      // overwrite the slot's own identity (row ordering could otherwise let a
      // subslot-symbol row be processed before the slot-header row).
      if (sig.subslot_no == null) {
        slotObj.orderNo        = sig.module_order_no;
        slotObj.name           = sig.module_name;
        slotObj.pipNo          = sig.pip_no != null ? sig.pip_no : null;
        slotObj.potentialGroup = sig.potential_group != null ? sig.potential_group : null;
        slotObj.paProfile      = sig.pa_profile || null;
        slotObj.mlfb           = sig.station_mlfb || null;
      }
      if (sig.subslot_no == null && (sig.tag || sig.channel != null)) {
        slotObj.channels.push({
          channel: sig.channel, tag: sig.tag, desc: sig.description, signalType: sig.signal_type,
        });
      }
      // A subslot's own SYMBOL rows (real per-instance data, e.g. IO-Link port
      // tags) share the same `slot` value but carry their own subslot_no —
      // attach them to that specific subslot entry (already present in
      // slotObj.subslots from hw_slot_subslots) rather than the slot's channels.
      if (sig.subslot_no != null && (sig.tag || sig.channel != null)) {
        const ss = slotObj.subslots.find(s => s.subslotNo === sig.subslot_no);
        if (ss) {
          ss.symbols.push({ channel: sig.channel, tag: sig.tag, desc: sig.description, signalType: sig.signal_type });
        }
      }
    }

    const parsedBaseline = parseCfg(hwImport.baseline_cfg);
    allocateAddresses(stations, templateMap,
      parsedBaseline.existingAddresses.maxInput,
      parsedBaseline.existingAddresses.maxOutput,
      null
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

// ── Catalogue Export / Import ──────────────────────────────────────────────────
// Mirrors the Library export/import feature: export the full hardware catalogue
// (module templates + parameters, slot/subslot compatibility, signal types) as a
// single JSON file, then preview a diff against the current DB before a selective,
// checkbox-driven commit.

const _catalogueImportCache = new Map(); // token -> { fileTemplates, fileSlotCompat, fileSignalTypes, timerId }

function catalogueCacheSet(token, data) {
  for (const [, v] of _catalogueImportCache) clearTimeout(v.timerId);
  _catalogueImportCache.clear();
  const timerId = setTimeout(() => _catalogueImportCache.delete(token), 15 * 60 * 1000);
  _catalogueImportCache.set(token, { ...data, timerId });
}

function catalogueTemplateKey(order_no, hw_category) {
  return `${order_no}::${hw_category || ''}`;
}

const CATALOGUE_TEMPLATE_FIELDS = [
  'display_name', 'family', 'signal_type', 'channel_count', 'input_bytes', 'output_bytes',
  'in_addr_fmt', 'out_addr_fmt', 'param_template', 'version', 'gsdml_file', 'dap_id',
  'subslot_defaults', 'port_config', 'in_identifier', 'out_identifier', 'default_datatype', 'mlfb',
];

function catalogueTemplateDiffers(existingRow, fileTpl) {
  for (const f of CATALOGUE_TEMPLATE_FIELDS) {
    const a = existingRow[f] ?? null;
    const b = fileTpl[f] ?? null;
    if (a !== b) return true;
  }
  return false;
}

function catalogueParamsDiffer(existingParams, fileParams) {
  const norm = (p) => [
    p.parameter_name, p.parameter_value ?? '', p.spare_value ?? '', !!p.is_dynamic,
    p.channel_type ?? '', p.channel_no ?? '', p.parameter_type || 'module',
    p.is_visible === undefined ? true : !!p.is_visible,
  ].join('|');
  const a = (existingParams || []).map(norm).sort();
  const b = (fileParams || []).map(norm).sort();
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

async function catalogueInsertParameters(db, templateId, parameters) {
  if (!Array.isArray(parameters) || !parameters.length) return 0;
  const insert = db.prepare(`
    INSERT INTO hw_module_parameters
      (template_id, parameter_name, parameter_value, spare_value, is_dynamic, channel_type, channel_no, parameter_type, is_visible, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (template_id, parameter_name, channel_no) DO UPDATE SET
      parameter_value = EXCLUDED.parameter_value,
      spare_value     = EXCLUDED.spare_value,
      is_dynamic      = EXCLUDED.is_dynamic,
      channel_type    = EXCLUDED.channel_type,
      parameter_type  = EXCLUDED.parameter_type,
      is_visible      = EXCLUDED.is_visible,
      sort_order      = EXCLUDED.sort_order
  `);
  let count = 0;
  for (const p of parameters) {
    await insert.run(
      templateId, p.parameter_name, p.parameter_value ?? null, p.spare_value ?? null,
      !!p.is_dynamic, p.channel_type ?? null, p.channel_no ?? null,
      p.parameter_type || 'module', p.is_visible === undefined ? true : !!p.is_visible,
      p.sort_order ?? 0,
    );
    count++;
  }
  return count;
}

// GET /catalogue/export
router.get('/catalogue/export', async (req, res) => {
  try {
    const db = getDb();
    const templateRows = await db.prepare('SELECT * FROM hw_module_templates ORDER BY family, display_name').all();

    const templates = [];
    for (const t of templateRows) {
      const paramRows = await ModuleParameterDb.getParametersByTemplate(t.id);
      templates.push({
        order_no: t.order_no,
        display_name: t.display_name,
        family: t.family,
        hw_category: t.hw_category,
        signal_type: t.signal_type,
        channel_count: t.channel_count,
        input_bytes: t.input_bytes,
        output_bytes: t.output_bytes,
        in_addr_fmt: t.in_addr_fmt,
        out_addr_fmt: t.out_addr_fmt,
        param_template: t.param_template,
        version: t.version,
        gsdml_file: t.gsdml_file,
        dap_id: t.dap_id,
        subslot_defaults: t.subslot_defaults,
        port_config: t.port_config,
        in_identifier: t.in_identifier,
        out_identifier: t.out_identifier,
        default_datatype: t.default_datatype,
        mlfb: t.mlfb,
        parameters: paramRows.map((p) => ({
          parameter_name: p.parameter_name,
          parameter_value: p.parameter_value,
          spare_value: p.spare_value,
          is_dynamic: !!p.is_dynamic,
          channel_type: p.channel_type,
          channel_no: p.channel_no,
          parameter_type: p.parameter_type,
          is_visible: !!p.is_visible,
          sort_order: p.sort_order,
        })),
      });
    }

    const slotCompat = await db.prepare(
      'SELECT slot_order_no, subslot_order_no, is_default FROM hw_slot_subslot_compat ORDER BY slot_order_no, subslot_order_no'
    ).all();
    const signalTypes = await db.prepare('SELECT name FROM hw_signal_types ORDER BY sort_order, name').all();

    const payload = {
      meta: {
        exportedAt: new Date().toISOString(),
        sourceStats: {
          templateCount: templates.length,
          slotCompatCount: slotCompat.length,
          signalTypeCount: signalTypes.length,
        },
      },
      templates,
      slotCompat,
      signalTypes,
    };

    res.setHeader('Content-Disposition', `attachment; filename="catalogue-export-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (e) { err(res, 500, e.message); }
});

// POST /catalogue/import/preview
router.post('/catalogue/import/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return err(res, 400, 'No file uploaded');
  try {
    let parsed;
    try {
      parsed = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch (e) {
      return err(res, 400, 'Invalid catalogue export file (not valid JSON)');
    }
    if (!parsed || typeof parsed !== 'object') return err(res, 400, 'Invalid catalogue export file');

    const fileTemplates = Array.isArray(parsed.templates) ? parsed.templates : [];
    const fileSlotCompat = Array.isArray(parsed.slotCompat) ? parsed.slotCompat : [];
    const fileSignalTypes = Array.isArray(parsed.signalTypes) ? parsed.signalTypes : [];

    const db = getDb();

    // ── Module templates diff, keyed by (order_no, hw_category) ──
    const dbTplRows = await db.prepare('SELECT * FROM hw_module_templates').all();
    const dbTplMap = new Map(dbTplRows.map((t) => [catalogueTemplateKey(t.order_no, t.hw_category), t]));
    const fileTplKeys = new Set();

    const templateItems = [];
    let tplNew = 0, tplUpdated = 0, tplUnchanged = 0, tplRemoved = 0;

    for (const ft of fileTemplates) {
      const key = catalogueTemplateKey(ft.order_no, ft.hw_category);
      fileTplKeys.add(key);
      const existing = dbTplMap.get(key);
      const base = { id: key, order_no: ft.order_no, display_name: ft.display_name, hw_category: ft.hw_category, family: ft.family };
      if (!existing) {
        templateItems.push({ ...base, status: 'NEW' });
        tplNew++;
      } else {
        const existingParams = await ModuleParameterDb.getParametersByTemplate(existing.id);
        const differs = catalogueTemplateDiffers(existing, ft) || catalogueParamsDiffer(existingParams, ft.parameters);
        if (differs) { templateItems.push({ ...base, status: 'UPDATED' }); tplUpdated++; }
        else { templateItems.push({ ...base, status: 'UNCHANGED' }); tplUnchanged++; }
      }
    }
    for (const [key, t] of dbTplMap) {
      if (!fileTplKeys.has(key)) {
        templateItems.push({ id: key, order_no: t.order_no, display_name: t.display_name, hw_category: t.hw_category, family: t.family, status: 'REMOVED_FROM_FILE' });
        tplRemoved++;
      }
    }

    // ── Slot/subslot compatibility diff, keyed by (slot_order_no, subslot_order_no) ──
    const dbCompatRows = await db.prepare('SELECT * FROM hw_slot_subslot_compat').all();
    const dbCompatMap = new Map(dbCompatRows.map((c) => [`${c.slot_order_no}::${c.subslot_order_no}`, c]));
    const fileCompatKeys = new Set();
    const tplNameByOrderNo = new Map(dbTplRows.map((t) => [t.order_no, t.display_name]));

    const compatItems = [];
    let compNew = 0, compUpdated = 0, compUnchanged = 0, compRemoved = 0;
    for (const fc of fileSlotCompat) {
      const key = `${fc.slot_order_no}::${fc.subslot_order_no}`;
      fileCompatKeys.add(key);
      const existing = dbCompatMap.get(key);
      const item = {
        id: key,
        slot_order_no: fc.slot_order_no,
        subslot_order_no: fc.subslot_order_no,
        slot_name: tplNameByOrderNo.get(fc.slot_order_no) || null,
        subslot_name: tplNameByOrderNo.get(fc.subslot_order_no) || null,
      };
      if (!existing) { item.status = 'NEW'; compNew++; }
      else if (!!existing.is_default !== !!fc.is_default) { item.status = 'UPDATED'; compUpdated++; }
      else { item.status = 'UNCHANGED'; compUnchanged++; }
      compatItems.push(item);
    }
    for (const [key, c] of dbCompatMap) {
      if (!fileCompatKeys.has(key)) {
        compatItems.push({
          id: key, slot_order_no: c.slot_order_no, subslot_order_no: c.subslot_order_no,
          slot_name: tplNameByOrderNo.get(c.slot_order_no) || null,
          subslot_name: tplNameByOrderNo.get(c.subslot_order_no) || null,
          status: 'REMOVED_FROM_FILE',
        });
        compRemoved++;
      }
    }

    // ── Signal types diff, keyed by name ──
    const dbSigRows = await db.prepare('SELECT name FROM hw_signal_types').all();
    const dbSigSet = new Set(dbSigRows.map((r) => r.name));
    const fileSigNames = new Set();
    const sigItems = [];
    let sigNew = 0, sigUnchanged = 0, sigRemoved = 0;
    for (const fs of fileSignalTypes) {
      const name = ((fs && fs.name) || fs || '').toString();
      if (!name) continue;
      fileSigNames.add(name);
      if (dbSigSet.has(name)) { sigItems.push({ id: name, name, status: 'UNCHANGED' }); sigUnchanged++; }
      else { sigItems.push({ id: name, name, status: 'NEW' }); sigNew++; }
    }
    for (const name of dbSigSet) {
      if (!fileSigNames.has(name)) { sigItems.push({ id: name, name, status: 'REMOVED_FROM_FILE' }); sigRemoved++; }
    }

    const token = Date.now().toString(36);
    catalogueCacheSet(token, { fileTemplates, fileSlotCompat, fileSignalTypes });

    res.json({
      token,
      meta: parsed.meta || null,
      templates: { summary: { new: tplNew, updated: tplUpdated, unchanged: tplUnchanged, removed: tplRemoved }, items: templateItems },
      slotCompat: { summary: { new: compNew, updated: compUpdated, unchanged: compUnchanged, removed: compRemoved }, items: compatItems },
      signalTypes: { summary: { new: sigNew, updated: 0, unchanged: sigUnchanged, removed: sigRemoved }, items: sigItems },
    });
  } catch (e) { err(res, 500, e.message); }
});

// POST /catalogue/import/commit
router.post('/catalogue/import/commit', async (req, res) => {
  const { token, selectedTemplateIds = [], selectedSlotCompatIds = [], selectedSignalTypes = [] } = req.body || {};
  if (!token) return err(res, 400, 'token is required');
  const cached = _catalogueImportCache.get(token);
  if (!cached) return err(res, 404, 'Upload token expired or not found — please re-upload the file');

  const selTpl = new Set(selectedTemplateIds);
  const selCompat = new Set(selectedSlotCompatIds);
  const selSig = new Set(selectedSignalTypes);

  try {
    const db = getDb();
    let templatesNew = 0, templatesUpdated = 0, templatesSkipped = 0;
    let slotCompatNew = 0, slotCompatSkipped = 0;
    let signalTypesNew = 0, signalTypesSkipped = 0;

    const doCommit = db.transaction(async () => {
      // ── Templates ──
      for (const ft of cached.fileTemplates) {
        const key = catalogueTemplateKey(ft.order_no, ft.hw_category);
        if (!selTpl.has(key)) { templatesSkipped++; continue; }

        const existing = await db.prepare(
          'SELECT id FROM hw_module_templates WHERE order_no=? AND (hw_category IS NOT DISTINCT FROM ? OR hw_category=?)'
        ).get(ft.order_no, ft.hw_category || null, ft.hw_category || null);

        const vals = [
          ft.display_name, ft.family, ft.signal_type || null, ft.channel_count || 0,
          ft.input_bytes || 0, ft.output_bytes || 0, ft.in_addr_fmt || null, ft.out_addr_fmt || null,
          ft.param_template || null, ft.version || null, ft.gsdml_file || null, ft.dap_id || null,
          ft.hw_category || null, ft.subslot_defaults || null, ft.port_config || null,
          ft.in_identifier || null, ft.out_identifier || null, ft.default_datatype || null, ft.mlfb || null,
        ];

        let templateId;
        if (existing) {
          await db.prepare(`UPDATE hw_module_templates SET
            display_name=?, family=?, signal_type=?, channel_count=?, input_bytes=?, output_bytes=?,
            in_addr_fmt=?, out_addr_fmt=?, param_template=?, version=?, gsdml_file=?, dap_id=?, hw_category=?,
            subslot_defaults=?, port_config=?, in_identifier=?, out_identifier=?, default_datatype=?, mlfb=?
            WHERE id=?`).run(...vals, existing.id);
          templateId = existing.id;
          templatesUpdated++;
        } else {
          const r = await db.prepare(`INSERT INTO hw_module_templates
            (display_name, family, signal_type, channel_count, input_bytes, output_bytes,
             in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category,
             subslot_defaults, port_config, in_identifier, out_identifier, default_datatype, mlfb, order_no)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, ft.order_no);
          templateId = r.lastInsertRowid;
          templatesNew++;
        }

        if (templateId) {
          await ModuleParameterDb.deleteParametersForTemplate(templateId);
          await catalogueInsertParameters(db, templateId, ft.parameters);
        }
      }

      // ── Slot/subslot compatibility ──
      for (const fc of cached.fileSlotCompat) {
        const key = `${fc.slot_order_no}::${fc.subslot_order_no}`;
        if (!selCompat.has(key)) { slotCompatSkipped++; continue; }
        const existing = await db.prepare(
          'SELECT id FROM hw_slot_subslot_compat WHERE slot_order_no=? AND subslot_order_no=?'
        ).get(fc.slot_order_no, fc.subslot_order_no);
        if (existing) {
          await db.prepare('UPDATE hw_slot_subslot_compat SET is_default=? WHERE id=?').run(!!fc.is_default, existing.id);
        } else {
          await db.prepare('INSERT INTO hw_slot_subslot_compat (slot_order_no, subslot_order_no, is_default) VALUES (?,?,?)')
            .run(fc.slot_order_no, fc.subslot_order_no, !!fc.is_default);
          slotCompatNew++;
        }
      }

      // ── Signal types ──
      for (const fs of cached.fileSignalTypes) {
        const name = ((fs && fs.name) || fs || '').toString();
        if (!name) continue;
        if (!selSig.has(name)) { signalTypesSkipped++; continue; }
        const r = await db.prepare('INSERT INTO hw_signal_types (name) VALUES (?) ON CONFLICT (name) DO NOTHING').run(name);
        if (r.rowCount > 0 || r.changes > 0) signalTypesNew++;
      }
    });

    await doCommit();
    clearTimeout(cached.timerId);
    _catalogueImportCache.delete(token);

    res.json({
      success: true,
      templatesNew, templatesUpdated, templatesSkipped,
      slotCompatNew, slotCompatSkipped,
      signalTypesNew, signalTypesSkipped,
    });
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

    // Dual-write: hw_station_auto_slots stays the live source the renderer/Add-Station
    // read (via autoSlotResolver.loadStationAutoSlotConfig), unchanged; hw_default_children
    // is kept in sync from the same save so the generic slot/subslot-derivation helpers
    // (firstAddableSlot, materializeDefaultTree, the compat-validated subslot PATCH) work
    // for hand-edited stations too, not just CFG-captured ones.
    await explodeConfigIntoDefaultChildren(db, order_no.trim(), config);

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

    // Dual-write into hw_default_children — see POST /station-auto-slots comment.
    await explodeConfigIntoDefaultChildren(db, orderNo, config);

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

    // Clean up the mirrored hw_default_children rows (slot rows for this head, plus
    // the subslot rows owned by each of those slots' own order_no).
    const slotOrderNos = await db.prepare(
      `SELECT child_order_no FROM hw_default_children WHERE parent_order_no=? AND position_kind='slot'`
    ).all(orderNo);
    await db.prepare(`DELETE FROM hw_default_children WHERE parent_order_no=?`).run(orderNo);
    for (const s of slotOrderNos) {
      await db.prepare(`DELETE FROM hw_default_children WHERE parent_order_no=?`).run(s.child_order_no);
    }

    res.json({ ok: true, deleted: orderNo });
  } catch (e) { err(res, 500, e.message); }
});

// POST /station-auto-slots/from-cfg — "Capture from CFG" action. Upload a single-station
// CFG file; parses it with the same catalogue parser used for module-templates import,
// and (re)seeds hw_station_auto_slots + hw_default_children for every station head found,
// overwriting any existing config for that order_no (this is an explicit user action,
// unlike the passive auto-seed in /module-templates/bulk-upsert which never overwrites).
router.post('/station-auto-slots/from-cfg', upload.single('cfg'), async (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No CFG file uploaded');
    const db = getDb();
    const text = req.file.buffer.toString('utf8');
    const { error, candidates } = parseCfgForCatalogue(text);
    if (error && candidates.length === 0) return err(res, 422, error);

    const stationCandidates = candidates.filter(c => !c.parseError && c.hw_category === 'station' && c.auto_slots_seed);
    if (!stationCandidates.length) return err(res, 400, 'No station head with a slot/subslot tree found in this CFG');

    const captured = [];
    for (const d of stationCandidates) {
      const seedConfig = JSON.parse(d.auto_slots_seed);
      if (!seedConfig.rules) seedConfig.rules = {};
      await inferAutoSlotTypes(db, seedConfig);
      const configJson = JSON.stringify(seedConfig);
      const existing = await db.prepare('SELECT id FROM hw_station_auto_slots WHERE order_no=?').get(d.order_no);
      if (existing) {
        await db.prepare('UPDATE hw_station_auto_slots SET auto_slots_config=?, updated_at=NOW() WHERE order_no=?')
          .run(configJson, d.order_no);
      } else {
        await db.prepare('INSERT INTO hw_station_auto_slots (order_no, auto_slots_config) VALUES (?, ?)')
          .run(d.order_no, configJson);
      }
      await explodeConfigIntoDefaultChildren(db, d.order_no, seedConfig);
      captured.push(d.order_no);
    }

    res.json({ ok: true, captured });
  } catch (e) { err(res, 500, e.message); }
});

// GET /slot-default-subslots/:orderNo — Get a slot-category catalogue device's own
// default subslot tree (hw_default_children rows keyed by this slot's order_no as parent).
router.get('/slot-default-subslots/:orderNo', async (req, res) => {
  try {
    const db = getDb();
    const orderNo = (req.params.orderNo || '').trim();
    if (!orderNo) return err(res, 400, 'orderNo parameter required');

    const rows = await db.prepare(
      `SELECT position, child_order_no, hw_category, label, is_autocreated
       FROM hw_default_children WHERE parent_order_no=? AND position_kind='subslot' ORDER BY position`
    ).all(orderNo);

    res.json({ order_no: orderNo, subslots: rows });
  } catch (e) { err(res, 500, e.message); }
});

// PUT /slot-default-subslots/:orderNo — Full replace of a slot's default subslot tree.
// Body: { subslots: [{position, child_order_no, label, is_autocreated}, ...] }
router.put('/slot-default-subslots/:orderNo', async (req, res) => {
  try {
    const db = getDb();
    const orderNo = (req.params.orderNo || '').trim();
    const { subslots } = req.body;
    if (!orderNo) return err(res, 400, 'orderNo parameter required');
    if (!Array.isArray(subslots)) return err(res, 400, 'subslots array required');

    await db.transaction(async () => {
      await db.prepare(`DELETE FROM hw_default_children WHERE parent_order_no=? AND position_kind='subslot'`).run(orderNo);
      for (const ss of subslots) {
        if (ss.position == null || !ss.child_order_no) continue;
        await db.prepare(
          `INSERT INTO hw_default_children (parent_order_no, position, position_kind, child_order_no, hw_category, is_autocreated, label, sort_order)
           VALUES (?, ?, 'subslot', ?, 'subslot', ?, ?, ?)`
        ).run(orderNo, ss.position, ss.child_order_no, !!ss.is_autocreated, ss.label || null, ss.position);
      }
    })();

    res.json({ ok: true, order_no: orderNo });
  } catch (e) { err(res, 500, e.message); }
});

// ── Export HW Config to Excel (full slot hierarchy) ──
router.get('/imports/:id/export', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);

    // One row per station+slot+subslot (GROUP BY deduplicates channels). subslot_no is
    // grouped in explicitly so slot-level and subslot-level rows stay distinct; PA
    // Profile is sourced from hw_slot_subslots.child_order_no (the generic per-node
    // "what's plugged in here" column) with a COALESCE fallback to the legacy
    // hw_signals.pa_profile for rows captured before child_order_no was populated.
    const rows = await db.prepare(`
      SELECT
        s.hw_import_id,
        s.station_address,
        MIN(s.station_name)   AS station_name,
        MIN(s.ip_address)     AS ip_address,
        MIN(s.subsystem_no)   AS subsystem_no,
        MIN(s.router_address) AS router_address,
        MIN(s.as_assignment)  AS as_assignment,
        s.slot,
        s.subslot_no,
        s.module_order_no,
        MIN(s.module_name)    AS module_name,
        MIN(s.signal_type)    AS signal_type,
        MIN(s.pip_no)         AS pip_no,
        MIN(s.potential_group) AS potential_group,
        COALESCE(MIN(ss.child_order_no), MIN(s.pa_profile)) AS pa_profile,
        COUNT(*)              AS channel_count
      FROM hw_signals s
      LEFT JOIN hw_slot_subslots ss
        ON ss.hw_import_id    = s.hw_import_id
       AND ss.station_address = s.station_address
       AND ss.slot            = s.slot
       AND ss.subslot_no IS NOT DISTINCT FROM s.subslot_no
      WHERE s.hw_import_id = ? AND s.module_order_no != 'PLACEHOLDER'
      GROUP BY s.hw_import_id, s.station_address, s.slot, s.subslot_no, s.module_order_no
      ORDER BY s.station_address, s.slot, s.subslot_no
    `).all(importId);

    if (rows.length === 0) {
      return err(res, 404, 'No configuration found for this import');
    }

    // Build Excel workbook with two sheets: Stations (deduplicated) and Slots (detailed)
    const workbook = new ExcelJS.Workbook();

    // ── Sheet 1: Stations (one row per station) ──
    const stationsSheet = workbook.addWorksheet('Stations');
    stationsSheet.columns = [
      { header: 'Device #', key: 'station_address', width: 12 },
      { header: 'Device Name', key: 'station_name', width: 20 },
      { header: 'IP Address', key: 'ip_address', width: 18 },
      { header: 'Subsystem No', key: 'subsystem_no', width: 14 },
      { header: 'Router Address', key: 'router_address', width: 18 },
      { header: 'AS Assignment', key: 'as_assignment', width: 20 },
    ];

    // Deduplicate stations (take first row per station)
    const stationMap = new Map();
    for (const row of rows) {
      if (!stationMap.has(row.station_address)) {
        stationMap.set(row.station_address, {
          station_address: row.station_address,
          station_name: row.station_name,
          ip_address: row.ip_address,
          subsystem_no: row.subsystem_no,
          router_address: row.router_address,
          as_assignment: row.as_assignment,
        });
      }
    }
    for (const st of stationMap.values()) {
      stationsSheet.addRow(st);
    }
    stationsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    stationsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '366092' } };

    // ── Sheet 2: Slots (all rows with per-slot config) ──
    const slotsSheet = workbook.addWorksheet('Slots');
    slotsSheet.columns = [
      { header: 'Station Address', key: 'station_address', width: 14 },
      { header: 'Station Name', key: 'station_name', width: 18 },
      { header: 'Slot', key: 'slot', width: 8 },
      { header: 'Subslot', key: 'subslot_no', width: 10 },
      { header: 'Order No', key: 'module_order_no', width: 22 },
      { header: 'Module Name', key: 'module_name', width: 20 },
      { header: 'Signal Type', key: 'signal_type', width: 14 },
      { header: 'Channels', key: 'channel_count', width: 10 },
      { header: 'PIP No', key: 'pip_no', width: 10 },
      { header: 'Potential Group', key: 'potential_group', width: 18 },
      { header: 'PA Profile', key: 'pa_profile', width: 20 },
    ];

    for (const row of rows) {
      slotsSheet.addRow(row);
    }
    slotsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    slotsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '366092' } };

    // Generate Excel file and send as download
    const buffer = await workbook.xlsx.writeBuffer();
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="hw-config-${importId}-${timestamp}.xlsx"`);
    res.send(buffer);
  } catch (e) { err(res, 500, e.message); }
});

// ── Import HW Config from Excel (strict validation) ──
router.post('/imports/:id/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return err(res, 400, 'No file uploaded');
    }

    const db = getDb();
    const importId = parseInt(req.params.id, 10);

    // Parse Excel file
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const slotsSheet = workbook.getWorksheet('Slots');
    const stationsSheet = workbook.getWorksheet('Stations');

    if (!slotsSheet) {
      return err(res, 400, 'Excel file must contain a "Slots" sheet');
    }

    // ── Load station IP/Router from Stations sheet ──
    const stationIpMap = new Map(); // stationAddr -> {ip, router}
    if (stationsSheet) {
      const stHeaders = {};
      stationsSheet.getRow(1).eachCell((cell, colNumber) => {
        stHeaders[cell.value] = colNumber;
      });
      for (let rowNum = 2; rowNum <= stationsSheet.rowCount; rowNum++) {
        const row = stationsSheet.getRow(rowNum);
        const addr = row.getCell(stHeaders['Device #'] || 1).value;
        const ip = row.getCell(stHeaders['IP Address'] || 3).value;
        const router = row.getCell(stHeaders['Router Address'] || 5).value;
        if (addr != null) {
          stationIpMap.set(parseInt(addr, 10), {
            ipAddress: ip || null,
            routerAddress: router || null,
          });
        }
      }
    }

    // ── Validation Phase (strict: all-or-nothing) ──
    const validationErrors = [];
    const slotRows = [];

    // Get header row
    const headers = {};
    slotsSheet.getRow(1).eachCell((cell, colNumber) => {
      headers[cell.value] = colNumber;
    });

    // Validate all rows
    for (let rowNum = 2; rowNum <= slotsSheet.rowCount; rowNum++) {
      const row = slotsSheet.getRow(rowNum);
      const data = {};

      // Extract cell values by header
      for (const [header, colNum] of Object.entries(headers)) {
        data[header] = row.getCell(colNum).value;
      }

      // Skip fully empty rows (e.g. trailing blank rows in the sheet)
      if (data['Station Address'] == null && data['Slot'] == null) continue;

      // Validate Station Address and Slot are present and integers
      // Use != null (not falsy) so slot 0 and address 0 are accepted
      const stationAddr = parseInt(data['Station Address'], 10);
      const slotNum = parseInt(data['Slot'], 10);

      if (data['Station Address'] == null || isNaN(stationAddr) || stationAddr < 0) {
        validationErrors.push({
          row: rowNum,
          field: 'Station Address',
          message: 'Station Address must be a non-negative integer',
        });
      }
      if (data['Slot'] == null || isNaN(slotNum) || slotNum < 0) {
        validationErrors.push({
          row: rowNum,
          field: 'Slot',
          message: 'Slot must be a non-negative integer',
        });
      }

      // Validate PIP No is null or integer
      if (data['PIP No'] != null && data['PIP No'] !== '') {
        const pipNum = parseInt(data['PIP No'], 10);
        if (isNaN(pipNum) || pipNum < 0) {
          validationErrors.push({
            row: rowNum,
            field: 'PIP No',
            message: 'PIP No must be a non-negative integer or empty',
          });
        }
      }

      // 'Subslot' is a newer column — absent in older exported files being re-imported.
      // Missing/empty ⇒ null, matching today's behavior (slot-level row, no subslot).
      let subslotNo = null;
      if (data['Subslot'] != null && data['Subslot'] !== '') {
        subslotNo = parseInt(data['Subslot'], 10);
        if (isNaN(subslotNo) || subslotNo < 0) {
          validationErrors.push({
            row: rowNum,
            field: 'Subslot',
            message: 'Subslot must be a non-negative integer or empty',
          });
        }
      }

      // Skip further checks if basic address/slot failed
      if (validationErrors.length > 0) continue;

      // Check that station + slot (+ subslot) exists in database
      const existing = await db.prepare(
        'SELECT id FROM hw_signals WHERE hw_import_id = ? AND station_address = ? AND slot = ? AND subslot_no IS NOT DISTINCT FROM ?'
      ).get(importId, stationAddr, slotNum, subslotNo);

      if (!existing) {
        validationErrors.push({
          row: rowNum,
          field: 'Station Address / Slot',
          message: subslotNo != null
            ? `Station ${stationAddr}, Slot ${slotNum}, Subslot ${subslotNo} does not exist in this import`
            : `Station ${stationAddr}, Slot ${slotNum} does not exist in this import`,
        });
      }

      if (validationErrors.length === 0) {
        const stationData = stationIpMap.get(stationAddr) || { ipAddress: null, routerAddress: null };
        slotRows.push({
          rowNum,
          stationAddr,
          slotNum,
          subslotNo,
          ipAddress: stationData.ipAddress,
          routerAddress: stationData.routerAddress,
          moduleName: data['Module Name'] || null,
          pipNo: (data['PIP No'] != null && data['PIP No'] !== '') ? parseInt(data['PIP No'], 10) : null,
          potentialGroup: data['Potential Group'] || null,
          paProfile: data['PA Profile'] || null,
        });
      }
    }

    // If validation failed, return all errors
    if (validationErrors.length > 0) {
      return res.status(400).json({ errors: validationErrors });
    }

    // ── Snapshot current values so we can compute a diff ──
    const currentRows = await db.prepare(`
      SELECT s.station_address, s.slot, s.subslot_no, s.module_order_no,
             MIN(s.station_name) AS station_name,
             MIN(s.ip_address) AS ip_address,
             MIN(s.router_address) AS router_address,
             MIN(s.module_name) AS module_name,
             MIN(s.pip_no) AS pip_no,
             MIN(s.potential_group) AS potential_group,
             COALESCE(MIN(ss.child_order_no), MIN(s.pa_profile)) AS pa_profile
      FROM hw_signals s
      LEFT JOIN hw_slot_subslots ss
        ON ss.hw_import_id    = s.hw_import_id
       AND ss.station_address = s.station_address
       AND ss.slot            = s.slot
       AND ss.subslot_no IS NOT DISTINCT FROM s.subslot_no
      WHERE s.hw_import_id = ?
      GROUP BY s.station_address, s.slot, s.subslot_no, s.module_order_no
    `).all(importId);

    const currentMap = new Map();
    for (const r of currentRows) {
      currentMap.set(`${r.station_address}:${r.slot}:${r.subslot_no ?? 'null'}`, r);
    }

    // ── Update Phase (strict validation passed) ──
    // Only track slot-level changes (not station-level IP/Router, which are shared across all slots)
    const FIELD_LABELS = {
      module_name:     'Module Name',
      pip_no:          'PIP No',
      potential_group: 'Potential Group',
      pa_profile:      'PA Profile',
    };
    const changes = [];
    let updated = 0;

    await db.transaction(async () => {
      for (const row of slotRows) {
        const cur = currentMap.get(`${row.stationAddr}:${row.slotNum}:${row.subslotNo ?? 'null'}`);
        const newVals = {
          ip_address:      row.ipAddress      ?? null,
          router_address:  row.routerAddress  ?? null,
          module_name:     row.moduleName     ?? null,
          pip_no:          row.pipNo          ?? null,
          potential_group: row.potentialGroup ?? null,
          pa_profile:      row.paProfile      ?? null,
        };

        // Collect field-level diffs for the summary
        if (cur) {
          for (const [field, label] of Object.entries(FIELD_LABELS)) {
            const oldVal = cur[field] ?? null;
            const newVal = newVals[field];
            const oldStr = oldVal == null ? '—' : String(oldVal);
            const newStr = newVal == null ? '—' : String(newVal);
            if (oldStr !== newStr) {
              changes.push({
                station: cur.station_name || `Station ${row.stationAddr}`,
                stationAddr: row.stationAddr,
                slot: row.slotNum,
                subslot: row.subslotNo,
                orderNo: cur.module_order_no,
                field: label,
                from: oldStr,
                to: newStr,
              });
            }
          }
        }

        await db.prepare(`
          UPDATE hw_signals
          SET ip_address = ?, router_address = ?, module_name = ?, pip_no = ?, potential_group = ?, pa_profile = ?
          WHERE hw_import_id = ? AND station_address = ? AND slot = ? AND subslot_no IS NOT DISTINCT FROM ?
        `).run(
          newVals.ip_address,
          newVals.router_address,
          newVals.module_name,
          newVals.pip_no,
          newVals.potential_group,
          newVals.pa_profile,
          importId,
          row.stationAddr,
          row.slotNum,
          row.subslotNo
        );

        // Mirror PA Profile into hw_slot_subslots.child_order_no (the generic
        // per-node "what's plugged in here" source the views now read from), same
        // as the dedicated PA-profile PATCH routes do. Only when a Subslot was given
        // — a slot-level row (no subslot) has no hw_slot_subslots identity to target.
        if (row.subslotNo != null && row.paProfile !== undefined) {
          await db.prepare(`
            INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, child_order_no, pa_profile)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
              child_order_no = EXCLUDED.child_order_no, pa_profile = EXCLUDED.pa_profile
          `).run(importId, row.stationAddr, row.slotNum, row.subslotNo, newVals.pa_profile, newVals.pa_profile);
        }

        updated++;
      }
    })();

    res.json({ updated, changes, errors: [] });
  } catch (e) { err(res, 500, e.message); }
});

// GET /hw-config/templates/io-list-excel — Download Excel template with AS01 current configuration
router.get('/templates/io-list-excel', async (req, res) => {
  try {
    const db = getDb();

    // Get AS01 hardware configuration (all slots from all stations matching 'AS01')
    const hwData = await db.prepare(`
      SELECT DISTINCT
        s.station_address,
        s.station_name,
        s.slot,
        s.module_order_no,
        s.module_name,
        s.signal_type,
        s.subsystem_no
      FROM hw_signals s
      WHERE s.station_name LIKE '%AS01%'
        AND s.slot > 0
      ORDER BY s.station_address, s.slot
    `).all();

    // Get station reference info
    const stationRef = await db.prepare(`
      SELECT DISTINCT station_address, station_name
      FROM hw_signals
      WHERE station_name LIKE '%AS01%'
      LIMIT 1
    `).get();

    const stationName = stationRef?.station_name || 'AS01';
    const ctrlAddr = stationRef?.station_address || 4;

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('HW IO List');

    // Define headers
    const headers = [
      'Station Name',
      'Controller Address',
      'Unit Name',
      'Unit Type',
      'Slot',
      'Module Type (Order No)',
      'Module Name',
      'Signal Type'
    ];

    // Add header row with styling
    const headerRow = worksheet.addRow(headers);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF366092' } };

    // Set column widths
    worksheet.columns = [
      { width: 12 },
      { width: 18 },
      { width: 20 },
      { width: 20 },
      { width: 6 },
      { width: 35 },
      { width: 28 },
      { width: 15 }
    ];

    // Freeze header row
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Add AS01 data rows from current configuration
    const addedSlots = new Set();
    for (const hw of hwData) {
      const slotKey = `${hw.station_address}:${hw.slot}`;
      if (addedSlots.has(slotKey)) continue;
      addedSlots.add(slotKey);

      worksheet.addRow([
        stationName,                    // Station Name
        ctrlAddr,                       // Controller Address
        '',                             // Unit Name (user fills)
        '',                             // Unit Type (user fills)
        hw.slot,                        // Slot
        hw.module_order_no || '',       // Module Type (Order No)
        hw.module_name || '',           // Module Name
        hw.signal_type || ''            // Signal Type
      ]);
    }

    // Add 5 blank rows for user to fill
    for (let i = 0; i < 5; i++) {
      worksheet.addRow([stationName, ctrlAddr, '', '', '', '', '', '']);
    }

    // Stream as download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="HW_IO_List_AS01_$(date).xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
