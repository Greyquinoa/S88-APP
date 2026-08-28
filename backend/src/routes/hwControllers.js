'use strict';
// Routes: GET/POST /api/hw-controllers  (scoped to project)
//         GET/PUT/DELETE /api/hw-controllers/:id
const express = require('express');
const { getDb } = require('../db');
const { newGuid } = require('../services/cfgBlocks');

const router = express.Router();

const WRITABLE = [
  'T16_Controller_TagName', 'T16_Station_Type', 'T24_Program_Container',
  'INT_Controller_No', 'T8_Version', 'T15_IP_Address',
  'T50_Rack_Order_No', 'T50_Rack_Name', 'T50_PS_Order_No', 'T50_PS_Name',
  'YN_Redundant', 'YN_Slave', 'MEM_Doc_Change', 'user_project',
];

// Postgres folds unquoted identifiers to lowercase, so hw_controllers columns
// come back as e.g. t16_controller_tagname. Restore the canonical mixed-case
// keys the frontend expects before sending rows out.
const LOWER_TO_CANONICAL = new Map(WRITABLE.map(f => [f.toLowerCase(), f]));
function toCanonical(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[LOWER_TO_CANONICAL.get(k) || k] = v;
  return out;
}

// GET /api/hw-controllers?projectId=N
router.get('/', async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const db = getDb();
  const rows = await db.prepare(
    'SELECT * FROM hw_controllers WHERE project_id = ? ORDER BY id'
  ).all(Number(projectId));
  res.json(rows.map(toCanonical));
});

