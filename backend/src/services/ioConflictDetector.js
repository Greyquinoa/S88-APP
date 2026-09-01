'use strict';
const { computePromotionPlan } = require('./hierarchyBuilder');
const { newBatchId } = require('./auditLog');
const {
  buildInstanceLookups, auditInstanceCreate, auditInstanceUpdate,
} = require('./instanceAudit');

// ── Derived-value helpers (mirrors derivedValues.js logic) ───────────────────

function parseDerivedSpec(conn) {
  if (conn.conn_type !== 'value' || !conn.static_value) return null;
  try {
    const p = JSON.parse(conn.static_value);
    if (p && p.mode === 'derived') return { column: p.column || '', prefix: p.prefix || '', suffix: p.suffix || '' };
  } catch (_) {}
  return null;
}

/**
 * Build the io_tag symbol index for a specific import (same logic as resolveDerivedValues).
 * Returns Map<symbolLower, { id, raw }>
 */
async function buildIoTagIndex(db, importId) {
  const ioMap = new Map();
  const rows = await db.prepare(
    `SELECT id, instrument_tag, tag_name, raw_data FROM io_tags WHERE import_id = ?`
  ).all(importId);
  for (const r of rows) {
    let raw = {};
    try { raw = JSON.parse(r.raw_data || '{}'); } catch (_) {}
    const symbol = (raw['Tag'] || r.instrument_tag || r.tag_name || '').toString().trim();
    const key = symbol.toLowerCase();
    if (!key || ioMap.has(key)) continue;
    ioMap.set(key, { id: r.id, raw });
  }
  return ioMap;
}

/**
 * Compute what derived values each planned instance would get from the import's io_tags.
 * Returns Map<instanceName, [{toVarName, value, status, ioTagId}]>
 *
 * Only covers instances that have a compositeId (raw CM types have no derived connections).
 * Mirrors the resolution logic in resolveDerivedValues.js.
 */
async function computePlannedDerivedValues(db, importId, plannedInstances) {
  const ioMap = await buildIoTagIndex(db, importId);

  // Composite connections cache
  const connsCache = new Map();
  async function connsFor(compositeId) {
    if (!connsCache.has(compositeId)) {
      connsCache.set(compositeId, await db.prepare(
        'SELECT * FROM composite_cm_connections WHERE composite_id = ?'
      ).all(compositeId));
    }
    return connsCache.get(compositeId);
  }

  const result = new Map(); // instanceName → [{toVarName, value, status, ioTagId}]

  for (const planned of plannedInstances) {
    if (planned.compositeId === null || planned.memberIdx === null) continue;

    const conns = await connsFor(planned.compositeId);
    const entries = [];

    for (const c of conns) {
      if (c.to_member_idx !== planned.memberIdx || !c.to_var_name) continue;
      const spec = parseDerivedSpec(c);
      if (!spec) continue;

      const symbolName = `${spec.prefix}${planned.instanceName}${spec.suffix}`;
      const match = ioMap.get(symbolName.toLowerCase());
      const value = match ? (match.raw[spec.column] ?? null) : null;
      const valueStr = value != null ? String(value) : null;

      entries.push({
        toVarName: c.to_var_name,
        value: valueStr,
        status: match ? 'resolved' : 'unresolved',
        ioTagId: match ? match.id : null,
      });
    }

    if (entries.length > 0) {
      result.set(planned.instanceName, entries);
    }
  }

  return result;
}

// ── Instance-level field comparison ──────────────────────────────────────────

