// services/reconciliationEngine.js — Instance reconciliation logic
'use strict';

/**
 * Compute reconciliation status for a single instance.
 * Pure function for testability.
 */
function computeReconciliationStatus(isImported, isGenerated, previousStatus, wasAccepted = false) {
  if (isImported && isGenerated) return 'OK';
  if (isImported && !isGenerated) return 'IMPORTED_OK';
  if (!isImported && isGenerated) {
    // An acceptance is durable: it must survive a round trip through OK (import
    // appeared, then disappeared again), not just a directly-repeated re-run.
    // wasAccepted reflects accepted_at, which outlives the transient status.
    return (previousStatus === 'DUMMY_ACCEPTED' || wasAccepted) ? 'DUMMY_ACCEPTED' : 'DUMMY';
  }
  return 'ERROR';
}

/**
 * Run reconciliation for all instances in a project.
 * Returns: { countsPerStatus, instancesUpdated, warnings }
 */
async function runReconciliation(db, projectId) {
  const instances = await db.prepare(`
    SELECT id, instance_name, is_imported, is_generated, reconciliation_status, accepted_at, source_unit_instance_id
    FROM project_instances
    WHERE project_id = ?
    ORDER BY id
  `).all(projectId);

  // Check which unit instances still exist (for instances generated from unit types).
  const sourceIds = [...new Set(
    instances
      .filter(i => i.source_unit_instance_id != null)
      .map(i => i.source_unit_instance_id)
  )];
  const existingSources = new Set();
  if (sourceIds.length > 0) {
    const existing = await db.prepare(`
      SELECT id FROM unit_instances WHERE id IN (${sourceIds.map(() => '?').join(',')})
    `).all(...sourceIds);
    existing.forEach(r => existingSources.add(r.id));
  }

  const updates = [];
  const countsPerStatus = {
    OK: 0,
    IMPORTED_OK: 0,
    DUMMY: 0,
    DUMMY_ACCEPTED: 0,
    ERROR: 0,
  };
  const warnings = [];

  for (const inst of instances) {
    // If generated from a unit that no longer exists, warn but don't change status.
    if (inst.source_unit_instance_id != null && !existingSources.has(inst.source_unit_instance_id)) {
      warnings.push(`Instance ${inst.instance_name} (id=${inst.id}): generated from a unit type that no longer exists — left as-is`);
      countsPerStatus[inst.reconciliation_status]++;
      continue;
    }

    const newStatus = computeReconciliationStatus(
      !!inst.is_imported,
      !!inst.is_generated,
      inst.reconciliation_status,
      inst.accepted_at != null
    );

    if (newStatus === 'ERROR') {
      warnings.push(`Instance ${inst.instance_name} (id=${inst.id}): neither is_imported nor is_generated set`);
    }

    updates.push({
      id: inst.id,
      status: newStatus,
    });
    countsPerStatus[newStatus]++;
  }

  // Apply updates in transaction
  await db.transaction(async () => {
    const stmt = db.prepare(`
      UPDATE project_instances
      SET reconciliation_status = ?, last_reconciled_at = NOW()
      WHERE id = ?
    `);
    for (const upd of updates) {
      await stmt.run(upd.status, upd.id);
    }
  })();

  return { countsPerStatus, instancesUpdated: updates.length, warnings };
}

/**
 * Accept a dummy instance (set status to DUMMY_ACCEPTED).
 */
async function acceptDummy(db, instanceId, acceptedBy) {
  const inst = await db.prepare(
    'SELECT id FROM project_instances WHERE id = ? AND reconciliation_status = ?'
  ).get(instanceId, 'DUMMY');
  if (!inst) {
    throw new Error(`Instance ${instanceId} not found or is not in DUMMY status`);
  }

  await db.prepare(`
    UPDATE project_instances
    SET reconciliation_status = 'DUMMY_ACCEPTED', accepted_at = NOW(), accepted_by = ?
    WHERE id = ?
  `).run(acceptedBy || 'system', instanceId);
}

/**
 * Revert a dummy-accepted instance back to DUMMY.
 */
