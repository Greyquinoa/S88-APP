// routes/compositeCmTypes.js — Composite CM Type CRUD
'use strict';
const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

// ── GET /api/composite-cm-types ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT c.id, c.name, c.description, c.created_at, c.is_matrix,
             COUNT(m.id) AS member_count
      FROM composite_cm_types c
      LEFT JOIN composite_cm_members m ON m.composite_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `).all();
    res.json(rows.map(r => ({ ...r, member_count: Number(r.member_count) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/composite-cm-types/:id ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const comp = await db.prepare('SELECT * FROM composite_cm_types WHERE id = ?').get(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });
    const members = await db.prepare(
      'SELECT * FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);
    let connections = await db.prepare(
      'SELECT * FROM composite_cm_connections WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);

    // Decode IO connection metadata from static_value JSON
    connections = connections.map(c => {
      if (c.conn_type === 'io_connection' && c.static_value) {
        try {
          const meta = JSON.parse(c.static_value);
          return { ...c, ...meta };
        } catch (e) {
          return c;
        }
      }
      if (c.conn_type === 'value' && c.static_value) {
        try {
          const meta = JSON.parse(c.static_value);
          if (meta && meta.mode === 'derived') {
            return { ...c, value_mode: 'derived', column: meta.column || '', prefix: meta.prefix || '', suffix: meta.suffix || '' };
          }
        } catch (e) {
          // plain static string — not JSON, fall through
        }
        return { ...c, value_mode: 'static' };
      }
      return c;
    });

    // Matrix data
    const matrixColumnRows = await db.prepare(
      'SELECT column_name FROM composite_matrix_columns WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);
    const matrixColumns = matrixColumnRows.map(r => r.column_name);

    const modesRaw = await db.prepare(
      'SELECT * FROM composite_matrix_modes WHERE composite_id = ? ORDER BY sort_order, id'
    ).all(req.params.id);

    const matrixModes = [];
    for (const m of modesRaw) {
      const cells = await db.prepare(
        'SELECT column_name, value FROM composite_matrix_cells WHERE mode_id = ?'
      ).all(m.id);
      const cellMap = {};
      for (const c of cells) cellMap[c.column_name] = c.value;
      matrixModes.push({ id: m.id, mode_nr: m.mode_nr, mode_name: m.mode_name, sort_order: m.sort_order, cells: cellMap });
    }

    res.json({ ...comp, members, connections, matrixColumns, matrixModes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/composite-cm-types ──────────────────────────────────────────────
// Body: { name, description, is_matrix, members, connections, matrixColumns, matrixModes }
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const { name, description, is_matrix, members = [], connections = [], matrixColumns = [], matrixModes = [] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const result = await db.transaction(async () => {
      const row = await db.prepare(
        'INSERT INTO composite_cm_types (name, description, is_matrix) VALUES (?, ?, ?)'
      ).run(name.trim(), description?.trim() || '', !!is_matrix);
      const compId = row.lastInsertRowid;
      await _insertMembers(db, compId, members);
      await _insertConnections(db, compId, connections);
      if (is_matrix) {
        await _insertMatrixColumns(db, compId, matrixColumns);
        await _insertMatrixModes(db, compId, matrixModes);
      }
      return compId;
    })();

    res.status(201).json({ id: result, name: name.trim() });
  } catch (err) {
    if (err.message?.toLowerCase().includes('unique') || err.code === '23505') return res.status(409).json({ error: `Name "${req.body?.name}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/composite-cm-types/:id ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const db = getDb();
    const comp = await db.prepare('SELECT id FROM composite_cm_types WHERE id = ?').get(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });

    const { name, description, is_matrix, members = [], connections = [], matrixColumns = [], matrixModes = [] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    await db.transaction(async () => {
      await db.prepare('UPDATE composite_cm_types SET name=?, description=?, is_matrix=? WHERE id=?')
        .run(name.trim(), description?.trim() || '', !!is_matrix, comp.id);
      await db.prepare('DELETE FROM composite_cm_members WHERE composite_id = ?').run(comp.id);
      await db.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(comp.id);
      await _deleteMatrixData(db, comp.id);
      await _insertMembers(db, comp.id, members);
      await _insertConnections(db, comp.id, connections);
      if (is_matrix) {
        await _insertMatrixColumns(db, comp.id, matrixColumns);
        await _insertMatrixModes(db, comp.id, matrixModes);
      }
    })();

    res.json({ success: true });
  } catch (err) {
    if (err.message?.toLowerCase().includes('unique') || err.code === '23505') return res.status(409).json({ error: `Name "${req.body?.name}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/composite-cm-types/:id ───────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.transaction(async () => {
      await _deleteMatrixData(db, req.params.id);
      await db.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM composite_cm_members WHERE composite_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM composite_cm_types WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Private helpers ───────────────────────────────────────────────────────────

async function _deleteMatrixData(db, compId) {
  // Delete cells via modes
  const modes = await db.prepare('SELECT id FROM composite_matrix_modes WHERE composite_id = ?').all(compId);
  for (const m of modes) {
    await db.prepare('DELETE FROM composite_matrix_cells WHERE mode_id = ?').run(m.id);
  }
  await db.prepare('DELETE FROM composite_matrix_modes WHERE composite_id = ?').run(compId);
  await db.prepare('DELETE FROM composite_matrix_columns WHERE composite_id = ?').run(compId);
}

async function _insertMatrixColumns(db, compId, columns) {
  const stmt = db.prepare(
    'INSERT INTO composite_matrix_columns (composite_id, column_name, sort_order) VALUES (?, ?, ?)'
  );
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col?.trim()) await stmt.run(compId, col.trim(), i);
  }
}

async function _insertMatrixModes(db, compId, modes) {
  const modeStmt = db.prepare(
    'INSERT INTO composite_matrix_modes (composite_id, mode_nr, mode_name, sort_order) VALUES (?, ?, ?, ?)'
  );
  const cellStmt = db.prepare(
    'INSERT INTO composite_matrix_cells (mode_id, column_name, value) VALUES (?, ?, ?)'
  );
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i];
    const row = await modeStmt.run(compId, m.mode_nr ?? i, m.mode_name ?? '', i);
    const modeId = row.lastInsertRowid;
    const cells = m.cells || {};
    for (const [col, val] of Object.entries(cells)) {
      if (col?.trim()) await cellStmt.run(modeId, col.trim(), parseInt(val) || 0);
    }
  }
}

async function _insertConnections(db, compId, connections) {
  const stmt = db.prepare(`
    INSERT INTO composite_cm_connections
      (composite_id, from_member_idx, from_var_name, to_member_idx, to_var_name, conn_type, static_value, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i];
    const type = c.conn_type;

    if (type === 'value') {
      const staticValue = c.value_mode === 'derived'
        ? JSON.stringify({
            mode: 'derived',
            column: c.column || '',
            prefix: c.prefix || '',
            suffix: c.suffix || '',
          })
        : (c.static_value ?? '');
      await stmt.run(
        compId,
        -1,
        '',
        c.to_member_idx,
        c.to_var_name || '',
        'value',
        staticValue,
        i,
      );
    } else if (type === 'io_connection') {
      // IO Connection: encode block_name, prefix, suffix, dtype, required in static_value as JSON
      await stmt.run(
        compId,
        -1,
        '',
        c.to_member_idx,
        c.to_var_name || '',
        'io_connection',
        JSON.stringify({
          block_name: c.block_name || '',
          prefix: c.prefix || '',
          suffix: c.suffix || '',
          dtype: c.dtype || '',
          required: c.required ? 1 : 0,
        }),
        i,
      );
    } else {
      // interconnection (default)
      await stmt.run(
        compId,
        c.from_member_idx ?? -1,
        c.from_var_name || '',
        c.to_member_idx,
        c.to_var_name || '',
        'interconnection',
        null,
        i,
      );
    }
  }
}

async function _insertMembers(db, compId, members) {
  const stmt = db.prepare(`
    INSERT INTO composite_cm_members
      (composite_id, cm_type_name, hierarchy_folder, name_prefix, name_suffix, is_primary, scope, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    await stmt.run(
      compId,
      (m.cm_type_name || '').trim(),
      // Blank folder is intentional — the member's CM lands directly in the unit
      // path (rIX/DE01/React01) with no extra subfolder. Do NOT coerce to 'CM'.
      (m.hierarchy_folder || '').trim(),
      (m.name_prefix || '').trim(),
      (m.name_suffix || '').trim(),
      !!m.is_primary,
      m.scope === 'project' ? 'project' : 'unit',
      i,
    );
  }
}

module.exports = router;
