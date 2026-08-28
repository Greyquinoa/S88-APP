// src/routes/projects.js — Saved instance sets ("Projects")
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb } = require('../db');
const { parsePcs7Config } = require('../pcs7ConfigParser');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = express.Router();

// Replace the stored per-device hardware IDs for one user project. A PCS7 config
// upload covers the whole user project, so its device list is authoritative:
// delete-then-insert keeps removed controllers from lingering.
async function replaceConfigDevices(db, projectId, userProject, devices) {
  await db.prepare(
    'DELETE FROM project_config_devices WHERE project_id = ? AND user_project = ?'
  ).run(projectId, userProject);

  for (const d of devices || []) {
    await db.prepare(`
      INSERT INTO project_config_devices
        (project_id, user_project, device_name, device_id, cpu_id, rack_id, iotag_id, sort_order, updated_at)
      VALUES (?,?,?,?,?,?,?,?,NOW())
    `).run(
      projectId, userProject,
      d.device_name || null, d.device_id || null, d.cpu_id || null,
      d.rack_id || null, d.iotag_id || null, d.sort_order ?? 0,
    );
  }
}

// ── GET /api/projects ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT
        p.id, p.name, p.comment, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM project_instances pi
          JOIN lib_cm_types lct ON lct.name = pi.cm_type AND lct.project_id = pi.project_id
          WHERE pi.project_id = p.id AND (lct.cm_type = 'ControlModule' OR lct.cm_type = '')) AS cm_count,
        (SELECT COUNT(*) FROM project_instances pi
          JOIN lib_cm_types lct ON lct.name = pi.cm_type AND lct.project_id = pi.project_id
          WHERE pi.project_id = p.id AND lct.cm_type = 'EquipmentModule') AS em_count,
        (SELECT COUNT(*) FROM project_instances pi
          JOIN lib_cm_types lct ON lct.name = pi.cm_type AND lct.project_id = pi.project_id
          WHERE pi.project_id = p.id AND lct.cm_type = 'EquipmentPhase') AS eph_count
      FROM projects p
      ORDER BY p.updated_at DESC
    `).all();
    res.json(rows.map(r => ({
      ...r,
      cm_count: Number(r.cm_count),
      em_count: Number(r.em_count),
      eph_count: Number(r.eph_count),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const project = await db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const instanceRows = await db.prepare(`
      SELECT cm_type, instance_name, sampling_time, user_project, hw_controller_id, folder_id, role_assignments,
             composite_group_id, composite_id, member_idx, source, connections
      FROM project_instances
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(req.params.id);
    const instances = instanceRows.map(r => ({
      ...r,
      role_assignments: r.role_assignments ? JSON.parse(r.role_assignments) : {},
      connections: r.connections ? JSON.parse(r.connections) : [],
    }));

    const cmtProfileRows = await db.prepare(`
      SELECT cm_type, enabled_blocks
      FROM project_cmt_profiles
      WHERE project_id = ?
    `).all(req.params.id);
    const cmtProfiles = cmtProfileRows.map(r => ({
      cmType:        r.cm_type,
      enabledBlocks: JSON.parse(r.enabled_blocks || '[]'),
    }));

    const userProjectRows = await db.prepare(`
      SELECT name FROM project_user_projects
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(req.params.id);
    const userProjects = userProjectRows.map(r => r.name);

    const hierarchy = await db.prepare(`
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
router.post('/', async (req, res) => {
  try {
    const {
      name, comment,
      instances = [], cmtProfiles = [], userProjects = [], hierarchy = [],
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const db = getDb();

    const save = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO projects (name, comment)
        VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET
          comment = excluded.comment,
          updated_at = NOW()
      `).run(name, comment || '');

      const row = await db.prepare(`SELECT id FROM projects WHERE name = ?`).get(name);
      const projectId = row.id;

      // Reconciliation state is owned by the server (set by IO import / unit type
      // expansion, and by manual accept), never round-tripped through the client.
      // This endpoint wipes and reinserts every instance, so snapshot that state by
      // instance name and restore it below — otherwise any save (autosave, "Generate
      // Connections") silently resets every row to not-imported/not-generated.
      const priorRecon = new Map(
        (await db.prepare(`
          SELECT instance_name, is_imported, is_generated, reconciliation_status,
                 accepted_at, accepted_by, last_reconciled_at
          FROM project_instances WHERE project_id = ?
        `).all(projectId)).map(r => [r.instance_name, r])
      );

      await db.prepare(`DELETE FROM project_instances         WHERE project_id = ?`).run(projectId);
      await db.prepare(`DELETE FROM project_cmt_profiles      WHERE project_id = ?`).run(projectId);
      await db.prepare(`DELETE FROM project_user_projects     WHERE project_id = ?`).run(projectId);
      await db.prepare(`DELETE FROM project_hierarchy_folders WHERE project_id = ?`).run(projectId);

      const insUp = db.prepare(`
        INSERT INTO project_user_projects (project_id, name, sort_order)
        VALUES (?,?,?)
      `);
      for (let idx = 0; idx < userProjects.length; idx++) {
        await insUp.run(projectId, userProjects[idx], idx);
      }

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
      for (let idx = 0; idx < hierarchy.length; idx++) {
        const f = hierarchy[idx];
        const parentDbId = f.parentClientId != null ? folderIdMap[f.parentClientId] ?? null : null;
        const keepId = typeof f.clientId === 'string' && f.clientId.startsWith('db')
          ? Number(f.clientId.slice(2)) : null;
        let dbId;
        if (keepId != null && Number.isFinite(keepId)) {
          await insFolderKeep.run(keepId, projectId, parentDbId, f.name, f.s88_type || null, f.sort_order ?? idx);
          dbId = keepId;
        } else {
          const r = await insFolderNew.run(projectId, parentDbId, f.name, f.s88_type || null, f.sort_order ?? idx);
          dbId = r.lastInsertRowid;
        }
        folderIdMap[f.clientId] = dbId;
      }

      const insInst = db.prepare(`
        INSERT INTO project_instances (project_id, cm_type, instance_name, sampling_time, user_project, hw_controller_id, folder_id, role_assignments, sort_order, composite_group_id, composite_id, member_idx, source, connections,
          is_imported, is_generated, reconciliation_status, accepted_at, accepted_by, last_reconciled_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (let idx = 0; idx < instances.length; idx++) {
        const i = instances[idx];
        const folderDbId = i.folder_client_id != null ? folderIdMap[i.folder_client_id] ?? null : null;
        // Carry forward reconciliation state for a row that already existed under
        // this name; a genuinely new instance starts unreconciled.
        const rec = priorRecon.get(i.instance_name);
        await insInst.run(projectId, i.cm_type, i.instance_name, i.sampling_time || '1000',
          i.user_project || null, i.hw_controller_id ?? null, folderDbId,
          JSON.stringify(i.role_assignments || {}), idx,
          i.composite_group_id ?? null, i.composite_id ?? null, i.member_idx ?? null,
          i.source || 'manual', JSON.stringify(i.connections || []),
          rec?.is_imported ?? false, rec?.is_generated ?? false,
          rec?.reconciliation_status ?? 'PENDING',
          rec?.accepted_at ?? null, rec?.accepted_by ?? null, rec?.last_reconciled_at ?? null);
      }

      const insProf = db.prepare(`
        INSERT INTO project_cmt_profiles (project_id, cm_type, enabled_blocks)
        VALUES (?,?,?)
      `);
      for (const p of cmtProfiles) {
        await insProf.run(projectId, p.cmType, JSON.stringify(p.enabledBlocks || []));
      }

      return { projectId, folderIdMap };
    });

    const { projectId, folderIdMap } = await save();
    res.json({ id: projectId, name, folderIdMap });
  } catch (err) {
    console.error('[Projects] Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id/pcs7-config ────────────────────────────────────────
router.get('/:id/pcs7-config', async (req, res) => {
  try {
    const db  = getDb();
    const row = await db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(req.params.id);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/projects/:id/pcs7-config — save manually-edited fields ──────────
router.put('/:id/pcs7-config', async (req, res) => {
  try {
    const db  = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    const {
      project_name, project_id_val, device_name, device_id, cpu_id,
      process_cell, process_cell_id,
      export_user, unit_author,
    } = req.body || {};
    await db.prepare(`
      INSERT INTO project_config
        (project_id, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
      ON CONFLICT(project_id) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = NOW()
    `).run(
      req.params.id,
      project_name || '', project_id_val || '', device_name || '', device_id || '', cpu_id || '',
      process_cell || '', process_cell_id || '',
      export_user || '', unit_author || '',
    );
    const saved = await db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(req.params.id);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/pcs7-config/parse-xml — upload + parse SimaticML ──
router.post('/:id/pcs7-config/parse-xml', upload.single('pcs7xml'), async (req, res) => {
  try {
    const db   = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: pcs7xml)' });

    const { config, missing } = await parsePcs7Config(req.file.buffer);

    // Upsert into project_config
    await db.prepare(`
      INSERT INTO project_config
        (project_id, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
      ON CONFLICT(project_id) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = NOW()
    `).run(
      req.params.id,
      config.project_name, config.project_id_val, config.device_name, config.device_id, config.cpu_id,
      config.process_cell, config.process_cell_id,
      config.export_user, config.unit_author,
    );

    const saved = await db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(req.params.id);
    res.json({ config: saved, missing });
  } catch (err) {
    console.error('[Projects] pcs7-config parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id/user-projects/:userProjectName/pcs7-config ────────
router.get('/:id/user-projects/:userProjectName/pcs7-config', async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const row = await db.prepare(
      'SELECT * FROM project_config WHERE project_id = ? AND user_project = ?'
    ).get(req.params.id, req.params.userProjectName);
    if (!row) return res.json(null);

    // Attach the per-device IDs (AS01, AS02, …) parsed from this user project's export.
    row.devices = await db.prepare(
      'SELECT * FROM project_config_devices WHERE project_id = ? AND user_project = ? ORDER BY sort_order'
    ).all(req.params.id, req.params.userProjectName);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/user-projects/:userProjectName/pcs7-config/devices
// Manually add one controller row (no XML upload needed).
router.post('/:id/user-projects/:userProjectName/pcs7-config/devices', async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const { device_name, device_id, cpu_id, rack_id, iotag_id } = req.body || {};
    if (!device_name || !device_name.trim()) {
      return res.status(400).json({ error: 'device_name is required' });
    }

    const nextSort = await db.prepare(
      'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM project_config_devices WHERE project_id = ? AND user_project = ?'
    ).get(req.params.id, req.params.userProjectName);

    await db.prepare(`
      INSERT INTO project_config_devices
        (project_id, user_project, device_name, device_id, cpu_id, rack_id, iotag_id, sort_order, updated_at)
      VALUES (?,?,?,?,?,?,?,?,NOW())
    `).run(
      req.params.id, req.params.userProjectName,
      device_name.trim(), device_id || null, cpu_id || null, rack_id || null, iotag_id || null,
      nextSort?.next ?? 0,
    );

    const devices = await db.prepare(
      'SELECT * FROM project_config_devices WHERE project_id = ? AND user_project = ? ORDER BY sort_order'
    ).all(req.params.id, req.params.userProjectName);
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/projects/:id/user-projects/:userProjectName/pcs7-config/devices/:deviceId
// Edit one controller row's fields.
router.put('/:id/user-projects/:userProjectName/pcs7-config/devices/:deviceId', async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const existing = await db.prepare(
      'SELECT id FROM project_config_devices WHERE id = ? AND project_id = ? AND user_project = ?'
    ).get(req.params.deviceId, req.params.id, req.params.userProjectName);
    if (!existing) return res.status(404).json({ error: 'Controller not found' });

    const { device_name, device_id, cpu_id, rack_id, iotag_id } = req.body || {};
    if (!device_name || !device_name.trim()) {
      return res.status(400).json({ error: 'device_name is required' });
    }

    await db.prepare(`
      UPDATE project_config_devices
      SET device_name = ?, device_id = ?, cpu_id = ?, rack_id = ?, iotag_id = ?, updated_at = NOW()
      WHERE id = ?
    `).run(device_name.trim(), device_id || null, cpu_id || null, rack_id || null, iotag_id || null, req.params.deviceId);

    const devices = await db.prepare(
      'SELECT * FROM project_config_devices WHERE project_id = ? AND user_project = ? ORDER BY sort_order'
    ).all(req.params.id, req.params.userProjectName);
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/projects/:id/user-projects/:userProjectName/pcs7-config/devices/:deviceId
router.delete('/:id/user-projects/:userProjectName/pcs7-config/devices/:deviceId', async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const existing = await db.prepare(
      'SELECT id FROM project_config_devices WHERE id = ? AND project_id = ? AND user_project = ?'
    ).get(req.params.deviceId, req.params.id, req.params.userProjectName);
    if (!existing) return res.status(404).json({ error: 'Controller not found' });

    await db.prepare('DELETE FROM project_config_devices WHERE id = ?').run(req.params.deviceId);

    const devices = await db.prepare(
      'SELECT * FROM project_config_devices WHERE project_id = ? AND user_project = ? ORDER BY sort_order'
    ).all(req.params.id, req.params.userProjectName);
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/projects/:id/user-projects/:userProjectName/pcs7-config ────────
router.put('/:id/user-projects/:userProjectName/pcs7-config', async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const {
      project_name, project_id_val, device_name, device_id, cpu_id,
      process_cell, process_cell_id,
      export_user, unit_author,
    } = req.body || {};

    await db.prepare(`
      INSERT INTO project_config
        (project_id, user_project, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
      ON CONFLICT(project_id, user_project) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = NOW()
    `).run(
      req.params.id, req.params.userProjectName,
      project_name || '', project_id_val || '', device_name || '', device_id || '', cpu_id || '',
      process_cell || '', process_cell_id || '',
      export_user || '', unit_author || '',
    );

    const saved = await db.prepare(
      'SELECT * FROM project_config WHERE project_id = ? AND user_project = ?'
    ).get(req.params.id, req.params.userProjectName);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/user-projects/:userProjectName/pcs7-config/parse-xml
router.post('/:id/user-projects/:userProjectName/pcs7-config/parse-xml', upload.single('pcs7xml'), async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: pcs7xml)' });

    const { config, devices, missing } = await parsePcs7Config(req.file.buffer);
    const extractedName = config.project_name;
    const requestedName = req.params.userProjectName;

    // Check if extracted name matches requested name
    const warning = extractedName && extractedName !== requestedName;

    // Return response with potential warning
    const response = {
      config,
      devices,
      missing,
      warning: warning ? true : false,
    };

    if (warning) {
      response.extractedName = extractedName;
      response.requestedName = requestedName;
      // Don't auto-save if there's a mismatch; let client decide
      return res.json(response);
    }

    // No warning: save the config under the requested user project name
    const targetUserProject = extractedName || requestedName;
    await db.prepare(`
      INSERT INTO project_config
        (project_id, user_project, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
      ON CONFLICT(project_id, user_project) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = NOW()
    `).run(
      req.params.id, targetUserProject,
      config.project_name, config.project_id_val, config.device_name, config.device_id, config.cpu_id,
      config.process_cell, config.process_cell_id,
      config.export_user, config.unit_author,
    );

    await replaceConfigDevices(db, req.params.id, targetUserProject, devices);

    const saved = await db.prepare(
      'SELECT * FROM project_config WHERE project_id = ? AND user_project = ?'
    ).get(req.params.id, targetUserProject);

    response.config = saved;
    response.devices = await db.prepare(
      'SELECT * FROM project_config_devices WHERE project_id = ? AND user_project = ? ORDER BY sort_order'
    ).all(req.params.id, targetUserProject);
    res.json(response);
  } catch (err) {
    console.error('[Projects] user-project pcs7-config parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/user-projects/:userProjectName/pcs7-config/save-with-warning
// Endpoint to confirm and save config after warning (mismatched project name)
router.post('/:id/user-projects/:userProjectName/pcs7-config/save-with-warning', async (req, res) => {
  try {
    const db = getDb();
    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const {
      config, devices, targetUserProject,
    } = req.body || {};

    if (!config) return res.status(400).json({ error: 'config required in body' });

    const target = targetUserProject || req.params.userProjectName;

    await db.prepare(`
      INSERT INTO project_config
        (project_id, user_project, project_name, project_id_val, device_name, device_id, cpu_id,
         process_cell, process_cell_id, export_user, unit_author, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
      ON CONFLICT(project_id, user_project) DO UPDATE SET
        project_name     = excluded.project_name,
        project_id_val   = excluded.project_id_val,
        device_name      = excluded.device_name,
        device_id        = excluded.device_id,
        cpu_id           = excluded.cpu_id,
        process_cell     = excluded.process_cell,
        process_cell_id  = excluded.process_cell_id,
        export_user      = excluded.export_user,
        unit_author      = excluded.unit_author,
        updated_at       = NOW()
    `).run(
      req.params.id, target,
      config.project_name, config.project_id_val, config.device_name, config.device_id, config.cpu_id,
      config.process_cell, config.process_cell_id,
      config.export_user, config.unit_author,
    );

    await replaceConfigDevices(db, req.params.id, target, devices);

    const saved = await db.prepare(
      'SELECT * FROM project_config WHERE project_id = ? AND user_project = ?'
    ).get(req.params.id, target);
    const savedDevices = await db.prepare(
      'SELECT * FROM project_config_devices WHERE project_id = ? AND user_project = ? ORDER BY sort_order'
    ).all(req.params.id, target);

    res.json({ config: saved, devices: savedDevices, success: true });
  } catch (err) {
    console.error('[Projects] save-with-warning error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const project = await db.prepare(`SELECT id FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const del = db.transaction(async () => {
      await db.prepare(`DELETE FROM project_instances         WHERE project_id = ?`).run(req.params.id);
      await db.prepare(`DELETE FROM project_cmt_profiles      WHERE project_id = ?`).run(req.params.id);
      await db.prepare(`DELETE FROM project_user_projects     WHERE project_id = ?`).run(req.params.id);
      await db.prepare(`DELETE FROM project_hierarchy_folders WHERE project_id = ?`).run(req.params.id);
      await db.prepare(`DELETE FROM project_config_devices    WHERE project_id = ?`).run(req.params.id);
      await db.prepare(`DELETE FROM project_config            WHERE project_id = ?`).run(req.params.id);

      // Library / Composite CM Types / Unit Types are project-scoped (each
      // project owns its own clone) — tear down their full trees before the
      // project row itself, or the FK to projects(id) blocks the delete.
      await db.prepare(`DELETE FROM user_cm_block_prefs WHERE project_id = ?`).run(req.params.id);

      const cmIds = (await db.prepare(`SELECT id FROM lib_cm_types WHERE project_id = ?`).all(req.params.id)).map(r => r.id);
      for (const cmId of cmIds) {
        const blockIds = (await db.prepare(`SELECT id FROM lib_blocks WHERE cm_type_id = ?`).all(cmId)).map(r => r.id);
        for (const blockId of blockIds) {
          const varIds = (await db.prepare(`SELECT id FROM lib_variables WHERE block_id = ?`).all(blockId)).map(r => r.id);
          for (const varId of varIds) await db.prepare(`DELETE FROM lib_var_links WHERE var_id = ?`).run(varId);
          await db.prepare(`DELETE FROM lib_variables WHERE block_id = ?`).run(blockId);
          await db.prepare(`DELETE FROM lib_messages  WHERE block_id = ?`).run(blockId);
        }
        await db.prepare(`DELETE FROM lib_blocks   WHERE cm_type_id = ?`).run(cmId);
        await db.prepare(`DELETE FROM lib_em_roles WHERE cm_type_id = ?`).run(cmId);
      }
      await db.prepare(`DELETE FROM lib_cm_types WHERE project_id = ?`).run(req.params.id);

      const compIds = (await db.prepare(`SELECT id FROM composite_cm_types WHERE project_id = ?`).all(req.params.id)).map(r => r.id);
      for (const compId of compIds) {
        const modeIds = (await db.prepare(`SELECT id FROM composite_matrix_modes WHERE composite_id = ?`).all(compId)).map(r => r.id);
        for (const modeId of modeIds) await db.prepare(`DELETE FROM composite_matrix_cells WHERE mode_id = ?`).run(modeId);
        await db.prepare(`DELETE FROM composite_matrix_modes   WHERE composite_id = ?`).run(compId);
        await db.prepare(`DELETE FROM composite_matrix_columns WHERE composite_id = ?`).run(compId);
        await db.prepare(`DELETE FROM composite_cm_connections WHERE composite_id = ?`).run(compId);
        await db.prepare(`DELETE FROM composite_cm_members     WHERE composite_id = ?`).run(compId);
      }
      await db.prepare(`DELETE FROM composite_cm_types WHERE project_id = ?`).run(req.params.id);

      const unitTypeIds = (await db.prepare(`SELECT id FROM unit_types WHERE project_id = ?`).all(req.params.id)).map(r => r.id);
      for (const utId of unitTypeIds) {
        const memberIds = (await db.prepare(`SELECT id FROM unit_type_members WHERE unit_type_id = ?`).all(utId)).map(r => r.id);
        for (const memberId of memberIds) await db.prepare(`DELETE FROM unit_type_member_roles WHERE member_id = ?`).run(memberId);
        await db.prepare(`DELETE FROM unit_type_members            WHERE unit_type_id = ?`).run(utId);
        await db.prepare(`DELETE FROM unit_type_member_connections WHERE unit_type_id = ?`).run(utId);
      }
      await db.prepare(`DELETE FROM unit_instances WHERE project_id = ?`).run(req.params.id);
      await db.prepare(`DELETE FROM unit_types     WHERE project_id = ?`).run(req.params.id);

      await db.prepare(`DELETE FROM projects WHERE id = ?`).run(req.params.id);
    });
    await del();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/projects/:projectId/instances/:instanceName ──────────────────
// Delete an instance and all its related data (derived values, IOs, matrix overrides, etc)
router.delete('/:projectId/instances/:instanceName', async (req, res) => {
  try {
    const db = getDb();
    const { projectId, instanceName } = req.params;

    await db.transaction(async () => {
      // First, get the instance ID so we can delete unit_resolved_connections if needed
      const instance = await db.prepare(
        'SELECT id FROM project_instances WHERE project_id = ? AND instance_name = ?'
      ).get(projectId, instanceName);

      if (!instance) {
        throw new Error('Instance not found');
      }

      const instanceId = instance.id;

      // Delete all related data in order (respect any foreign key constraints)
      await db.prepare(
        'DELETE FROM instance_ios WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, instanceName);

      await db.prepare(
        'DELETE FROM instance_derived_values WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, instanceName);

      await db.prepare(
        'DELETE FROM instance_matrix_overrides WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, instanceName);

      await db.prepare(
        'DELETE FROM signal_mappings WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, instanceName);

      await db.prepare(
        'DELETE FROM unit_resolved_connections WHERE project_id = ? AND unit_instance_id = ?'
      ).run(projectId, instanceId);

      // Finally, delete the instance itself
      await db.prepare(
        'DELETE FROM project_instances WHERE id = ? AND project_id = ?'
      ).run(instanceId, projectId);
    })();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
