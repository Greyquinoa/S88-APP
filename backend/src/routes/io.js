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
    if (!(await db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)))
      return err(res, 404, 'Project not found');

    if (!req.file) return err(res, 400, 'No file uploaded');

    const buffer    = req.file.buffer;
    const sheetName = req.query.sheet || null;

    // List sheets (for pre-upload sheet-picker)
    const sheets = await listSheets(buffer);
    const targetSheet = sheetName || sheets[0];

    const { headers, rows } = await parseSheet(buffer, targetSheet);

    // Create the import record
    const impRow = await db.prepare(`
      INSERT INTO io_imports (project_id, file_name, file_size_bytes, sheet_name, total_rows, status)
      VALUES (?,?,?,?,?,'pending')
    `).run(projectId, req.file.originalname, req.file.size, targetSheet, rows.length);
    const importId = impRow.lastInsertRowid;

    // Bulk-insert raw rows in batches of 500
    const insert = db.prepare(`
      INSERT INTO io_tags (import_id, row_number, raw_data) VALUES (?,?,?)
    `);
    const batchInsert = db.transaction(async (batch) => {
      for (const r of batch) await insert.run(importId, r.rowNum, JSON.stringify(r.data));
    });
    for (let i = 0; i < rows.length; i += 500) {
      await batchInsert(rows.slice(i, i + 500));
    }

    // Auto-suggest column mapping
    const suggestions = suggestMappings(headers);

    // Apply column_map_id immediately if provided, then auto-build hierarchy
    const cmId = req.query.column_map_id ? parseInt(req.query.column_map_id, 10) : null;
    let hierarchyStats = null;
    if (cmId) {
      const cm = await db.prepare('SELECT mappings FROM io_column_mappings WHERE id=?').get(cmId);
      if (cm) {
        let parsedCm = {};
        try { parsedCm = JSON.parse(cm.mappings || '{}'); } catch (_) {}
        // Unified configs (UnifiedColumnMappingScreen) nest instance mappings under
        // .instance alongside a sibling .hardware map — applyMapping expects the flat
        // { customerCol: internalField } shape directly, or every field gets written
        // null (silently breaking hierarchy build downstream).
        const instanceMappings = parsedCm.instance || parsedCm;
        await applyMapping(db, importId, instanceMappings);
        // source_column_map_id preserves this user-picked config (may carry a
        // .hardware mapping) even after column_map_id is later overwritten by the
        // transient instance-only config the "Import Instances" flow applies.
        await db.prepare('UPDATE io_imports SET column_map_id=?, source_column_map_id=? WHERE id=?').run(cmId, cmId, importId);
        hierarchyStats = await buildHierarchy(db, parseInt(importId, 10));
      }
    }

    // Run initial validation
    const validation = await validateTags(db, importId);

    res.json({
      importId,
      sheets,
      sheet: targetSheet,
      headers,
      totalRows: rows.length,
      suggestions,
      validation,
      hierarchyStats,
      preview: rows.map(r => r.data),
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
    const imp      = await db.prepare('SELECT * FROM io_imports WHERE id=?').get(importId);
    if (!imp) return err(res, 404, 'Import not found');
    if (!req.file) return err(res, 400, 'No file uploaded');

    const sheetName = req.query.sheet || imp.sheet_name || null;
    const sheets    = await listSheets(req.file.buffer);
    const targetSheet = sheetName || sheets[0];
    const { headers, rows } = await parseSheet(req.file.buffer, targetSheet);

    await db.transaction(async () => {
      // Wipe old data
      await db.prepare('DELETE FROM io_validation_log WHERE import_id=?').run(importId);
      await db.prepare('DELETE FROM io_audit_trail    WHERE import_id=?').run(importId);
      await db.prepare('DELETE FROM io_hierarchy_nodes WHERE import_id=?').run(importId);
      await db.prepare('DELETE FROM io_tags           WHERE import_id=?').run(importId);

      // Update import record metadata
      await db.prepare(`
        UPDATE io_imports SET
          file_name=?, file_size_bytes=?, sheet_name=?, total_rows=?,
          status='pending', imported_at=NOW()
        WHERE id=?
      `).run(req.file.originalname, req.file.size, targetSheet, rows.length, importId);

      // Re-insert raw rows
      const ins = db.prepare('INSERT INTO io_tags (import_id, row_number, raw_data) VALUES (?,?,?)');
      for (const r of rows) await ins.run(importId, r.rowNum, JSON.stringify(r.data));
    })();

    // Re-apply existing column mapping if one is saved
    let hierarchyStats = null;
    if (imp.column_map_id) {
      const cm = await db.prepare('SELECT mappings FROM io_column_mappings WHERE id=?').get(imp.column_map_id);
      if (cm) {
        let parsedCm = {};
        try { parsedCm = JSON.parse(cm.mappings || '{}'); } catch (_) {}
        const instanceMappings = parsedCm.instance || parsedCm; // unwrap Unified nested shape, see apply-column-map
        await applyMapping(db, importId, instanceMappings);
        hierarchyStats = await buildHierarchy(db, importId);
      }
    }

    const validation = await validateTags(db, importId);
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
      preview: rows.map(r => r.data),
    });
  } catch (e) {
    console.error('[IO reimport]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/io/project/:projectId/imports — list imports for a project
// GET /api/io/imports/latest — most recently uploaded IO import across all projects.
// Used to seed column-name suggestions where no single project is in scope (e.g. the
// global Composite CM Types editor's derived-value column picker).
router.get('/imports/latest', async (req, res) => {
  try {
    const db  = getDb();
    const imp = await db.prepare('SELECT * FROM io_imports ORDER BY imported_at DESC LIMIT 1').get();
    res.json(imp || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/project/:projectId/imports', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT i.*,
             (SELECT COUNT(*) FROM io_tags WHERE import_id=i.id) AS total_tags,
             (SELECT COUNT(*) FROM io_tags WHERE import_id=i.id AND assignment_status='auto') AS auto_assigned,
             (SELECT COUNT(*) FROM io_tags WHERE import_id=i.id AND assignment_status='unresolved') AS unresolved
      FROM io_imports i WHERE i.project_id=? ORDER BY i.imported_at DESC
    `).all(req.params.projectId);
    res.json(rows.map(r => ({
      ...r,
      total_tags: Number(r.total_tags),
      auto_assigned: Number(r.auto_assigned),
      unresolved: Number(r.unresolved),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/headers — column headers detected at upload time
router.get('/imports/:id/headers', async (req, res) => {
  try {
    const db  = getDb();
    const tag = await db.prepare('SELECT raw_data FROM io_tags WHERE import_id=? LIMIT 1').get(req.params.id);
    if (!tag) return res.json({ headers: [] });
    let headers = [];
    try { headers = Object.keys(JSON.parse(tag.raw_data || '{}')); } catch (_) {}
    res.json({ headers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/preview — all raw rows for preview display
router.get('/imports/:id/preview', async (req, res) => {
  try {
    const db  = getDb();
    const imp = await db.prepare('SELECT total_rows FROM io_imports WHERE id=?').get(req.params.id);
    if (!imp) return err(res, 404, 'Import not found');

    const rows = await db.prepare(
      'SELECT raw_data FROM io_tags WHERE import_id=? ORDER BY row_number'
    ).all(req.params.id);

    const preview = [];
    for (const row of rows) {
      try {
        preview.push(JSON.parse(row.raw_data || '{}'));
      } catch (_) {
        preview.push({});
      }
    }

    res.json({ preview, totalRows: imp.total_rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id — single import detail
router.get('/imports/:id', async (req, res) => {
  try {
    const db  = getDb();
    const imp = await db.prepare('SELECT * FROM io_imports WHERE id=?').get(req.params.id);
    if (!imp) return err(res, 404, 'Import not found');
    const stats = await db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN assignment_status='auto' THEN 1 ELSE 0 END) AS auto_assigned,
        SUM(CASE WHEN assignment_status='unresolved' THEN 1 ELSE 0 END) AS unresolved,
        SUM(CASE WHEN assignment_status='manual_override' THEN 1 ELSE 0 END) AS manual_override,
        SUM(CASE WHEN assignment_status='approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN validation_status='error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN validation_status='warning' THEN 1 ELSE 0 END) AS warnings
      FROM io_tags WHERE import_id=?
    `).get(req.params.id);
    const numericStats = {};
    for (const k of Object.keys(stats)) numericStats[k] = Number(stats[k]) || 0;
    res.json({ ...imp, stats: numericStats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/io/imports/:id
router.delete('/imports/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.transaction(async () => {
      await db.prepare('DELETE FROM io_validation_log WHERE import_id=?').run(req.params.id);
      await db.prepare('DELETE FROM io_audit_trail WHERE import_id=?').run(req.params.id);
      await db.prepare('DELETE FROM io_tags WHERE import_id=?').run(req.params.id);
      await db.prepare('DELETE FROM io_hierarchy_nodes WHERE import_id=?').run(req.params.id);
      await db.prepare('DELETE FROM io_imports WHERE id=?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/tags — paginated, one row per unique instrument_tag
router.get('/imports/:id/tags', async (req, res) => {
  try {
    const db      = getDb();
    const page    = Math.max(1, parseInt(req.query.page  || '1',   10));
    const perPage = Math.min(200, parseInt(req.query.per || '100', 10));
    const status  = req.query.status || null;
    const search  = req.query.search || null;
    const offset  = (page - 1) * perPage;

    // Collapse IO rows into one row per instrument identity (instrument_tag when
    // mapped, else tag_name). Uses Postgres DISTINCT ON to pick the representative
    // row — the best assignment_status, then lowest id within that. This gives a
    // single real row per instrument, so assigned_cm_type / hierarchy / etc. all
    // come from that same best row (no ungrouped-column or GROUP BY issues).
    // status filter and search apply on the collapsed result.
    const baseParams = [req.params.id];

    let statusFilter = '';
    if (status && status !== 'all') {
      statusFilter = `AND g.assignment_status = '${status.replace(/'/g, "''")}'`;
    }
    let searchFilter = '';
    const searchParams = [];
    if (search) {
      searchFilter = 'AND (g.identity LIKE ? OR g.function_val LIKE ? OR g.hierarchy LIKE ?)';
      searchParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // base = rows with a real identity, annotated with a status rank for ordering.
    // Skip rows with no identity (blank cells in instrument_tag + tag_name) — these
    // are unassigned channels with no real CM, and shouldn't appear in Review.
    // agg  = per-identity io_count and the lowest row_number (for stable ordering).
    // rep  = DISTINCT ON picks one representative row per identity (best status).
    const subSql = `
      WITH base AS (
        SELECT
          t.*,
          COALESCE(t.instrument_tag, t.tag_name) AS identity,
          CASE t.assignment_status
            WHEN 'manual_override' THEN 1
            WHEN 'approved'        THEN 2
            WHEN 'auto'            THEN 3
            WHEN 'unresolved'      THEN 4
            ELSE 5
          END AS status_rank
        FROM io_tags t
        WHERE t.import_id = ?
          AND ((t.instrument_tag IS NOT NULL AND t.instrument_tag != '')
            OR (t.tag_name IS NOT NULL AND t.tag_name != ''))
      ),
      agg AS (
        SELECT identity,
               COUNT(*)                                 AS io_count,
               MIN(row_number)                          AS min_row_number,
               -- hierarchy_node_id / assignment may live on a row other than the
               -- representative one; take the first non-null across the group.
               MIN(hierarchy_node_id) FILTER (WHERE hierarchy_node_id IS NOT NULL) AS any_hierarchy_node_id,
               MIN(assignment)        FILTER (WHERE assignment IS NOT NULL)        AS any_assignment
        FROM base
        GROUP BY identity
      ),
      rep AS (
        SELECT DISTINCT ON (identity)
          identity,
          id,
          import_id,
          hierarchy,
          function_val,
          assignment_status,
          assigned_cm_type,
          hierarchy_node_id,
          assignment,
          validation_status
        FROM base
        ORDER BY identity, status_rank, (assigned_cm_type IS NULL), id
      )
      SELECT
        rep.identity,
        rep.id,
        rep.import_id,
        rep.hierarchy,
        rep.function_val,
        rep.assignment_status,
        rep.assigned_cm_type,
        COALESCE(rep.hierarchy_node_id, agg.any_hierarchy_node_id) AS hierarchy_node_id,
        COALESCE(rep.assignment, agg.any_assignment)              AS assignment,
        rep.validation_status,
        agg.io_count,
        agg.min_row_number AS row_number
      FROM rep
      JOIN agg ON agg.identity = rep.identity
    `;

    const countSql = `SELECT COUNT(*) AS n FROM (${subSql}) g
      WHERE 1=1 ${statusFilter} ${searchFilter}`;
    const total = Number((await db.prepare(countSql).get(...baseParams, ...searchParams)).n);

    const pageSql = `
      SELECT g.*, n.name AS node_name, n.level AS node_level
      FROM (${subSql}) g
      LEFT JOIN io_hierarchy_nodes n ON n.id = g.hierarchy_node_id
      WHERE 1=1 ${statusFilter} ${searchFilter}
      ORDER BY g.row_number
      LIMIT ? OFFSET ?
    `;
    const tags = await db.prepare(pageSql).all(...baseParams, ...searchParams, perPage, offset);

    // Add sequential row numbers to the result (1, 2, 3, ...) instead of using
    // row_number from the IO list, which has gaps from filtered blank rows.
    tags.forEach((tag, idx) => {
      tag.row_number = offset + idx + 1;
    });

    res.json({ tags, total, page, perPage, pages: Math.ceil(total / perPage) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/io/imports/:id/tags/:tagId — override assignment for all IO rows of that instrument
router.patch('/imports/:id/tags/:tagId', async (req, res) => {
  try {
    const db  = getDb();
    const tag = await db.prepare('SELECT * FROM io_tags WHERE id=? AND import_id=?')
      .get(req.params.tagId, req.params.id);
    if (!tag) return err(res, 404, 'Tag not found');

    const { assigned_cm_type, assignment_status, override_reason, hierarchy_node_id } = req.body;

    // Apply to all IO rows that share the same instrument identity in this import
    const identity = tag.instrument_tag || tag.tag_name;
    await db.prepare(`
      UPDATE io_tags SET
        assigned_cm_type   = COALESCE(?, assigned_cm_type),
        assignment_status  = COALESCE(?, assignment_status),
        override_reason    = COALESCE(?, override_reason),
        hierarchy_node_id  = COALESCE(?, hierarchy_node_id),
        assigned_by        = 'user',
        assigned_at        = NOW(),
        updated_at         = NOW()
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
    await db.prepare(`
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
router.post('/imports/:id/tags/:tagId/reject', async (req, res) => {
  try {
    const db  = getDb();
    const tag = await db.prepare('SELECT * FROM io_tags WHERE id=? AND import_id=?')
      .get(req.params.tagId, req.params.id);
    if (!tag) return err(res, 404, 'Tag not found');

    const identity   = tag.instrument_tag || tag.tag_name;
    const importId   = req.params.id;
    const imp        = await db.prepare('SELECT project_id FROM io_imports WHERE id=?').get(importId);

    await db.transaction(async () => {
      // Mark all IO rows of this instrument as rejected
      await db.prepare(`
        UPDATE io_tags SET assignment_status='rejected', assigned_by='user',
          assigned_at=NOW(), updated_at=NOW()
        WHERE import_id=? AND COALESCE(instrument_tag, tag_name)=?
      `).run(importId, identity);

      // Remove the matching project_instance by name (if it was promoted)
      if (imp?.project_id) {
        await db.prepare(
          'DELETE FROM project_instances WHERE project_id=? AND instance_name=?'
        ).run(imp.project_id, identity);
      }

      await db.prepare(`
        INSERT INTO io_audit_trail (import_id, tag_id, action, actor, after_val)
        VALUES (?,?,'reject','user',?)
      `).run(importId, tag.id, JSON.stringify({ identity, removed_from_project: !!imp?.project_id }));
    })();

    res.json({ success: true, identity, removedFromProject: !!imp?.project_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/io/imports/:id/approve-all — approve all auto-assigned tags
router.post('/imports/:id/approve-all', async (req, res) => {
  try {
    const db = getDb();
    const { tag_ids } = req.body || {};
    if (tag_ids?.length) {
      const placeholders = tag_ids.map(() => '?').join(',');
      await db.prepare(`
        UPDATE io_tags SET assignment_status='approved', assigned_by='user', assigned_at=NOW()
        WHERE import_id=? AND id IN (${placeholders}) AND assigned_cm_type IS NOT NULL
      `).run(req.params.id, ...tag_ids);
    } else {
      await db.prepare(`
        UPDATE io_tags SET assignment_status='approved', assigned_by='user', assigned_at=NOW()
        WHERE import_id=? AND assignment_status='auto' AND assigned_cm_type IS NOT NULL
      `).run(req.params.id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Column Mapping Configs ────────────────────────────────────────────────────

router.get('/column-maps', async (req, res) => {
  try {
    res.json(await getDb().prepare('SELECT * FROM io_column_mappings ORDER BY name').all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/column-maps', async (req, res) => {
  try {
    const db = getDb();
    const { name, description, mappings, included } = req.body || {};
    if (!name?.trim()) return err(res, 400, 'name required');
    const row = await db.prepare(
      `INSERT INTO io_column_mappings (name, description, mappings, included) VALUES (?,?,?,?)`
    ).run(name.trim(), description || '', JSON.stringify(mappings || {}), included ?? null);
    res.json({ id: row.lastInsertRowid, name: name.trim(), description: description || '', mappings: mappings || {}, included: included ?? null });
  } catch (e) {
    if (e.message?.toLowerCase().includes('unique') || e.code === '23505') return err(res, 409, 'Name already exists');
    res.status(500).json({ error: e.message });
  }
});

router.put('/column-maps/:id', async (req, res) => {
  try {
    const db = getDb();
    const { name, description, mappings, included } = req.body || {};
    if (!name?.trim()) return err(res, 400, 'name required');
    await db.prepare(
      `UPDATE io_column_mappings SET name=?, description=?, mappings=?, included=?, updated_at=NOW() WHERE id=?`
    ).run(name.trim(), description || '', JSON.stringify(mappings || {}), included ?? null, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/column-maps/:id', async (req, res) => {
  try {
    await getDb().prepare('DELETE FROM io_column_mappings WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply a column map to an existing import
router.post('/imports/:id/apply-column-map', async (req, res) => {
  try {
    const db = getDb();
    const { column_map_id } = req.body || {};
    const cm = await db.prepare('SELECT * FROM io_column_mappings WHERE id=?').get(column_map_id);
    if (!cm) return err(res, 404, 'Column map not found');
    const impId = parseInt(req.params.id, 10);
    let parsedCm = {};
    try { parsedCm = JSON.parse(cm.mappings || '{}'); } catch (_) {}
    // Unified configs (UnifiedColumnMappingScreen) nest instance mappings under
    // .instance alongside a sibling .hardware map — applyMapping expects the flat
    // { customerCol: internalField } shape directly, or every field gets written
    // null (silently breaking hierarchy build downstream). The transient
    // __io_instances_* configs are already flat, so `.instance || parsedCm` covers both.
    const instanceMappings = parsedCm.instance || parsedCm;
    await applyMapping(db, impId, instanceMappings);

    // Transient configs auto-created by the "Import Instances" unified-mapping flow
    // (named __io_instances_<id>) are instance-only and must NOT overwrite
    // source_column_map_id — that column preserves the user's real, originally
    // picked config (which may carry a .hardware mapping) for the workflow engine.
    const isTransient = String(cm.name || '').startsWith('__io_instances_');
    if (isTransient) {
      await db.prepare('UPDATE io_imports SET column_map_id=? WHERE id=?').run(column_map_id, impId);
    } else {
      await db.prepare('UPDATE io_imports SET column_map_id=?, source_column_map_id=? WHERE id=?')
        .run(column_map_id, column_map_id, impId);
    }

    const hierarchyStats = await buildHierarchy(db, impId);
    const validation = await validateTags(db, impId);
    res.json({ success: true, validation, hierarchyStats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/io/imports/:id/set-source-column-map
// Records which saved column-map config the user picked as the "real" source of
// truth for this import — independent of column_map_id, which the "Import
// Instances" flow overwrites with a transient instance-only config. Called from
// the Unified Column Mapping screen's "Import Hardware" button, since clicking it
// is the clearest signal that this config's .hardware mapping belongs to the
// import (used later by the automated workflow to sync hardware signals).
router.post('/imports/:id/set-source-column-map', async (req, res) => {
  try {
    const db = getDb();
    const { column_map_id } = req.body || {};
    if (!column_map_id) return err(res, 400, 'column_map_id required');
    const impId = parseInt(req.params.id, 10);
    const cm = await db.prepare('SELECT id FROM io_column_mappings WHERE id=?').get(column_map_id);
    if (!cm) return err(res, 404, 'Column map not found');
    await db.prepare('UPDATE io_imports SET source_column_map_id=? WHERE id=?').run(column_map_id, impId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Function Mapping Configs ──────────────────────────────────────────────────

router.get('/function-maps', async (req, res) => {
  try {
    const db   = getDb();
    const cfgs = await db.prepare('SELECT * FROM io_function_map_configs ORDER BY name').all();
    res.json(cfgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/function-maps', async (req, res) => {
  try {
    const db = getDb();
    const { name, description } = req.body || {};
    if (!name?.trim()) return err(res, 400, 'name required');
    const row = await db.prepare(
      `INSERT INTO io_function_map_configs (name, description) VALUES (?,?)`
    ).run(name.trim(), description || '');
    res.json({ id: row.lastInsertRowid, name: name.trim(), description: description || '' });
  } catch (e) {
    if (e.message?.toLowerCase().includes('unique') || e.code === '23505') return err(res, 409, 'Name already exists');
    res.status(500).json({ error: e.message });
  }
});

router.put('/function-maps/:id', async (req, res) => {
  try {
    const db = getDb();
    const { name, description } = req.body || {};
    await db.prepare(`UPDATE io_function_map_configs SET name=?, description=?, updated_at=NOW() WHERE id=?`)
      .run(name?.trim() || '', description || '', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/function-maps/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.transaction(async () => {
      await db.prepare('DELETE FROM io_function_mappings WHERE config_id=?').run(req.params.id);
      await db.prepare('DELETE FROM io_function_map_configs WHERE id=?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/function-maps/:id/mappings
router.get('/function-maps/:id/mappings', async (req, res) => {
  try {
    res.json(await getDb().prepare(
      'SELECT * FROM io_function_mappings WHERE config_id=? ORDER BY priority DESC, function_value'
    ).all(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/io/function-maps/:id/mappings — full replace
router.put('/function-maps/:id/mappings', async (req, res) => {
  try {
    const db = getDb();
    const { mappings } = req.body || {};
    await db.transaction(async () => {
      await db.prepare('DELETE FROM io_function_mappings WHERE config_id=?').run(req.params.id);
      const ins = db.prepare(`
        INSERT INTO io_function_mappings
          (config_id, function_value, cm_type_name, priority, match_mode, match_pattern, notes)
        VALUES (?,?,?,?,?,?,?)
      `);
      for (const m of (mappings || [])) {
        if (!m.function_value?.trim() || !m.cm_type_name?.trim()) continue;
        await ins.run(req.params.id, m.function_value.trim().toUpperCase(),
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
router.post('/imports/:id/build-hierarchy', async (req, res) => {
  try {
    const db       = getDb();
    const levelMap = req.body?.levelMap;
    const importId = parseInt(req.params.id, 10);
    const result   = await buildHierarchy(db, importId, levelMap);
    // Persist the effective level map so the UI restores it on reload
    await db.prepare('UPDATE io_imports SET level_map=? WHERE id=?')
      .run(JSON.stringify(result.effectiveLevelMap), importId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/hierarchy
router.get('/imports/:id/hierarchy', async (req, res) => {
  try {
    const db       = getDb();
    const importId = parseInt(req.params.id, 10);
    const imp      = await db.prepare('SELECT level_map FROM io_imports WHERE id=?').get(importId);
    const levelMap = imp?.level_map ? JSON.parse(imp.level_map) : null;
    const tree     = await loadHierarchyTree(db, importId);
    res.json({ tree, levelMap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Assignment Engine ─────────────────────────────────────────────────────────

// POST /api/io/imports/:id/assign
router.post('/imports/:id/assign', async (req, res) => {
  try {
    const db = getDb();
    const { function_map_id } = req.body || {};
    if (!function_map_id) return err(res, 400, 'function_map_id required');
    const report = await runAssignment(db, parseInt(req.params.id, 10), parseInt(function_map_id, 10));
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/io/imports/:id/unresolved-functions
router.get('/imports/:id/unresolved-functions', async (req, res) => {
  try {
    res.json(await getUnresolvedFunctions(getDb(), req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Validation report ─────────────────────────────────────────────────────────

router.get('/imports/:id/validation-report', async (req, res) => {
  try {
    const db = getDb();
    const logs = await db.prepare(`
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
router.post('/imports/:id/promote', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.body.projectId || req.query.projectId, 10);
    if (!projectId) return err(res, 400, 'projectId required');
    const result = await promoteToProject(db, parseInt(req.params.id, 10), projectId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export CSV ────────────────────────────────────────────────────────────────

router.get('/imports/:id/export', async (req, res) => {
  try {
    const db   = getDb();
    const tags = await db.prepare(`
      SELECT t.row_number, t.tag_name, t.function_val, t.assigned_cm_type,
             t.assignment_status, t.description, t.unit_id, t.area, t.equipment_module,
             t.signal_type, t.override_reason, t.validation_status,
             n.name AS hierarchy_path
      FROM io_tags t
      LEFT JOIN io_hierarchy_nodes n ON n.id=t.hierarchy_node_id
      WHERE t.import_id=? ORDER BY t.row_number
    `).all(req.params.id);

    const imp = await db.prepare('SELECT file_name FROM io_imports WHERE id=?').get(req.params.id);
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

// ── GET /api/io/imports/:id/column-prefs — Get user's saved column selections ────
router.get('/imports/:id/column-prefs', async (req, res) => {
  try {
    const db = getDb();
    const prefs = await db.prepare(`
      SELECT active_columns FROM user_io_column_prefs WHERE import_id = ?
    `).get(parseInt(req.params.id, 10));
    const activeColumns = prefs ? JSON.parse(prefs.active_columns || '[]') : [];
    res.json({ activeColumns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/io/imports/:id/column-prefs — Save user's column selections ────
router.put('/imports/:id/column-prefs', async (req, res) => {
  try {
    const db = getDb();
    const { activeColumns = [] } = req.body || {};
    await db.prepare(`
      INSERT INTO user_io_column_prefs (import_id, active_columns)
      VALUES (?, ?)
      ON CONFLICT(import_id) DO UPDATE SET
        active_columns = excluded.active_columns,
        updated_at = NOW()
    `).run(parseInt(req.params.id, 10), JSON.stringify(activeColumns));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
