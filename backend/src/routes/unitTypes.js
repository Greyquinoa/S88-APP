// src/routes/unitTypes.js — Unit Type library + per-project Unit Instances
'use strict';
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function loadUnitTypeDetail(db, id) {
  const ut = db.prepare('SELECT * FROM unit_types WHERE id = ?').get(id);
  if (!ut) return null;
  const members = db.prepare(
    'SELECT * FROM unit_type_members WHERE unit_type_id = ? ORDER BY sort_order, id'
  ).all(id);
  const memberIds = members.map(m => m.id);
  const allRoles = memberIds.length
    ? db.prepare(
        `SELECT * FROM unit_type_member_roles WHERE member_id IN (${memberIds.map(() => '?').join(',')})`
      ).all(...memberIds)
    : [];
  const rolesByMember = {};
  for (const r of allRoles) {
    (rolesByMember[r.member_id] ||= []).push({
      role:            r.role,
      assignedAlias:   r.assigned_alias,
      sourceMemberIdx: r.source_member_idx ?? 0,
      targetAlias:     r.assigned_alias,
      targetMemberIdx: r.target_member_idx ?? 0,
    });
  }
  return {
    ...ut,
    members: members.map(m => ({
      id:              m.id,
      alias:           m.alias,
      cmTypeName:      m.cm_type_name || '',
      compositeCmId:   m.composite_cm_id || null,
      hierarchyFolder: m.hierarchy_folder || '',
      sortOrder:       m.sort_order,
      // Legacy shape kept for back-compat; roleAssignments is the composite-aware form.
      roles:           rolesByMember[m.id] || [],
      roleAssignments: rolesByMember[m.id] || [],
    })),
  };
}

// ── GET /api/unit-types — list all ───────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare(`
      SELECT ut.id, ut.name, ut.description, ut.created_at,
             COUNT(utm.id) AS member_count
      FROM unit_types ut
      LEFT JOIN unit_type_members utm ON utm.unit_type_id = ut.id
      GROUP BY ut.id
      ORDER BY ut.name
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types — create ────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const db  = getDb();
    const row = db.prepare(
      'INSERT INTO unit_types (name, description) VALUES (?, ?)'
    ).run(name.trim(), description || '');
    res.json({ id: row.lastInsertRowid, name: name.trim(), description: description || '', members: [] });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Unit type name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/unit-types/:id — full detail ────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const ut = loadUnitTypeDetail(db, req.params.id);
    if (!ut) return res.status(404).json({ error: 'Unit type not found' });
    res.json(ut);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/unit-types/:id — full replace (members + roles) ─────────────────