async function revertDummy(db, instanceId) {
  const inst = await db.prepare(
    'SELECT id FROM project_instances WHERE id = ? AND reconciliation_status = ?'
  ).get(instanceId, 'DUMMY_ACCEPTED');
  if (!inst) {
    throw new Error(`Instance ${instanceId} not found or is not in DUMMY_ACCEPTED status`);
  }

  await db.prepare(`
    UPDATE project_instances
    SET reconciliation_status = 'DUMMY', accepted_at = NULL, accepted_by = NULL
    WHERE id = ?
  `).run(instanceId);
}

/**
 * Bulk accept multiple dummy instances.
 */
async function bulkAcceptDummies(db, instanceIds, acceptedBy) {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    throw new Error('instanceIds must be a non-empty array');
  }

  const placeholders = instanceIds.map(() => '?').join(',');
  const dummies = await db.prepare(`
    SELECT id FROM project_instances
    WHERE id IN (${placeholders}) AND reconciliation_status = 'DUMMY'
  `).all(...instanceIds);

  if (dummies.length === 0) {
    throw new Error('No instances in DUMMY status found');
  }

  await db.transaction(async () => {
    const stmt = db.prepare(`
      UPDATE project_instances
      SET reconciliation_status = 'DUMMY_ACCEPTED', accepted_at = NOW(), accepted_by = ?
      WHERE id = ?
    `);
    for (const d of dummies) {
      await stmt.run(acceptedBy || 'system', d.id);
    }
  })();

  return dummies.length;
}

/**
 * Bulk revert multiple dummy-accepted instances.
 */
async function bulkRevertDummies(db, instanceIds) {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    throw new Error('instanceIds must be a non-empty array');
  }

  const placeholders = instanceIds.map(() => '?').join(',');
  const accepted = await db.prepare(`
    SELECT id FROM project_instances
    WHERE id IN (${placeholders}) AND reconciliation_status = 'DUMMY_ACCEPTED'
  `).all(...instanceIds);

  if (accepted.length === 0) {
    throw new Error('No instances in DUMMY_ACCEPTED status found');
  }

  await db.transaction(async () => {
    const stmt = db.prepare(`
      UPDATE project_instances
      SET reconciliation_status = 'DUMMY', accepted_at = NULL, accepted_by = NULL
      WHERE id = ?
    `);
    for (const a of accepted) {
      await stmt.run(a.id);
    }
  })();

  return accepted.length;
}

/**
 * Get reconciliation summary for a project.
 */
async function getReconciliationSummary(db, projectId) {
  const rows = await db.prepare(`
    SELECT reconciliation_status, COUNT(*) as count
    FROM project_instances
    WHERE project_id = ?
    GROUP BY reconciliation_status
  `).all(projectId);

  const summary = {
    OK: 0,
    IMPORTED_OK: 0,
    DUMMY: 0,
    DUMMY_ACCEPTED: 0,
    ERROR: 0,
  };

  for (const row of rows) {
    if (summary.hasOwnProperty(row.reconciliation_status)) {
      summary[row.reconciliation_status] = Number(row.count);
    }
  }

  return summary;
}

/**
 * Get all instances with reconciliation details for a project.
 */
async function getInstancesWithReconciliation(db, projectId, filters = {}) {
  let query = `
    SELECT
      id, cm_type, instance_name, is_imported, is_generated,
      reconciliation_status, accepted_at, accepted_by, last_reconciled_at
    FROM project_instances
    WHERE project_id = ?
  `;
  const params = [projectId];

  if (filters.status) {
    query += ` AND reconciliation_status = ?`;
    params.push(filters.status);
  }

  if (filters.search) {
    query += ` AND instance_name ILIKE ?`;
    params.push(`%${filters.search}%`);
  }

  query += ` ORDER BY id`;

  const rows = await db.prepare(query).all(...params);
  return rows.map(r => ({
    id: r.id,
    cmType: r.cm_type,
    instanceName: r.instance_name,
    isImported: !!r.is_imported,
    isGenerated: !!r.is_generated,
    reconciliationStatus: r.reconciliation_status,
    acceptedAt: r.accepted_at,
    acceptedBy: r.accepted_by,
    lastReconciledAt: r.last_reconciled_at,
  }));
}

module.exports = {
  computeReconciliationStatus,
  runReconciliation,
  acceptDummy,
  revertDummy,
  bulkAcceptDummies,
  bulkRevertDummies,
  getReconciliationSummary,
  getInstancesWithReconciliation,
};
