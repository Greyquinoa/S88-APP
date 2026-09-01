// src/services/fieldMetaFactory.js — shared label + diff-rendering logic for audit
// field metadata. Each module owns a map of "<table>.<column>" -> { label, type }
// and calls createFieldMeta() with it; the formatting itself lives here so a fix
// to how a change reads applies to every module at once.
//
// See libraryFieldMeta.js and instanceFieldMeta.js for the per-module maps.
'use strict';

// `lookups` resolves a foreign key to something a human can read: a map of
// field key -> Map(rawValue -> displayString). Without it an FK column logs as
// "Controller changed from 3 to 7", which tells the reader nothing.
function displayValue(type, val, fieldKey, lookups) {
  if (val === null || val === undefined || val === '') return null;

  if (type === 'lookup') {
    const table = lookups?.[fieldKey];
    const resolved = table?.get(val) ?? table?.get(String(val)) ?? table?.get(Number(val));
    return resolved ?? String(val);
  }
  if (type === 'boolean') {
    return (val === true || val === 'true' || val === 1 || val === '1') ? 'Yes' : 'No';
  }
  return String(val);
}

function createFieldMeta(FIELD_META) {
  // Renders one field's old→new change as a sentence, given "<table>.<column>".
  function formatFieldChange(tableField, oldVal, newVal, lookups) {
    const meta = FIELD_META[tableField];
    const label = meta?.label || tableField;
    const type = meta?.type || 'string';

    const oldDisplay = displayValue(type, oldVal, tableField, lookups);
    const newDisplay = displayValue(type, newVal, tableField, lookups);

    if (oldDisplay === null && newDisplay !== null) return `${label} set to ${newDisplay}`;
    if (oldDisplay !== null && newDisplay === null) return `${label} cleared (was ${oldDisplay})`;
    if (oldDisplay === null && newDisplay === null) return `${label} unchanged`;
    return `${label} changed from ${oldDisplay} to ${newDisplay}`;
  }

  // Joins one or more { field, old, new } diffs (field = "<table>.<column>") into
  // a single description sentence for the audit_log.description column.
  function describeChanges(entityLabel, changes, lookups) {
    if (!changes || !changes.length) return `${entityLabel} updated`;
    const sentences = changes.map(c => formatFieldChange(c.field, c.old, c.new, lookups));
    return `${entityLabel}: ${sentences.join('; ')}`;
  }

  // Enriches raw { field, old, new } diffs with label + display strings, for
  // storage in audit_log.field_changes so the UI doesn't need to re-derive labels.
  function enrichChanges(changes, lookups) {
    return changes.map(c => {
      const meta = FIELD_META[c.field];
      const type = meta?.type || 'string';
      return {
        field: c.field,
        label: meta?.label || c.field,
        old: c.old,
        new: c.new,
        oldDisplay: displayValue(type, c.old, c.field, lookups),
        newDisplay: displayValue(type, c.new, c.field, lookups),
      };
    });
  }

  return { formatFieldChange, describeChanges, enrichChanges };
}

module.exports = { createFieldMeta, displayValue };
