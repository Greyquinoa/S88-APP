// routes/ioConnections.js — CRUD for lib_io_connections (IO rules on lib_cm_types)
'use strict';
const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

// ── GET /api/io-connections/cm-type/:cmTypeId ─────────────────────────────────
// List all IO connection rules for a given lib_cm_type id.
// Also returns the available blocks+vars for that type so the frontend can
// build dropdowns without a separate call.
router.get('/cm-type/:cmTypeId', (req, res) => {
  try {
    const db = getDb();
    const { cmTypeId } = req.params;

    // Accept either a numeric lib_cm_types.id or a CM type name (frontend has the name).
    const cmType = /^\d+$/.test(String(cmTypeId))
      ? db.prepare('SELECT id, name FROM lib_cm_types WHERE id = ?').get(cmTypeId)
      : db.prepare('SELECT id, name FROM lib_cm_types WHERE name = ?').get(cmTypeId);
    if (!cmType) return res.status(404).json({ error: 'CM type not found' });

    // From here on, use the resolved numeric id for child lookups.
    const resolvedId = cmType.id;

    const rules = db.prepare(`
      SELECT * FROM lib_io_connections
      WHERE cm_type_id = ?
      ORDER BY sort_order, id
    `).all(resolvedId);

    // Return block+var options so the frontend can build dropdowns
    const blocks = db.prepare(`
      SELECT b.id, b.name
      FROM lib_blocks b
      WHERE b.cm_type_id = ?
      ORDER BY b.sort_order, b.id
    `).all(resolvedId);

    const vars = db.prepare(`
      SELECT v.id, v.name, v.dir, v.dtype, v.vtype, v.is_valid, b.name AS block_name
      FROM lib_variables v
      JOIN lib_blocks b ON b.id = v.block_id
      WHERE b.cm_type_id = ?
      ORDER BY b.sort_order, b.id, v.sort_order, v.id
    `).all(resolvedId);

    res.json({ cmType, rules, blocks, vars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/io-connections/cm-type/:cmTypeId ────────────────────────────────
// Create a new IO connection rule on a lib_cm_type.
// Body: { block_name, var_name, suffix, prefix, signal_type, required }
router.post('/cm-type/:cmTypeId', (req, res) => {
  try {
    const db = getDb();
    const { cmTypeId } = req.params;

    const cmType = db.prepare('SELECT id FROM lib_cm_types WHERE id = ?').get(cmTypeId);
    if (!cmType) return res.status(404).json({ error: 'CM type not found' });

    const {
      block_name,
      var_name,
      suffix      = '',
      prefix      = '',
      signal_type = 'DI',
      required    = 1,
      sort_order  = 0,
    } = req.body || {};

    if (!block_name?.trim()) return res.status(400).json({ error: 'block_name is required' });
    if (!var_name?.trim())   return res.status(400).json({ error: 'var_name is required' });

    const result = db.prepare(`
      INSERT INTO lib_io_connections
        (cm_type_id, block_name, var_name, suffix, prefix, signal_type, required, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cmTypeId,
      block_name.trim(),
      var_name.trim(),
      suffix  ?? '',
      prefix  ?? '',
      signal_type || 'DI',
      required ? 1 : 0,
      sort_order ?? 0,
    );

    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/io-connections/:id ───────────────────────────────────────────────
// Update an existing IO connection rule.
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const rule = db.prepare('SELECT id FROM lib_io_connections WHERE id = ?').get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    const {
      block_name,
      var_name,
      suffix,
      prefix,
      signal_type,
      required,
      sort_order,
    } = req.body || {};

    if (!block_name?.trim()) return res.status(400).json({ error: 'block_name is required' });
    if (!var_name?.trim())   return res.status(400).json({ error: 'var_name is required' });

    db.prepare(`
      UPDATE lib_io_connections
      SET block_name=?, var_name=?, suffix=?, prefix=?, signal_type=?, required=?, sort_order=?
      WHERE id=?
    `).run(
      block_name.trim(),
      var_name.trim(),
      suffix      ?? '',
      prefix      ?? '',
      signal_type || 'DI',
      required ? 1 : 0,
      sort_order  ?? 0,
      req.params.id,
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/io-connections/:id ───────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM lib_io_connections WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/io-connections/cm-type/:cmTypeId/reorder ──────────────────────
// Bulk-update sort_order after the user drags rows.
// Body: { ids: [id, id, ...] }  — ordered list of rule IDs in new order.
router.patch('/cm-type/:cmTypeId/reorder', (req, res) => {
  try {
    const db = getDb();
    const { ids = [] } = req.body || {};
    db.transaction(() => {
      ids.forEach((id, i) => {
        db.prepare('UPDATE lib_io_connections SET sort_order=? WHERE id=?').run(i, id);
      });
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
