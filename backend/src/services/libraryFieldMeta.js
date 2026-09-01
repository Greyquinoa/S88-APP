// src/services/libraryFieldMeta.js — field labels + human-readable diff rendering
// for the Library module (lib_cm_types / lib_blocks / lib_variables).
//
// Keep this isolated per-module: when audit logging extends to other modules,
// add a sibling file (e.g. instanceFieldMeta.js) rather than growing this one.
// The formatting itself lives in fieldMetaFactory.js so every module renders a
// change the same way.
'use strict';
const { createFieldMeta } = require('./fieldMetaFactory');

// key = "<table>.<column>" so the same column name in different tables can't collide.
const LIBRARY_FIELD_META = {
  'lib_variables.val':          { label: 'Default value',      type: 'string' },
  'lib_variables.is_valid':     { label: 'Exposed for wiring', type: 'boolean' },
  'lib_blocks.optional':        { label: 'Optional block',     type: 'boolean' },
  'lib_blocks.is_conditional':  { label: 'Conditional block',  type: 'boolean' },
  'lib_cm_types.comment':       { label: 'Comment',            type: 'string' },
  'lib_cm_types.sampling_time': { label: 'Sampling time (ms)', type: 'string' },
};

const { formatFieldChange, describeChanges, enrichChanges } = createFieldMeta(LIBRARY_FIELD_META);

module.exports = { LIBRARY_FIELD_META, formatFieldChange, describeChanges, enrichChanges };