// POST /api/hw-controllers
router.post('/', async (req, res) => {
  const { projectId, ...rest } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const db = getDb();
  const data = pick(rest);
  const cols = ['project_id', ...Object.keys(data)];
  const vals = [Number(projectId), ...Object.values(data)];
  const placeholders = cols.map(() => '?').join(', ');
  const result = await db.prepare(
    `INSERT INTO hw_controllers (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(vals);
  const created = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(toCanonical(created));
});

// GET /api/hw-controllers/:id
router.get('/:id', async (req, res) => {
  const db = getDb();
  const row = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(toCanonical(row));
});

// PUT /api/hw-controllers/:id
router.put('/:id', async (req, res) => {
  const db = getDb();
  const existing = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const data = pick(req.body);
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No writable fields' });
  const setClause = Object.keys(data).map(c => `${c} = ?`).join(', ');
  await db.prepare(
    `UPDATE hw_controllers SET ${setClause}, updated_at = NOW() WHERE id = ?`
  ).run([...Object.values(data), Number(req.params.id)]);
  const updated = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  res.json(toCanonical(updated));
});

// DELETE /api/hw-controllers/:id
// Cascades to all imports, signals, fieldbuses, and generated configs.
// Catalogue tables (templates, hardware_resolution) are NOT deleted — they are project-wide.
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const controllerId = Number(req.params.id);
    const existing = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(controllerId);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    await db.transaction(async () => {
      // ── Step 1: Find all imports scoped to this controller ───────────────────
      const imports = await db.prepare('SELECT id FROM hw_imports WHERE hw_controller_id = ?').all(controllerId);
      const importIds = imports.map(r => r.id);

      // ── Step 2: For each import, cascade delete ────────────────────────────
      for (const importId of importIds) {
        // Delete instance_ios that reference signals from this import
        const signals = await db.prepare('SELECT id FROM hw_signals WHERE hw_import_id = ?').all(importId);
        const signalIds = signals.map(r => r.id);
        for (const sigId of signalIds) {
          await db.prepare('DELETE FROM instance_ios WHERE hw_signal_id = ?').run(sigId);
        }

        // Delete import-scoped tables
        await db.prepare('DELETE FROM hw_signals WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM mrp_configs WHERE hw_import_id = ?').run(importId);

        // Delete the import itself
        await db.prepare('DELETE FROM hw_imports WHERE id = ?').run(importId);
      }

      // ── Step 3: Delete fieldbuses scoped to this controller ────────────────
      await db.prepare('DELETE FROM hw_fieldbuses WHERE hw_controller_id = ?').run(controllerId);

      // ── Step 4: Delete the controller itself ──────────────────────────────
      await db.prepare('DELETE FROM hw_controllers WHERE id = ?').run(controllerId);
    })();

    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fields copied onto a duplicated hw_fieldbuses row — everything except id,
// hw_controller_id (set to the new controller) and the timestamps.
const FIELDBUS_COPY_FIELDS = [
  'INT_DP_Subsystem', 'INT_Bus_DP_Address', 'T50_Fieldbus_Name', 'LINT_T_Driver', 'T15_IP_Address',
];
const FB_LOWER_TO_CANONICAL = new Map(FIELDBUS_COPY_FIELDS.map(f => [f.toLowerCase(), f]));
function fbToCanonical(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[FB_LOWER_TO_CANONICAL.get(k) || k] = v;
  return out;
}

// Finds a T16_Controller_TagName that doesn't collide with an existing one in
// this project — required by the live uq_hwctrl_proj_name unique index on
// (project_id, T16_Controller_TagName). Tries "<base>_copy", then "_copy2",
// "_copy3", ... until a free name is found.
async function findFreeControllerName(db, projectId, baseName) {
  const existing = await db.prepare(
    'SELECT T16_Controller_TagName FROM hw_controllers WHERE project_id = ?'
  ).all(projectId);
  const taken = new Set(existing.map(r => (r.t16_controller_tagname ?? r.T16_Controller_TagName ?? '').toLowerCase()));

  let candidate = `${baseName}_copy`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${baseName}_copy${n}`;
    n++;
  }
  return candidate;
}

// Columns copied verbatim from a source hw_signals row onto its duplicate
// (everything except id and hw_import_id, which is repointed to the new import).
const SIGNAL_COPY_FIELDS = [
  'row_number', 'station_address', 'station_name', 'ip_address', 'slot', 'channel',
  'module_order_no', 'module_name', 'tag', 'description', 'signal_type',
  'subsystem_no', 'router_address', 'as_assignment', 'approved', 'pip_no',
  'potential_group', 'pa_profile', 'resolved_by_tier2', 'unresolved', 'station_mlfb',
];

// Rewrites a copied baseline_cfg's per-station identity so it doesn't collide
// with the source when both exist in the same PCS7 project:
//  - every ASSET_ID GUID gets replaced with a fresh one (PCS7 requires these
//    to be globally unique; cfgGenerator.js never regenerates them for
//    baseline-derived blocks, only for newly-synthesized ones)
//  - the STATION header's quoted name is swapped to the new controller's name
// NET_ID/IP/router values are left untouched — out of scope for this fix,
// same as any other manual edit the user makes after pasting.
function rewriteBaselineCfg(cfgText, oldName, newName) {
  if (!cfgText) return cfgText;
  let out = cfgText.replace(/ASSET_ID\s+"[0-9A-Fa-f]{32}"/g, () => `ASSET_ID "${newGuid()}"`);
  if (oldName) {
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(STATION\\s+\\S+\\s*,\\s*)"${escaped}"`), `$1"${newName}"`);
  }
  return out;
}

// POST /api/hw-controllers/:id/copy
// Duplicates a controller row, its fieldbuses, and — if the source has one —
// its hw_imports baseline (CFG text + parsed info), hw_signals, hw_slot_subslots,
// and MRP config, so the pasted controller can generate a CFG immediately
// instead of starting with no baseline at all. hw_excel_raw (upload history)
// and hw_generated_cfgs (generation history) are deliberately NOT copied — the
// pasted controller hasn't uploaded or generated anything of its own yet.
// A live unique index (uq_hwctrl_proj_name) enforces one T16_Controller_TagName
// per project, so the name can't be reused verbatim — it gets a "_copy" (then
// "_copyN") suffix, and the frontend autofocuses the name field so the user can
// rename it immediately. uq_hwi_proj_ctrl / hw_slot_subslots' unique key are
// both scoped by hw_controller_id / hw_import_id, so they can't collide since
// the copy always gets a fresh id on both.
router.post('/:id/copy', async (req, res) => {
  try {
    const db = getDb();
    const sourceId = Number(req.params.id);
    const source = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(sourceId);
    if (!source) return res.status(404).json({ error: 'Not found' });

    const sourceCanon = toCanonical(source);
    const data = pick(sourceCanon);
    const oldName = data.T16_Controller_TagName;
    if (oldName) {
      data.T16_Controller_TagName = await findFreeControllerName(db, sourceCanon.project_id, oldName);
    }
    const newName = data.T16_Controller_TagName;
    const cols = ['project_id', ...Object.keys(data)];
    const vals = [sourceCanon.project_id, ...Object.values(data)];
    const placeholders = cols.map(() => '?').join(', ');

    let newControllerId;
    let newImportId = null;
    await db.transaction(async () => {
      const result = await db.prepare(
        `INSERT INTO hw_controllers (${cols.join(', ')}) VALUES (${placeholders})`
      ).run(vals);
      newControllerId = result.lastInsertRowid;

      const sourceFieldbuses = await db.prepare(
        'SELECT * FROM hw_fieldbuses WHERE hw_controller_id = ? ORDER BY id'
      ).all(sourceId);

      for (const fb of sourceFieldbuses) {
        const fbData = fbToCanonical(fb);
        const fbCols = ['hw_controller_id', ...FIELDBUS_COPY_FIELDS];
        const fbVals = [newControllerId, ...FIELDBUS_COPY_FIELDS.map(f => fbData[f] ?? null)];
        const fbPlaceholders = fbCols.map(() => '?').join(', ');
        await db.prepare(
          `INSERT INTO hw_fieldbuses (${fbCols.join(', ')}) VALUES (${fbPlaceholders})`
        ).run(fbVals);
      }

      // ── Baseline import (only if the source itself has one) ────────────────
      const sourceImport = await db.prepare(
        'SELECT * FROM hw_imports WHERE project_id = ? AND hw_controller_id = ?'
      ).get(sourceCanon.project_id, sourceId);
      if (!sourceImport) return;

      let baselineInfo = null;
      if (sourceImport.baseline_info) {
        try { baselineInfo = JSON.parse(sourceImport.baseline_info); } catch { /* leave null */ }
        if (baselineInfo) baselineInfo.stationName = newName;
      }
      const newBaselineCfg = rewriteBaselineCfg(sourceImport.baseline_cfg, oldName, newName);

      const impResult = await db.prepare(`
        INSERT INTO hw_imports (project_id, hw_controller_id, baseline_cfg, excel_name, column_map, status, baseline_info, imported_at)
        VALUES (?,?,?,?,?,?,?,NOW())
      `).run(
        sourceCanon.project_id, newControllerId, newBaselineCfg, sourceImport.excel_name,
        sourceImport.column_map, 'pending', baselineInfo ? JSON.stringify(baselineInfo) : null,
      );
      newImportId = impResult.lastInsertRowid;

      // ── hw_signals ──────────────────────────────────────────────────────────
      const sourceSignals = await db.prepare(
        'SELECT * FROM hw_signals WHERE hw_import_id = ? ORDER BY id'
      ).all(sourceImport.id);
      for (const sig of sourceSignals) {
        const sigCols = ['hw_import_id', ...SIGNAL_COPY_FIELDS];
        const sigVals = [newImportId, ...SIGNAL_COPY_FIELDS.map(f => sig[f.toLowerCase()] ?? null)];
        const sigPlaceholders = sigCols.map(() => '?').join(', ');
        await db.prepare(
          `INSERT INTO hw_signals (${sigCols.join(', ')}) VALUES (${sigPlaceholders})`
        ).run(sigVals);
      }

      // ── hw_slot_subslots ────────────────────────────────────────────────────
      const sourceSubslots = await db.prepare(
        'SELECT * FROM hw_slot_subslots WHERE hw_import_id = ? ORDER BY id'
      ).all(sourceImport.id);
      for (const ss of sourceSubslots) {
        await db.prepare(`
          INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile)
          VALUES (?,?,?,?,?)
        `).run(newImportId, ss.station_address, ss.slot, ss.subslot_no, ss.pa_profile ?? null);
      }

      // ── mrp_configs (+ device roles / port links) ──────────────────────────
      const sourceMrpConfigs = await db.prepare(
        'SELECT * FROM mrp_configs WHERE hw_import_id = ? ORDER BY id'
      ).all(sourceImport.id);
      for (const mrp of sourceMrpConfigs) {
        const mrpResult = await db.prepare(`
          INSERT INTO mrp_configs (hw_import_id, domain_name, fieldbus_no, station_name)
          VALUES (?,?,?,?)
        `).run(newImportId, mrp.domain_name, mrp.fieldbus_no, mrp.station_name);
        const newMrpConfigId = mrpResult.lastInsertRowid;

        const roles = await db.prepare('SELECT * FROM mrp_device_roles WHERE mrp_config_id = ? ORDER BY id').all(mrp.id);
        for (const r of roles) {
          await db.prepare(`
            INSERT INTO mrp_device_roles (mrp_config_id, device_alias, io_address, subsystem_no, mrp_role, mrp_instances, ring_port_1, ring_port_2)
            VALUES (?,?,?,?,?,?,?,?)
          `).run(newMrpConfigId, r.device_alias, r.io_address, r.subsystem_no, r.mrp_role, r.mrp_instances, r.ring_port_1, r.ring_port_2);
        }

        const links = await db.prepare('SELECT * FROM mrp_port_links WHERE mrp_config_id = ? ORDER BY id').all(mrp.id);
        for (const l of links) {
          await db.prepare(`
            INSERT INTO mrp_port_links (mrp_config_id, from_device, from_iface_subslot, from_port_subslot, to_device, to_iface_subslot, to_port_subslot)
            VALUES (?,?,?,?,?,?,?)
          `).run(newMrpConfigId, l.from_device, l.from_iface_subslot, l.from_port_subslot, l.to_device, l.to_iface_subslot, l.to_port_subslot);
        }
      }
    })();

    const created = await db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(newControllerId);
    const createdFieldbuses = await db.prepare(
      'SELECT * FROM hw_fieldbuses WHERE hw_controller_id = ? ORDER BY id'
    ).all(newControllerId);
    const createdImport = newImportId
      ? await db.prepare('SELECT * FROM hw_imports WHERE id = ?').get(newImportId)
      : null;
    res.status(201).json({
      controller: toCanonical(created),
      fieldbuses: createdFieldbuses.map(fbToCanonical),
      import: createdImport,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function pick(body) {
  const out = {};
  for (const f of WRITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  }
  return out;
}

module.exports = router;