function computeInstanceChanges(planned, existing) {
  const changes = [];

  if (existing.cm_type !== planned.cmType) {
    changes.push({ field: 'cm_type', oldValue: existing.cm_type, newValue: planned.cmType });
  }

  if ((existing.hw_controller_id ?? null) !== (planned.hwControllerId ?? null)) {
    changes.push({
      field: 'hw_controller_id',
      oldValue: existing.controller_tag_name || '(unassigned)',
      newValue: planned.hwControllerTagName || '(unassigned)',
    });
  }

  // Note: `connections` (IO wiring rules) comes from the composite CM type definition,
  // not from the IO import data. Changes there belong to the reconciliation flow, not here.

  return changes;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect conflicts between what an IO import would create and existing project instances.
 * Checks both project_instances columns AND instance_derived_values (parameter values).
 * Read-only — makes no DB writes.
 */
async function detectIOConflicts(db, importId, projectId) {
  const plannedInstances = await computePromotionPlan(db, importId, projectId);

  const existingRows = await db.prepare(`
    SELECT pi.id, pi.instance_name, pi.cm_type, pi.hw_controller_id,
           pi.connections, hc.T16_Controller_TagName AS controller_tag_name
    FROM project_instances pi
    LEFT JOIN hw_controllers hc ON hc.id = pi.hw_controller_id
    WHERE pi.project_id = ?
  `).all(projectId);
  const existingMap = new Map(existingRows.map(r => [r.instance_name, r]));

  // Classify by instance-level fields first
  let unchanged = 0;
  const conflicts = [];       // [{instanceName, cmType, tagNodeName, changes}]
  const newInstances = [];
  const seen = new Set();
  const plannedByName = new Map();

  for (const planned of plannedInstances) {
    const name = planned.instanceName;
    if (seen.has(name)) continue;
    seen.add(name);
    plannedByName.set(name, planned);

    const existing = existingMap.get(name);
    if (!existing) {
      newInstances.push({ instanceName: name, cmType: planned.cmType, tagNodeName: planned.tagNodeName });
      continue;
    }

    const changes = computeInstanceChanges(planned, existing);
    if (changes.length === 0) {
      unchanged++;
    } else {
      conflicts.push({ instanceName: name, cmType: planned.cmType, tagNodeName: planned.tagNodeName, changes });
    }
  }

  // ── Derived value comparison (parameter values from io_tags.raw_data) ──────
  const plannedDerived = await computePlannedDerivedValues(db, importId, plannedInstances);

  // Only compare rows where no manual override is set (override_value takes precedence)
  const existingDerivedRows = await db.prepare(`
    SELECT instance_name, to_var_name, value
    FROM instance_derived_values
    WHERE project_id = ? AND override_value IS NULL AND value IS NOT NULL
  `).all(projectId);

  const existingDerivedMap = new Map(); // instanceName → Map<toVarName, value>
  for (const r of existingDerivedRows) {
    if (!existingDerivedMap.has(r.instance_name)) existingDerivedMap.set(r.instance_name, new Map());
    existingDerivedMap.get(r.instance_name).set(r.to_var_name, r.value);
  }

  const unchangedToRemove = new Set();

  for (const [instanceName, plannedValues] of plannedDerived) {
    if (!existingMap.has(instanceName)) continue; // new instance — skip

    const existingValues = existingDerivedMap.get(instanceName);
    if (!existingValues || existingValues.size === 0) continue; // never resolved before — skip

    const derivedChanges = [];
    for (const { toVarName, value: newValue } of plannedValues) {
      if (!existingValues.has(toVarName)) continue; // new parameter — skip
      const oldValue = existingValues.get(toVarName);
      if (oldValue === null || newValue === null) continue;
      if (String(oldValue) !== String(newValue)) {
        derivedChanges.push({
          field: `derived:${toVarName}`,
          oldValue: String(oldValue),
          newValue: String(newValue),
        });
      }
    }

    if (derivedChanges.length === 0) continue;

    const existingConflict = conflicts.find(c => c.instanceName === instanceName);
    if (existingConflict) {
      existingConflict.changes.push(...derivedChanges);
    } else {
      // Was counted as unchanged by instance fields — promote to conflict
      unchangedToRemove.add(instanceName);
      const planned = plannedByName.get(instanceName);
      conflicts.push({
        instanceName,
        cmType: planned?.cmType || '',
        tagNodeName: planned?.tagNodeName || '',
        changes: derivedChanges,
      });
    }
  }

  unchanged -= unchangedToRemove.size;

  return {
    unchanged,
    conflicts,
    newInstances,
    summary: {
      total: seen.size,
      unchanged,
      conflicts: conflicts.length,
      newInstances: newInstances.length,
    },
  };
}

/**
 * Promote the import, applying every change the detect pass found.
 *
 * The modal is a preview, not a picker: the user either applies the whole set or
 * cancels and nothing is written. So this takes no per-field resolutions — it
 * creates the new instances and brings the existing ones in line with the import.
 */
async function applyIOPromotion(db, importId, projectId) {
  const plannedInstances = await computePromotionPlan(db, importId, projectId);

  const existingRows = await db.prepare(`
    SELECT pi.id, pi.instance_name, pi.cm_type, pi.hw_controller_id,
           pi.connections, hc.T16_Controller_TagName AS controller_tag_name
    FROM project_instances pi
    LEFT JOIN hw_controllers hc ON hc.id = pi.hw_controller_id
    WHERE pi.project_id = ?
  `).all(projectId);
  const existingMap = new Map(existingRows.map(r => [r.instance_name, r]));

  const plannedDerived = await computePlannedDerivedValues(db, importId, plannedInstances);

  const controllerRows = await db.prepare(
    `SELECT id, T16_Controller_TagName AS tag_name, user_project
       FROM hw_controllers WHERE project_id = ?`
  ).all(projectId);

  let foldersCreated = 0, created = 0, updated = 0, unchanged = 0;

  // One batch id for the whole promote, so the log can show it as one operation.
  const auditBatchId = newBatchId();
  const auditOpts = { batchId: auditBatchId, source: 'import', location: 'IO Import > Review' };

  const result = await db.transaction(async () => {
    const auditLookups = await buildInstanceLookups(db, projectId);
    // ── Folder creation ───────────────────────────────────────────────────────
    const nodes = await db.prepare(`
      SELECT * FROM io_hierarchy_nodes WHERE import_id = ? ORDER BY sort_order, id
    `).all(importId);

    const nodeToFolderId = {};
    const maxSO = (await db.prepare(
      'SELECT MAX(sort_order) AS m FROM project_hierarchy_folders WHERE project_id=?'
    ).get(projectId))?.m || 0;
    let folSO = maxSO + 1;

    const folderPathCache = new Map();
    const ensureFolderPath = async (parentId, folderPath) => {
      if (!folderPath) return parentId;
      const segs = (folderPath || '').split('/').map(s => s.trim()).filter(Boolean);
      let cur = parentId;
      for (const seg of segs) {
        const key = `${cur ?? 'root'}::${seg}`;
        if (folderPathCache.has(key)) {
          cur = folderPathCache.get(key);
        } else {
          const ex = await db.prepare(`
            SELECT id FROM project_hierarchy_folders
            WHERE project_id=? AND parent_id IS NOT DISTINCT FROM ? AND name=?
          `).get(projectId, cur, seg);
          if (ex) {
            cur = ex.id;
          } else {
            const row = await db.prepare(`
              INSERT INTO project_hierarchy_folders
                (project_id, parent_id, name, s88_type, sort_order)
              VALUES (?,?,?,?,?)
            `).run(projectId, cur, seg, null, folSO++);
            cur = row.lastInsertRowid;
            foldersCreated++;
          }
          folderPathCache.set(key, cur);
        }
      }
      return cur;
    };

    const folderNodes = nodes.filter(n => n.level !== 'ControlModule');
    for (const node of folderNodes) {
      const parentFolderId = node.parent_id ? (nodeToFolderId[node.parent_id] ?? null) : null;
      const ex = await db.prepare(`
        SELECT id FROM project_hierarchy_folders
        WHERE project_id=? AND name=? AND (parent_id IS NOT DISTINCT FROM ? OR parent_id = ?)
      `).get(projectId, node.name, parentFolderId, parentFolderId);
      if (ex) {
        nodeToFolderId[node.id] = ex.id;
      } else {
        const row = await db.prepare(`
          INSERT INTO project_hierarchy_folders
            (project_id, parent_id, name, s88_type, sort_order)
          VALUES (?,?,?,?,?)
        `).run(projectId, parentFolderId, node.name, node.s88_type || null, folSO++);
        nodeToFolderId[node.id] = row.lastInsertRowid;
        foldersCreated++;
      }
      await db.prepare(
        'UPDATE io_hierarchy_nodes SET promoted=true, promoted_folder_id=? WHERE id=?'
      ).run(nodeToFolderId[node.id], node.id);
    }

    // ── Composite member subfolder helper ─────────────────────────────────────
    const compositeCache = new Map();
    async function getCompositeMembers(compositeId) {
      if (compositeCache.has(compositeId)) return compositeCache.get(compositeId);
      const members = await db.prepare(
        'SELECT * FROM composite_cm_members WHERE composite_id=? ORDER BY sort_order, id'
      ).all(compositeId);
      compositeCache.set(compositeId, members);
      return members;
    }

    const maxInstSO = (await db.prepare(
      'SELECT MAX(sort_order) AS m FROM project_instances WHERE project_id=?'
    ).get(projectId))?.m || 0;
    let instSO = maxInstSO + 1;

    const seen = new Set();
    const groupMap = new Map();
    let groupCounter = instSO * 1000;

    for (const planned of plannedInstances) {
      const name = planned.instanceName;
      if (seen.has(name)) continue;
      seen.add(name);

      const existing = existingMap.get(name);

      if (!existing) {
        // ── New instance: INSERT ──────────────────────────────────────────────
        const baseFolderId = planned.parentNodeId
          ? (nodeToFolderId[planned.parentNodeId] ?? null)
          : null;

        let memberFolderId = baseFolderId;
        if (planned.compositeId && planned.memberIdx !== null) {
          const members = await getCompositeMembers(planned.compositeId);
          const member = members[planned.memberIdx];
          if (member?.hierarchy_folder) {
            memberFolderId = await ensureFolderPath(baseFolderId, member.hierarchy_folder);
          }
        }

        let groupId = null;
        if (planned.compositeId) {
          if (!groupMap.has(planned.tagNodeName)) groupMap.set(planned.tagNodeName, ++groupCounter);
          groupId = groupMap.get(planned.tagNodeName);
        }

        const ctrl = controllerRows.find(c => c.id === planned.hwControllerId);
        const userProject = ctrl?.user_project || '';

        if (planned.compositeId !== null) {
          await db.prepare(`
            INSERT INTO project_instances
              (project_id, cm_type, instance_name, sampling_time, user_project, hw_controller_id,
               folder_id, sort_order, composite_group_id, composite_id, member_idx, source, connections, is_imported)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            projectId, planned.cmType, name, '1000', userProject,
            planned.hwControllerId, memberFolderId, instSO++,
            groupId, planned.compositeId, planned.memberIdx,
            'imported', JSON.stringify(planned.connections), true
          );
        } else {
          await db.prepare(`
            INSERT INTO project_instances
              (project_id, cm_type, instance_name, sampling_time, user_project, hw_controller_id,
               folder_id, sort_order, source, connections, is_imported)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            projectId, planned.cmType, name, '1000', userProject,
            planned.hwControllerId, baseFolderId, instSO++,
            'imported', JSON.stringify([]), true
          );
        }
        created++;
        await auditInstanceCreate(db, {
          projectId,
          instance: { instance_name: name, cm_type: planned.cmType },
          ...auditOpts,
        });
      } else {
        // ── Existing instance: bring it in line with the import ───────────────
        const changes = computeInstanceChanges(planned, existing);

        const setClauses = ['is_imported = true'];
        const params = [];

        for (const c of changes) {
          if (c.field === 'cm_type') {
            // The stored reconciliation was computed for the old type — force a re-run.
            setClauses.push('cm_type = ?', "reconciliation_status = 'PENDING'");
            params.push(planned.cmType);
          } else if (c.field === 'hw_controller_id') {
            setClauses.push('hw_controller_id = ?');
            params.push(planned.hwControllerId);
          }
        }

        params.push(projectId, name);
        await db.prepare(
          `UPDATE project_instances SET ${setClauses.join(', ')} WHERE project_id = ? AND instance_name = ?`
        ).run(...params);

        // Derived parameter values — write the import's value over the stored one.
        // Rows carrying a manual override are left alone: an override is a deliberate
        // pin that the IO list is not allowed to overwrite. The old value is read
        // first because it's about to be overwritten and the audit entry needs it.
        const derivedChanges = [];
        for (const entry of (plannedDerived.get(name) || [])) {
          if (entry.value === null) continue;

          const priorRow = await db.prepare(`
            SELECT value FROM instance_derived_values
            WHERE project_id = ? AND instance_name = ? AND to_var_name = ?
              AND override_value IS NULL
          `).get(projectId, name, entry.toVarName);
          if (!priorRow || priorRow.value === entry.value) continue;

          const res = await db.prepare(`
            UPDATE instance_derived_values
            SET value = ?, status = ?, io_tag_id = ?
            WHERE project_id = ? AND instance_name = ? AND to_var_name = ?
              AND override_value IS NULL
          `).run(entry.value, entry.status, entry.ioTagId, projectId, name, entry.toVarName);

          if (res?.rowCount) {
            derivedChanges.push({
              field: `derived:${entry.toVarName}`,
              label: entry.toVarName,
              old: priorRow.value,
              new: entry.value,
              oldDisplay: priorRow.value,
              newDisplay: entry.value,
            });
          }
        }

        if (changes.length > 0 || derivedChanges.length > 0) {
          updated++;
          await auditInstanceUpdate(db, {
            projectId,
            prior: existing,
            next: {
              ...existing,
              instance_name:    name,
              cm_type:          planned.cmType,
              hw_controller_id: planned.hwControllerId,
            },
            lookups: auditLookups,
            extraChanges: derivedChanges,
            ...auditOpts,
          });
        } else {
          unchanged++;
        }
      }
    }

    await db.prepare(`UPDATE io_imports SET status='promoted' WHERE id=?`).run(importId);

    return { created, updated, unchanged, folders: foldersCreated, unmatchedAs: [] };
  })();

  return result;
}

module.exports = { detectIOConflicts, applyIOPromotion };
