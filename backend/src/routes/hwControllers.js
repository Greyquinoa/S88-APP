'use strict';
// Routes: GET/POST /api/hw-controllers  (scoped to project)
//         GET/PUT/DELETE /api/hw-controllers/:id
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const WRITABLE = [
  'T16_Controller_TagName', 'T16_Station_Type', 'T24_Program_Container',
  'INT_Controller_No', 'T8_Version', 'T15_IP_Address',
  'T50_Rack_Order_No', 'T50_Rack_Name', 'T50_PS_Order_No', 'T50_PS_Name',
  'YN_Redundant', 'YN_Slave', 'MEM_Doc_Change',
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

function pick(body) {
  const out = {};
  for (const f of WRITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  }
  return out;
}

module.exports = router;
