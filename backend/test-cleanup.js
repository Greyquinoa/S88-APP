#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

async function testCleanup() {
  const pool = new Pool({
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
    ssl:      false,
  });

  try {
    // Get a client
    const client = await pool.connect();

    // List all projects
    console.log('\n=== PROJECTS ===');
    const projects = await client.query('SELECT id, name FROM projects ORDER BY id DESC LIMIT 5');
    console.log(projects.rows);

    if (projects.rows.length === 0) {
      console.log('No projects found');
      client.release();
      await pool.end();
      return;
    }

    const projectId = projects.rows[0].id;
    const projectName = projects.rows[0].name;
    console.log(`\nUsing project: ${projectName} (ID: ${projectId})`);

    // Show all instances for this project
    console.log('\n=== ALL INSTANCES ===');
    const allInstances = await client.query(
      'SELECT id, instance_name, cm_type FROM project_instances WHERE project_id = $1 ORDER BY id',
      [projectId]
    );
    console.log(`Total instances: ${allInstances.rows.length}`);
    allInstances.rows.forEach(r => {
      console.log(`  [${r.id}] ${r.instance_name} (${r.cm_type})`);
    });

    // Show all CMT profiles for this project
    console.log('\n=== CMT PROFILES ===');
    const profiles = await client.query(
      'SELECT cm_type FROM project_cmt_profiles WHERE project_id = $1 ORDER BY cm_type',
      [projectId]
    );
    console.log(`Total profiles: ${profiles.rows.length}`);
    profiles.rows.forEach(r => {
      console.log(`  ${r.cm_type}`);
    });

    // Find orphaned instances
    console.log('\n=== ORPHANED INSTANCES (NO MATCHING PROFILE) ===');
    const orphaned = await client.query(`
      SELECT pi.id, pi.instance_name, pi.cm_type
      FROM project_instances pi
      WHERE pi.project_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM project_cmt_profiles pcp
          WHERE pcp.project_id = pi.project_id
            AND pcp.cm_type = pi.cm_type
        )
      ORDER BY pi.id
    `, [projectId]);

    if (orphaned.rows.length === 0) {
      console.log('No orphaned instances found');
    } else {
      console.log(`Found ${orphaned.rows.length} orphaned instance(s):`);
      orphaned.rows.forEach(r => {
        console.log(`  [${r.id}] ${r.instance_name} (${r.cm_type}) — NO MATCHING PROFILE`);
      });

      // Ask user if they want to delete
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question('\nDelete these orphaned instances? (yes/no): ', async (answer) => {
        rl.close();

        if (answer.toLowerCase() === 'yes') {
          console.log('\nDeleting orphaned instances...');
          try {
            await client.query('BEGIN');

            for (const orphan of orphaned.rows) {
              await client.query('DELETE FROM project_instances WHERE id = $1', [orphan.id]);
              console.log(`  Deleted [${orphan.id}] ${orphan.instance_name}`);
            }

            await client.query('COMMIT');
            console.log(`\nSuccess! Deleted ${orphaned.rows.length} orphaned instance(s)`);
          } catch (err) {
            await client.query('ROLLBACK');
            console.error('Error deleting:', err.message);
          }
        } else {
          console.log('Cancelled');
        }

        client.release();
        await pool.end();
      });
    }

    if (orphaned.rows.length === 0) {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

testCleanup();
