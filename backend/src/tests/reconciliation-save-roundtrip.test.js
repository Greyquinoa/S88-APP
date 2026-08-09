'use strict';

// Regression test: saving a project (which "Generate Connections" does before it
// runs) wipes and reinserts every project_instances row. Reconciliation state is
// server-owned and absent from the client payload, so the save must carry it
// forward by instance name — otherwise every row comes back as neither imported
// nor generated and reconciliation reports "inconsistent data".
// Run: node src/tests/reconciliation-save-roundtrip.test.js

const request = require('http');
const { initDb, getDb } = require('../db');
const { runReconciliation, getInstancesWithReconciliation } = require('../services/reconciliationEngine');

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const PROJECT_NAME = `__recon_save_test_${process.pid}`;

// Exercise the real route handler rather than duplicating its SQL here, so the
// test breaks if the save path regresses again.
function callSaveProject(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request.request({
      host: 'localhost', port: process.env.PORT || 3001,
      path: '/api/projects', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => res.statusCode < 400
        ? resolve(JSON.parse(data || '{}'))
        : reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  await initDb();
  const db = getDb();

  const proj = await db.prepare('INSERT INTO projects (name, comment) VALUES (?, ?)')
    .run(PROJECT_NAME, 'reconciliation save round-trip test');
  const projectId = proj.lastInsertRowid;

  try {
    const seed = [
      { name: 'XV01', imported: true,  generated: true },
      { name: 'XV02', imported: true,  generated: false },
      { name: 'XV03', imported: false, generated: true },
    ];
    const ins = db.prepare(`
      INSERT INTO project_instances
        (project_id, cm_type, instance_name, sort_order, is_imported, is_generated)
      VALUES (?,?,?,?,?,?)
    `);
    for (let i = 0; i < seed.length; i++) {
      await ins.run(projectId, 'CM_VALVE', seed[i].name, i, seed[i].imported, seed[i].generated);
    }

    console.log('\nreconciliation survives a project save\n');

    await runReconciliation(db, projectId);
    const byName = async () => Object.fromEntries(
      (await getInstancesWithReconciliation(db, projectId)).map(i => [i.instanceName, i])
    );
    let m = await byName();
    check('XV01 → OK before save',          m.XV01.reconciliationStatus, 'OK');
    check('XV02 → IMPORTED_OK before save', m.XV02.reconciliationStatus, 'IMPORTED_OK');
    check('XV03 → DUMMY before save',       m.XV03.reconciliationStatus, 'DUMMY');

    // The client payload carries no reconciliation fields — exactly what the
    // frontend sends when "Generate Connections" calls saveProjectNow() first.
    console.log('\nafter saving the project (no reconciliation fields in payload)');
    await callSaveProject({
      name: PROJECT_NAME,
      comment: '',
      userProjects: [],
      hierarchy: [],
      cmtProfiles: [],
      instances: seed.map(s => ({
        cm_type: 'CM_VALVE',
        instance_name: s.name,
        sampling_time: '1000',
        connections: [],
      })),
    });

    m = await byName();
    check('3 instances still present', Object.keys(m).length, 3);
    check('XV01 is_imported preserved',  m.XV01.isImported,  true);
    check('XV01 is_generated preserved', m.XV01.isGenerated, true);
    check('XV01 still OK',               m.XV01.reconciliationStatus, 'OK');
    check('XV02 still IMPORTED_OK',      m.XV02.reconciliationStatus, 'IMPORTED_OK');
    check('XV03 still DUMMY',            m.XV03.reconciliationStatus, 'DUMMY');

    console.log('\nre-running reconciliation after the save');
    const run = await runReconciliation(db, projectId);
    check('no instances reported inconsistent', run.countsPerStatus.ERROR, 0);
    check('1 OK',          run.countsPerStatus.OK, 1);
    check('1 IMPORTED_OK', run.countsPerStatus.IMPORTED_OK, 1);
    check('1 DUMMY',       run.countsPerStatus.DUMMY, 1);

    console.log('\na brand-new instance added by the save starts unreconciled');
    await callSaveProject({
      name: PROJECT_NAME, comment: '', userProjects: [], hierarchy: [], cmtProfiles: [],
      instances: [...seed, { name: 'XV99' }].map(s => ({
        cm_type: 'CM_VALVE',
        instance_name: s.name ?? s.instance_name,
        sampling_time: '1000',
        connections: [],
      })),
    });
    m = await byName();
    check('XV99 not imported',  m.XV99.isImported,  false);
    check('XV99 not generated', m.XV99.isGenerated, false);
    check('XV99 PENDING',       m.XV99.reconciliationStatus, 'PENDING');
  } finally {
    await db.prepare('DELETE FROM project_instances     WHERE project_id=?').run(projectId);
    await db.prepare('DELETE FROM project_cmt_profiles  WHERE project_id=?').run(projectId);
    await db.prepare('DELETE FROM project_user_projects WHERE project_id=?').run(projectId);
    await db.prepare('DELETE FROM projects              WHERE id=?').run(projectId);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nTest run failed:', e.message); process.exit(1); });