router.put('/:id', (req, res) => {
  try {
    const db  = getDb();
    const { name, description, members } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const existing = db.prepare('SELECT id FROM unit_types WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Unit type not found' });

    db.transaction(() => {
      db.prepare('UPDATE unit_types SET name=?, description=? WHERE id=?')
        .run(name.trim(), description || '', req.params.id);

      // Delete existing members (cascade to roles via member_id)
      const oldMembers = db.prepare('SELECT id FROM unit_type_members WHERE unit_type_id = ?').all(req.params.id);
      for (const m of oldMembers) {
        db.prepare('DELETE FROM unit_type_member_roles WHERE member_id = ?').run(m.id);
      }
      db.prepare('DELETE FROM unit_type_members WHERE unit_type_id = ?').run(req.params.id);

      // Re-insert members and their roles
      for (let i = 0; i < (members || []).length; i++) {
        const m = members[i];
        if (!m.alias?.trim()) continue;
        const isComposite = !!m.compositeCmId;
        if (!isComposite && !m.cmTypeName?.trim()) continue;
        const mRow = db.prepare(
          'INSERT INTO unit_type_members (unit_type_id, alias, cm_type_name, composite_cm_id, hierarchy_folder, sort_order) VALUES (?,?,?,?,?,?)'
        ).run(
          req.params.id,
          m.alias.trim(),
          isComposite ? '' : m.cmTypeName.trim(),
          isComposite ? m.compositeCmId : null,
          m.hierarchyFolder || '',
          i,
        );
        // Composite-aware role assignments: each maps an EM/EPH sub-member's role
        // (source_member_idx) to a target sub-member (assigned_alias + target_member_idx).
        const roleEntries = m.roleAssignments || m.roles || [];
        for (const r of roleEntries) {
          const targetAlias = (r.targetAlias ?? r.assignedAlias ?? '').trim();
          if (!r.role?.trim() || !targetAlias) continue;
          db.prepare(
            'INSERT INTO unit_type_member_roles (member_id, role, assigned_alias, source_member_idx, target_member_idx) VALUES (?,?,?,?,?)'
          ).run(
            mRow.lastInsertRowid,
            r.role.trim(),
            targetAlias,
            r.sourceMemberIdx ?? 0,
            r.targetMemberIdx ?? 0,
          );
        }
      }
    })();

    res.json(loadUnitTypeDetail(db, req.params.id));
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Unit type name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/unit-types/:id ───────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      const members = db.prepare('SELECT id FROM unit_type_members WHERE unit_type_id = ?').all(req.params.id);
      for (const m of members) {
        db.prepare('DELETE FROM unit_type_member_roles WHERE member_id = ?').run(m.id);
      }
      db.prepare('DELETE FROM unit_type_members WHERE unit_type_id = ?').run(req.params.id);
      db.prepare('DELETE FROM unit_instances WHERE unit_type_id = ?').run(req.params.id);
      db.prepare('DELETE FROM unit_types WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/unit-types/project/:projectId/unit-instances ────────────────────
router.get('/project/:projectId/unit-instances', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare(`
      SELECT ui.id, ui.unit_name, ui.user_project, ui.parent_path, ui.sort_order,
             ut.id AS unit_type_id, ut.name AS unit_type_name
      FROM unit_instances ui
      JOIN unit_types ut ON ut.id = ui.unit_type_id
      WHERE ui.project_id = ?
      ORDER BY ui.sort_order, ui.id
    `).all(req.params.projectId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/unit-types/project/:projectId/unit-instances/:id — update fields ─
router.put('/project/:projectId/unit-instances/:id', (req, res) => {
  try {
    const { user_project, parent_path, unit_name } = req.body || {};
    const db = getDb();
    db.prepare(
      'UPDATE unit_instances SET user_project=?, parent_path=?, unit_name=? WHERE id=? AND project_id=?'
    ).run(user_project || '', parent_path || '', unit_name || '', req.params.id, req.params.projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types/project/:projectId/unit-instances ───────────────────
router.post('/project/:projectId/unit-instances', (req, res) => {
  try {
    const { unit_type_id, unit_name, user_project, parent_path } = req.body || {};
    if (!unit_type_id || !unit_name?.trim())
      return res.status(400).json({ error: 'unit_type_id and unit_name are required' });
    const db  = getDb();
    const row = db.prepare(
      'INSERT INTO unit_instances (project_id, unit_type_id, unit_name, user_project, parent_path) VALUES (?,?,?,?,?)'
    ).run(req.params.projectId, unit_type_id, unit_name.trim(), user_project || '', parent_path || '');
    res.json({ id: row.lastInsertRowid, unit_type_id, unit_name: unit_name.trim(), user_project: user_project || '', parent_path: parent_path || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/unit-types/project/:projectId/unit-instances/:id ─────────────
router.delete('/project/:projectId/unit-instances/:id', (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM project_instances WHERE source_unit_instance_id = ?').run(req.params.id);
      db.prepare('DELETE FROM project_hierarchy_folders WHERE source_unit_instance_id = ?').run(req.params.id);
      db.prepare('DELETE FROM unit_instances WHERE id = ? AND project_id = ?')
        .run(req.params.id, req.params.projectId);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types/project/:projectId/unit-instances/expand ─────────────
// Idempotent: deletes and recreates all unit-sourced instances + folders.
router.post('/project/:projectId/unit-instances/expand', (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);

    // Load enabled_blocks profile per cm_type for this project (or default to all required)
    const profileRows = db.prepare(
      'SELECT cm_type, enabled_blocks FROM project_cmt_profiles WHERE project_id = ?'
    ).all(projectId);
    const profileMap = {};
    for (const p of profileRows) profileMap[p.cm_type] = JSON.parse(p.enabled_blocks || '[]');

    // Fallback user project (used only if a unit instance has none set)
    const upRows = db.prepare(
      'SELECT name FROM project_user_projects WHERE project_id = ? ORDER BY sort_order LIMIT 1'
    ).all(projectId);
    const defaultUserProject = upRows[0]?.name || '';

    // Determine current max sort_order in project_instances + project_hierarchy_folders
    const maxInstSO  = db.prepare('SELECT MAX(sort_order) AS m FROM project_instances WHERE project_id = ? AND source_unit_instance_id IS NULL').get(projectId)?.m || 0;
    const maxFolSO   = db.prepare('SELECT MAX(sort_order) AS m FROM project_hierarchy_folders WHERE project_id = ? AND source_unit_instance_id IS NULL').get(projectId)?.m || 0;
    let folSO = maxFolSO + 1;
    let instSO = maxInstSO + 1;
    let compositeGroupCounter = 0;

    // Project-scope registry: "<userProject>::<name>" → true. A project-scope
    // composite member is instantiated only once per User Project; later units
    // referencing it reuse the same instance (by name) instead of creating a copy.
    const projectScopeCreated = new Set();

    const unitInsts = db.prepare(
      'SELECT * FROM unit_instances WHERE project_id = ? ORDER BY sort_order, id'
    ).all(projectId);

    const folderIdMap  = {};
    let instanceCount  = 0;
    let folderCount    = 0;

    // In-memory folder cache for this expand run: "parentId::name" → db id.
    // Ensures shared path segments (e.g. rIX, rIX/DE1, rIX/DE1/CM) are created
    // exactly once and reused by all unit instances that share the same path.
    const folderCache = new Map();
    const folderCacheKey = (parentId, name) => `${parentId ?? 'root'}::${name}`;

    // Find-or-create one folder segment. Uses folderCache to avoid duplicates
    // within this expand run; falls back to a DB lookup for pre-existing folders
    // (e.g. manually created hierarchy folders from the Hierarchy tab).
    const ensureFolder = (parentId, name, uiId) => {
      const key = folderCacheKey(parentId, name);
      if (folderCache.has(key)) return folderCache.get(key);

      // Check for a manually-created folder (source_unit_instance_id IS NULL)
      const manual = db.prepare(
        'SELECT id FROM project_hierarchy_folders WHERE project_id=? AND parent_id IS ? AND name=? AND source_unit_instance_id IS NULL'
      ).get(projectId, parentId, name);
      if (manual) {
        folderCache.set(key, manual.id);
        return manual.id;
      }

      // Create a new shared unit-expand folder (attributed to the first unit that needs it)
      const r = db.prepare(
        'INSERT INTO project_hierarchy_folders (project_id, parent_id, name, s88_type, sort_order, source_unit_instance_id) VALUES (?,?,?,?,?,?)'
      ).run(projectId, parentId, name, '', folSO++, uiId);
      const id = r.lastInsertRowid;
      folderCache.set(key, id);
      folderCount++;
      return id;
    };

    // Walk a slash-separated path from a parent folder id, creating segments as needed.
    const makeFolderPath = (uiId, parentId, folderPath) => {
      const segs = (folderPath || '').split('/').map(s => s.trim()).filter(Boolean);
      let cur = parentId;
      for (const seg of segs) cur = ensureFolder(cur, seg, uiId);
      return cur;
    };

    db.transaction(() => {
      // Delete ALL previously expanded instances and folders in one pass before recreating.
      // This avoids per-unit duplicate paths when multiple units share the same parent path.
      for (const ui of unitInsts) {
        db.prepare('DELETE FROM project_instances WHERE source_unit_instance_id = ?').run(ui.id);
        db.prepare('DELETE FROM project_hierarchy_folders WHERE source_unit_instance_id = ?').run(ui.id);
      }

      for (const ui of unitInsts) {
        const ut = loadUnitTypeDetail(db, ui.unit_type_id);
        if (!ut) continue;

        // Build: parent_path / unit_name / composite.hierarchy_folder
        // e.g. rIX/DE1 → U010 → CM  =  rIX/DE1/U010/CM
        const parentPath = (ui.parent_path || '').trim();
        const parentFolderId = parentPath
          ? makeFolderPath(ui.id, null, parentPath)
          : null;
        const unitFolderId = ensureFolder(parentFolderId, ui.unit_name, ui.id);

        const instanceUserProject = (ui.user_project || '').trim() || defaultUserProject;

        // Project-scope members hang off level 1 of the parent path (the FIRST
        // segment), then the folder defined on the composite member.
        // e.g. parent "rIX/DE01" + member folder "Shared" → "rIX/Shared".
        const firstSeg = parentPath.split('/').map(s => s.trim()).filter(Boolean)[0];
        const sharedParentId = firstSeg ? ensureFolder(null, firstSeg, ui.id) : null;

        // Derive an instance name for a composite sub-member of a unit member.
        // Unit scope:    base = "<unit>_<alias>"  (one instance per unit).
        // Project scope: base = "<alias>"          (one shared instance, no unit).
        // Primary keeps the base name; others apply the composite's prefix/suffix.
        const deriveName = (alias, cm) => {
          const baseName = cm.scope === 'project' ? alias : `${ui.unit_name}_${alias}`;
          return cm.is_primary
            ? baseName
            : `${cm.name_prefix || ''}${baseName}${cm.name_suffix || ''}`;
        };

        // ── Pass 1: cache composite members per unit member and build a name map ──
        // nameMap key "<alias>::<subMemberIdx>" → derived instance name, so role
        // assignments can resolve a target sub-member (in this or another member)
        // to the concrete instance name produced below.
        const compositeMembers = ut.members.filter(m => m.compositeCmId);
        const compMembersByAlias = {};
        const nameMap = {};
        for (const m of compositeMembers) {
          const subMembers = db.prepare(
            'SELECT * FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order, id'
          ).all(m.compositeCmId);
          compMembersByAlias[m.alias] = subMembers;
          subMembers.forEach((cm, idx) => {
            nameMap[`${m.alias}::${idx}`] = deriveName(m.alias, cm);
          });
        }

        // ── Pass 2: insert each sub-member, resolving role assignments ──
        for (const m of compositeMembers) {
          const compMembers = compMembersByAlias[m.alias];

          // Unique group id for this (unit instance, composite member) pair so
          // generate.js can group them back into a single connGroup.
          const compositeGroupId = ++compositeGroupCounter;

          for (let cmIdx = 0; cmIdx < compMembers.length; cmIdx++) {
            const cm = compMembers[cmIdx];
            const isProject = cm.scope === 'project';
            const instanceName = deriveName(m.alias, cm);

            // Project scope: instantiate once per (User Project, name). Later units
            // referencing it reuse the existing instance (resolved by name) instead
            // of creating a duplicate.
            if (isProject) {
              const key = `${instanceUserProject}::${instanceName}`;
              if (projectScopeCreated.has(key)) continue;
              projectScopeCreated.add(key);
            }

            // Unit scope → folder under the unit. Project scope → first parent
            // segment + the composite member's folder (e.g. rIX/Shared).
            let subFolderId;
            if (isProject) {
              subFolderId = cm.hierarchy_folder
                ? makeFolderPath(ui.id, sharedParentId, cm.hierarchy_folder)
                : sharedParentId;
            } else {
              subFolderId = cm.hierarchy_folder
                ? makeFolderPath(ui.id, unitFolderId, cm.hierarchy_folder)
                : unitFolderId;
            }

            // Resolve role assignments declared on THIS sub-member (sourceMemberIdx===cmIdx).
            // Each maps role → the concrete instance name of the target sub-member.
            const roleAssignments = {};
            for (const r of (m.roleAssignments || [])) {
              if ((r.sourceMemberIdx ?? 0) !== cmIdx) continue;
              const targetName = nameMap[`${r.targetAlias}::${r.targetMemberIdx ?? 0}`];
              if (targetName && r.role) roleAssignments[r.role] = targetName;
            }

            db.prepare(`
              INSERT INTO project_instances
                (project_id, cm_type, instance_name, sampling_time, user_project,
                 folder_id, role_assignments, sort_order, source_unit_instance_id,
                 composite_group_id, composite_id, member_idx)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
              projectId,
              cm.cm_type_name,
              instanceName,
              '1000',
              instanceUserProject,
              subFolderId,
              JSON.stringify(roleAssignments),
              instSO++,
              ui.id,
              compositeGroupId,
              m.compositeCmId,
              cmIdx,
            );
            instanceCount++;
          }
        }
        // Members without a compositeCmId are skipped (legacy plain members from old data)
      }
    })();

    res.json({ success: true, instanceCount, folderCount, folderIdMap });
  } catch (err) {
    console.error('[UnitTypes] Expand error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
