'use strict';

// Unit tests for the pure audit-log diffing helpers.
// Run: node src/tests/auditLog.test.js

const { diffRow, newBatchId } = require('../services/auditLog');

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

console.log('\ndiffRow\n');

check('no changes → []',
  diffRow({ a: '1' }, { a: '1' }, { a: true }),
  []);

check('single changed field → one diff entry',
  diffRow({ a: '1' }, { a: '2' }, { a: true }),
  [{ field: 'a', old: '1', new: '2' }]);

check('ignores fields outside fieldMeta',
  diffRow({ a: '1', b: '1' }, { a: '1', b: '2' }, { a: true }),
  []);

check('multiple tracked fields, only changed ones reported',
  diffRow({ a: '1', b: 'x' }, { a: '2', b: 'x' }, { a: true, b: true }),
  [{ field: 'a', old: '1', new: '2' }]);

check('unset → set (null to value)',
  diffRow({ a: null }, { a: 'hello' }, { a: true }),
  [{ field: 'a', old: null, new: 'hello' }]);

check('set → unset (value to null)',
  diffRow({ a: 'hello' }, { a: null }, { a: true }),
  [{ field: 'a', old: 'hello', new: null }]);

check('missing oldRow treated as all-null baseline',
  diffRow(null, { a: 'x' }, { a: true }),
  [{ field: 'a', old: null, new: 'x' }]);

check('boolean false vs true detected as change',
  diffRow({ a: false }, { a: true }, { a: true }),
  [{ field: 'a', old: false, new: true }]);

check('boolean identical values → no change',
  diffRow({ a: true }, { a: true }, { a: true }),
  []);

check('numeric-looking strings compared as strings ("50" !== "50.0")',
  diffRow({ a: '50' }, { a: '50.0' }, { a: true }),
  [{ field: 'a', old: '50', new: '50.0' }]);

check('field absent from newRow is skipped entirely',
  diffRow({ a: '1' }, {}, { a: true }),
  []);

console.log('\nnewBatchId\n');

const id1 = newBatchId();
const id2 = newBatchId();
check('returns a UUID-shaped string', /^[0-9a-f-]{36}$/i.test(id1), true);
check('two calls produce different ids', id1 !== id2, true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
