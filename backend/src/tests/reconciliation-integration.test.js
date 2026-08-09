'use strict';

// Integration test for the reconciliation flow against a real database.
// Creates a throwaway project, seeds instances the way IO import and unit type
// generation would, then exercises run → accept → revert and the export filter.
// Run: node src/tests/reconciliation-integration.test.js

const { initDb, getDb } = require('../db');
const {
  runReconciliation, acceptDummy, revertDummy,
  getReconciliationSummary, getInstancesWithReconciliation,
} = require('../services/reconciliationEngine');

let passed = 0, failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const PROJECT_NAME = `__recon_test_${process.pid}`;

async function main() {
  await initDb();
  const db = getDb();

  const proj = await db.prepare(
    'INSERT INTO projects (name, comment) VALUES (?, ?)'
  ).run(PROJECT_NAME, 'reconciliation integration test');
  const projectId = proj.lastInsertRowid;

  try {
    // Seed as the two creation paths would: XV01-XV03 imported, XV01-XV04 generated.
    const seed = [
      { name: 'XV01', imported: true,  generated: true },
      { name: 'XV02', imported: true,  generated: true },
      { name: 'XV03', imported: true,  generated: true },
      { name: 'XV04', imported: false, generated: true },
    ];
    const ins = db.prepare(`
      INSERT INTO project_instances
        (project_id, cm_type, instance_name, sort_order, is_imported, is_generated)
      VALUES (?,?,?,?,?,?)
    `);
    for (let i = 0; i < seed.length; i++) {
      await ins.run(projectId, 'CM_VALVE', seed[i].name, i, seed[i].imported, seed[i].generated);
    }

    console.log('\nreconciliation integration\n');

    console.log('after import + generation');
    const all = await getInstancesWithReconciliation(db, projectId);
    check('4 instances, no duplicates', all.length, 4);

    console.log('\nfirst reconciliation run');
    const run1 = await runReconciliation(db, projectId);
    check('4 instances updated', run1.instancesUpdated, 4);
    const sum1 = await getReconciliationSummary(db, projectId);
    check('3 OK', sum1.OK, 3);
    check('1 DUMMY', sum1.DUMMY, 1);
    check('0 DUMMY_ACCEPTED', sum1.DUMMY_ACCEPTED, 0);

    const byName = async () => Object.fromEntries(
      (await getInstancesWithReconciliation(db, projectId))
        .map(i => [i.instanceName, i])
    );
    let m = await byName();
    check('XV01 → OK', m.XV01.reconciliationStatus, 'OK');
    check('XV04 → DUMMY', m.XV04.reconciliationStatus, 'DUMMY');

    console.log('\nexport filter before accepting XV04');
    const excludedBefore = (await db.prepare(
      `SELECT instance_name FROM project_instances WHERE project_id=? AND reconciliation_status='DUMMY'`
    ).all(projectId)).map(r => r.instance_name);
    check('XV04 excluded from export', excludedBefore, ['XV04']);

    console.log('\naccept XV04');
    await acceptDummy(db, m.XV04.id, 'tester');
    m = await byName();
    check('XV04 → DUMMY_ACCEPTED', m.XV04.reconciliationStatus, 'DUMMY_ACCEPTED');
    check('accepted_by recorded', m.XV04.acceptedBy, 'tester');
    check('accepted_at recorded', m.XV04.acceptedAt != null, true);

    console.log('\nexport filter after accepting XV04');
    const excludedAfter = (await db.prepare(
      `SELECT instance_name FROM project_instances WHERE project_id=? AND reconciliation_status='DUMMY'`
    ).all(projectId)).map(r => r.instance_name);
    check('nothing excluded — all 4 exported', excludedAfter, []);

    console.log('\nre-run keeps the manual acceptance');
    await runReconciliation(db, projectId);
    m = await byName();
    check('XV04 stays DUMMY_ACCEPTED', m.XV04.reconciliationStatus, 'DUMMY_ACCEPTED');

    console.log('\nre-run promotes an accepted dummy once it is imported');
    await db.prepare('UPDATE project_instances SET is_imported=true WHERE id=?').run(m.XV04.id);
    await runReconciliation(db, projectId);
    m = await byName();
    check('XV04 → OK', m.XV04.reconciliationStatus, 'OK');

    console.log('\nrevert back to DUMMY');
    await db.prepare('UPDATE project_instances SET is_imported=false WHERE id=?').run(m.XV04.id);
    await runReconciliation(db, projectId);
    m = await byName();
    check('XV04 returns to DUMMY_ACCEPTED (acceptance survives)', m.XV04.reconciliationStatus, 'DUMMY_ACCEPTED');
    await revertDummy(db, m.XV04.id);
    m = await byName();
    check('XV04 → DUMMY after revert', m.XV04.reconciliationStatus, 'DUMMY');
    check('accepted_by cleared', m.XV04.acceptedBy, null);
  } finally {
    await db.prepare('DELETE FROM project_instances WHERE project_id=?').run(projectId);
    await db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nTest run failed:', e.message); process.exit(1); });
