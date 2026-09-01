// src/services/auditLog.js — generic, module-agnostic audit trail capture.
// Append-only by convention: this file exposes no update/delete function.
// No auth system exists yet, so `changedBy` defaults to DEFAULT_CHANGED_BY —
// swap this for the logged-in user's identity once login is implemented.
'use strict';
const crypto = require('crypto');

const DEFAULT_CHANGED_BY = 'System';

// Compares oldRow vs newRow using only the keys present in fieldMeta.
// Returns [] when nothing tracked actually changed. Untracked fields are ignored.
function diffRow(oldRow, newRow, fieldMeta) {
  const changes = [];
  for (const field of Object.keys(fieldMeta)) {
    if (!(field in newRow)) continue;
    const oldVal = oldRow ? oldRow[field] ?? null : null;
    const newVal = newRow[field] ?? null;
    if (normalize(oldVal) === normalize(newVal)) continue;
    changes.push({ field, old: oldVal, new: newVal });
  }
  return changes;
}

function normalize(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val;
  return String(val);
}

function newBatchId() {
  return crypto.randomUUID();
}

// Inserts one audit_log row. Must be called within the same db.transaction()
// callback as the mutating write it documents, so both commit/rollback together.
async function recordAudit(db, {
  projectId = null,
  batchId = null,
  entityType,
  entityId,
  // Durable string identity, for entities whose row id churns (project_instances
  // is wiped and reinserted on every save). Null for entities keyed by entityId.
  entityKey = null,
  action,
  fieldChanges = null,
  description,
  changedBy = DEFAULT_CHANGED_BY,
  reason = null,
  source,
  location = null,
  objectLabel = null,
  contextCmType = null,
}) {
  if (!entityType || entityId === undefined || entityId === null) {
    throw new Error('recordAudit: entityType and entityId are required');
  }
  if (!action) throw new Error('recordAudit: action is required');
  if (!description) throw new Error('recordAudit: description is required');
  if (!source) throw new Error('recordAudit: source is required');

  await db.prepare(`
    INSERT INTO audit_log
      (project_id, batch_id, entity_type, entity_id, entity_key, action, field_changes, description, changed_by, reason, source, location, object_label, context_cm_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    projectId,
    batchId,
    entityType,
    entityId,
    entityKey,
    action,
    fieldChanges ? JSON.stringify(fieldChanges) : null,
    description,
    changedBy,
    reason,
    source,
    location,
    objectLabel,
    contextCmType,
  );
}

module.exports = { recordAudit, diffRow, newBatchId, DEFAULT_CHANGED_BY };
