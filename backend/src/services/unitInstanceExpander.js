// services/unitInstanceExpander.js — Unit instance expansion with conflict detection
'use strict';

/**
 * Plans unit instance expansion without modifying the database.
 * Returns list of instances that would be created.
 *
 * @param {Database} db
 * @param {number} projectId
 * @returns {Promise<Array<{name: string, cmType: string}>>}
 */
async function planUnitInstanceExpansion(db, projectId) {
  // Required lazily: unitTypes.js is a route module, so a top-level require here
  // would create a cycle through the router's own imports.
  const { loadUnitTypeDetail } = require('../routes/unitTypes');

  const unitInsts = await db.prepare(
    'SELECT * FROM unit_instances WHERE project_id = ? ORDER BY sort_order, id'
  ).all(projectId);

  const plannedInstances = [];
  const projectScopeCreated = new Set();

  // Fallback user project
  const upRows = await db.prepare(
    'SELECT name FROM project_user_projects WHERE project_id = ? ORDER BY sort_order LIMIT 1'
  ).all(projectId);
  const defaultUserProject = upRows[0]?.name || '';

  // Helper: derive instance name for a composite sub-member
  const deriveName = (unitName, alias, cm) => {
    const baseName = cm.scope === 'project' ? alias : `${unitName}_${alias}`;
    return cm.is_primary
      ? baseName
      : `${cm.name_prefix || ''}${baseName}${cm.name_suffix || ''}`;
  };

  for (const ui of unitInsts) {
    const ut = await loadUnitTypeDetail(db, ui.unit_type_id);
    if (!ut) continue;

    const instanceUserProject = (ui.user_project || '').trim() || defaultUserProject;
    // loadUnitTypeDetail returns camelCase members (compositeCmId), not raw rows.
    const compositeMembers = ut.members.filter(m => m.compositeCmId);

    for (const m of compositeMembers) {
      const subMembers = await db.prepare(
        'SELECT * FROM composite_cm_members WHERE composite_id = ? ORDER BY sort_order, id'
      ).all(m.compositeCmId);

      for (const cm of subMembers) {
        const instanceName = deriveName(ui.unit_name, m.alias, cm);

        // Project scope: instantiate once per (User Project, name)
        if (cm.scope === 'project') {
          const key = `${instanceUserProject}::${instanceName}`;
          if (projectScopeCreated.has(key)) continue;
          projectScopeCreated.add(key);
        }

        plannedInstances.push({
          name: instanceName,
          cmType: cm.cm_type_name,
        });
      }
    }
  }

  return plannedInstances;
}

/**
 * Detects conflicts between planned unit instances and existing instances.
 *
 * Scenario 1 (silent update): Instance exists with is_imported=true, is_generated=false
 *   → Just set is_generated=true, no conflict shown
 *
 * Scenario 2 (show conflict): Instance exists with is_imported=true AND is_generated=true
 *   OR instance exists with is_imported=false AND is_generated=true
 *   → Show in conflict modal
 *
 * Scenario 3 (clean): No conflict at all
 *
 * @param {Database} db
 * @param {number} projectId
 * @param {Array<{name: string, cmType: string}>} plannedInstances
 * @returns {Promise<{
 *   conflicts: Array<{name, existingId, incoming: {cmType}, existing: {cmType, id}}>,
 *   silentUpdates: Array<{name, existingId}>,
 *   clean: Array<string>,
 *   summary: {total, conflicts, clean, silentUpdates}
 * }>}
 */
async function detectUnitInstanceConflicts(db, projectId, plannedInstances) {
  const existing = await db.prepare(
    'SELECT id, instance_name, cm_type, is_imported, is_generated FROM project_instances WHERE project_id = ?'
  ).all(projectId);

  const existingMap = new Map(existing.map(r => [r.instance_name, r]));
  const conflicts = [];
  const silentUpdates = [];
  const clean = [];

  const planCounts = new Map();
  for (const p of plannedInstances) {
    planCounts.set(p.name, (planCounts.get(p.name) || 0) + 1);
  }

  const seen = new Set();
  for (const incoming of plannedInstances) {
    if (seen.has(incoming.name)) continue;
    seen.add(incoming.name);

    const existingRow = existingMap.get(incoming.name);
    const repeatsInPlan = planCounts.get(incoming.name) > 1;

    if (existingRow) {
      const isImported = !!existingRow.is_imported;
      const isGenerated = !!existingRow.is_generated;

      // Scenario 1: is_imported=true, is_generated=false → silent update
      if (isImported && !isGenerated) {
        silentUpdates.push({
          name: incoming.name,
          existingId: existingRow.id,
        });
      }
      // Scenario 2: (is_imported=true AND is_generated=true) OR (is_imported=false AND is_generated=true)
      // → show conflict
      else if ((isImported && isGenerated) || (!isImported && isGenerated)) {
        conflicts.push({
          name: incoming.name,
          existingId: existingRow.id,
          incoming: { cmType: incoming.cmType },
          existing: {
            cmType: existingRow.cm_type,
            id: existingRow.id,
          },
          planCount: planCounts.get(incoming.name),
          source: 'existing',
        });
      }
      // Other cases (is_imported=true AND is_generated=false was handled above,
      // is_imported=false AND is_generated=false shouldn't happen in expansion)
      else {
        // Unexpected case, treat as conflict to be safe
        conflicts.push({
          name: incoming.name,
          existingId: existingRow.id,
          incoming: { cmType: incoming.cmType },
          existing: {
            cmType: existingRow.cm_type,
            id: existingRow.id,
          },
          planCount: planCounts.get(incoming.name),
          source: 'existing',
        });
      }
    } else if (repeatsInPlan) {
      // Duplication within the plan itself (two unit instances share unit_name)
      conflicts.push({
        name: incoming.name,
        existingId: null,
        incoming: { cmType: incoming.cmType },
        existing: {
          cmType: incoming.cmType,
          id: null,
        },
        planCount: planCounts.get(incoming.name),
        source: 'plan',
      });
    } else {
      clean.push(incoming.name);
    }
  }

  return {
    conflicts,
    silentUpdates,
    clean,
    summary: {
      total: seen.size,
      conflicts: conflicts.length,
      silentUpdates: silentUpdates.length,
      clean: clean.length,
    },
  };
}

module.exports = {
  planUnitInstanceExpansion,
  detectUnitInstanceConflicts,
};
