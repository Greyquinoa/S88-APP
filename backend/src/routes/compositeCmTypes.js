// routes/compositeCmTypes.js — Composite CM Type CRUD
'use strict';
const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

// ── GET /api/composite-cm-types ───────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT c.id, c.name, c.description, c.created_at, c.is_matrix,
             COUNT(m.id) AS member_count
      FROM composite_cm_types c
      LEFT JOIN composite_cm_members m ON m.composite_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/composite-cm-types/:id ──────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const comp = db.prepare('SELECT * FROM composite_cm_types WHERE id = ?').get(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });
    const members = db.prepare(
      'SELECT * FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);
    const connections = db.prepare(
      'SELECT * FROM composite_cm_connections WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);

    // Matrix data
    const matrixColumns = db.prepare(
      'SELECT column_name FROM composite_matrix_columns WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id).map(r => r.column_name);

    const modesRaw = db.prepare(
      'SELECT * FROM composite_matrix_modes WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);

    const matrixModes = modesRaw.map(m => {
      const cells = db.prepare(
        'SELECT column_name, value FROM composite_matrix_cells WHERE mode_id = ?'
      ).all(m.id);
      const cellMap = {};
      for (const c of cells) cellMap[c.column_name] = c.value;
      return { id: m.id, mode_nr: m.mode_nr, mode_name: m.mode_name, sort_order: m.sort_order, cells: cellMap };
    });

    res.json({ ...comp, members, connections, matrixColumns, matrixModes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/composite-cm-types ──────────────────────────────────────────────
// Body: { name, description, is_matrix, members, connections, matrixColumns, matrixModes }
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, description, is_matrix, members = [], connections = [], matrixColumns = [], matrixModes = [] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const result = db.transaction(() => {
      const row = db.prepare(
        'INSERT INTO composite_cm_types (name, description, is_matrix) VALUES (?, ?, ?)'
      ).run(name.trim(), description?.trim() || '', is_matrix ? 1 : 0);
      const compId = row.lastInsertRowid;
      _insertMembers(db, compId, members);
      _insertConnections(db, compId, connections);
      if (is_matrix) {
        _insertMatrixColumns(db, compId, matrixColumns);
        _insertMatrixModes(db, compId, matrixModes);
      }
      return compId;
    })();

    res.status(201).json({ id: result, name: name.trim() });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: `Name "${req.body?.name}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/composite-cm-types/:id ─────────────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const comp = db.prepare('SELECT id FROM composite_cm_types WHERE id = ?').get(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });

    const { name, description, is_matrix, members = [], connections = [], matrixColumns = [], matrixModes = [] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    db.transaction(() => {
      db.prepare('UPDATE composite_cm_types SET name=?, description=?, is_matrix=? WHERE id=?')
        .run(name.trim(), description?.trim() || '', is_matrix ? 1 : 0, comp.id);
      db.prepare('DELETE FROM composite_cm_members WHERE composite_id = ?').run(comp.id);
      db.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(comp.id);
      _deleteMatrixData(db, comp.id);
      _insertMembers(db, comp.id, members);
      _insertConnections(db, comp.id, connections);
      if (is_matrix) {
        _insertMatrixColumns(db, comp.id, matrixColumns);
        _insertMatrixModes(db, comp.id, matrixModes);
      }
    })();

    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: `Name "${req.body?.name}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/composite-cm-types/:id ───────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      _deleteMatrixData(db, req.params.id);
      db.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(req.params.id);
      db.prepare('DELETE FROM composite_cm_members WHERE composite_id = ?').run(req.params.id);
      db.prepare('DELETE FROM composite_cm_types WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Private helpers ───────────────────────────────────────────────────────────

function _deleteMatrixData(db, compId) {
  // Delete cells via modes
  const modes = db.prepare('SELECT id FROM composite_matrix_modes WHERE composite_id = ?').all(compId);
  for (const m of modes) {
    db.prepare('DELETE FROM composite_matrix_cells WHERE mode_id = ?').run(m.id);
  }
  db.prepare('DELETE FROM composite_matrix_modes WHERE composite_id = ?').run(compId);
  db.prepare('DELETE FROM composite_matrix_columns WHERE composite_id = ?').run(compId);
}

function _insertMatrixColumns(db, compId, columns) {
  const stmt = db.prepare(
    'INSERT INTO composite_matrix_columns (composite_id, column_name, sort_order) VALUES (?, ?, ?)'
  );
  columns.forEach((col, i) => {
    if (col?.trim()) stmt.run(compId, col.trim(), i);
  });
}

function _insertMatrixModes(db, compId, modes) {
  const modeStmt = db.prepare(
    'INSERT INTO composite_matrix_modes (composite_id, mode_nr, mode_name, sort_order) VALUES (?, ?, ?, ?)'
  );
  const cellStmt = db.prepare(
    'INSERT INTO composite_matrix_cells (mode_id, column_name, value) VALUES (?, ?, ?)'
  );
  modes.forEach((m, i) => {
    const row = modeStmt.run(compId, m.mode_nr ?? i, m.mode_name ?? '', i);
    const modeId = row.lastInsertRowid;
    const cells = m.cells || {};
    for (const [col, val] of Object.entries(cells)) {
      if (col?.trim()) cellStmt.run(modeId, col.trim(), parseInt(val) || 0);
    }
  });
}

function _insertConnections(db, compId, connections) {
  const stmt = db.prepare(`
    INSERT INTO composite_cm_connections
      (composite_id, from_member_idx, from_var_name, to_member_idx, to_var_name, conn_type, static_value, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  connections.forEach((c, i) => {
    const type = c.conn_type === 'value' ? 'value' : 'interconnection';
    stmt.run(
      compId,
      type === 'value' ? -1            : c.from_member_idx,
      type === 'value' ? ''            : (c.from_var_name || ''),
      c.to_member_idx,
      c.to_var_name || '',
      type,
      type === 'value' ? (c.static_value ?? '') : null,
      i,
    );
  });
}

function _insertMembers(db, compId, members) {
  const stmt = db.prepare(`
    INSERT INTO composite_cm_members
      (composite_id, cm_type_name, hierarchy_folder, name_prefix, name_suffix, is_primary, scope, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  members.forEach((m, i) => {
    stmt.run(
      compId,
      (m.cm_type_name || '').trim(),
      (m.hierarchy_folder || 'CM').trim(),
      (m.name_prefix || '').trim(),
      (m.name_suffix || '').trim(),
      m.is_primary ? 1 : 0,
      m.scope === 'project' ? 'project' : 'unit',
      i,
    );
  });
}

module.exports = router;
