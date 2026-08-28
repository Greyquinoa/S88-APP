// src/services/libraryFieldMeta.js — field labels + human-readable diff rendering
// for the Library module (lib_cm_types / lib_blocks / lib_variables).
//
// Keep this isolated per-module: when audit logging extends to other modules,
// add a sibling file (e.g. ioFieldMeta.js) rather than growing this one.
'use strict';

// key = "<table>.<column>" so the same column name in different tables can't collide.
const LIBRARY_FIELD_META = {
  'lib_variables.val':          { label: 'Default value',      type: 'string' },
  'lib_variables.is_valid':     { label: 'Exposed for wiring', type: 'boolean' },
  'lib_blocks.optional':        { label: 'Optional block',     type: 'boolean' },
  'lib_blocks.is_conditional':  { label: 'Conditional block',  type: 'boolean' },
  'lib_cm_types.comment':       { label: 'Comment',            type: 'string' },
  'lib_cm_types.sampling_time': { label: 'Sampling time (ms)', type: 'string' },
};

function displayValue(type, val) {
  if (val === null || val === undefined || val === '') return null;
  if (type === 'boolean') return (val === true || val === 'true' || val === 1 || val === '1') ? 'Yes' : 'No';
  return String(val);
}

// Renders one field's old→new change as a sentence, given "<table>.<column>".
function formatFieldChange(tableField, oldVal, newVal) {
  const meta = LIBRARY_FIELD_META[tableField];
  const label = meta?.label || tableField;
  const type = meta?.type || 'string';

  const oldDisplay = displayValue(type, oldVal);
  const newDisplay = displayValue(type, newVal);

  if (oldDisplay === null && newDisplay !== null) return `${label} set to ${newDisplay}`;
  if (oldDisplay !== null && newDisplay === null) return `${label} cleared (was ${oldDisplay})`;
  if (oldDisplay === null && newDisplay === null) return `${label} unchanged`;
  return `${label} changed from ${oldDisplay} to ${newDisplay}`;
}

// Joins one or more { field, old, new } diffs (field = "<table>.<column>") into
// a single description sentence for the audit_log.description column.
function describeChanges(entityLabel, changes) {
  if (!changes || !changes.length) return `${entityLabel} updated`;
  const sentences = changes.map(c => formatFieldChange(c.field, c.old, c.new));
  return `${entityLabel}: ${sentences.join('; ')}`;
}

// Enriches raw { field, old, new } diffs with label + display strings, for
// storage in audit_log.field_changes so the UI doesn't need to re-derive labels.
function enrichChanges(changes) {
  return changes.map(c => {
    const meta = LIBRARY_FIELD_META[c.field];
    const type = meta?.type || 'string';
    return {
      field: c.field,
      label: meta?.label || c.field,
      old: c.old,
      new: c.new,
      oldDisplay: displayValue(type, c.old),
      newDisplay: displayValue(type, c.new),
    };
  });
}

module.exports = { LIBRARY_FIELD_META, formatFieldChange, describeChanges, enrichChanges };
