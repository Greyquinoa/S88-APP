#!/usr/bin/env node
/**
 * Export HW Data Script: Extract all hardware-related data from local database
 *
 * Exports:
 *  - hw_imports
 *  - hw_excel_raw
 *  - hw_signals
 *  - hw_generated_cfgs
 *  - hw_slot_subslots
 *  - hw_station_auto_slots
 *  - hw_module_parameters
 *
 * Usage:
 *   node export-hw-data.js
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

async function exportHwData() {
  let sourcePool;

  try {
    console.log('[Export HW] Starting hardware data export...\n');

    console.log(`[Export HW] Connecting to source (local): ${sourceConfig.host}:${sourceConfig.port}/${sourceConfig.database}`);
    sourcePool = new Pool(sourceConfig);
    await sourcePool.query('SELECT 1');
    console.log('[Export HW] ✓ Connected to source\n');

    const tables = [
      'hw_imports',
      'hw_excel_raw',
      'hw_signals',
      'hw_generated_cfgs',
      'hw_slot_subslots',
      'hw_station_auto_slots',
      'hw_module_parameters',
    ];

    const exportData = {
      exported_at: new Date().toISOString(),
      tables: {},
      summary: {}
    };

    for (const table of tables) {
      console.log(`[Export HW] Fetching ${table}...`);
      const result = await sourcePool.query(`SELECT * FROM ${table}`);
      const rows = result.rows;
      exportData.tables[table] = rows;
      exportData.summary[table] = rows.length;
      console.log(`[Export HW] ✓ Found ${rows.length} rows in ${table}`);
    }

    console.log('');

    // Export to file
    const outputFile = path.join(__dirname, 'hw-data-export.json');
    fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

    console.log(`[Export HW] ✓ Exported to: ${outputFile}`);
    console.log(`\n[Export HW] Summary:`);
    Object.entries(exportData.summary).forEach(([table, count]) => {
      console.log(`  - ${table}: ${count} rows`);
    });

    const totalRows = Object.values(exportData.summary).reduce((a, b) => a + b, 0);
    console.log(`\n[Export HW] Total rows exported: ${totalRows}`);

  } catch (error) {
    console.error('\n[Export HW] ✗ Error:', error.message);
    process.exit(1);
  } finally {
    if (sourcePool) await sourcePool.end();
  }
}

exportHwData();
