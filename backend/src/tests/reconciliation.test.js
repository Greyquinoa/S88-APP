'use strict';

// Unit tests for the pure reconciliation status function.
// Run: node src/tests/reconciliation.test.js

const { computeReconciliationStatus } = require('../services/reconciliationEngine');

let passed = 0, failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} — expected "${expected}", got "${actual}"`);
  }
}

console.log('\ncomputeReconciliationStatus\n');

console.log('fresh reconciliation (no previous status)');
check('imported + generated → OK',
  computeReconciliationStatus(true, true, 'PENDING'), 'OK');
check('imported only → IMPORTED_OK',
  computeReconciliationStatus(true, false, 'PENDING'), 'IMPORTED_OK');
check('generated only → DUMMY',
  computeReconciliationStatus(false, true, 'PENDING'), 'DUMMY');
check('neither flag → ERROR',
  computeReconciliationStatus(false, false, 'PENDING'), 'ERROR');

console.log('\nre-run rules');
check('DUMMY_ACCEPTED + still generated-only → stays DUMMY_ACCEPTED',
  computeReconciliationStatus(false, true, 'DUMMY_ACCEPTED'), 'DUMMY_ACCEPTED');
check('DUMMY_ACCEPTED + now imported → promoted to OK',
  computeReconciliationStatus(true, true, 'DUMMY_ACCEPTED'), 'OK');
check('DUMMY_ACCEPTED + imported, no longer generated → IMPORTED_OK',
  computeReconciliationStatus(true, false, 'DUMMY_ACCEPTED'), 'IMPORTED_OK');
check('DUMMY + still generated-only → stays DUMMY',
  computeReconciliationStatus(false, true, 'DUMMY'), 'DUMMY');
check('OK re-run with both flags → stays OK',
  computeReconciliationStatus(true, true, 'OK'), 'OK');
check('previously accepted, went OK, import removed → back to DUMMY_ACCEPTED',
  computeReconciliationStatus(false, true, 'OK', true), 'DUMMY_ACCEPTED');
check('never accepted, went OK, import removed → DUMMY',
  computeReconciliationStatus(false, true, 'OK', false), 'DUMMY');

console.log('\nacceptance scenario (XV01-XV03 imported, XV01-XV04 generated)');
const scenario = [
  { tag: 'XV01', imported: true,  generated: true },
  { tag: 'XV02', imported: true,  generated: true },
  { tag: 'XV03', imported: true,  generated: true },
  { tag: 'XV04', imported: false, generated: true },
];
for (const s of scenario) {
  const expected = s.imported ? 'OK' : 'DUMMY';
  check(`${s.tag} → ${expected}`,
    computeReconciliationStatus(s.imported, s.generated, 'PENDING'), expected);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
