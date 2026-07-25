// src/routes/unitTypes.js — Unit Type library + per-project Unit Instances
'use strict';
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadUnitTypeDetail(db, id) {
  const ut = await db.prepare('SELECT * FROM unit_types WHERE id = ?').get(id);
  if (!ut) return null;
  const members = await db.prepare(
    'SELECT * FROM unit_type_members WHERE unit_type_id = ? ORDER BY sort_order, id'
  ).all(id);
  const memberIds = members.map(m => m.id);
  const allRoles = memberIds.length
    ? await db.prepare(
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
  // Load connections
  const connections = (await db.prepare(
    'SELECT * FROM unit_type_member_connections WHERE unit_type_id = ? ORDER BY sort_order, id'
  ).all(id)) || [];

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
    connections: connections.map(c => ({
      id:            c.id,
      from_alias:    c.from_alias,
      from_sub_idx:  c.from_sub_idx || 0,
      from_var_name: c.from_var_name,
      to_alias:      c.to_alias,
      to_sub_idx:    c.to_sub_idx || 0,
      to_var_name:   c.to_var_name,
      conn_type:     c.conn_type || 'interconnection',
      static_value:  c.static_value,
      sort_order:    c.sort_order,
    })),
  };
}

// ── GET /api/unit-types — list all ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare(`
      SELECT ut.id, ut.name, ut.description, ut.created_at,
             COUNT(utm.id) AS member_count
      FROM unit_types ut
      LEFT JOIN unit_type_members utm ON utm.unit_type_id = ut.id
      GROUP BY ut.id
      ORDER BY ut.name
    `).all();
    res.json(rows.map(r => ({ ...r, member_count: Number(r.member_count) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types — create ────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const db  = getDb();
    const row = await db.prepare(
      'INSERT INTO unit_types (name, description) VALUES (?, ?)'
    ).run(name.trim(), description || '');
    res.json({ id: row.lastInsertRowid, name: name.trim(), description: description || '', members: [] });
  } catch (err) {
    if (err.message?.toLowerCase().includes('unique') || err.code === '23505') return res.status(409).json({ error: 'Unit type name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/unit-types/:id — full detail ────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const ut = await loadUnitTypeDetail(db, req.params.id);
    if (!ut) return res.status(404).json({ error: 'Unit type not found' });
    res.json(ut);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/unit-types/:id — full replace (members + roles) ─────────────────
router.put('/:id', async (req, res) => {
  try {
    const db  = getDb();
    const { name, description, members } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const existing = await db.prepare('SELECT id FROM unit_types WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Unit type not found' });

    await db.transaction(async () => {
      await db.prepare('UPDATE unit_types SET name=?, description=? WHERE id=?')
        .run(name.trim(), description || '', req.params.id);

      // Delete existing members (cascade to roles via member_id)
      const oldMembers = await db.prepare('SELECT id FROM unit_type_members WHERE unit_type_id = ?').all(req.params.id);
      for (const m of oldMembers) {
        await db.prepare('DELETE FROM unit_type_member_roles WHERE member_id = ?').run(m.id);
      }
      await db.prepare('DELETE FROM unit_type_members WHERE unit_type_id = ?').run(req.params.id);

      // Re-insert members and their roles
      for (let i = 0; i < (members || []).length; i++) {
        const m = members[i];
        if (!m.alias?.trim()) continue;
        const isComposite = !!m.compositeCmId;
        if (!isComposite && !m.cmTypeName?.trim()) continue;
        const mRow = await db.prepare(
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
          await db.prepare(
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

      // Note: connections are managed separately via the POST /unit-types/:id/connections endpoint
      // Do NOT touch connections here — only update members and roles
    })();

    res.json(await loadUnitTypeDetail(db, req.params.id));
  } catch (err) {
    if (err.message?.toLowerCase().includes('unique') || err.code === '23505') return res.status(409).json({ error: 'Unit type name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/unit-types/:id ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.transaction(async () => {
      const members = await db.prepare('SELECT id FROM unit_type_members WHERE unit_type_id = ?').all(req.params.id);
      for (const m of members) {
        await db.prepare('DELETE FROM unit_type_member_roles WHERE member_id = ?').run(m.id);
      }
      await db.prepare('DELETE FROM unit_type_members WHERE unit_type_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM unit_instances WHERE unit_type_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM unit_type_member_connections WHERE unit_type_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM unit_types WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/unit-types/:id/connections ──────────────────────────────────────
// Fetch all wiring for this unit type
router.get('/:id/connections', async (req, res) => {
  try {
    const db = getDb();
    const connections = (await db.prepare(
      'SELECT * FROM unit_type_member_connections WHERE unit_type_id = ? ORDER BY sort_order, id'
    ).all(req.params.id)) || [];
    res.json(connections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types/:id/connections ─────────────────────────────────────
// Body: { connections: [{...}], validateCycles: true }
router.post('/:id/connections', async (req, res) => {
  try {
    const db = getDb();
    const { connections = [], validateCycles = true } = req.body || {};
    const ut = await db.prepare('SELECT id FROM unit_types WHERE id = ?').get(req.params.id);
    if (!ut) return res.status(404).json({ error: 'Unit type not found' });

    // Load members and build alias map
    const members = (await db.prepare(
      'SELECT alias, cm_type_name FROM unit_type_members WHERE unit_type_id = ? ORDER BY sort_order, id'
    ).all(req.params.id)) || [];
    const membersByAlias = {};
    for (const m of members) membersByAlias[m.alias] = m;

    // Validate member aliases exist. Value connections have no source member
    // (the source is a static constant), so only validate from_alias for non-value types.
    for (const conn of connections) {
      if (conn.conn_type !== 'value' && !membersByAlias[conn.from_alias])
        return res.status(422).json({ error: `Source member "${conn.from_alias}" not found` });
      if (!membersByAlias[conn.to_alias])
        return res.status(422).json({ error: `Target member "${conn.to_alias}" not found` });
    }

    // DFS cycle detection
    if (validateCycles) {
      const visited = new Set();
      const recStack = new Set();

      function dfs(alias, subIdx) {
        const node = `${alias}::${subIdx}`;
        if (recStack.has(node)) return true;  // cycle found
        if (visited.has(node)) return false;

        visited.add(node);
        recStack.add(node);

        for (const conn of connections) {
          if (conn.from_alias === alias && (conn.from_sub_idx ?? 0) === subIdx) {
            if (dfs(conn.to_alias, conn.to_sub_idx ?? 0)) return true;
          }
        }

        recStack.delete(node);
        return false;
      }

      // Check all starting nodes
      const checkedNodes = new Set();
      for (const conn of connections) {
        const node = `${conn.from_alias}::${conn.from_sub_idx ?? 0}`;
        if (!checkedNodes.has(node)) {
          checkedNodes.add(node);
          if (dfs(conn.from_alias, conn.from_sub_idx ?? 0)) {
            return res.status(422).json({
              error: `Cycle detected involving ${conn.from_alias}::${conn.from_sub_idx ?? 0}`
            });
          }
        }
      }
    }

    // Save connections
    await db.transaction(async () => {
      await db.prepare('DELETE FROM unit_type_member_connections WHERE unit_type_id = ?').run(req.params.id);

      if (connections.length > 0) {
        const stmt = db.prepare(`
          INSERT INTO unit_type_member_connections
            (unit_type_id, from_alias, from_sub_idx, from_var_name, to_alias, to_sub_idx, to_var_name, conn_type, static_value, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `);

        for (let i = 0; i < connections.length; i++) {
          const c = connections[i];
          await stmt.run(req.params.id, c.from_alias, c.from_sub_idx ?? 0, c.from_var_name || '',
            c.to_alias, c.to_sub_idx ?? 0, c.to_var_name || '', c.conn_type || 'interconnection',
            c.static_value ?? null, i);
        }
      }
    })();

    res.json({ success: true, count: connections.length });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ── DELETE /api/unit-types/:id/connections/:connId ───────────────────────────
router.delete('/:id/connections/:connId', async (req, res) => {
  try {
    const db = getDb();
    await db.prepare('DELETE FROM unit_type_member_connections WHERE id = ? AND unit_type_id = ?')
      .run(req.params.connId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/unit-types/:id/cm-type-variables ────────────────────────────────
// Load blocks/variables for every member of this unit, keyed by member alias.
// Simple members:    { alias: { kind:'simple', cmTypeName, vars:[{name,dir,dtype,block}] } }
// Composite members: { alias: { kind:'composite', subMembers:[{subIdx,subAlias,cmTypeName,vars:[...]}] } }
router.get('/:id/cm-type-variables', async (req, res) => {
  try {
    const db = getDb();
    const ut = await db.prepare('SELECT * FROM unit_types WHERE id = ?').get(req.params.id);
    if (!ut) return res.status(404).json({ error: 'Unit type not found' });

    // Resolve all variables for a given CM type name → flat list with block name.
    const varsForCmType = async (cmTypeName) => {
      if (!cmTypeName) return [];
      const cmType = await db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(cmTypeName);
      const cmTypeId = cmType?.id;
      if (!cmTypeId) return [];
      const blocks = (await db.prepare(
        'SELECT id, name FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order, id'
      ).all(cmTypeId)) || [];
      // PCS7 stores direction as VarInput / VarOutput / VarInOut — normalize to
      // in / out / inout so the frontend can filter source vs. target uniformly.
      const normDir = (d) => {
        const s = String(d || '').toLowerCase();
        if (s === 'varoutput' || s === 'out') return 'out';
        if (s === 'varinout' || s === 'inout') return 'inout';
        return 'in'; // VarInput and anything else default to input
      };
      const out = [];
      for (const b of blocks) {
        const vars = (await db.prepare(
          'SELECT name, dir, dtype FROM lib_variables WHERE block_id = ? ORDER BY sort_order, id'
        ).all(b.id)) || [];
        for (const v of vars) out.push({ name: v.name, dir: normDir(v.dir), dtype: v.dtype, block: b.name });
      }
      return out;
    };

    const members = (await db.prepare(
      'SELECT * FROM unit_type_members WHERE unit_type_id = ? ORDER BY sort_order, id'
    ).all(req.params.id)) || [];

    const result = {};
    for (const m of members) {
      if (m.composite_cm_id) {
        // Composite member: enumerate sub-members with their sub-index (sort_order position).
        const subs = (await db.prepare(
          'SELECT * FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order, id'
        ).all(m.composite_cm_id)) || [];
        const subMembers = [];
        for (let idx = 0; idx < subs.length; idx++) {
          const sm = subs[idx];
          subMembers.push({
            subIdx: idx,
            subAlias: sm.cm_type_name,           // sub-members are identified by their CM type name
            cmTypeName: sm.cm_type_name,
            vars: await varsForCmType(sm.cm_type_name)
          });
        }
        result[m.alias] = { kind: 'composite', subMembers };
      } else if (m.cm_type_name) {
        result[m.alias] = {
          kind: 'simple',
          cmTypeName: m.cm_type_name,
          vars: await varsForCmType(m.cm_type_name)
        };
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/unit-types/project/:projectId/unit-instances ────────────────────
router.get('/project/:projectId/unit-instances', async (req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare(`
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
router.put('/project/:projectId/unit-instances/:id', async (req, res) => {
  try {
    const { user_project, parent_path, unit_name } = req.body || {};
    const db = getDb();
    await db.prepare(
      'UPDATE unit_instances SET user_project=?, parent_path=?, unit_name=? WHERE id=? AND project_id=?'
    ).run(user_project || '', parent_path || '', unit_name || '', req.params.id, req.params.projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types/project/:projectId/unit-instances ───────────────────
router.post('/project/:projectId/unit-instances', async (req, res) => {
  try {
    const { unit_type_id, unit_name, user_project, parent_path } = req.body || {};
    if (!unit_type_id || !unit_name?.trim())
      return res.status(400).json({ error: 'unit_type_id and unit_name are required' });
    const db  = getDb();
    const row = await db.prepare(
      'INSERT INTO unit_instances (project_id, unit_type_id, unit_name, user_project, parent_path) VALUES (?,?,?,?,?)'
    ).run(req.params.projectId, unit_type_id, unit_name.trim(), user_project || '', parent_path || '');
    res.json({ id: row.lastInsertRowid, unit_type_id, unit_name: unit_name.trim(), user_project: user_project || '', parent_path: parent_path || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/unit-types/project/:projectId/unit-instances/:id ─────────────
router.delete('/project/:projectId/unit-instances/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.transaction(async () => {
      await db.prepare('DELETE FROM project_instances WHERE source_unit_instance_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM project_hierarchy_folders WHERE source_unit_instance_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM unit_instances WHERE id = ? AND project_id = ?')
        .run(req.params.id, req.params.projectId);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types/project/:projectId/unit-instances/expand ─────────────
// Idempotent: deletes and recreates all unit-sourced instances + folders.
router.post('/project/:projectId/unit-instances/expand', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);

    // Load enabled_blocks profile per cm_type for this project (or default to all required)
    const profileRows = await db.prepare(
      'SELECT cm_type, enabled_blocks FROM project_cmt_profiles WHERE project_id = ?'
    ).all(projectId);
    const profileMap = {};
    for (const p of profileRows) profileMap[p.cm_type] = JSON.parse(p.enabled_blocks || '[]');

    // Fallback user project (used only if a unit instance has none set)
    const upRows = await db.prepare(
      'SELECT name FROM project_user_projects WHERE project_id = ? ORDER BY sort_order LIMIT 1'
    ).all(projectId);
    const defaultUserProject = upRows[0]?.name || '';

    // Determine current max sort_order in project_instances + project_hierarchy_folders
    const maxInstSO  = (await db.prepare('SELECT MAX(sort_order) AS m FROM project_instances WHERE project_id = ? AND source_unit_instance_id IS NULL').get(projectId))?.m || 0;
    const maxFolSO   = (await db.prepare('SELECT MAX(sort_order) AS m FROM project_hierarchy_folders WHERE project_id = ? AND source_unit_instance_id IS NULL').get(projectId))?.m || 0;
    let folSO = maxFolSO + 1;
    let instSO = maxInstSO + 1;
    let compositeGroupCounter = 0;

    // Project-scope registry: "<userProject>::<name>" → true. A project-scope
    // composite member is instantiated only once per User Project; later units
    // referencing it reuse the same instance (by name) instead of creating a copy.
    const projectScopeCreated = new Set();

    // IO connection rules per composite → per member idx. Mirrors the logic in
    // hierarchyBuilder.promoteToProject so unit-type-generated instances get the
    // same dummy-signal wiring as IO-import-generated ones. Each connection:
    //   { target_block, target_pin, prefix, suffix, signal_type, required }
    // The dummy signal name is later derived as prefix + instanceName + suffix.
    const ioConnCache = new Map();   // compositeId → { [memberIdx]: connections[] }
    const getIOConnectionsForMember = async (compositeId, memberIdx) => {
      let byMember = ioConnCache.get(compositeId);
      if (!byMember) {
        byMember = {};
        const rules = await db.prepare(
          'SELECT * FROM composite_cm_connections WHERE composite_id = ? AND conn_type = ? ORDER BY sort_order, id'
        ).all(compositeId, 'io_connection');
        for (const c of rules) {
          let meta = {};
          try { meta = c.static_value ? JSON.parse(c.static_value) : {}; } catch { meta = {}; }
          const row = { ...c, ...meta };
          const idx = Number(row.to_member_idx);
          (byMember[idx] ||= []).push({
            target_block: row.block_name || '',
            target_pin:   row.to_var_name || '',
            prefix:       row.prefix || '',
            suffix:       row.suffix || '',
            signal_type:  row.signal_type || null,
            required:     row.required ? 1 : 0,
          });
        }
        ioConnCache.set(compositeId, byMember);
      }
      return byMember[Number(memberIdx)] || [];
    };

    const unitInsts = await db.prepare(
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
    const ensureFolder = async (parentId, name, uiId) => {
      const key = folderCacheKey(parentId, name);
      if (folderCache.has(key)) return folderCache.get(key);

      // Check for a manually-created folder (source_unit_instance_id IS NULL)
      const manual = await db.prepare(
        'SELECT id FROM project_hierarchy_folders WHERE project_id=? AND parent_id IS NOT DISTINCT FROM ? AND name=? AND source_unit_instance_id IS NULL'
      ).get(projectId, parentId, name);
      if (manual) {
        folderCache.set(key, manual.id);
        return manual.id;
      }

      // Create a new shared unit-expand folder (attributed to the first unit that needs it)
      const r = await db.prepare(
        'INSERT INTO project_hierarchy_folders (project_id, parent_id, name, s88_type, sort_order, source_unit_instance_id) VALUES (?,?,?,?,?,?)'
      ).run(projectId, parentId, name, '', folSO++, uiId);
      const id = r.lastInsertRowid;
      folderCache.set(key, id);
      folderCount++;
      return id;
    };

    // Walk a slash-separated path from a parent folder id, creating segments as needed.
    const makeFolderPath = async (uiId, parentId, folderPath) => {
      const segs = (folderPath || '').split('/').map(s => s.trim()).filter(Boolean);
      let cur = parentId;
      for (const seg of segs) cur = await ensureFolder(cur, seg, uiId);
      return cur;
    };

    await db.transaction(async () => {
      // Delete ALL previously expanded instances and folders in one pass before recreating.
      // This avoids per-unit duplicate paths when multiple units share the same parent path.
      for (const ui of unitInsts) {
        await db.prepare('DELETE FROM project_instances WHERE source_unit_instance_id = ?').run(ui.id);
        await db.prepare('DELETE FROM project_hierarchy_folders WHERE source_unit_instance_id = ?').run(ui.id);
        await db.prepare('DELETE FROM unit_resolved_connections WHERE unit_instance_id = ?').run(ui.id);
      }

      for (const ui of unitInsts) {
        const ut = await loadUnitTypeDetail(db, ui.unit_type_id);
        if (!ut) continue;

        // Build: parent_path / unit_name / composite.hierarchy_folder
        // e.g. rIX/DE1 → U010 → CM  =  rIX/DE1/U010/CM
        const parentPath = (ui.parent_path || '').trim();
        const parentFolderId = parentPath
          ? await makeFolderPath(ui.id, null, parentPath)
          : null;
        const unitFolderId = await ensureFolder(parentFolderId, ui.unit_name, ui.id);

        const instanceUserProject = (ui.user_project || '').trim() || defaultUserProject;

        // Project-scope members hang off level 1 of the parent path (the FIRST
        // segment), then the folder defined on the composite member.
        // e.g. parent "rIX/DE01" + member folder "Shared" → "rIX/Shared".
        const firstSeg = parentPath.split('/').map(s => s.trim()).filter(Boolean)[0];
        const sharedParentId = firstSeg ? await ensureFolder(null, firstSeg, ui.id) : null;

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
          const subMembers = await db.prepare(
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
                ? await makeFolderPath(ui.id, sharedParentId, cm.hierarchy_folder)
                : sharedParentId;
            } else {
              subFolderId = cm.hierarchy_folder
                ? await makeFolderPath(ui.id, unitFolderId, cm.hierarchy_folder)
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

            const connections = await getIOConnectionsForMember(m.compositeCmId, cmIdx);

            await db.prepare(`
              INSERT INTO project_instances
                (project_id, cm_type, instance_name, sampling_time, user_project,
                 folder_id, role_assignments, sort_order, source_unit_instance_id,
                 composite_group_id, composite_id, member_idx, connections)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
              JSON.stringify(connections),
            );
            instanceCount++;
          }
        }

        // ── Pass 3: materialize unit-level member connections ──────────────────
        // unit_type_member_connections wire member aliases (UNIT_PLC.QCmndUnitCM →
        // XV10.CmndUnit) across composite boundaries. Resolve each endpoint via the
        // nameMap (alias::subIdx → instance name) and persist the concrete pair so
        // generate.js can emit an InterconnectionSource on the destination pin.
        let connSO = 0;
        for (const conn of (ut.connections || [])) {
          if ((conn.conn_type || 'interconnection') !== 'interconnection') continue;
          const toInstance = nameMap[`${conn.to_alias}::${conn.to_sub_idx ?? 0}`];
          if (!toInstance || !conn.to_var_name) continue;
          const fromInstance = nameMap[`${conn.from_alias}::${conn.from_sub_idx ?? 0}`];
          if (!fromInstance || !conn.from_var_name) continue;

          await db.prepare(`
            INSERT INTO unit_resolved_connections
              (project_id, unit_instance_id, from_instance, from_var_name,
               to_instance, to_var_name, conn_type, static_value, user_project, sort_order)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(
            projectId, ui.id, fromInstance, conn.from_var_name,
            toInstance, conn.to_var_name, 'interconnection', conn.static_value ?? null,
            instanceUserProject, connSO++,
          );
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

// ── POST /api/unit-types/import-pcs7/preview ───────────────────────────────────
// Preview: Extract CM/EM types from XML without creating unit type yet.
// Body: { xmlText }
router.post('/import-pcs7/preview', async (req, res) => {
  try {
    const { xmlText } = req.body || {};

    if (!xmlText?.trim()) {
      return res.status(400).json({ error: 'xmlText (XML file contents) is required' });
    }

    const pcs7XmlImporter = require('../services/pcs7XmlImporter');
    const compositeMatcherV2 = require('../services/compositeMatcherV2');
    const extracted = pcs7XmlImporter.extractCmTypesFromXml(xmlText);
    const db = getDb();

    // Try to match instances to existing Composite CM Types (+ attach role + classify interconnections)
    const { assignments, metadata: matchMetadata, interconnections: filteredConnections, intraCompositeChecks } = await compositeMatcherV2.matchInstancesToComposites(
      extracted.cmInstances,
      db,
      extracted.metadata.roleAssignments || [],
      extracted.interconnections || []
    );

    console.log(`[Import Preview] Extracted ${extracted.cmInstances.length} CM/EM instances`);
    console.log(`[Import Preview] Common suffix: ${matchMetadata.commonSuffix}`);
    console.log(`[Import Preview] Matched to composite: ${matchMetadata.matchedToComposite}, Direct: ${matchMetadata.matchedDirect}`);
    console.log(`[Import Preview] Interconnections: ${matchMetadata.interconnectionsProcessed} found, ${matchMetadata.interconnectionsImported} imported (cross-composite), ${matchMetadata.intraCompositeCount || 0} intra-composite checked`);

    res.json({
      success: true,
      cmInstances: extracted.cmInstances,  // [{ name, alias, type, kind, stripped }]
      assignments: assignments,  // [{ alias, cmTypeName, compositeCmId, compositeInfo, ... }]
      interconnections: filteredConnections,  // [{ from_alias, from_var_name, to_alias, to_var_name }] - cross-composite only
      intraCompositeChecks: intraCompositeChecks || [],  // [{ compositeName, memberAlias, fromSubCmType, fromVarName, toSubCmType, toVarName, existsInComposite }]
      metadata: extracted.metadata,
      matchMetadata,
      stats: {
        totalInstances: extracted.cmInstances.length,
        cmCount: extracted.cmInstances.filter(c => c.kind === 'CM').length,
        emCount: extracted.cmInstances.filter(c => c.kind === 'EM').length,
        connectionCount: matchMetadata.interconnectionsImported,  // Only count cross-composite connections
        matchedToComposite: matchMetadata.matchedToComposite,
        matchedDirect: matchMetadata.matchedDirect,
        intraCompositeChecked: matchMetadata.intraCompositeCount || 0,
        intraExisting: matchMetadata.intraExisting || 0,
        intraMissing: matchMetadata.intraMissing || 0,
      }
    });
  } catch (err) {
    console.error('[Import Preview] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/unit-types/import-pcs7 ───────────────────────────────────────────
// Create unit type from extracted CM instances (without Composite assignment for now).
// Body: { unitName, description, cmInstances, interconnections }
router.post('/import-pcs7', async (req, res) => {
  try {
    const { unitName, description, assignments, interconnections } = req.body || {};

    if (!unitName?.trim()) {
      return res.status(400).json({ error: 'unitName is required' });
    }
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({ error: 'assignments array is required and must not be empty' });
    }

    const db = getDb();
    const unitTypeBuilder = require('../services/unitTypeBuilder');

    // Build unit members from assignments (may include composite CM references)
    // assignments: [{ alias, cmTypeName, compositeCmId, ... }]
    const unitMembers = assignments.map((assign, idx) => ({
      alias: assign.alias,
      cmTypeName: assign.cmTypeName,
      compositeCmId: assign.compositeCmId || null,  // may be null for direct members
      hierarchyFolder: assign.hierarchyFolder || 'CM',  // can be 'CM', 'EM', or 'EPH'
      isPrimary: idx === 0 ? 1 : 0,
      sortOrder: idx,
      roleAssignments: assign.roleAssignments || [],  // [{ role, targetAlias, targetMemberIdx, sourceMemberIdx }]
    }));

    console.log(`[Import] Creating unit type with ${unitMembers.length} direct CM members`);

    // Create unit type (no composite assignment)
    const result = await unitTypeBuilder.createUnitTypeFromAssignment(
      unitName.trim(),
      description?.trim() || '',
      unitMembers,
      interconnections || [],  // preserve interconnections
      db
    );

    res.status(201).json({
      unitTypeId: result.id,
      unitName: result.name,
      memberCount: result.memberCount,
      connectionCount: result.connectionCount,
      members: unitMembers,
      message: 'Unit type created successfully'
    });
  } catch (err) {
    console.error('[Import] Error:', err.message);
    if (err.message?.toLowerCase().includes('unique') || err.code === '23505') {
      return res.status(409).json({ error: `Unit type "${req.body?.unitName}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
