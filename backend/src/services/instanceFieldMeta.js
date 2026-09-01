// src/services/instanceFieldMeta.js — field labels + human-readable diff rendering
// for project instances. Sibling of libraryFieldMeta.js; formatting lives in
// fieldMetaFactory.js.
//
// Deliberately narrow. `connections` and `role_assignments` are machine-managed
// JSON — composite definitions rewrite the first wholesale, autoAssignRoles merges
// into the second on every "Generate Connections" — so diffing them produces noise
// rather than a record of what a person did.
'use strict';
const { createFieldMeta } = require('./fieldMetaFactory');

// key = "<table>.<column>" so the same column name in different tables can't collide.
const INSTANCE_FIELD_META = {
  'project_instances.cm_type':          { label: 'CM Type',            type: 'string' },
  'project_instances.sampling_time':    { label: 'Sampling time (ms)', type: 'string' },
  'project_instances.user_project':     { label: 'User project',       type: 'string' },
  'project_instances.hw_controller_id': { label: 'Controller',         type: 'lookup' },
  'project_instances.folder_id':        { label: 'Folder',             type: 'lookup' },
};

// The columns diffRow() compares, in the shape it expects.
const INSTANCE_DIFF_FIELDS = Object.keys(INSTANCE_FIELD_META);

const { formatFieldChange, describeChanges, enrichChanges } = createFieldMeta(INSTANCE_FIELD_META);

module.exports = {
  INSTANCE_FIELD_META,
  INSTANCE_DIFF_FIELDS,
  formatFieldChange,
  describeChanges,
  enrichChanges,
};
