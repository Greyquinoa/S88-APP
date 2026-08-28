#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { initDb, getDb } = require('./src/db');

async function testCascadeDelete() {
  try {
    console.log('[TEST] Initializing database...');
    await initDb();
    const db = getDb();

    // Get or create a project
    let projectId;
    const projects = await db.prepare('SELECT id FROM projects LIMIT 1').all();
    if (projects.length) {
      projectId = projects[0].id;
    } else {
      const result = await db.prepare('INSERT INTO projects (name) VALUES (?)').run('test-cascade');
      projectId = result.lastInsertRowid;
    }

    console.log(`[TEST] Using project ID: ${projectId}`);

    // Create a test instance
    const instanceResult = await db.prepare(
      `INSERT INTO project_instances (project_id, cm_type, instance_name, sampling_time)
       VALUES (?, ?, ?, ?)`
    ).run(projectId, 'TEST_CM', 'CASCADE_TEST_001', '1000');

    const instanceId = instanceResult.lastInsertRowid;
    console.log(`[TEST] Created instance: CASCADE_TEST_001 (ID: ${instanceId})`);

    // Add related data
    await db.prepare(
      `INSERT INTO instance_ios (project_id, instance_name, block_name, var_name, signal_name, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectId, 'CASCADE_TEST_001', 'TEST_BLOCK', 'TEST_VAR', 'TEST_SIG', 'dummy');
    console.log('[TEST] Added instance_ios record');

    await db.prepare(
      `INSERT INTO instance_derived_values (project_id, instance_name, to_var_name, symbol_name, column_name)
       VALUES (?, ?, ?, ?, ?)`
    ).run(projectId, 'CASCADE_TEST_001', 'TEST_VAR', 'TEST_SYM', 'TEST_COL');
    console.log('[TEST] Added instance_derived_values record');

    await db.prepare(
      `INSERT INTO instance_matrix_overrides (project_id, instance_name, enabled, cells)
       VALUES (?, ?, ?, ?)`
    ).run(projectId, 'CASCADE_TEST_001', false, '{}');
    console.log('[TEST] Added instance_matrix_overrides record');

    // Verify records exist
    console.log('[TEST] Verifying records before delete...');
    const instCount = await db.prepare('SELECT COUNT(*) AS n FROM project_instances WHERE instance_name = ?').get('CASCADE_TEST_001');
    const iosCount = await db.prepare('SELECT COUNT(*) AS n FROM instance_ios WHERE instance_name = ?').get('CASCADE_TEST_001');
    const dvCount = await db.prepare('SELECT COUNT(*) AS n FROM instance_derived_values WHERE instance_name = ?').get('CASCADE_TEST_001');
    const mmoCount = await db.prepare('SELECT COUNT(*) AS n FROM instance_matrix_overrides WHERE instance_name = ?').get('CASCADE_TEST_001');

    console.log(`  - project_instances: ${instCount.n}`);
    console.log(`  - instance_ios: ${iosCount.n}`);
    console.log(`  - instance_derived_values: ${dvCount.n}`);
    console.log(`  - instance_matrix_overrides: ${mmoCount.n}`);

    // Now delete the instance using cascade logic
    console.log('[TEST] Deleting instance with cascade...');

    await db.transaction(async () => {
      const instance = await db.prepare(
        'SELECT id FROM project_instances WHERE project_id = ? AND instance_name = ?'
      ).get(projectId, 'CASCADE_TEST_001');

      if (!instance) throw new Error('Instance not found');

      const instanceId = instance.id;

      await db.prepare(
        'DELETE FROM instance_ios WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, 'CASCADE_TEST_001');

      await db.prepare(
        'DELETE FROM instance_derived_values WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, 'CASCADE_TEST_001');

      await db.prepare(
        'DELETE FROM instance_matrix_overrides WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, 'CASCADE_TEST_001');

      await db.prepare(
        'DELETE FROM signal_mappings WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, 'CASCADE_TEST_001');

      await db.prepare(
        'DELETE FROM unit_resolved_connections WHERE project_id = ? AND unit_instance_id = ?'
      ).run(projectId, instanceId);

      await db.prepare(
        'DELETE FROM project_instances WHERE id = ? AND project_id = ?'
      ).run(instanceId, projectId);
    })();

    console.log('[TEST] Cascade delete completed');

    // Verify all records are gone
    console.log('[TEST] Verifying records after delete...');
    const instCountAfter = await db.prepare('SELECT COUNT(*) AS n FROM project_instances WHERE instance_name = ?').get('CASCADE_TEST_001');
    const iosCountAfter = await db.prepare('SELECT COUNT(*) AS n FROM instance_ios WHERE instance_name = ?').get('CASCADE_TEST_001');
    const dvCountAfter = await db.prepare('SELECT COUNT(*) AS n FROM instance_derived_values WHERE instance_name = ?').get('CASCADE_TEST_001');
    const mmoCountAfter = await db.prepare('SELECT COUNT(*) AS n FROM instance_matrix_overrides WHERE instance_name = ?').get('CASCADE_TEST_001');

    console.log(`  - project_instances: ${instCountAfter.n}`);
    console.log(`  - instance_ios: ${iosCountAfter.n}`);
    console.log(`  - instance_derived_values: ${dvCountAfter.n}`);
    console.log(`  - instance_matrix_overrides: ${mmoCountAfter.n}`);

    const allDeleted = Number(instCountAfter.n) === 0 && Number(iosCountAfter.n) === 0 && Number(dvCountAfter.n) === 0 && Number(mmoCountAfter.n) === 0;
    if (allDeleted) {
      console.log('[TEST] ✓ SUCCESS - All related records were deleted');
    } else {
      console.log('[TEST] ✗ FAILED - Some records still exist');
      console.log(`Debug: ${instCountAfter.n} + ${iosCountAfter.n} + ${dvCountAfter.n} + ${mmoCountAfter.n}`);
    }

  } catch (err) {
    console.error('[TEST] Error:', err.message);
    console.error('[TEST] Stack:', err.stack);
  }
}

testCascadeDelete();
