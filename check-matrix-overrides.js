#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { initDb, getDb } = require('./src/db');

async function checkOrphans() {
  try {
    await initDb();
    const db = getDb();

    console.log('[CHECK] Fetching instance_matrix_overrides...');
    const rows = await db.prepare(`
      SELECT imo.id, imo.project_id, imo.instance_name, 
             CASE WHEN pi.id IS NULL THEN 'ORPHAN' ELSE 'valid' END AS status
      FROM instance_matrix_overrides imo
      LEFT JOIN project_instances pi 
        ON pi.project_id = imo.project_id AND pi.instance_name = imo.instance_name
      ORDER BY imo.project_id, imo.instance_name
    `).all();

    console.log(`[CHECK] Found ${rows.length} records:\n`);
    
    const orphans = [];
    rows.forEach(r => {
      console.log(`  ID: ${r.id} | Project: ${r.project_id} | Instance: ${r.instance_name} | Status: ${r.status}`);
      if (r.status === 'ORPHAN') orphans.push(r.id);
    });

    if (orphans.length > 0) {
      console.log(`\n[CHECK] Found ${orphans.length} orphaned records`);
      console.log('[CHECK] Deleting orphaned records...');
      
      for (const id of orphans) {
        await db.prepare('DELETE FROM instance_matrix_overrides WHERE id = ?').run(id);
      }
      
      console.log(`[CHECK] Deleted ${orphans.length} orphaned records`);
    } else {
      console.log('\n[CHECK] All records are valid (instances exist)');
    }

  } catch (err) {
    console.error('[CHECK] Error:', err.message);
  }
}

checkOrphans();
