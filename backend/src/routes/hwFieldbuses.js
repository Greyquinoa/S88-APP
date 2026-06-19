'use strict';
// Routes: GET/POST /api/hw-fieldbuses  (scoped to controller)
//         GET/PUT/DELETE /api/hw-fieldbuses/:id
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const WRITABLE = [
  'hw_controller_id', 'INT_DP_Subsystem', 'INT_Bus_DP_Address',
  'T50_Fieldbus_Name', 'LINT_T_Driver', 'T15_IP_Address',
];

// GET /api/hw-fieldbuses?controllerId=N
router.get('/', (req, res) => {
  const { controllerId } = req.query;
  if (!controllerId) return res.status(400).json({ error: 'controllerId required' });
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM hw_fieldbuses WHERE hw_controller_id = ? ORDER BY INT_DP_Subsystem, id'
  ).all(Number(controllerId));
  res.json(rows);
});

// POST /api/hw-fieldbuses
router.post('/', (req, res) => {
  const db = getDb();
  const data = pick(req.body);
  if (!data.hw_controller_id) return res.status(400).json({ error: 'hw_controller_id required' });
  const cols = Object.keys(data);
  const vals = Object.values(data);
  const placeholders = cols.map(() => '?').join(', ');
  const result = db.prepare(
    `INSERT INTO hw_fieldbuses (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(vals);
  const created = db.prepare('SELECT * FROM hw_fieldbuses WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

// GET /api/hw-fieldbuses/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM hw_fieldbuses WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// PUT /api/hw-fieldbuses/:id
router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM hw_fieldbuses WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const data = pick(req.body);
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No writable fields' });
  const setClause = Object.keys(data).map(c => `${c} = ?`).join(', ');
  db.prepare(
    `UPDATE hw_fieldbuses SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
  ).run([...Object.values(data), Number(req.params.id)]);
  const updated = db.prepare('SELECT * FROM hw_fieldbuses WHERE id = ?').get(Number(req.params.id));
  res.json(updated);
});

// DELETE /api/hw-fieldbuses/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM hw_fieldbuses WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM hw_fieldbuses WHERE id = ?').run(Number(req.params.id));
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
