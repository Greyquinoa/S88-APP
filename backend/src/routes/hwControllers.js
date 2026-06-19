'use strict';
// Routes: GET/POST /api/hw-controllers  (scoped to project)
//         GET/PUT/DELETE /api/hw-controllers/:id
const express = require('express');
const { getDb, saveDb } = require('../db');

const router = express.Router();

const WRITABLE = [
  'T16_Controller_TagName', 'T16_Station_Type', 'T24_Program_Container',
  'INT_Controller_No', 'T8_Version', 'T15_IP_Address',
  'T50_Rack_Order_No', 'T50_Rack_Name', 'T50_PS_Order_No', 'T50_PS_Name',
  'YN_Redundant', 'YN_Slave', 'MEM_Doc_Change',
];

// GET /api/hw-controllers?projectId=N
router.get('/', (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM hw_controllers WHERE project_id = ? ORDER BY id'
  ).all(Number(projectId));
  res.json(rows);
});

// POST /api/hw-controllers
router.post('/', (req, res) => {
  const { projectId, ...rest } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const db = getDb();
  const data = pick(rest);
  const cols = ['project_id', ...Object.keys(data)];
  const vals = [Number(projectId), ...Object.values(data)];
  const placeholders = cols.map(() => '?').join(', ');
  const result = db.prepare(
    `INSERT INTO hw_controllers (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(vals);
  const created = db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

// GET /api/hw-controllers/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// PUT /api/hw-controllers/:id
router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const data = pick(req.body);
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No writable fields' });
  const setClause = Object.keys(data).map(c => `${c} = ?`).join(', ');
  db.prepare(
    `UPDATE hw_controllers SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
  ).run([...Object.values(data), Number(req.params.id)]);
  const updated = db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  res.json(updated);
});

// DELETE /api/hw-controllers/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM hw_controllers WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    // cascade: fieldbuses → controller
    db.prepare('DELETE FROM hw_fieldbuses WHERE hw_controller_id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM hw_controllers WHERE id = ?').run(Number(req.params.id));
  })();
  res.status(204).send();
});

function pick(body) {
  const out = {};
  for (const f of WRITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  }
  return out;
}

module.exports = router;
