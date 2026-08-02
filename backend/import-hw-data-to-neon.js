#!/usr/bin/env node
/**
 * Import HW Data to Neon Script
 *
 * This script imports hardware configuration data from the local export
 * to the Neon online database. It handles ID mapping and project references.
 *
 * Usage:
 *   NEON_HOST=... NEON_USER=... NEON_PASSWORD=... node import-hw-data-to-neon.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');
const fs = require('fs');

const targetConfig = {
  host: process.env.NEON_HOST,
  port: Number(process.env.NEON_PORT) || 5432,
  user: process.env.NEON_USER,
  password: process.env.NEON_PASSWORD,
  database: process.env.NEON_DATABASE || 's88_app',
  ssl: { rejectUnauthorized: false },
};

async function importHwData() {
  let targetPool;

  try {
    console.log('[Import HW] Starting HW data import to Neon...\n');

    // Validate Neon credentials
    if (!targetConfig.host || !targetConfig.user || !targetConfig.password) {
      throw new Error(
        'Missing Neon credentials. Set: NEON_HOST, NEON_USER, NEON_PASSWORD'
      );
    }

    // Read export file
    const exportFile = path.join(__dirname, 'hw-data-export.json');
    if (!fs.existsSync(exportFile)) {
      throw new Error(`Export file not found: ${exportFile}\n\nRun 'node export-hw-data.js' first.`);
    }

    const exportData = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    console.log('[Import HW] ✓ Loaded export file');
    console.log('[Import HW]   Total rows: ' + Object.values(exportData.summary).reduce((a,b)=>a+b,0));
    console.log('');

    // Connect to Neon
    console.log(`[Import HW] Connecting to Neon: ${targetConfig.host}`);
    targetPool = new Pool(targetConfig);
    await targetPool.query('SELECT 1');
    console.log('[Import HW] ✓ Connected to Neon\n');

    // Get project mapping from Neon (local project_id → neon project_id)
    const projectMap = {};
    const neonProjects = await targetPool.query('SELECT id, name FROM projects');
    for (const proj of neonProjects.rows) {
      projectMap[proj.name] = proj.id;
    }
    console.log('[Import HW] Project mapping loaded: ' + Object.keys(projectMap).join(', '));
    console.log('');

    // Create import ID map: old local id → new neon id
    const importIdMap = {};

    // 1. Insert hw_imports
    console.log('[Import HW] Inserting hw_imports...');
    const imports = exportData.tables.hw_imports || [];
    for (const imp of imports) {
      // Assume single project "rIX" as per controller export
      const projectId = projectMap['rIX'] || 1;

      const result = await targetPool.query(
        `INSERT INTO hw_imports (
          project_id, baseline_cfg, excel_name, column_map, status
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id`,
        [
          projectId,
          imp.baseline_cfg || null,
          imp.excel_name || null,
          imp.column_map || null,
          imp.status || 'generated',
        ]
      );
      const newImportId = result.rows[0].id;
      importIdMap[imp.id] = newImportId;
      console.log(`[Import HW]   ✓ hw_imports ID ${imp.id} → ${newImportId}`);
    }
    console.log('');

    const newImportId = Object.values(importIdMap)[0];

    // 2. Skip hw_excel_raw (it's not needed for Configuration tab to work)
    console.log('[Import HW] Skipping hw_excel_raw (not required for configuration)...');
    console.log('');

    // 3. Insert hw_signals
    console.log('[Import HW] Inserting hw_signals...');
    const signals = exportData.tables.hw_signals || [];
    for (let i = 0; i < signals.length; i += 100) {
      const batch = signals.slice(i, i + 100);
      for (const sig of batch) {
        await targetPool.query(
          `INSERT INTO hw_signals (
            hw_import_id, row_number, station_address, station_name, ip_address, router_address,
            slot, module_order_no, module_name, subsystem_no, pip_no, potential_group,
            pa_profile, tag, signal_type, channel, description,
            unresolved, resolved_by_tier2, approved
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            newImportId,
            sig.row_number || null,
            sig.station_address || null,
            sig.station_name || null,
            sig.ip_address || null,
            sig.router_address || null,
            sig.slot !== undefined && sig.slot !== null ? sig.slot : 0,
            sig.module_order_no || 'UNKNOWN',
            sig.module_name || null,
            sig.subsystem_no || null,
            sig.pip_no || null,
            sig.potential_group || null,
            sig.pa_profile || null,
            sig.tag || null,
            sig.signal_type || null,
            sig.channel || null,
            sig.description || null,
            sig.unresolved || false,
            sig.resolved_by_tier2 || false,
            sig.approved || false,
          ]
        );
      }
      console.log(`[Import HW]   ✓ Inserted ${Math.min(i + 100, signals.length)} / ${signals.length} signals`);
    }
    console.log('');

    // 4. Insert hw_slot_subslots (CRITICAL for Configuration tab subslot display)
    console.log('[Import HW] Inserting hw_slot_subslots...');
    const subslots = exportData.tables.hw_slot_subslots || [];
    for (const ss of subslots) {
      await targetPool.query(
        `INSERT INTO hw_slot_subslots (
          hw_import_id, station_address, slot, subslot_no, pa_profile
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          newImportId,
          ss.station_address || null,
          ss.slot || null,
          ss.subslot_no || null,
          ss.pa_profile || null,
        ]
      );
    }
    console.log(`[Import HW]   ✓ Inserted ${subslots.length} subslots\n`);

    // 5. Skip other tables (not critical for Configuration tab)
    console.log('[Import HW] Skipping hw_generated_cfgs, hw_station_auto_slots, hw_module_parameters...');
    console.log('');

    // Verify import
    console.log('[Import HW] Verifying import...');
    const verifyImports = await targetPool.query('SELECT COUNT(*) as cnt FROM hw_imports');
    const verifySignals = await targetPool.query('SELECT COUNT(*) as cnt FROM hw_signals');
    const verifyControllers = await targetPool.query('SELECT COUNT(*) as cnt FROM hw_controllers');
    console.log(`[Import HW]   ✓ Total hw_imports: ${verifyImports.rows[0].cnt}`);
    console.log(`[Import HW]   ✓ Total hw_signals: ${verifySignals.rows[0].cnt}`);
    console.log(`[Import HW]   ✓ Total hw_controllers: ${verifyControllers.rows[0].cnt}`);

    console.log('\n[Import HW] ✓ Import complete!');

  } catch (error) {
    console.error('\n[Import HW] ✗ Error:', error.message);
    if (error.code) console.error(`[Import HW] Error code: ${error.code}`);
    process.exit(1);
  } finally {
    if (targetPool) await targetPool.end();
  }
}

importHwData();
