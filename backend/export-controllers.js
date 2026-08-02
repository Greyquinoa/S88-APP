#!/usr/bin/env node
/**
 * Export Controllers Script: Extract hw_controllers and hw_fieldbuses from local database
 *
 * Usage:
 *   node export-controllers.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');
const fs = require('fs');

const sourceConfig = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
};

async function exportControllers() {
  let sourcePool;

  try {
    console.log('[Export] Starting controller data export...\n');

    console.log(`[Export] Connecting to source (local): ${sourceConfig.host}:${sourceConfig.port}/${sourceConfig.database}`);
    sourcePool = new Pool(sourceConfig);
    await sourcePool.query('SELECT 1');
    console.log('[Export] ✓ Connected to source\n');

    // Get controllers with project names
    console.log('[Export] Fetching hw_controllers...');
    const controllersResult = await sourcePool.query(`
      SELECT c.*, p.name as project_name
      FROM hw_controllers c
      LEFT JOIN projects p ON c.project_id = p.id
      ORDER BY c.project_id, c.id
    `);
    const controllers = controllersResult.rows;
    console.log(`[Export] ✓ Found ${controllers.length} controllers\n`);

    // Get fieldbuses
    console.log('[Export] Fetching hw_fieldbuses...');
    const fieldbusesResult = await sourcePool.query(`
      SELECT f.*
      FROM hw_fieldbuses f
      ORDER BY f.hw_controller_id, f.id
    `);
    const fieldbuses = fieldbusesResult.rows;
    console.log(`[Export] ✓ Found ${fieldbuses.length} fieldbuses\n`);

    // Export to file
    const exportData = {
      exported_at: new Date().toISOString(),
      controllers: controllers,
      fieldbuses: fieldbuses,
      summary: {
        controller_count: controllers.length,
        fieldbus_count: fieldbuses.length,
        projects: [...new Set(controllers.map(c => c.project_name))].filter(Boolean)
      }
    };

    const outputFile = path.join(__dirname, 'controllers-export.json');
    fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

    console.log(`[Export] ✓ Exported to: ${outputFile}`);
    console.log(`\n[Export] Summary:`);
    console.log(`  - Controllers: ${exportData.summary.controller_count}`);
    console.log(`  - Fieldbuses: ${exportData.summary.fieldbus_count}`);
    console.log(`  - Projects: ${exportData.summary.projects.join(', ') || 'none'}`);

    if (controllers.length > 0) {
      console.log(`\n[Export] Controllers:`);
      controllers.forEach(c => {
        console.log(`  - [ID: ${c.id}] ${c.T16_Controller_TagName} (${c.project_name || 'no project'})`);
      });
    }

  } catch (error) {
    console.error('\n[Export] ✗ Error:', error.message);
    process.exit(1);
  } finally {
    if (sourcePool) await sourcePool.end();
  }
}

exportControllers();
