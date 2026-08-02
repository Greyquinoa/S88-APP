// src/routes/ephEmImport.js — EPH/EM Import system endpoints
'use strict';
const express = require('express');
const multer = require('multer');
const { getDb } = require('../db');
const {
  uploadEphEmFile,
  applyColumnMap,
  runAssignment,
  promoteToProject,
  resolveUnitPath,
} = require('../services/ephEmImporter');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function err(res, code, msg) {
  return res.status(code).json({ error: msg });
}

// ── Upload + parse Excel ──────────────────────────────────────────────────────
// POST /api/eph-em/project/:projectId/upload
// multipart: field "ephemlist"
router.post('/project/:projectId/upload', upload.single('ephemlist'), async (req, res) => {
  try {
    const db = getDb();
    const projectId = parseInt(req.params.projectId, 10);

    if (!(await db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))) {
      return err(res, 404, 'Project not found');
    }

    if (!req.file) {
      return err(res, 400, 'No file uploaded');
    }

    const buffer = req.file.buffer;
    const sheetName = req.query.sheet || null;

    // Parse file
    const { sheets, sheet, headers, totalRows, preview, rows } = await uploadEphEmFile(buffer, sheetName);

    // Create import record with columns metadata
    const impRow = await db.prepare(`
      INSERT INTO eph_em_imports (project_id, file_name, file_size_bytes, sheet_name, total_rows, columns, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(projectId, req.file.originalname, req.file.size, sheet, totalRows, JSON.stringify(headers));

    const importId = impRow.lastInsertRowid;

    // Bulk-insert raw rows
    const insert = db.prepare(`
      INSERT INTO eph_em_import_rows (import_id, row_number, raw_data)
      VALUES (?, ?, ?)
    `);

    const batchInsert = db.transaction(async (batch) => {
      for (const r of batch) {
        await insert.run(importId, r.rowNum, JSON.stringify(r.data));
      }
    });

    for (let i = 0; i < rows.length; i += 500) {
      await batchInsert(rows.slice(i, i + 500));
    }

    res.json({
      importId,
      sheets,
      sheet,
      headers,
      totalRows,
      preview: preview.slice(0, 10),
    });
  } catch (e) {
    console.error('[EPH-EM upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── List all imports for a project ────────────────────────────────────────────
// GET /api/eph-em/project/:projectId/imports
router.get('/project/:projectId/imports', async (req, res) => {
  try {
    const db = getDb();
    const projectId = parseInt(req.params.projectId, 10);

    if (!(await db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))) {
      return err(res, 404, 'Project not found');
    }

    const imports = await db.prepare(`
      SELECT id, file_name, total_rows, sheet_name, status, imported_at, columns
      FROM eph_em_imports
      WHERE project_id = ?
      ORDER BY imported_at DESC
    `).all(projectId);

    const result = imports.map(imp => ({
      id: imp.id,
      fileName: imp.file_name,
      rowCount: imp.total_rows,
      sheetName: imp.sheet_name,
      status: imp.status,
      uploadedAt: imp.imported_at,
      columnCount: imp.columns ? JSON.parse(imp.columns).length : 0,
    }));

    res.json(result);
  } catch (e) {
    console.error('[EPH-EM list imports]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get full import with metadata and preview ────────────────────────────────
// GET /api/eph-em/imports/:id
router.get('/imports/:id', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);

    const imp = await db.prepare(`
      SELECT id, file_name, total_rows, sheet_name, status, imported_at, columns
      FROM eph_em_imports
      WHERE id = ?
    `).get(importId);

    if (!imp) {
      return err(res, 404, 'Import not found');
    }

    // Parse columns from JSON
    let columns = [];
    try {
      columns = JSON.parse(imp.columns || '[]');
    } catch (e) {
      console.warn('Failed to parse columns for import', importId, e.message);
    }

    // Get first 10 rows as preview
    const preview = await db.prepare(`
      SELECT * FROM eph_em_import_rows
      WHERE import_id = ?
      ORDER BY row_number ASC
      LIMIT 10
    `).all(importId);

    const parsedPreview = preview.map(row => {
      try {
        return JSON.parse(row.raw_data);
      } catch (e) {
        return row.raw_data;
      }
    });

    res.json({
      id: imp.id,
      fileName: imp.file_name,
      rowCount: imp.total_rows,
      columnCount: columns.length,
      sheetName: imp.sheet_name,
      status: imp.status,
      uploadedAt: imp.imported_at,
      headers: columns,
      preview: parsedPreview,
    });
  } catch (e) {
    console.error('[EPH-EM get import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete import ────────────────────────────────────────────────────────────
// DELETE /api/eph-em/imports/:id
router.delete('/imports/:id', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);

    const imp = await db.prepare('SELECT id FROM eph_em_imports WHERE id=?').get(importId);
    if (!imp) {
      return err(res, 404, 'Import not found');
    }

    // Delete rows first (foreign key constraint)
    await db.prepare('DELETE FROM eph_em_import_rows WHERE import_id=?').run(importId);

    // Delete the import
    await db.prepare('DELETE FROM eph_em_imports WHERE id=?').run(importId);

    res.json({ success: true, importId });
  } catch (e) {
    console.error('[EPH-EM delete import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Apply column mapping ──────────────────────────────────────────────────────
// POST /api/eph-em/imports/:id/apply-column-map
// body: { mappings: { unit_column: "Unit_Name" }, headers: [...] }
router.post('/imports/:id/apply-column-map', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);
    const { mappings, headers } = req.body;

    const imp = await db.prepare('SELECT * FROM eph_em_imports WHERE id=?').get(importId);
    if (!imp) return err(res, 404, 'Import not found');

    if (!mappings || !mappings.unit_column) {
      return err(res, 400, 'Missing or invalid mappings (must have unit_column)');
    }

    if (!headers || !Array.isArray(headers)) {
      return err(res, 400, 'Missing or invalid headers array');
    }

    await applyColumnMap(db, importId, mappings, headers);

    res.json({ success: true, importId, status: 'mapped' });
  } catch (e) {
    console.error('[EPH-EM apply-column-map]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Run function-map assignment ───────────────────────────────────────────────
// POST /api/eph-em/imports/:id/assign
// body: { type_column_mappings: { "EM_DNS": "COMPOSITE_EM_DNS", ... } }
router.post('/imports/:id/assign', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);
    const { type_column_mappings } = req.body;

    const imp = await db.prepare('SELECT * FROM eph_em_imports WHERE id=?').get(importId);
    if (!imp) return err(res, 404, 'Import not found');

    if (!type_column_mappings || Object.keys(type_column_mappings).length === 0) {
      return err(res, 400, 'Missing or invalid type_column_mappings');
    }

    await runAssignment(db, importId, type_column_mappings);

    res.json({ success: true, importId, status: 'assigned' });
  } catch (e) {
    console.error('[EPH-EM assign]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get import rows for review ────────────────────────────────────────────────
// GET /api/eph-em/imports/:id/rows?offset=0&limit=100
router.get('/imports/:id/rows', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 100;

    const rows = await db.prepare(`
      SELECT * FROM eph_em_import_rows
      WHERE import_id = ?
      ORDER BY row_number ASC
      LIMIT ? OFFSET ?
    `).all(importId, limit, offset);

    const total = await db.prepare(
      'SELECT COUNT(*) as count FROM eph_em_import_rows WHERE import_id = ?'
    ).get(importId);

    // Annotate each row with its unit's Plant Hierarchy path so the review grid
    // can show, before promoting, which units will land folder-less.
    const imp = await db.prepare('SELECT project_id FROM eph_em_imports WHERE id = ?').get(importId);
    if (imp) {
      const pathCache = new Map();
      for (const row of rows) {
        if (!row.unit_name) { row.hierarchy_path = null; continue; }
        if (!pathCache.has(row.unit_name)) {
          pathCache.set(row.unit_name, await resolveUnitPath(db, imp.project_id, row.unit_name));
        }
        row.hierarchy_path = pathCache.get(row.unit_name);
      }
    }

    res.json({
      rows,
      total: total.count,
      offset,
      limit,
    });
  } catch (e) {
    console.error('[EPH-EM get-rows]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Update row assignment ─────────────────────────────────────────────────────
// PATCH /api/eph-em/imports/:id/rows/:rowId
// body: { assigned_cm_types: {...}, assignment_status: 'assigned'|'rejected' }
router.patch('/imports/:id/rows/:rowId', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);
    const rowId = parseInt(req.params.rowId, 10);
    const { assigned_cm_types, assignment_status } = req.body;

    const row = await db.prepare(
      'SELECT * FROM eph_em_import_rows WHERE id = ? AND import_id = ?'
    ).get(rowId, importId);

    if (!row) return err(res, 404, 'Row not found');

    const updates = [];
    const params = [];

    if (assigned_cm_types !== undefined) {
      updates.push('assigned_cm_types = ?');
      params.push(JSON.stringify(assigned_cm_types));
    }

    if (assignment_status !== undefined) {
      updates.push('assignment_status = ?');
      params.push(assignment_status);
    }

    updates.push('updated_at = NOW()');
    params.push(rowId);

    if (updates.length > 1) {
      await db.prepare(`
        UPDATE eph_em_import_rows
        SET ${updates.slice(0, -1).join(', ')}
        WHERE id = ?
      `).run(...params);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[EPH-EM update-row]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Reject row ────────────────────────────────────────────────────────────────
// DELETE /api/eph-em/imports/:id/rows/:rowId
router.delete('/imports/:id/rows/:rowId', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);
    const rowId = parseInt(req.params.rowId, 10);

    const row = await db.prepare(
      'SELECT * FROM eph_em_import_rows WHERE id = ? AND import_id = ?'
    ).get(rowId, importId);

    if (!row) return err(res, 404, 'Row not found');

    await db.prepare('UPDATE eph_em_import_rows SET assignment_status = ? WHERE id = ?')
      .run('rejected', rowId);

    res.json({ success: true });
  } catch (e) {
    console.error('[EPH-EM delete-row]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Promote import ────────────────────────────────────────────────────────────
// POST /api/eph-em/imports/:id/promote
// body: { projectId: number }
router.post('/imports/:id/promote', async (req, res) => {
  try {
    const db = getDb();
    const importId = parseInt(req.params.id, 10);
    const { projectId } = req.body;

    const imp = await db.prepare('SELECT * FROM eph_em_imports WHERE id=?').get(importId);
    if (!imp) return err(res, 404, 'Import not found');

    if (!projectId) {
      return err(res, 400, 'projectId required in body');
    }

    const result = await promoteToProject(db, importId, projectId);

    res.json({
      success: true,
      created: result.created,
      instances: result.instances,
      warnings: result.warnings,
    });
  } catch (e) {
    console.error('[EPH-EM promote]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Column mappings CRUD ──────────────────────────────────────────────────────
// GET /api/eph-em/column-maps
router.get('/column-maps', async (req, res) => {
  try {
    const db = getDb();
    const maps = await db.prepare('SELECT id, name, description FROM eph_em_column_mappings ORDER BY id DESC').all();
    res.json(maps || []);
  } catch (e) {
    console.error('[EPH-EM column-maps GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/eph-em/column-maps/:id
router.get('/column-maps/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const map = await db.prepare('SELECT * FROM eph_em_column_mappings WHERE id = ?').get(id);
    if (!map) return err(res, 404, 'Not found');
    try {
      map.mappings = JSON.parse(map.mappings || '{}');
    } catch (_) {
      map.mappings = {};
    }
    res.json(map);
  } catch (e) {
    console.error('[EPH-EM column-maps GET:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/eph-em/column-maps
router.post('/column-maps', async (req, res) => {
  try {
    const db = getDb();
    const { name, description, mappings } = req.body;
    if (!name) return err(res, 400, 'name required');

    const result = await db.prepare(`
      INSERT INTO eph_em_column_mappings (name, description, mappings)
      VALUES (?, ?, ?)
    `).run(name, description || null, JSON.stringify(mappings || {}));

    res.json({ id: result.lastInsertRowid, name, description });
  } catch (e) {
    console.error('[EPH-EM column-maps POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/eph-em/column-maps/:id
router.patch('/column-maps/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const { name, description, mappings } = req.body;

    await db.prepare(`
      UPDATE eph_em_column_mappings
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          mappings = COALESCE(?, mappings),
          updated_at = NOW()
      WHERE id = ?
    `).run(name || null, description || null, mappings ? JSON.stringify(mappings) : null, id);

    res.json({ success: true });
  } catch (e) {
    console.error('[EPH-EM column-maps PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/eph-em/column-maps/:id
router.delete('/column-maps/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    await db.prepare('DELETE FROM eph_em_column_mappings WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error('[EPH-EM column-maps DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Function mappings CRUD ────────────────────────────────────────────────────
// GET /api/eph-em/function-map-configs
router.get('/function-map-configs', async (req, res) => {
  try {
    const db = getDb();
    const configs = await db.prepare(`
      SELECT id, name, description FROM eph_em_function_map_configs ORDER BY id DESC
    `).all();
    res.json(configs || []);
  } catch (e) {
    console.error('[EPH-EM function-map-configs GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/eph-em/function-map-configs
router.post('/function-map-configs', async (req, res) => {
  try {
    const db = getDb();
    const { name, description } = req.body;
    if (!name) return err(res, 400, 'name required');

    const result = await db.prepare(`
      INSERT INTO eph_em_function_map_configs (name, description)
      VALUES (?, ?)
    `).run(name, description || null);

    res.json({ id: result.lastInsertRowid, name, description });
  } catch (e) {
    console.error('[EPH-EM function-map-configs POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Type mapping configs CRUD ─────────────────────────────────────────────────
// GET /api/eph-em/type-mapping-configs
router.get('/type-mapping-configs', async (req, res) => {
  try {
    const db = getDb();
    const configs = await db.prepare(`
      SELECT id, name, mappings FROM eph_em_type_mapping_configs ORDER BY id DESC
    `).all();
    res.json(configs || []);
  } catch (e) {
    console.error('[EPH-EM type-mapping-configs GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/eph-em/type-mapping-configs
router.post('/type-mapping-configs', async (req, res) => {
  try {
    const db = getDb();
    const { name, mappings } = req.body;
    if (!name) return err(res, 400, 'name required');

    const result = await db.prepare(`
      INSERT INTO eph_em_type_mapping_configs (name, mappings)
      VALUES (?, ?)
    `).run(name, JSON.stringify(mappings || {}));

    res.json({ id: result.lastInsertRowid, name, mappings });
  } catch (e) {
    console.error('[EPH-EM type-mapping-configs POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/eph-em/type-mapping-configs/:id
router.patch('/type-mapping-configs/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const { name, mappings } = req.body;

    await db.prepare(`
      UPDATE eph_em_type_mapping_configs
      SET name = COALESCE(?, name),
          mappings = COALESCE(?, mappings),
          updated_at = NOW()
      WHERE id = ?
    `).run(name || null, mappings ? JSON.stringify(mappings) : null, id);

    res.json({ success: true });
  } catch (e) {
    console.error('[EPH-EM type-mapping-configs PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/eph-em/type-mapping-configs/:id
router.delete('/type-mapping-configs/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    await db.prepare('DELETE FROM eph_em_type_mapping_configs WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error('[EPH-EM type-mapping-configs DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
