'use strict';

// Unit tests for Library field-metadata labeling and human-readable rendering.
// Run: node src/tests/libraryFieldMeta.test.js

const { formatFieldChange, describeChanges, enrichChanges } = require('../services/libraryFieldMeta');

let passed = 0, failed = 0;

function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\nformatFieldChange\n');

check('string field, normal change (default value)',
  formatFieldChange('lib_variables.val', '50', '75'),
  'Default value changed from 50 to 75');

check('boolean field, false → true renders as No → Yes',
  formatFieldChange('lib_variables.is_valid', false, true),
  'Exposed for wiring changed from No to Yes');

check('boolean field, true → false renders as Yes → No',
  formatFieldChange('lib_blocks.optional', true, false),
  'Optional block changed from Yes to No');

check('boolean field, is_conditional toggle',
  formatFieldChange('lib_blocks.is_conditional', false, true),
  'Conditional block changed from No to Yes');

check('string field, value newly set from empty',
  formatFieldChange('lib_cm_types.comment', '', 'New comment text'),
  'Comment set to New comment text');

check('string field, value cleared to empty',
  formatFieldChange('lib_cm_types.comment', 'Old comment', ''),
  'Comment cleared (was Old comment)');

check('string field, both empty → unchanged wording (defensive; diffRow would not emit this)',
  formatFieldChange('lib_cm_types.comment', '', ''),
  'Comment unchanged');

check('unknown field key falls back to the raw key as label',
  formatFieldChange('some_table.unknown_field', '1', '2'),
  'some_table.unknown_field changed from 1 to 2');

check('sampling_time field label includes unit',
  formatFieldChange('lib_cm_types.sampling_time', '1000', '500'),
  'Sampling time (ms) changed from 1000 to 500');

console.log('\ndescribeChanges\n');

check('no changes → generic updated sentence',
  describeChanges("Variable 'SP_VAL'", []),
  "Variable 'SP_VAL' updated");

check('single change joined with entity label',
  describeChanges("Variable 'SP_VAL'", [{ field: 'lib_variables.val', old: '50.0', new: '75.0' }]),
  "Variable 'SP_VAL': Default value changed from 50.0 to 75.0");

check('multiple changes joined with semicolons',
  describeChanges("Variable 'SP_VAL'", [
    { field: 'lib_variables.val', old: '50.0', new: '75.0' },
    { field: 'lib_variables.is_valid', old: false, new: true },
  ]),
  "Variable 'SP_VAL': Default value changed from 50.0 to 75.0; Exposed for wiring changed from No to Yes");

console.log('\nenrichChanges\n');

check('adds label + display strings to each change',
  enrichChanges([{ field: 'lib_variables.val', old: '50.0', new: '75.0' }]),
  [{ field: 'lib_variables.val', label: 'Default value', old: '50.0', new: '75.0', oldDisplay: '50.0', newDisplay: '75.0' }]);

check('boolean field enrichment renders Yes/No display values',
  enrichChanges([{ field: 'lib_blocks.optional', old: false, new: true }]),
  [{ field: 'lib_blocks.optional', label: 'Optional block', old: false, new: true, oldDisplay: 'No', newDisplay: 'Yes' }]);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
