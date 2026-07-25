// src/routes/generate.js — XML generation + audit trail
'use strict';
const express = require('express');
const { getDb }        = require('../db');
const { generateXML }  = require('../xmlGenerator');
const { loadMappingsForProject } = require('../signalMappings');
const { loadConnectionIOsForProject } = require('../connections');
const { parseDerivedValueSpec } = require('../derivedValues');

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
// ── Shared generation core ─────────────────────────────────────────────────────
// Runs the full generation pipeline and returns { outputs, auditIds }.
// `onProgress({ pct, phase, msg })` is optional — when provided it is invoked at
// phase-level checkpoints so a streaming caller can report progress. The non-
// streaming POST / handler calls this without a callback (unchanged behaviour).
// Throws on validation / generation errors (caller maps to a response).
async function runGeneration(db, body, onProgress) {
  const report = (pct, phase, msg) => { if (onProgress) onProgress({ pct, phase, msg }); };

  const { projectName, instances, generatedBy, userProjects } = body;
  if (!instances?.length) { const e = new Error('instances array required'); e.status = 400; throw e; }

  // Determine which user projects to emit. If none provided, fall back to a single
  // group using projectName (legacy behavior).
  const groups = (userProjects && userProjects.length)
    ? userProjects
    : [projectName || 'PROJECT'];

  // Load the hierarchy and project config for this saved project (looked up by name).
  let hierarchy = [];
  let projectConfig = null;
  let signalMaps = {};   // { instanceName: { "block.var": { tag, ... } } } — injected at export
  let matrixOverrides = {};   // { instanceName: { enabled, cells: { mode_nr: { colName: val } } } }
  if (projectName) {
      const proj = await db.prepare(`SELECT id FROM projects WHERE name = ?`).get(projectName);
      if (proj) {
        hierarchy = await db.prepare(`
          SELECT id, parent_id, name, s88_type, sort_order
          FROM project_hierarchy_folders
          WHERE project_id = ?
          ORDER BY sort_order, id
        `).all(proj.id);
        projectConfig = (await db.prepare(`SELECT * FROM project_config WHERE project_id = ?`).get(proj.id)) || null;
        signalMaps = await loadMappingsForProject(db, proj.id);

        // Per-instance matrix overrides — applied to matrix CM instances below.
        const moRows = await db.prepare(
          `SELECT instance_name, enabled, cells FROM instance_matrix_overrides WHERE project_id = ?`
        ).all(proj.id);
        for (const r of moRows) {
          if (!r.enabled) continue;
          let cells = {};
          try { cells = r.cells ? JSON.parse(r.cells) : {}; } catch { cells = {}; }
          matrixOverrides[r.instance_name] = { enabled: true, cells };
        }

        // Overlay reconciled connection IOs (from "Generate Connections"). REAL
        // rows carry a hardware-matched signal and emit <SignalName>; unmatched
        // rows are dummy:true so the block-omission rule can drop required pins.
        // A manual signal mapping always wins over a reconciled entry.
        const connIOs = await loadConnectionIOsForProject(db, proj.id);
        for (const [instName, pins] of Object.entries(connIOs)) {
          const bucket = (signalMaps[instName] ||= {});
          for (const [key, entry] of Object.entries(pins)) {
            if (bucket[key]) {
              // Manual mapping wins for the tag assignment, but augment it with the
              // hardware address from the reconciled entry so IOTag generation works.
              if (entry.ioAddress && !bucket[key].ioAddress) {
                bucket[key].ioAddress = entry.ioAddress;
                bucket[key].comment   = entry.comment || bucket[key].comment || null;
              }
              continue;
            }
            bucket[key] = entry;
          }
        }

        // Fallback: instances whose IO rules were never reconciled still get
        // on-the-fly dummy markers (prefix + instance name + suffix) pre-wired to
        // a block pin. This preserves prior behavior when "Generate Connections"
        // has not been run. A real or reconciled entry above always wins.
        const connRows = await db.prepare(
          `SELECT instance_name, connections FROM project_instances WHERE project_id = ?`
        ).all(proj.id);
        for (const row of connRows) {
          let conns = [];
          try { conns = JSON.parse(row.connections || '[]'); } catch { conns = []; }
          if (!Array.isArray(conns) || !conns.length) continue;
          const instName = row.instance_name;
          for (const c of conns) {
            if (!c.target_block || !c.target_pin) continue;
            const key = `${c.target_block}.${c.target_pin}`;
            const bucket = (signalMaps[instName] ||= {});
            if (bucket[key]) continue;   // real / reconciled entry wins over dummy
            bucket[key] = {
              tag:        `${c.prefix || ''}${instName}${c.suffix || ''}`,
              varDtype:   null,
              signalType: c.signal_type || null,
              dummy:      true,
              required:   (c.required === 0 || c.required === false) ? 0 : 1,
            };
          }
        }
      }
    }

    report(3, 'setup', 'Loading project…');

    const getCmType = db.prepare(`SELECT * FROM lib_cm_types WHERE name = ?`);
    const getBlocks = db.prepare(`
      SELECT
        b.*,
        STRING_AGG(DISTINCT v.lib_id, ',') AS var_lib_ids
      FROM lib_blocks b
      LEFT JOIN lib_variables v ON v.block_id = b.id
      WHERE b.cm_type_id = ?
      GROUP BY b.id
      ORDER BY b.sort_order
    `);
    const getVars = db.prepare(`
      SELECT v.*, STRING_AGG(lk.target_lib_id, ',') AS link_ids
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
    async function resolveMatrixComposite(compositeId) {
      if (matrixCache.has(compositeId)) return matrixCache.get(compositeId);
      const comp = await db.prepare('SELECT is_matrix FROM composite_cm_types WHERE id = ?').get(compositeId);
      if (!comp?.is_matrix) {
        const result = { isMatrix: false };
        matrixCache.set(compositeId, result);
        return result;
      }
      const columnRows = await db.prepare(
        'SELECT column_name FROM composite_matrix_columns WHERE composite_id = ? ORDER BY sort_order, id'
      ).all(compositeId);
      const columns = columnRows.map(r => r.column_name);
      const modesRaw = await db.prepare(
        'SELECT * FROM composite_matrix_modes WHERE composite_id = ? ORDER BY sort_order, id'
      ).all(compositeId);
      const modes = [];
      for (const m of modesRaw) {
        const cells = await db.prepare(
          'SELECT column_name, value FROM composite_matrix_cells WHERE mode_id = ?'
        ).all(m.id);
        const cellMap = {};
        for (const c of cells) cellMap[c.column_name] = c.value;
        modes.push({ mode_nr: m.mode_nr, mode_name: m.mode_name, cells: cellMap });
      }
      const result = { isMatrix: true, columns, modes };
      matrixCache.set(compositeId, result);
      return result;
    }

    // Cache CM type lookups so we don't refetch for every instance.
    const cmCache = new Map();
    async function resolveInstance(inst) {
      // If this instance belongs to a matrix composite, use the matrix emitter.
      if (inst.compositeId != null) {
        const matrixComp = await resolveMatrixComposite(inst.compositeId);
        if (matrixComp.isMatrix) {
          // Overlay this instance's per-instance override (if enabled) onto the
          // composite's default modes. `cells` is keyed by mode_nr → { colName: val }.
          // Only overridden cells win; everything else keeps the composite default.
          const override = matrixOverrides[inst.instanceName];
          let modes = matrixComp.modes;
          if (override?.enabled && override.cells) {
            modes = matrixComp.modes.map(m => {
              const ov = override.cells[m.mode_nr] || override.cells[String(m.mode_nr)];
              if (!ov) return m;
              return { ...m, cells: { ...m.cells, ...ov } };
            });
          }
          return {
            isMatrix:     true,
            instanceName: inst.instanceName,
            matrixDef: {
              instanceName: inst.instanceName,
              samplingTime: inst.samplingTime || '100',
              columns:      matrixComp.columns,
              modes,
            },
          };
        }
      }

      let resolved = cmCache.get(inst.cmType);
      if (!resolved) {
        const cm = await getCmType.get(inst.cmType);
        if (!cm) throw new Error(`CM type not found: ${inst.cmType}`);
        const blockRows = await getBlocks.all(cm.id);
        const blocks = [];
        for (const b of blockRows) {
          const varRows = await getVars.all(b.id);
          const msgRows = await getMsgs.all(b.id);
          blocks.push({
            name:     b.name,
            comment:  b.comment,
            optional: !!b.optional,
            vars: varRows.map(v => ({
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
            msgs: msgRows.map(m => ({
              name: m.name, batch: m.batch, cls: m.cls, event: m.event,
              origin: m.origin, osarea: m.osarea, prio: m.prio, ack: !!m.ack,
            })),
          });
        }
        const roleRows = await getRoles.all(cm.id);
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
    async function memberScopes(cid) {
      if (!scopeCache[cid]) {
        const rows = await getMemberScopes.all(cid);
        scopeCache[cid] = rows.map(r => r.scope || 'unit');
      }
      return scopeCache[cid];
    }

    // Project-scope members are instantiated once and shared; record the single
    // instance name per (compositeId, memberIdx) so every unit's connGroup can
    // resolve interconnections to it even though only one instance row exists.
    const psNames = {};  // compositeId -> { memberIdx: instanceName }
    for (const inst of instances) {
      if (inst.compositeId == null || inst.memberIdx == null) continue;
      const scopes = await memberScopes(inst.compositeId);
      if (scopes[inst.memberIdx] === 'project') {
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
          connections: await getConns.all(inst.compositeId),
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

    // ── Unit-level interconnections (resolved by expand) ─────────────────────────
    // unit_resolved_connections holds inter-member wiring resolved to concrete
    // instance names (e.g. React01_UNIT_PLC.QCmndUnitCM → React01_XV10.CmndUnit).
    // These cross composite-member boundaries, so they cannot use the member-idx
    // grouping above. Repackage each into a connGroup whose memberInstanceNames maps
    // synthetic indices (0 = source, 1 = destination) to the resolved instance names,
    // which buildWireSpecs() in the XML generator consumes the same way.
    let genProjectId = null;
    if (projectName) {
      const proj = await db.prepare(`SELECT id FROM projects WHERE name = ?`).get(projectName);
      if (proj) {
        genProjectId = proj.id;
        const resolved = await db.prepare(
          `SELECT from_instance, from_var_name, to_instance, to_var_name, conn_type, static_value
           FROM unit_resolved_connections WHERE project_id = ? ORDER BY sort_order, id`
        ).all(proj.id);
        for (const rc of resolved) {
          connGroups.push({
            compositeId: null,
            connections: [{
              conn_type:      rc.conn_type || 'interconnection',
              from_member_idx: 0,
              from_var_name:   rc.from_var_name,
              to_member_idx:   1,
              to_var_name:     rc.to_var_name,
              static_value:    rc.static_value,
            }],
            memberInstanceNames: { 0: rc.from_instance, 1: rc.to_instance },
          });
        }
      }
    }

    // ── Derived "value" connections ───────────────────────────────────────────────
    // A conn_type='value' connection whose static_value decodes as a derived-mode
    // spec (see derivedValues.js) has no literal value — its value was already
    // materialized into instance_derived_values by the connections-reconcile step.
    // Rewrite each such connection's static_value in place to the resolved string
    // (or '' if unresolved) so buildWireSpecs() stays unaware derived values exist.
    if (genProjectId != null) {
      const hasDerived = connGroups.some(g => g.connections.some(c => parseDerivedValueSpec(c)));
      if (hasDerived) {
        const derivedRows = await db.prepare(
          `SELECT instance_name, to_var_name, value, status, override_value FROM instance_derived_values WHERE project_id = ?`
        ).all(genProjectId);
        const derivedMap = new Map(derivedRows.map(r => [`${r.instance_name} ${r.to_var_name}`, r]));
        for (const grp of connGroups) {
          for (const c of grp.connections) {
            const spec = parseDerivedValueSpec(c);
            if (!spec) continue;
            const instName = grp.memberInstanceNames[c.to_member_idx];
            const row = instName ? derivedMap.get(`${instName} ${c.to_var_name}`) : null;
            // A manual override always wins over the auto-resolved IO-list value.
            c.static_value = row?.override_value ?? (row?.status === 'resolved' ? (row.value ?? '') : '');
          }
        }
      }
    }

    // Group instances by user project, then generate one XML per group.
    // Progress budget: resolve phase 5→85 (scaled by total instances resolved
    // across all groups), build phase 85→95 (per group), audit 95→100.
    const outputs = [];
    const totalToResolve = instances.length || 1;
    let resolvedCount = 0;
    const groupCount = groups.length || 1;
    let groupIdx = 0;
    for (const up of groups) {
      const groupInstances = (userProjects && userProjects.length)
        ? instances.filter(i => i.userProject === up)
        : instances;
      if (!groupInstances.length) { groupIdx++; continue; }

      // Resolve instances one at a time so we can report live progress. This phase
      // is async DB work (with CM-type caching) and yields the event loop, so SSE
      // frames actually flush here — the visibly-moving part of the bar.
      const instDefs = [];
      for (const inst of groupInstances) {
        instDefs.push(await resolveInstance(inst));
        resolvedCount++;
        // Report every 25 instances (and on the last) to avoid frame spam.
        if (resolvedCount % 25 === 0 || resolvedCount === totalToResolve) {
          const pct = 5 + Math.round((resolvedCount / totalToResolve) * 80);
          report(pct, 'resolving', `${up}: resolved ${resolvedCount}/${totalToResolve}`);
        }
      }

      const instanceFolderMap = {};
      for (const inst of groupInstances) {
        if (inst.folderId != null) instanceFolderMap[inst.instanceName] = inst.folderId;
      }

      // Build phase: synchronous CPU-bound string build (event loop blocks here;
      // this frame is emitted just before so the label updates before the stall).
      const buildPct = 85 + Math.round(((groupIdx + 1) / groupCount) * 10);
      report(buildPct, 'building', `${up}: building XML…`);
      const { xml, stats } = generateXML(instDefs, up, hierarchy, instanceFolderMap, projectConfig, connGroups, signalMaps);
      outputs.push({ userProject: up, xml, stats, instances: groupInstances });
      groupIdx++;
    }

    if (!outputs.length) {
      const e = new Error('no instances assigned to any user project'); e.status = 400; throw e;
    }

    report(96, 'saving', 'Saving audit…');

    // Audit: one row per emitted XML.
    const saveAudit = db.transaction(async () => {
      const ids = [];
      for (const out of outputs) {
        const genRow = await db.prepare(`
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
          await insInst.run(genId, inst.cmType, inst.instanceName, inst.samplingTime || '1000',
            JSON.stringify(inst.enabledBlocks || []));
        }
        ids.push(genId);
      }
      return ids;
    });
    const auditIds = await saveAudit();

    // Strip the `instances` field from the response — caller doesn't need it back.
    const responseOutputs = outputs.map(({ userProject, xml, stats }) => ({ userProject, xml, stats }));
    return { outputs: responseOutputs, auditIds };
}

