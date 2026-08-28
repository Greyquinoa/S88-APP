#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { initDb, getDb } = require('./src/db');

async function cleanupInstance() {
  try {
    console.log('[CLEANUP] Starting...');
    await initDb();
    const db = getDb();

    // Find the project first
    const projects = await db.prepare('SELECT id, name FROM projects LIMIT 1').all();
    if (!projects.length) {
      console.log('[CLEANUP] No projects found');
      process.exit(0);
    }

    const projectId = projects[0].id;
    console.log(`[CLEANUP] Working with project: ${projects[0].name} (ID: ${projectId})`);

    // Find XV005 instance
    const instances = await db.prepare(
      'SELECT id, instance_name FROM project_instances WHERE instance_name = ? AND project_id = ?'
    ).all('XV005', projectId);

    if (!instances.length) {
      console.log('[CLEANUP] XV005 not found in current project, checking all projects...');
      const allInstances = await db.prepare(
        'SELECT id, instance_name, project_id FROM project_instances WHERE instance_name = ?'
      ).all('XV005');

      if (allInstances.length) {
        console.log(`[CLEANUP] Found ${allInstances.length} XV005 instance(s) in other projects:`);
        allInstances.forEach(i => console.log(`  - Project ID ${i.project_id}: ${i.instance_name}`));
      } else {
        console.log('[CLEANUP] XV005 not found anywhere in database');
      }
      process.exit(0);
    }

    console.log(`[CLEANUP] Found ${instances.length} XV005 instance(s), deleting...`);

    await db.transaction(async () => {
      for (const inst of instances) {
        const instId = inst.id;

        // Delete related records
        await db.prepare('DELETE FROM instance_ios WHERE project_id = ? AND instance_name = ?').run(projectId, 'XV005');
        await db.prepare('DELETE FROM instance_derived_values WHERE project_id = ? AND instance_name = ?').run(projectId, 'XV005');
        await db.prepare('DELETE FROM instance_matrix_overrides WHERE project_id = ? AND instance_name = ?').run(projectId, 'XV005');
        await db.prepare('DELETE FROM unit_resolved_connections WHERE project_id = ? AND unit_instance_id = ?').run(projectId, instId);

        // Delete the instance itself
        await db.prepare('DELETE FROM project_instances WHERE id = ?').run(instId);

        console.log(`[CLEANUP] Deleted instance XV005 (ID: ${instId})`);
      }
    })();

    console.log('[CLEANUP] Complete');
    process.exit(0);
  } catch (err) {
    console.error('[CLEANUP] Error:', err.message);
    process.exit(1);
  }
}

cleanupInstance();
