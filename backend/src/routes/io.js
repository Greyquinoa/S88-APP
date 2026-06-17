// src/routes/io.js — IO Import system endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb } = require('../db');
const { listSheets, parseSheet }    = require('../services/ioParser');
const { validateTags }              = require('../services/ioValidator');
const { applyMapping, suggestMappings } = require('../services/columnMapper');
const { buildHierarchy, loadHierarchyTree, promoteToProject, VALID_LEVELS } = require('../services/hierarchyBuilder');
const { runAssignment, getUnresolvedFunctions } = require('../services/assignmentEngine');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────────────────

function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// ── Upload + parse Excel ──────────────────────────────────────────────────────
// POST /api/io/project/:projectId/upload
// multipart: field "iolist", optional query ?sheet=Sheet1&column_map_id=1
router.post('/project/:projectId/upload', upload.single('iolist'), async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
      return err(res, 404, 'Project not found');

    if (!req.file) return err(res, 400, 'No file uploaded');

    const buffer    = req.file.buffer;
    const sheetName = req.query.sheet || null;

    // List sheets (for pre-upload sheet-picker)
    const sheets = await listSheets(buffer);
    const targetSheet = sheetName || sheets[0];

    const { headers, rows } = await parseSheet(buffer, targetSheet);

    // Create the import record
    const impRow = db.prepare(`
      INSERT INTO io_imports (project_id, file_name, file_size_bytes, sheet_name, total_rows, status)
      VALUES (?,?,?,?,?,'pending')
    `).run(projectId, req.file.originalname, req.file.size, targetSheet, rows.length);
    const importId = impRow.lastInsertRowid;

    // Bulk-insert raw rows in batches of 500
    const insert = db.prepare(`
      INSERT INTO io_tags (import_id, row_number, raw_data) VALUES (?,?,?)
    `);
    const batchInsert = db.transaction((batch) => {
      for (const r of batch) insert.run(importId, r.rowNum, JSON.stringify(r.data));
    });
    for (let i = 0; i < rows.length; i += 500) {
      batchInsert(rows.slice(i, i + 500));
    }

    // Auto-suggest column mapping
    const suggestions = suggestMappings(headers);

    // Apply column_map_id immediately if provided, then auto-build hierarchy
    const cmId = req.query.column_map_id ? parseInt(req.query.column_map_id, 10) : null;
    let hierarchyStats = null;
    if (cmId) {
      const cm = db.prepare('SELECT mappings FROM io_column_mappings WHERE id=?').get(cmId);
      if (cm) {
        applyMapping(db, importId, JSON.parse(cm.mappings));
        db.prepare('UPDATE io_imports SET column_map_id=? WHERE id=?').run(cmId, importId);
        hierarchyStats = buildHierarchy(db, parseInt(importId, 10));
      }
    }

    // Run initial validation
    const validation = validateTags(db, importId);

    res.json({
      importId,
      sheets,
      sheet: targetSheet,
      headers,
      totalRows: rows.length,
      suggestions,
      validation,
      hierarchyStats,
      preview: rows.slice(0, 20).map(r => r.data),
    });
  } catch (e) {
    console.error('[IO upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/io/imports/:id/reimport — replace raw rows of an existing import with new file data
// Keeps the same import record, column map, and hierarchy config.
// Re-applies column mapping and rebuilds hierarchy automatically.
router.post('/imports/:id/reimport', upload.single('iolist'), async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const imp      = db.prepare('SELECT * FROM io_imports WHERE id=?').get(importId);
    if (!imp) return err(res, 404, 'Import not found');
    if (!req.file) return err(res, 400, 'No file uploaded');

    const sheetName = req.query.sheet || imp.sheet_name || null;
    const sheets    = await listSheets(req.file.buffer);
    const targetSheet = sheetName || sheets[0];
    const { headers, rows } = await parseSheet(req.file.buffer, targetSheet);

    db.transaction(() => {
      // Wipe old data
      db.prepare('DELETE FROM io_validation_log WHERE import_id=?').run(importId);
      db.prepare('DELETE FROM io_audit_trail    WHERE import_id=?').run(importId);
      db.prepare('DELETE FROM io_hierarchy_nodes WHERE import_id=?').run(importId);
      db.prepare('DELETE FROM io_tags           WHERE import_id=?').run(importId);

      // Update import record metadata
      db.prepare(`
        UPDATE io_imports SET
          file_name=?, file_size_bytes=?, sheet_name=?, total_rows=?,
          status='pending', imported_at=datetime('now')
        WHERE id=?
      `).run(req.file.originalname, req.file.size, targetSheet, rows.length, importId);

      // Re-insert raw rows
      const ins = db.prepare('INSERT INTO io_tags (import_id, row_number, raw_data) VALUES (?,?,?)');
      for (const r of rows) ins.run(importId, r.rowNum, JSON.stringify(r.data));
    })();

    // Re-apply existing column mapping if one is saved
    let hierarchyStats = null;
    if (imp.column_map_id) {
      const cm = db.prepare('SELECT mappings FROM io_column_mappings WHERE id=?').get(imp.column_map_id);
      if (cm) {
        applyMapping(db, importId, JSON.parse(cm.mappings || '{}'));
        hierarchyStats = buildHierarchy(db, importId);
      }
    }

    const validation = validateTags(db, importId);
    const suggestions = suggestMappings(headers);

    res.json({
      importId,
      sheets,
      sheet: targetSheet,
      headers,
      totalRows: rows.length,
      suggestions,
      validation,
      hierarchyStats,
      preview: rows.slice(0, 20).map(r => r.data),
    });
  } catch (e) {
    console.error('[IO reimport]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/io/project/:projectId/imports — list imports for a project
router.get('/project/:projectId/imports', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT i.*,
             (SELECT COUNT(*) FROM io_tags WHERE import_id=i.id) AS total_tags,
             (SELECT COUNT(*) FROM io_tags WHERE import_id=i.id AND assignment_status='auto') AS auto_assigned,
             (SELECT COUNT(*) FROM io_tags WHERE import_id=i.id AND assignment_status='unresolved') AS unresolved
      FROM io_imports i WHERE i.project_id=? ORDER BY i.imported_at DESC
    `).all(req.params.projectId);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/headers — column headers detected at upload time
router.get('/imports/:id/headers', (req, res) => {
  try {
    const db  = getDb();
    const tag = db.prepare('SELECT raw_data FROM io_tags WHERE import_id=? LIMIT 1').get(req.params.id);
    if (!tag) return res.json({ headers: [] });
    let headers = [];
    try { headers = Object.keys(JSON.parse(tag.raw_data || '{}')); } catch (_) {}
    res.json({ headers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id — single import detail
router.get('/imports/:id', (req, res) => {
  try {
    const db  = getDb();
    const imp = db.prepare('SELECT * FROM io_imports WHERE id=?').get(req.params.id);
    if (!imp) return err(res, 404, 'Import not found');
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(assignment_status='auto') AS auto_assigned,
        SUM(assignment_status='unresolved') AS unresolved,
        SUM(assignment_status='manual_override') AS manual_override,
        SUM(assignment_status='approved') AS approved,
        SUM(validation_status='error') AS errors,
        SUM(validation_status='warning') AS warnings
      FROM io_tags WHERE import_id=?
    `).get(req.params.id);
    res.json({ ...imp, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/io/imports/:id
router.delete('/imports/:id', (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM io_validation_log WHERE import_id=?').run(req.params.id);
      db.prepare('DELETE FROM io_audit_trail WHERE import_id=?').run(req.params.id);
      db.prepare('DELETE FROM io_tags WHERE import_id=?').run(req.params.id);
      db.prepare('DELETE FROM io_hierarchy_nodes WHERE import_id=?').run(req.params.id);
      db.prepare('DELETE FROM io_imports WHERE id=?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/tags — paginated, one row per unique instrument_tag
router.get('/imports/:id/tags', (req, res) => {
  try {
    const db      = getDb();
    const page    = Math.max(1, parseInt(req.query.page  || '1',   10));
    const perPage = Math.min(200, parseInt(req.query.per || '100', 10));
    const status  = req.query.status || null;
    const search  = req.query.search || null;
    const offset  = (page - 1) * perPage;

    // Group by the instrument identity (instrument_tag when mapped, else tag_name).
    // Pick the representative row: best assignment_status, lowest row_number within that.
    // status filter and search apply on the grouped result.
    let having = 'WHERE import_id=?';
    const baseParams = [req.params.id];

    let statusFilter = '';
    if (status && status !== 'all') {
      statusFilter = `AND assignment_status = '${status.replace(/'/g, "''")}'`;
    }
    let searchFilter = '';
    const searchParams = [];
    if (search) {
      searchFilter = 'AND (identity LIKE ? OR function_val LIKE ? OR hierarchy LIKE ?)';
      searchParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Sub-query: collapse IO rows into one row per instrument identity
    const subSql = `
      SELECT
        COALESCE(instrument_tag, tag_name) AS identity,
        MIN(id)                            AS id,
        import_id,
        hierarchy,
        function_val,
        COUNT(*)                           AS io_count,
        -- best assignment_status (manual_override > approved > auto > unresolved > pending)
        CASE MIN(CASE assignment_status
                   WHEN 'manual_override' THEN 1
                   WHEN 'approved'        THEN 2
                   WHEN 'auto'            THEN 3
                   WHEN 'unresolved'      THEN 4
                   ELSE 5 END)
          WHEN 1 THEN 'manual_override'
          WHEN 2 THEN 'approved'
          WHEN 3 THEN 'auto'
          WHEN 4 THEN 'unresolved'
          ELSE 'pending'
        END                                AS assignment_status,
        -- pick the assigned type that came from the best-ranked row
        (SELECT assigned_cm_type FROM io_tags sub
         WHERE sub.import_id = t.import_id
           AND COALESCE(sub.instrument_tag, sub.tag_name) = COALESCE(t.instrument_tag, t.tag_name)
           AND sub.assigned_cm_type IS NOT NULL
         ORDER BY CASE sub.assignment_status
                    WHEN 'manual_override' THEN 1
                    WHEN 'approved'        THEN 2
                    WHEN 'auto'            THEN 3
                    ELSE 4 END, sub.id
         LIMIT 1)                          AS assigned_cm_type,
        -- hierarchy node from the first row that has one
        (SELECT hierarchy_node_id FROM io_tags sub
         WHERE sub.import_id = t.import_id
           AND COALESCE(sub.instrument_tag, sub.tag_name) = COALESCE(t.instrument_tag, t.tag_name)
           AND sub.hierarchy_node_id IS NOT NULL
         LIMIT 1)                          AS hierarchy_node_id,
        -- assignment (AS station) from the first row that has one
        (SELECT assignment FROM io_tags sub
         WHERE sub.import_id = t.import_id
           AND COALESCE(sub.instrument_tag, sub.tag_name) = COALESCE(t.instrument_tag, t.tag_name)
           AND sub.assignment IS NOT NULL
         LIMIT 1)                          AS assignment,
        MIN(row_number)                    AS row_number,
        validation_status
      FROM io_tags t
      ${having}
      GROUP BY import_id, COALESCE(instrument_tag, tag_name)
    `;

    const countSql = `SELECT COUNT(*) AS n FROM (${subSql}) g
      WHERE 1=1 ${statusFilter} ${searchFilter}`;
    const total = db.prepare(countSql).get(...baseParams, ...searchParams).n;

    const pageSql = `
      SELECT g.*, n.name AS node_name, n.level AS node_level
      FROM (${subSql}) g
      LEFT JOIN io_hierarchy_nodes n ON n.id = g.hierarchy_node_id
      WHERE 1=1 ${statusFilter} ${searchFilter}
      ORDER BY g.row_number
      LIMIT ? OFFSET ?
    `;
    const tags = db.prepare(pageSql).all(...baseParams, ...searchParams, perPage, offset);

    res.json({ tags, total, page, perPage, pages: Math.ceil(total / perPage) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/io/imports/:id/tags/:tagId — override assignment for all IO rows of that instrument
router.patch('/imports/:id/tags/:tagId', (req, res) => {
  try {
    const db  = getDb();
    const tag = db.prepare('SELECT * FROM io_tags WHERE id=? AND import_id=?')
      .get(req.params.tagId, req.params.id);
    if (!tag) return err(res, 404, 'Tag not found');

    const { assigned_cm_type, assignment_status, override_reason, hierarchy_node_id } = req.body;

    // Apply to all IO rows that share the same instrument identity in this import
    const identity = tag.instrument_tag || tag.tag_name;
    db.prepare(`
      UPDATE io_tags SET
        assigned_cm_type   = COALESCE(?, assigned_cm_type),
        assignment_status  = COALESCE(?, assignment_status),
        override_reason    = COALESCE(?, override_reason),
        hierarchy_node_id  = COALESCE(?, hierarchy_node_id),
        assigned_by        = 'user',
        assigned_at        = datetime('now'),
        updated_at         = datetime('now')
      WHERE import_id=? AND COALESCE(instrument_tag, tag_name)=?
    `).run(
      assigned_cm_type  ?? null,
      assignment_status ?? null,
      override_reason   ?? null,
      hierarchy_node_id ?? null,
      req.params.id,
      identity
    );

    // Audit
    db.prepare(`
      INSERT INTO io_audit_trail (import_id, tag_id, action, actor, before_val, after_val, reason)
      VALUES (?,?,'override','user',?,?,?)
    `).run(req.params.id, tag.id,
      JSON.stringify({ assigned_cm_type: tag.assigned_cm_type, assignment_status: tag.assignment_status }),
      JSON.stringify({ assigned_cm_type, assignment_status }),
      override_reason || null
    );

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/io/imports/:id/tags/:tagId/reject
// Marks all IO rows of the instrument as rejected AND removes the instance from any project.
router.post('/imports/:id/tags/:tagId/reject', (req, res) => {
  try {
    const db  = getDb();
    const tag = db.prepare('SELECT * FROM io_tags WHERE id=? AND import_id=?')
      .get(req.params.tagId, req.params.id);
    if (!tag) return err(res, 404, 'Tag not found');

    const identity   = tag.instrument_tag || tag.tag_name;
    const importId   = req.params.id;
    const imp        = db.prepare('SELECT project_id FROM io_imports WHERE id=?').get(importId);

    db.transaction(() => {
      // Mark all IO rows of this instrument as rejected
      db.prepare(`
        UPDATE io_tags SET assignment_status='rejected', assigned_by='user',
          assigned_at=datetime('now'), updated_at=datetime('now')
        WHERE import_id=? AND COALESCE(instrument_tag, tag_name)=?
      `).run(importId, identity);

      // Remove the matching project_instance by name (if it was promoted)
      if (imp?.project_id) {
        db.prepare(
          'DELETE FROM project_instances WHERE project_id=? AND instance_name=?'
        ).run(imp.project_id, identity);
      }

      db.prepare(`
        INSERT INTO io_audit_trail (import_id, tag_id, action, actor, after_val)
        VALUES (?,?,'reject','user',?)
      `).run(importId, tag.id, JSON.stringify({ identity, removed_from_project: !!imp?.project_id }));
    })();

    res.json({ success: true, identity, removedFromProject: !!imp?.project_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/io/imports/:id/approve-all — approve all auto-assigned tags
router.post('/imports/:id/approve-all', (req, res) => {
  try {
    const db = getDb();
    const { tag_ids } = req.body || {};
    if (tag_ids?.length) {
      const placeholders = tag_ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE io_tags SET assignment_status='approved', assigned_by='user', assigned_at=datetime('now')
        WHERE import_id=? AND id IN (${placeholders}) AND assigned_cm_type IS NOT NULL
      `).run(req.params.id, ...tag_ids);
    } else {
      db.prepare(`
        UPDATE io_tags SET assignment_status='approved', assigned_by='user', assigned_at=datetime('now')
        WHERE import_id=? AND assignment_status='auto' AND assigned_cm_type IS NOT NULL
      `).run(req.params.id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Column Mapping Configs ────────────────────────────────────────────────────

router.get('/column-maps', (req, res) => {
  try {
    res.json(getDb().prepare('SELECT * FROM io_column_mappings ORDER BY name').all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/column-maps', (req, res) => {
  try {
    const db = getDb();
    const { name, description, mappings, included } = req.body || {};
    if (!name?.trim()) return err(res, 400, 'name required');
    const row = db.prepare(
      `INSERT INTO io_column_mappings (name, description, mappings, included) VALUES (?,?,?,?)`
    ).run(name.trim(), description || '', JSON.stringify(mappings || {}), included ?? null);
    res.json({ id: row.lastInsertRowid, name: name.trim(), description: description || '', mappings: mappings || {}, included: included ?? null });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return err(res, 409, 'Name already exists');
    res.status(500).json({ error: e.message });
  }
});

router.put('/column-maps/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, description, mappings, included } = req.body || {};
    if (!name?.trim()) return err(res, 400, 'name required');
    db.prepare(
      `UPDATE io_column_mappings SET name=?, description=?, mappings=?, included=?, updated_at=datetime('now') WHERE id=?`
    ).run(name.trim(), description || '', JSON.stringify(mappings || {}), included ?? null, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/column-maps/:id', (req, res) => {
  try {
    getDb().prepare('DELETE FROM io_column_mappings WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply a column map to an existing import
router.post('/imports/:id/apply-column-map', (req, res) => {
  try {
    const db = getDb();
    const { column_map_id } = req.body || {};
    const cm = db.prepare('SELECT * FROM io_column_mappings WHERE id=?').get(column_map_id);
    if (!cm) return err(res, 404, 'Column map not found');
    const impId = parseInt(req.params.id, 10);
    applyMapping(db, impId, JSON.parse(cm.mappings || '{}'));
    db.prepare('UPDATE io_imports SET column_map_id=? WHERE id=?').run(column_map_id, impId);
    const hierarchyStats = buildHierarchy(db, impId);
    const validation = validateTags(db, impId);
    res.json({ success: true, validation, hierarchyStats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Function Mapping Configs ──────────────────────────────────────────────────

router.get('/function-maps', (req, res) => {
  try {
    const db   = getDb();
    const cfgs = db.prepare('SELECT * FROM io_function_map_configs ORDER BY name').all();
    res.json(cfgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/function-maps', (req, res) => {
  try {
    const db = getDb();
    const { name, description } = req.body || {};
    if (!name?.trim()) return err(res, 400, 'name required');
    const row = db.prepare(
      `INSERT INTO io_function_map_configs (name, description) VALUES (?,?)`
    ).run(name.trim(), description || '');
    res.json({ id: row.lastInsertRowid, name: name.trim(), description: description || '' });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return err(res, 409, 'Name already exists');
    res.status(500).json({ error: e.message });
  }
});

router.put('/function-maps/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, description } = req.body || {};
    db.prepare(`UPDATE io_function_map_configs SET name=?, description=?, updated_at=datetime('now') WHERE id=?`)
      .run(name?.trim() || '', description || '', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/function-maps/:id', (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM io_function_mappings WHERE config_id=?').run(req.params.id);
      db.prepare('DELETE FROM io_function_map_configs WHERE id=?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/function-maps/:id/mappings
router.get('/function-maps/:id/mappings', (req, res) => {
  try {
    res.json(getDb().prepare(
      'SELECT * FROM io_function_mappings WHERE config_id=? ORDER BY priority DESC, function_value'
    ).all(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/io/function-maps/:id/mappings — full replace
router.put('/function-maps/:id/mappings', (req, res) => {
  try {
    const db = getDb();
    const { mappings } = req.body || {};
    db.transaction(() => {
      db.prepare('DELETE FROM io_function_mappings WHERE config_id=?').run(req.params.id);
      const ins = db.prepare(`
        INSERT INTO io_function_mappings
          (config_id, function_value, cm_type_name, priority, match_mode, match_pattern, notes)
        VALUES (?,?,?,?,?,?,?)
      `);
      for (const m of (mappings || [])) {
        if (!m.function_value?.trim() || !m.cm_type_name?.trim()) continue;
        ins.run(req.params.id, m.function_value.trim().toUpperCase(),
          m.cm_type_name.trim(), m.priority || 0,
          m.match_mode || 'exact', m.match_pattern || null, m.notes || null);
      }
    })();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hierarchy ─────────────────────────────────────────────────────────────────

// GET /api/io/hierarchy-levels — return the valid ISA-88 levels for the UI picker
router.get('/hierarchy-levels', (_req, res) => res.json(VALID_LEVELS));

// POST /api/io/imports/:id/build-hierarchy
// body: { levelMap: ['Area','ProcessCell','Unit'] }  — optional
router.post('/imports/:id/build-hierarchy', (req, res) => {
  try {
    const db       = getDb();
    const levelMap = req.body?.levelMap;
    const importId = parseInt(req.params.id, 10);
    const result   = buildHierarchy(db, importId, levelMap);
    // Persist the effective level map so the UI restores it on reload
    db.prepare('UPDATE io_imports SET level_map=? WHERE id=?')
      .run(JSON.stringify(result.effectiveLevelMap), importId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/hierarchy
router.get('/imports/:id/hierarchy', (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const imp      = db.prepare('SELECT level_map FROM io_imports WHERE id=?').get(importId);
    const levelMap = imp?.level_map ? JSON.parse(imp.level_map) : null;
    const tree     = loadHierarchyTree(db, importId);
    res.json({ tree, levelMap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Assignment Engine ─────────────────────────────────────────────────────────

// POST /api/io/imports/:id/assign
router.post('/imports/:id/assign', (req, res) => {
  try {
    const db = getDb();
    const { function_map_id } = req.body || {};
    if (!function_map_id) return err(res, 400, 'function_map_id required');
    const report = runAssignment(db, parseInt(req.params.id, 10), parseInt(function_map_id, 10));
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/unresolved-functions
router.get('/imports/:id/unresolved-functions', (req, res) => {
  try {
    res.json(getUnresolvedFunctions(getDb(), req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Validation report ─────────────────────────────────────────────────────────

router.get('/imports/:id/validation-report', (req, res) => {
  try {
    const db = getDb();
    const logs = db.prepare(`
      SELECT v.*, t.tag_name, t.row_number
      FROM io_validation_log v
      LEFT JOIN io_tags t ON t.id = v.tag_id
      WHERE v.import_id=?
      ORDER BY v.severity DESC, v.id
    `).all(req.params.id);
    const summary = { error: 0, warning: 0, info: 0 };
    for (const l of logs) summary[l.severity] = (summary[l.severity] || 0) + 1;
    res.json({ summary, logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Promote ───────────────────────────────────────────────────────────────────

// POST /api/io/imports/:id/promote?projectId=N
router.post('/imports/:id/promote', (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.body.projectId || req.query.projectId, 10);
    if (!projectId) return err(res, 400, 'projectId required');
    const result = promoteToProject(db, parseInt(req.params.id, 10), projectId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export CSV ────────────────────────────────────────────────────────────────

router.get('/imports/:id/export', (req, res) => {
  try {
    const db   = getDb();
    const tags = db.prepare(`
      SELECT t.row_number, t.tag_name, t.function_val, t.assigned_cm_type,
             t.assignment_status, t.description, t.unit_id, t.area, t.equipment_module,
             t.signal_type, t.override_reason, t.validation_status,
             n.name AS hierarchy_path
      FROM io_tags t
      LEFT JOIN io_hierarchy_nodes n ON n.id=t.hierarchy_node_id
      WHERE t.import_id=? ORDER BY t.row_number
    `).all(req.params.id);

    const imp = db.prepare('SELECT file_name FROM io_imports WHERE id=?').get(req.params.id);
    const baseName = (imp?.file_name || 'export').replace(/\.[^.]+$/, '');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}_assignment.csv"`);

    const headers = ['Row','Tag','Function','Assigned Type','Status','Description','Unit','Area','Equipment','Signal Type','Hierarchy','Override Reason'];
    res.write(headers.join(',') + '\r\n');
    for (const t of tags) {
      const row = [
        t.row_number, t.tag_name, t.function_val, t.assigned_cm_type,
        t.assignment_status, t.description, t.unit_id, t.area,
        t.equipment_module, t.signal_type, t.hierarchy_path, t.override_reason,
      ].map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`);
      res.write(row.join(',') + '\r\n');
    }
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
