// src/services/instanceAudit.js — audit_log capture for project instances.
//
// Wraps the generic recordAudit() so the seven call sites stay one-liners, and
// centralises the two things every instance entry must get right:
//
//   entityKey  instance_name, the only identity that survives a save. POST /api/projects
//              deletes and reinserts every row, so entity_id is a best-effort pointer
//              at the row as it existed when the entry was written, nothing more.
//   lookups    hw_controller_id and folder_id are foreign keys; without a resolver the
//              log reads "Controller changed from 3 to 7".
//
// Every function here MUST be called inside the caller's own db.transaction(), so an
// audit row cannot outlive a rolled-back write (the contract in auditLog.js).
'use strict';
const { recordAudit, diffRow } = require('./auditLog');
const {
  INSTANCE_FIELD_META,
  describeChanges,
  enrichChanges,
} = require('./instanceFieldMeta');

const INSTANCE_ENTITY_TYPE = 'ProjectInstance';

/**
 * Full "Parent/Child/Grandchild" path for one folder, walking parent_id up to the
 * root. A bare folder name ("CM") is ambiguous when the same name exists under
 * different parents — the path is what actually identifies where an instance sits.
 */
function folderPath(id, byId) {
  const segments = [];
  let cur = id;
  let guard = 0; // parent_id cycles shouldn't happen, but never hang on one
  while (cur != null && byId.has(cur) && guard++ < 50) {
    segments.unshift(byId.get(cur).name);
    cur = byId.get(cur).parent_id;
  }
  return segments.join('/');
}

/**
 * Resolve the foreign keys the instance field meta renders as 'lookup'.
 * Build this ONCE per operation and pass it down — not per instance.
 */
async function buildInstanceLookups(db, projectId) {
  const controllers = await db.prepare(
    `SELECT id, T16_Controller_TagName AS tag_name FROM hw_controllers WHERE project_id = ?`
  ).all(projectId);

  const folders = await db.prepare(
    `SELECT id, parent_id, name FROM project_hierarchy_folders WHERE project_id = ?`
  ).all(projectId);
  const foldersById = new Map(folders.map(f => [f.id, f]));

  return {
    'project_instances.hw_controller_id': new Map(
      controllers.map(c => [c.id, c.tag_name || `#${c.id}`])
    ),
    'project_instances.folder_id': new Map(
      folders.map(f => [f.id, folderPath(f.id, foldersById) || f.name])
    ),
  };
}

function labelFor(instance) {
  return `Instance '${instance.instance_name}'`;
}

/**
 * diffRow() keys on "<table>.<column>" so identically-named columns in different
 * tables can't collide, but rows come back from the DB with bare column names.
 * Projects a raw project_instances row (or a client payload item) into that shape.
 *
 * Only the tracked columns are read, so passing a wider row is harmless.
 */
function toDiffShape(row) {
  return {
    'project_instances.cm_type':          row.cm_type ?? null,
    'project_instances.sampling_time':    row.sampling_time ?? null,
    'project_instances.user_project':     row.user_project ?? null,
    'project_instances.hw_controller_id': row.hw_controller_id ?? null,
    'project_instances.folder_id':        row.folder_id ?? null,
  };
}

function commonFields(projectId, instance, { batchId, source, location, changedBy }) {
  return {
    projectId,
    batchId: batchId || null,
    entityType: INSTANCE_ENTITY_TYPE,
    entityId: instance.id ?? 0,
    entityKey: instance.instance_name,
    source,
    location,
    objectLabel: `Instance - ${instance.instance_name}`,
    contextCmType: instance.cm_type || null,
    ...(changedBy ? { changedBy } : {}),
  };
}

async function auditInstanceCreate(db, { projectId, instance, ...opts }) {
  await recordAudit(db, {
    ...commonFields(projectId, instance, opts),
    action: 'CREATE',
    description: `${labelFor(instance)} created`,
  });
}

async function auditInstanceDelete(db, { projectId, instance, ...opts }) {
  await recordAudit(db, {
    ...commonFields(projectId, instance, opts),
    action: 'DELETE',
    description: `${labelFor(instance)} deleted`,
  });
}

function sentenceFor(label, oldDisplay, newDisplay) {
  if (oldDisplay == null && newDisplay != null) return `${label} set to ${newDisplay}`;
  if (oldDisplay != null && newDisplay == null) return `${label} cleared (was ${oldDisplay})`;
  if (oldDisplay == null && newDisplay == null) return `${label} unchanged`;
  return `${label} changed from ${oldDisplay} to ${newDisplay}`;
}

/**
 * Records an UPDATE when a tracked project_instances column changed, an entry
 * in `extraChanges` did, or both — a no-op call (autosave, the pre-save inside
 * "Generate Connections") writes nothing. Returns true if an entry was written.
 *
 * `extraChanges` covers state that isn't a column on project_instances at all —
 * today that's derived parameter values (instance_derived_values), which the
 * field-meta table knows nothing about. Each entry is already display-ready:
 * { field, label, old, new, oldDisplay, newDisplay }.
 */
async function auditInstanceUpdate(db, { projectId, prior, next, lookups, extraChanges = [], ...opts }) {
  const changes = diffRow(toDiffShape(prior), toDiffShape(next), INSTANCE_FIELD_META);
  if (!changes.length && !extraChanges.length) return false;

  const enrichedTracked = enrichChanges(changes, lookups);
  const allChanges = [...enrichedTracked, ...extraChanges];

  const sentences = [
    ...(changes.length ? [describeChanges(labelFor(next), changes, lookups)] : []),
    ...extraChanges.map(c => sentenceFor(c.label, c.oldDisplay, c.newDisplay)),
  ];

  await recordAudit(db, {
    ...commonFields(projectId, { ...next, id: next.id ?? prior.id }, opts),
    action: 'UPDATE',
    fieldChanges: allChanges,
    description: sentences.join('; '),
  });
  return true;
}

module.exports = {
  INSTANCE_ENTITY_TYPE,
  buildInstanceLookups,
  folderPath,
  toDiffShape,
  auditInstanceCreate,
  auditInstanceDelete,
  auditInstanceUpdate,
};
