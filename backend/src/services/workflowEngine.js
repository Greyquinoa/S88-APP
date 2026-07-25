// services/workflowEngine.js — Automated IO workflow orchestration
'use strict';
const { buildHierarchy } = require('./hierarchyBuilder');
const { runAssignment } = require('./assignmentEngine');
const { promoteToProject } = require('./hierarchyBuilder');
const { generateXML } = require('../xmlGenerator');
const { loadMappingsForProject } = require('../signalMappings');
const { loadConnectionIOsForProject, reconcileConnections } = require('../connections');
const { resolveDerivedValues } = require('../derivedValues');
const { autoSyncHardware, generateCfgForWorkflow } = require('./hardwareAutoSync');

async function executeWorkflow(db, { importId, projectId, functionMapId }, onProgress) {
  const report = (pct, phase, msg) => { if (onProgress) onProgress({ pct, phase, msg }); };

  return await db.transaction(async () => {
    // ── GATE 1: Column Mapping Completeness ─────────────────────────────────────
    report(1, 'validation', 'Checking column mapping…');
    const imp = await db.prepare('SELECT column_map_id, source_column_map_id FROM io_imports WHERE id = ?').get(importId);
    if (!imp?.column_map_id) throw new Error('Column mapping not applied — apply a valid column map first');

    const cm = await db.prepare('SELECT mappings FROM io_column_mappings WHERE id = ?').get(imp.column_map_id);
    if (!cm) throw new Error('Column map not found');
    let parsed = {};
    try { parsed = JSON.parse(cm.mappings || '{}'); } catch (_) {}

    // Stored shape is { customerColumn: internalField, ... } (see columnMapper.js
    // applyMapping/suggestMappings and UnifiedColumnMappingScreen.saveConfig) —
    // the internal field name is a VALUE, not a key. Unified configs additionally
    // nest this under `.instance` alongside a sibling `.hardware` map.
    const mappings = parsed.instance || parsed;
    const mappedFields = new Set(Object.values(mappings));

    // column_map_id gets overwritten with a transient instance-only config by the
    // "Import Instances" step (see io.js handleImportInstances / apply-column-map),
    // which has no .hardware sibling. source_column_map_id preserves the user's
    // originally-picked config (e.g. "ProjMap") across that overwrite — read the
    // hardware mapping from there instead.
    let hardwareColumnMap = parsed.hardware || null;
    if (!hardwareColumnMap && imp.source_column_map_id && imp.source_column_map_id !== imp.column_map_id) {
      const sourceCm = await db.prepare('SELECT mappings FROM io_column_mappings WHERE id = ?').get(imp.source_column_map_id);
      if (sourceCm) {
        let sourceParsed = {};
        try { sourceParsed = JSON.parse(sourceCm.mappings || '{}'); } catch (_) {}
        hardwareColumnMap = sourceParsed.hardware || null;
      }
    }

    if (!mappedFields.has('instrument_tag')) throw new Error('Mandatory column "instrument_tag" not mapped');
    if (!mappedFields.has('function_val')) throw new Error('Mandatory column "function_val" not mapped');
    if (!mappedFields.has('hierarchy')) throw new Error('Mandatory column "hierarchy" not mapped');

    // ── GATE 2: Hierarchy Integrity ─────────────────────────────────────────────
    report(3, 'validation', 'Checking hierarchy integrity…');
    const nodes = await db.prepare('SELECT * FROM io_hierarchy_nodes WHERE import_id = ?').all(importId);
    if (!nodes?.length) throw new Error('Hierarchy not built — run "Build Hierarchy" first');

    const nodeIds = new Set(nodes.map(n => n.id));
    const parents = nodes.map(n => n.parent_id).filter(Boolean);
    for (const pid of parents) {
      if (!nodeIds.has(pid)) throw new Error(`Orphaned node reference: parent_id ${pid} missing`);
    }

    // ── RUN ASSIGNMENT ───────────────────────────────────────────────────────────
    // Component 3 of the pipeline: resolve each tag's CM type from function_val
    // using the selected function-mapping config, before Gate 3 checks coverage.
    // Respects manual_override/approved rows (runAssignment skips them) so re-running
    // the workflow never clobbers a human decision.
    if (!functionMapId) throw new Error('No function mapping selected — select one before running the workflow');
    report(4, 'validation', 'Running CM type assignment…');
    const assignmentReport = await runAssignment(db, importId, functionMapId);
    report(5, 'validation',
      `Assignment: ${assignmentReport.auto} auto, ${assignmentReport.unresolved} unresolved, ${assignmentReport.skipped} skipped (manual)`);

    // ── GATE 3: CM Assignment Coverage ──────────────────────────────────────────
    report(5, 'validation', 'Checking CM type assignments…');
    const unresolved = await db.prepare(
      'SELECT COUNT(*) AS n FROM io_tags WHERE import_id = ? AND validation_status != ?'
        + ' AND assignment_status IN (?,?)'
    ).get(importId, 'error', 'pending', 'unresolved');
    if (Number(unresolved.n) > 0) {
      throw new Error(`${unresolved.n} rows with unresolved CM types — resolve all before workflow`);
    }

    // ── GATE 4: State Consistency ───────────────────────────────────────────────
    report(7, 'validation', 'Checking projectate consistency…');
    const project = await db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('Project not found');

    // Get list of instance names that will be created
    const approvedTags = await db.prepare(`
      SELECT COALESCE(t.instrument_tag, t.tag_name) AS identity
      FROM io_tags t
      WHERE t.import_id = ? AND t.assignment_status IN (?,?,?)
        AND t.assigned_cm_type IS NOT NULL AND t.validation_status != ?
      GROUP BY identity
    `).all(importId, 'auto', 'manual_override', 'approved', 'error');

    const incomingNames = approvedTags.map(t => t.identity);
    if (incomingNames.length === 0) throw new Error('No valid assignments to promote');

    const existing = await db.prepare(
      'SELECT instance_name FROM project_instances WHERE project_id = ?'
    ).all(projectId);
    const existingSet = new Set(existing.map(r => r.instance_name));
    for (const name of incomingNames) {
      if (existingSet.has(name)) throw new Error(`Instance "${name}" already exists in project — remove or rename first`);
    }

    // ── PHASE 1: PROMOTION (10–30%) ─────────────────────────────────────────────
    report(10, 'promoting', 'Promoting IO hierarchy to project…');
    const promotionResult = await promoteToProject(db, importId, projectId);
    report(20, 'promoting', `Created ${promotionResult.folders} folders, ${promotionResult.instances} instances`);

    // ── GATE 5: Pre-Generation Validation ───────────────────────────────────────
    report(25, 'promoting', 'Verifying instances were created…');
    const instanceCount = await db.prepare(
      'SELECT COUNT(*) AS n FROM project_instances WHERE project_id = ?'
    ).get(projectId);
    if (Number(instanceCount.n) === 0) throw new Error('No instances were created during promotion');

    // Load instances for generation
    const proj = await db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
    const instances = await db.prepare(`
      SELECT id, cm_type, instance_name, sampling_time, user_project, folder_id,
             composite_group_id, composite_id, member_idx
      FROM project_instances
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(projectId);
    report(30, 'promoting', 'Loaded instances for generation');

    // ── PHASE 1b: HARDWARE SYNC + CFG GENERATION (30–40%) ───────────────────────
    // Optional — only runs if the project has a hardware import AND the column map
    // has a hardware mapping configured. Auto-imports New signals only; Modified and
    // Missing rows vs. the existing hw_signals are skipped and logged, never
    // overwritten or deleted (see hardwareAutoSync.js for the full rationale).
    let hwLog = null;
    let cfgResult = null;
    report(32, 'hardware', 'Checking for hardware configuration…');
    const hwImport = await db.prepare(
      'SELECT id FROM hw_imports WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(projectId);

    if (!hwImport) {
      report(38, 'hardware', 'No hardware import found for this project — skipping hardware sync');
    } else if (!hardwareColumnMap || Object.keys(hardwareColumnMap).length === 0) {
      report(38, 'hardware', 'No hardware column mapping configured — skipping hardware sync');
    } else {
      report(33, 'hardware', 'Syncing hardware signals (new rows only)…');
      const syncResult = await autoSyncHardware(db, {
        hwImportId: hwImport.id,
        ioImportId: importId,
        columnMap: hardwareColumnMap,
      });
      hwLog = syncResult.log;
      report(36, 'hardware',
        `Hardware sync: ${hwLog.imported} imported, ${hwLog.skippedModified.length} modified skipped, ${hwLog.skippedMissing.length} missing skipped`);

      report(38, 'hardware', 'Generating hardware CFG…');
      cfgResult = await generateCfgForWorkflow(db, hwImport.id);
      report(40, 'hardware', 'Hardware CFG generated');
    }

    // ── PHASE 1c: GENERATE CONNECTIONS (Component 3) ────────────────────────────
    // Reconcile each CM instance's dummy IO signal names against hw_signals.tag,
    // materializing the result into instance_ios (status='real' + hw_signal_id, or
    // 'dummy'). Idempotent/full-rebuild — same call the manual "Generate Connections"
    // button makes (routes/connections.js). Must run before XML generation reads
    // connections back via loadConnectionIOsForProject(), and after hardware sync so
    // newly-imported signals are available to match against.
    let connectionsResult = null;
    let derivedValuesResult = null;
    report(41, 'hardware', 'Generating connections (matching dummy IOs to hardware)…');
    connectionsResult = await reconcileConnections(db, projectId);
    derivedValuesResult = await resolveDerivedValues(db, projectId);
    report(42, 'hardware',
      `Connections: ${connectionsResult.real} real, ${connectionsResult.dummy} dummy` +
      (connectionsResult.conflicts?.length ? `, ${connectionsResult.conflicts.length} conflicts` : ''));

    // ── PHASE 2: XML GENERATION (42–95%) ────────────────────────────────────────
    report(43, 'resolving', 'Resolving CM types and signal mappings…');

    let hierarchy = [];
    let projectConfig = null;
    let signalMaps = {};
    hierarchy = await db.prepare(`
      SELECT id, parent_id, name, s88_type, sort_order
      FROM project_hierarchy_folders
      WHERE project_id = ?
      ORDER BY sort_order, id
    `).all(projectId);
    projectConfig = (await db.prepare('SELECT * FROM project_config WHERE project_id = ?').get(projectId)) || null;
    signalMaps = await loadMappingsForProject(db, projectId);

    const connIOs = await loadConnectionIOsForProject(db, projectId);
    for (const [instName, pins] of Object.entries(connIOs)) {
      const bucket = (signalMaps[instName] ||= {});
      for (const [key, entry] of Object.entries(pins)) {
        if (bucket[key]) {
          if (entry.ioAddress && !bucket[key].ioAddress) {
            bucket[key].ioAddress = entry.ioAddress;
            bucket[key].comment = entry.comment || bucket[key].comment || null;
          }
          continue;
        }
        bucket[key] = entry;
      }
    }

    const connRows = await db.prepare(
      'SELECT instance_name, connections FROM project_instances WHERE project_id = ?'
    ).all(projectId);
    for (const row of connRows) {
      let conns = [];
      try { conns = JSON.parse(row.connections || '[]'); } catch { conns = []; }
      if (!Array.isArray(conns) || !conns.length) continue;
      const instName = row.instance_name;
      for (const c of conns) {
        if (!c.target_block || !c.target_pin) continue;
        const key = `${c.target_block}.${c.target_pin}`;
        const bucket = (signalMaps[instName] ||= {});
        if (bucket[key]) continue;
        bucket[key] = {
          tag:        `${c.prefix || ''}${instName}${c.suffix || ''}`,
          varDtype:   null,
          signalType: c.signal_type || null,
          dummy:      true,
          required:   (c.required === 0 || c.required === false) ? 0 : 1,
        };
      }
    }

    // Build connection groups for composite wiring
    const getCmType = db.prepare('SELECT * FROM lib_cm_types WHERE name = ?');
    const getBlocks = db.prepare(`
      SELECT b.*, STRING_AGG(DISTINCT v.lib_id, ',') AS var_lib_ids
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
    const getMsgs = db.prepare('SELECT * FROM lib_messages WHERE block_id = ? ORDER BY sort_order');
    const getRoles = db.prepare('SELECT role, role_kind FROM lib_em_roles WHERE cm_type_id = ? ORDER BY sort_order');

    const cmCache = new Map();
    async function resolveInstance(inst) {
      let resolved = cmCache.get(inst.cm_type);
      if (!resolved) {
        const cmRow = await getCmType.get(inst.cm_type);
        if (!cmRow) throw new Error(`CM type not found: ${inst.cm_type}`);
        const blockRows = await getBlocks.all(cmRow.id);
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
        const roleRows = await getRoles.all(cmRow.id);
        const roles = roleRows.map(r => r.role);
        const roleKindMap = {};
        for (const r of roleRows) roleKindMap[r.role] = r.role_kind || 'cm';
        resolved = { cmRow, blocks, roles, roleKindMap };
        cmCache.set(inst.cm_type, resolved);
      }
      const { cmRow, blocks, roles, roleKindMap } = resolved;
      return {
        cmTypeDef: {
          name:         cmRow.name,
          comment:      cmRow.comment,
          samplingTime: cmRow.sampling_time,
          subBlocks:    blocks,
          roles,
          roleKindMap,
        },
        libType:        cmRow.cm_type,
        instanceName:   inst.instance_name,
        enabledBlocks:  inst.enabled_blocks || [],
        samplingTime:   inst.sampling_time || cmRow.sampling_time || '1000',
        roleAssignments: inst.role_assignments || {},
      };
    }

    const instDefs = [];
    for (let i = 0; i < instances.length; i++) {
      instDefs.push(await resolveInstance(instances[i]));
      const pct = 42 + Math.round(((i + 1) / instances.length) * 43);
      if ((i + 1) % Math.max(1, Math.floor(instances.length / 10)) === 0 || i === instances.length - 1) {
        report(pct, 'resolving', `Resolved ${i + 1}/${instances.length} instances`);
      }
    }

    // Build connection groups (simplified — no composites here)
    const connGroups = [];
    const resolved = await db.prepare(
      'SELECT from_instance, from_var_name, to_instance, to_var_name, conn_type, static_value'
      + ' FROM unit_resolved_connections WHERE project_id = ? ORDER BY sort_order, id'
    ).all(projectId);
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

    // Generate XML
    report(88, 'building', 'Building XML…');
    const { xml, stats } = generateXML(instDefs, proj.name, hierarchy, {}, projectConfig, connGroups, signalMaps);

    // ── PHASE 3: FINALIZATION (95–100%) ────────────────────────────────────────
    report(95, 'finalizing', 'Saving audit trail…');
    const genRow = await db.prepare(`
      INSERT INTO audit_generations
        (project_name, generated_by, instance_count, block_count, var_count, msg_count, link_count, xml_size_kb)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      proj.name,
      process.env.USERNAME || 'workflow',
      instances.length,
      stats.blocks,
      stats.vars,
      stats.msgs,
      stats.links,
      stats.sizeKb,
    );
    const genId = genRow.lastInsertRowid;

    const insInst = db.prepare(
      'INSERT INTO audit_instances (generation_id, cm_type, instance_name, sampling_time, enabled_blocks) VALUES (?,?,?,?,?)'
    );
    for (const inst of instances) {
      await insInst.run(genId, inst.cm_type, inst.instance_name, inst.sampling_time || '1000', '[]');
    }

    report(100, 'finalizing', 'Workflow complete!');
    return {
      success: true,
      xml,
      stats,
      auditId: genId,
      hwLog,
      cfg: cfgResult ? { text: cfgResult.cfgText, stats: cfgResult.stats, warnings: cfgResult.warnings } : null,
      connections: connectionsResult,
      derivedValues: derivedValuesResult,
    };
  })();
}

module.exports = { executeWorkflow };
