// src/routes/generate.js — XML generation + audit trail
'use strict';
const express = require('express');
const { getDb }        = require('../db');
const { generateXML }  = require('../xmlGenerator');

const router = express.Router();

// ── POST /api/generate ────────────────────────────────────────────────────────
// Body: {
//   projectName: "AS01",
//   generatedBy: "Z003UU2W",   (optional, defaults to OS user)
//   instances: [
//     { cmType: "CM_AO", instanceName: "CM_A01", samplingTime: "1000",
//       enabledBlocks: ["AIF_FRONT","CSF","GMP","IF_BACK","MV_Rate","V","YC_SCALE"] }
//   ]
// }
router.post('/', (req, res) => {
  try {
    const { projectName, instances, generatedBy, userProjects } = req.body;
    if (!instances?.length) return res.status(400).json({ error: 'instances array required' });

    // Determine which user projects to emit. If none provided, fall back to a single
    // group using projectName (legacy behavior).
    const groups = (userProjects && userProjects.length)
      ? userProjects
      : [projectName || 'PROJECT'];

    const db = getDb();

    // Load the hierarchy and project config for this saved project (looked up by name).
    let hierarchy = [];
    let projectConfig = null;
    if (projectName) {
      const proj = db.prepare(`SELECT id FROM projects WHERE name = ?`).get(projectName);
      if (proj) {
        hierarchy = db.prepare(`
          SELECT id, parent_id, name, s88_type, sort_order
          FROM project_hierarchy_folders
          WHERE project_id = ?
          ORDER BY sort_order, id
        `).all(proj.id);
        projectConfig = db.prepare(`SELECT * FROM project_config WHERE project_id = ?`).get(proj.id) || null;
      }
    }

    const getCmType = db.prepare(`SELECT * FROM lib_cm_types WHERE name = ?`);
    const getBlocks = db.prepare(`
      SELECT
        b.*,
        GROUP_CONCAT(DISTINCT v.lib_id) AS var_lib_ids
      FROM lib_blocks b
      LEFT JOIN lib_variables v ON v.block_id = b.id
      WHERE b.cm_type_id = ?
      GROUP BY b.id
      ORDER BY b.sort_order
    `);
    const getVars = db.prepare(`
      SELECT v.*, GROUP_CONCAT(lk.target_lib_id) AS link_ids
      FROM lib_variables v
      LEFT JOIN lib_var_links lk ON lk.var_id = v.id
      WHERE v.block_id = ?
      GROUP BY v.id
      ORDER BY v.sort_order
    `);
    const getMsgs = db.prepare(`
      SELECT * FROM lib_messages WHERE block_id = ? ORDER BY sort_order
    `);

    const getRoles = db.prepare(`
      SELECT role, role_kind FROM lib_em_roles WHERE cm_type_id = ? ORDER BY sort_order
    `);

    // Cache composite is_matrix + matrix data lookups by compositeId.
    const matrixCache = new Map();   // compositeId -> { isMatrix, columns, modes }
    function resolveMatrixComposite(compositeId) {
      if (matrixCache.has(compositeId)) return matrixCache.get(compositeId);
      const comp = db.prepare('SELECT is_matrix FROM composite_cm_types WHERE id = ?').get(compositeId);
      if (!comp?.is_matrix) {
        const result = { isMatrix: false };
        matrixCache.set(compositeId, result);
        return result;
      }
      const columns = db.prepare(
        'SELECT column_name FROM composite_matrix_columns WHERE composite_id = ? ORDER BY sort_order, id'
      ).all(compositeId).map(r => r.column_name);
      const modesRaw = db.prepare(
        'SELECT * FROM composite_matrix_modes WHERE composite_id = ? ORDER BY sort_order, id'
      ).all(compositeId);
      const modes = modesRaw.map(m => {
        const cells = db.prepare(
          'SELECT column_name, value FROM composite_matrix_cells WHERE mode_id = ?'
        ).all(m.id);
        const cellMap = {};
        for (const c of cells) cellMap[c.column_name] = c.value;
        return { mode_nr: m.mode_nr, mode_name: m.mode_name, cells: cellMap };
      });
      const result = { isMatrix: true, columns, modes };
      matrixCache.set(compositeId, result);
      return result;
    }

    // Cache CM type lookups so we don't refetch for every instance.
    const cmCache = new Map();
    function resolveInstance(inst) {
      // If this instance belongs to a matrix composite, use the matrix emitter.
      if (inst.compositeId != null) {
        const matrixComp = resolveMatrixComposite(inst.compositeId);
        if (matrixComp.isMatrix) {
          return {
            isMatrix:     true,
            instanceName: inst.instanceName,
            matrixDef: {
              instanceName: inst.instanceName,
              samplingTime: inst.samplingTime || '100',
              columns:      matrixComp.columns,
              modes:        matrixComp.modes,
            },
          };
        }
      }

      let resolved = cmCache.get(inst.cmType);
      if (!resolved) {
        const cm = getCmType.get(inst.cmType);
        if (!cm) throw new Error(`CM type not found: ${inst.cmType}`);
        const blocks = getBlocks.all(cm.id).map(b => ({
          name:     b.name,
          comment:  b.comment,
          optional: !!b.optional,
          vars: getVars.all(b.id).map(v => ({
            libId:       v.lib_id,
            name:        v.name,
            dir:         v.dir,
            dtype:       v.dtype,
            val:         v.val,
            comment:     v.comment,
            vtype:       v.vtype,
            enumeration: v.enumeration,
            negation:    !!v.negation,
            libLinks:    v.link_ids ? v.link_ids.split(',') : [],
          })),
          msgs: getMsgs.all(b.id).map(m => ({
            name: m.name, batch: m.batch, cls: m.cls, event: m.event,
            origin: m.origin, osarea: m.osarea, prio: m.prio, ack: !!m.ack,
          })),
        }));
        const roleRows = getRoles.all(cm.id);
        const roles = roleRows.map(r => r.role);
        const roleKindMap = {};
        for (const r of roleRows) roleKindMap[r.role] = r.role_kind || 'cm';
        resolved = { cm, blocks, roles, roleKindMap };
        cmCache.set(inst.cmType, resolved);
      }
      const { cm, blocks, roles, roleKindMap } = resolved;
      return {
        cmTypeDef: {
          name:         cm.name,
          comment:      cm.comment,
          samplingTime: cm.sampling_time,
          subBlocks:    blocks,
          roles,
          roleKindMap,
        },
        libType:        cm.cm_type,
        instanceName:   inst.instanceName,
        enabledBlocks:  inst.enabledBlocks || [],
        samplingTime:   inst.samplingTime  || cm.sampling_time || '1000',
        roleAssignments: inst.roleAssignments || {},
      };
    }

    // Build composite connection groups indexed by compositeGroupId.
    // Each connGroup entry: { compositeId, connections, memberInstanceNames: { [memberIdx]: instanceName } }
    const getConns = db.prepare(
      'SELECT * FROM composite_cm_connections WHERE composite_id = ? ORDER BY sort_order, id'
    );
    const getMemberScopes = db.prepare(
      'SELECT scope FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order, id'
    );
    // Member scope array per composite (memberIdx → 'unit' | 'project'), cached.
    const scopeCache = {};
    const memberScopes = cid => (scopeCache[cid] ||= getMemberScopes.all(cid).map(r => r.scope || 'unit'));

    // Project-scope members are instantiated once and shared; record the single
    // instance name per (compositeId, memberIdx) so every unit's connGroup can
    // resolve interconnections to it even though only one instance row exists.
    const psNames = {};  // compositeId -> { memberIdx: instanceName }
    for (const inst of instances) {
      if (inst.compositeId == null || inst.memberIdx == null) continue;
      if (memberScopes(inst.compositeId)[inst.memberIdx] === 'project') {
        (psNames[inst.compositeId] ||= {})[inst.memberIdx] = inst.instanceName;
      }
    }

    const connGroupsMap = {};  // compositeGroupId -> { compositeId, connections, memberInstanceNames }
    for (const inst of instances) {
      if (inst.compositeGroupId == null || inst.compositeId == null || inst.memberIdx == null) continue;
      const gid = inst.compositeGroupId;
      if (!connGroupsMap[gid]) {
        connGroupsMap[gid] = {
          compositeId: inst.compositeId,
          connections: getConns.all(inst.compositeId),
          memberInstanceNames: {},
        };
      }
      connGroupsMap[gid].memberInstanceNames[inst.memberIdx] = inst.instanceName;
    }
    // Fill shared project-scope member names into every group of the same composite.
    for (const grp of Object.values(connGroupsMap)) {
      const ps = psNames[grp.compositeId];
      if (!ps) continue;
      for (const [idx, name] of Object.entries(ps)) {
        if (grp.memberInstanceNames[idx] == null) grp.memberInstanceNames[idx] = name;
      }
    }
    const connGroups = Object.values(connGroupsMap);

    // Group instances by user project, then generate one XML per group.
    const outputs = [];
    for (const up of groups) {
      const groupInstances = (userProjects && userProjects.length)
        ? instances.filter(i => i.userProject === up)
        : instances;
      if (!groupInstances.length) continue;

      const instDefs = groupInstances.map(resolveInstance);
      const instanceFolderMap = {};
      for (const inst of groupInstances) {
        if (inst.folderId != null) instanceFolderMap[inst.instanceName] = inst.folderId;
      }
      const { xml, stats } = generateXML(instDefs, up, hierarchy, instanceFolderMap, projectConfig, connGroups);
      outputs.push({ userProject: up, xml, stats, instances: groupInstances });
    }

    if (!outputs.length) {
      return res.status(400).json({ error: 'no instances assigned to any user project' });
    }

    // Audit: one row per emitted XML.
    const saveAudit = db.transaction(() => {
      const ids = [];
      for (const out of outputs) {
        const genRow = db.prepare(`
          INSERT INTO audit_generations
            (project_name, generated_by, instance_count, block_count, var_count, msg_count, link_count, xml_size_kb)
          VALUES (?,?,?,?,?,?,?,?)
        `).run(
          out.userProject,
          generatedBy || process.env.USERNAME || 'unknown',
          out.instances.length,
          out.stats.blocks,
          out.stats.vars,
          out.stats.msgs,
          out.stats.links,
          out.stats.sizeKb,
        );
        const genId = genRow.lastInsertRowid;
        const insInst = db.prepare(`
          INSERT INTO audit_instances (generation_id, cm_type, instance_name, sampling_time, enabled_blocks)
          VALUES (?,?,?,?,?)
        `);
        for (const inst of out.instances) {
          insInst.run(genId, inst.cmType, inst.instanceName, inst.samplingTime || '1000',
            JSON.stringify(inst.enabledBlocks || []));
        }
        ids.push(genId);
      }
      return ids;
    });
    const auditIds = saveAudit();

    // Strip the `instances` field from the response — caller doesn't need it back.
    const responseOutputs = outputs.map(({ userProject, xml, stats }) => ({ userProject, xml, stats }));
    res.json({ success: true, outputs: responseOutputs, auditIds });

  } catch (err) {
    console.error('[Generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/generate/history ─────────────────────────────────────────────────
router.get('/history', (req, res) => {
  try {
    const db    = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows  = db.prepare(`
      SELECT
        g.id, g.project_name, g.generated_by, g.generated_at,
        g.instance_count, g.block_count, g.var_count, g.xml_size_kb
      FROM audit_generations g
      ORDER BY g.generated_at DESC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/generate/history/:id ────────────────────────────────────────────
router.get('/history/:id', (req, res) => {
  try {
    const db  = getDb();
    const gen = db.prepare(`SELECT * FROM audit_generations WHERE id = ?`).get(req.params.id);
    if (!gen) return res.status(404).json({ error: 'Generation not found' });
    const instances = db.prepare(`
      SELECT * FROM audit_instances WHERE generation_id = ? ORDER BY id
    `).all(req.params.id);
    res.json({ ...gen, instances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
