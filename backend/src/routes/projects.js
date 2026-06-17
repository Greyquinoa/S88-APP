// src/routes/projects.js — Saved instance sets ("Projects")
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb } = require('../db');
const { parsePcs7Config } = require('../pcs7ConfigParser');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = express.Router();

// ── GET /api/projects ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        p.id, p.name, p.comment, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM project_instances pi
          JOIN lib_cm_types lct ON lct.name = pi.cm_type
          WHERE pi.project_id = p.id AND (lct.cm_type = 'ControlModule' OR lct.cm_type = '')) AS cm_count,
        (SELECT COUNT(*) FROM project_instances pi
          JOIN lib_cm_types lct ON lct.name = pi.cm_type
          WHERE pi.project_id = p.id AND lct.cm_type = 'EquipmentModule') AS em_count,
        (SELECT COUNT(*) FROM project_instances pi
          JOIN lib_cm_types lct ON lct.name = pi.cm_type
          WHERE pi.project_id = p.id AND lct.cm_type = 'EquipmentPhase') AS eph_count
      FROM projects p
      ORDER BY p.updated_at DESC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const instances = db.prepare(`
      SELECT cm_type, instance_name, sampling_time, user_project, folder_id, role_assignments,
             composite_group_id, composite_id, member_idx
      FROM project_instances
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(req.params.id).map(r => ({
      ...r,
      role_assignments: r.role_assignments ? JSON.parse(r.role_assignments) : {},
    }));

    const cmtProfiles = db.prepare(`
      SELECT cm_type, enabled_blocks
      FROM project_cmt_profiles
      WHERE project_id = ?
    `).all(req.params.id).map(r => ({
      cmType:        r.cm_type,
      enabledBlocks: JSON.parse(r.enabled_blocks || '[]'),
    }));

    const userProjects = db.prepare(`
      SELECT name FROM project_user_projects
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(req.params.id).map(r => r.name);

    const hierarchy = db.prepare(`
      SELECT id, parent_id, name, s88_type, sort_order
      FROM project_hierarchy_folders
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(req.params.id);

    res.json({ ...project, instances, cmtProfiles, userProjects, hierarchy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects ────────────────────────────────────────────────────────
// Body: { name, comment, instances: [{cm_type, instance_name, sampling_time}],
//         cmtProfiles: [{cmType, enabledBlocks: [...]}] }
// Upserts by name — existing project with same name is replaced.
router.post('/', (req, res) => {
  try {
    const {
      name, comment,
      instances = [], cmtProfiles = [], userProjects = [], hierarchy = [],
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const db = getDb();

    const save = db.transaction(() => {
      db.prepare(`
        INSERT INTO projects (name, comment)
        VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET
          comment = excluded.comment,
          updated_at = datetime('now')
      `).run(name, comment || '');

      const row = db.prepare(`SELECT id FROM projects WHERE name = ?`).get(name);
      const projectId = row.id;

      db.prepare(`DELETE FROM project_instances         WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM project_cmt_profiles      WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM project_user_projects     WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM project_hierarchy_folders WHERE project_id = ?`).run(projectId);

      const insUp = db.prepare(`
        INSERT INTO project_user_projects (project_id, name, sort_order)
        VALUES (?,?,?)
      `);
      userProjects.forEach((n, idx) => insUp.run(projectId, n, idx));

      // Hierarchy: client sends rows pre-ordered (parents before children) with
      // clientId / parentClientId. clientIds prefixed "db" carry their existing
      // DB id (preserved across saves so the client doesn't have to re-map after
      // every auto-save). Others (new rows, "cf…") get a fresh autoincrement.
      const insFolderKeep = db.prepare(`
        INSERT INTO project_hierarchy_folders (id, project_id, parent_id, name, s88_type, sort_order)
        VALUES (?,?,?,?,?,?)
      `);
      const insFolderNew = db.prepare(`
        INSERT INTO project_hierarchy_folders (project_id, parent_id, name, s88_type, sort_order)
        VALUES (?,?,?,?,?)
      `);
      const folderIdMap = {}; // clientId -> dbId
      hierarchy.forEach((f, idx) => {
        const parentDbId = f.parentClientId != null ? folderIdMap[f.parentClientId] ?? null : null;
        const keepId = typeof f.clientId === 'string' && f.clientId.startsWith('db')
          ? Number(f.clientId.slice(2)) : null;
        let dbId;
        if (keepId != null && Number.isFinite(keepId)) {
          insFolderKeep.run(keepId, projectId, parentDbId, f.name, f.s88_type || null, f.sort_order ?? idx);
          dbId = keepId;
        } else {
          const r = insFolderNew.run(projectId, parentDbId, f.name, f.s88_type || null, f.sort_order ?? idx);
          dbId = r.lastInsertRowid;
        }
        folderIdMap[f.clientId] = dbId;
      });

      const insInst = db.prepare(`
        INSERT INTO project_instances (project_id, cm_type, instance_name, sampling_time, user_project, folder_id, role_assignments, sort_order, composite_group_id, composite_id, member_idx)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      instances.forEach((i, idx) => {
        const folderDbId = i.folder_client_id != null ? folderIdMap[i.folder_client_id] ?? null : null;
        insInst.run(projectId, i.cm_type, i.instance_name, i.sampling_time || '1000',
          i.user_project || null, folderDbId,
          JSON.stringify(i.role_assignments || {}), idx,
          i.composite_group_id ?? null, i.composite_id ?? null, i.member_idx ?? null);
      });

      const insProf = db.prepare(`
        INSERT INTO project_cmt_profiles (project_id, cm_type, enabled_blocks)
        VALUES (?,?,?)
      `);
      for (const p of cmtProfiles) {
        insProf.run(projectId, p.cmType, JSON.stringify(p.enabledBlocks || []));
      }

      return { projectId, folderIdMap };
    });

    const { projectId, folderIdMap } = save();
    res.json({ id: projectId, name, folderIdMap });
  } catch (err) {
    console.error('[Projects] Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id/pcs7-config ────────────────────────────────────────
router.get('/:id/pcs7-config', (req, res) => {
  try {
    const db  = getDb();
    const row = db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(req.params.id);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/projects/:id/pcs7-config — save manually-edited fields ──────────
router.put('/:id/pcs7-config', (req, res) => {
  try {
    const db  = getDb();
    const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    const {
      project_name, project_id_val, device_name, device_id, cpu_id,
      process_cell, process_cell_id, unit_name, unit_id, cm_folder_id,
      export_user, unit_author,
    } = req.body || {};
    db.prepare(`
      INSERT INTO project_config
        (project_id, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, unit_name, unit_id, cm_folder_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        unit_name        = excluded.unit_name,
        unit_id          = excluded.unit_id,
        cm_folder_id     = excluded.cm_folder_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = datetime('now')
    `).run(
      req.params.id,
      project_name || '', project_id_val || '', device_name || '', device_id || '', cpu_id || '',
      process_cell || '', process_cell_id || '', unit_name || '', unit_id || '', cm_folder_id || '',
      export_user || '', unit_author || '',
    );
    const saved = db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(req.params.id);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/pcs7-config/parse-xml — upload + parse SimaticML ──
router.post('/:id/pcs7-config/parse-xml', upload.single('pcs7xml'), async (req, res) => {
  try {
    const db   = getDb();
    const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: pcs7xml)' });

    const { config, missing } = await parsePcs7Config(req.file.buffer);

    // Upsert into project_config
    db.prepare(`
      INSERT INTO project_config
        (project_id, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, unit_name, unit_id, cm_folder_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        unit_name        = excluded.unit_name,
        unit_id          = excluded.unit_id,
        cm_folder_id     = excluded.cm_folder_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = datetime('now')
    `).run(
      req.params.id,
      config.project_name, config.project_id_val, config.device_name, config.device_id, config.cpu_id,
      config.process_cell, config.process_cell_id, config.unit_name, config.unit_id, config.cm_folder_id,
      config.export_user, config.unit_author,
    );

    const saved = db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(req.params.id);
    res.json({ config: saved, missing });
  } catch (err) {
    console.error('[Projects] pcs7-config parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const del = db.transaction(() => {
      db.prepare(`DELETE FROM project_instances         WHERE project_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM project_cmt_profiles      WHERE project_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM project_user_projects     WHERE project_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM project_hierarchy_folders WHERE project_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM project_config            WHERE project_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM projects                  WHERE id = ?`).run(req.params.id);
    });
    del();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