// ── POST /api/generate ──────────────────────────────────────────────────────────
// Non-streaming: returns the full result in one JSON response (unchanged contract).
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const { outputs, auditIds } = await runGeneration(db, req.body);
    res.json({ success: true, outputs, auditIds });
  } catch (err) {
    console.error('[Generate] Error:', err.message || err);
    if (err.stack) console.error(err.stack);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ── POST /api/generate/stream ────────────────────────────────────────────────────
// Streaming variant: emits Server-Sent-Events progress frames while generating, so
// the client can show a live progress bar and keep working. Same generation core.
// Uses a relative /api URL from the frontend so it rides the Vite proxy (no CORS).
router.post('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const db = getDb();
    const { outputs, auditIds } = await runGeneration(db, req.body, send);
    send({ done: true, outputs, auditIds });
    res.end();
  } catch (err) {
    console.error('[Generate stream] Error:', err.message || err);
    if (err.stack) console.error(err.stack);
    send({ error: err.message || String(err) });
    res.end();
  }
});

// ── GET /api/generate/history ─────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const db    = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows  = await db.prepare(`
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
router.get('/history/:id', async (req, res) => {
  try {
    const db  = getDb();
    const gen = await db.prepare(`SELECT * FROM audit_generations WHERE id = ?`).get(req.params.id);
    if (!gen) return res.status(404).json({ error: 'Generation not found' });
    const instances = await db.prepare(`
      SELECT * FROM audit_instances WHERE generation_id = ? ORDER BY id
    `).all(req.params.id);
    res.json({ ...gen, instances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
