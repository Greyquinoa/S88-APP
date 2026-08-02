#!/usr/bin/env node
/**
 * Import Controllers to Neon Script
 *
 * This script imports controller and fieldbus data from the local export
 * to the Neon online database. It:
 * 1. Maps local project IDs to target project IDs on Neon
 * 2. Preserves controller structure with fieldbuses
 * 3. Handles ID mapping (local IDs won't match Neon IDs)
 *
 * Usage:
 *   NEON_HOST=... NEON_USER=... NEON_PASSWORD=... node import-controllers-to-neon.js
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

async function importControllers() {
  let targetPool;

  try {
    console.log('[Import] Starting controller data import to Neon...\n');

    // Validate Neon credentials
    if (!targetConfig.host || !targetConfig.user || !targetConfig.password) {
      throw new Error(
        'Missing Neon credentials. Set: NEON_HOST, NEON_USER, NEON_PASSWORD\n\n' +
        'Example:\n' +
        '  NEON_HOST=abc123.neon.tech \\\n' +
        '  NEON_USER=myuser \\\n' +
        '  NEON_PASSWORD=mypass \\\n' +
        '  node import-controllers-to-neon.js'
      );
    }

    // Read export file
    const exportFile = path.join(__dirname, 'controllers-export.json');
    if (!fs.existsSync(exportFile)) {
      throw new Error(`Export file not found: ${exportFile}\n\nRun 'node export-controllers.js' first.`);
    }

    const exportData = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    console.log('[Import] ✓ Loaded export file');
    console.log(`[Import]   - Controllers: ${exportData.controllers.length}`);
    console.log(`[Import]   - Fieldbuses: ${exportData.fieldbuses.length}`);
    console.log(`[Import]   - Projects: ${exportData.summary.projects.join(', ')}\n`);

    // Connect to Neon
    console.log(`[Import] Connecting to Neon: ${targetConfig.host}`);
    targetPool = new Pool(targetConfig);
    await targetPool.query('SELECT 1');
    console.log('[Import] ✓ Connected to Neon\n');

    // Map local project names to Neon project IDs
    console.log('[Import] Mapping projects...');
    const projectMap = {}; // local_project_id → neon_project_id
    for (const controller of exportData.controllers) {
      const projectName = controller.project_name;
      if (!projectName || projectMap[controller.project_id]) continue;

      const projResult = await targetPool.query(
        'SELECT id FROM projects WHERE name = $1',
        [projectName]
      );
      if (projResult.rows.length === 0) {
        throw new Error(`Project "${projectName}" not found in Neon. Please create it first.`);
      }
      projectMap[controller.project_id] = projResult.rows[0].id;
      console.log(`[Import]   ✓ ${projectName} → ID ${projResult.rows[0].id}`);
    }
    console.log('');

    // Map local controller IDs to Neon controller IDs (after insertion)
    const controllerMap = {}; // local_id → neon_id

    // Insert controllers (without original IDs, let DB auto-increment)
    console.log('[Import] Inserting controllers...');
    for (const controller of exportData.controllers) {
      const neonProjectId = projectMap[controller.project_id];

      // Convert field names from lowercase to canonical case
      const insertResult = await targetPool.query(
        `INSERT INTO hw_controllers (
          project_id, T16_Controller_TagName, T16_Station_Type, T24_Program_Container,
          INT_Controller_No, T8_Version, T15_IP_Address,
          T50_Rack_Order_No, T50_Rack_Name, T50_PS_Order_No, T50_PS_Name,
          YN_Redundant, YN_Slave, MEM_Doc_Change
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id`,
        [
          neonProjectId,
          controller.t16_controller_tagname || null,
          controller.t16_station_type || null,
          controller.t24_program_container || null,
          controller.int_controller_no || null,
          controller.t8_version || null,
          controller.t15_ip_address || null,
          controller.t50_rack_order_no || null,
          controller.t50_rack_name || null,
          controller.t50_ps_order_no || null,
          controller.t50_ps_name || null,
          controller.yn_redundant || false,
          controller.yn_slave || false,
          controller.mem_doc_change || null,
        ]
      );

      const newId = insertResult.rows[0].id;
      controllerMap[controller.id] = newId;
      console.log(`[Import]   ✓ Controller ID ${controller.id} → ${newId} (${controller.t16_controller_tagname || 'unnamed'})`);
    }
    console.log('');

    // Insert fieldbuses with mapped controller IDs
    console.log('[Import] Inserting fieldbuses...');
    let fbCount = 0;
    for (const fieldbus of exportData.fieldbuses) {
      const newControllerId = controllerMap[fieldbus.hw_controller_id];
      if (!newControllerId) {
        console.log(`[Import]   ⚠ Fieldbus ${fieldbus.id}: controller ${fieldbus.hw_controller_id} not mapped, skipping`);
        continue;
      }

      await targetPool.query(
        `INSERT INTO hw_fieldbuses (
          hw_controller_id, INT_DP_Subsystem, INT_Bus_DP_Address,
          T50_Fieldbus_Name, LINT_T_Driver, T15_IP_Address
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newControllerId,
          fieldbus.int_dp_subsystem || null,
          fieldbus.int_bus_dp_address || null,
          fieldbus.t50_fieldbus_name || null,
          fieldbus.lint_t_driver || null,
          fieldbus.t15_ip_address || null,
        ]
      );
      fbCount++;
    }
    console.log(`[Import]   ✓ Inserted ${fbCount} fieldbuses\n`);

    // Verify import
    console.log('[Import] Verifying import...');
    const verifyControllers = await targetPool.query('SELECT COUNT(*) as cnt FROM hw_controllers');
    const verifyFieldbuses = await targetPool.query('SELECT COUNT(*) as cnt FROM hw_fieldbuses');
    console.log(`[Import]   ✓ Total controllers in Neon: ${verifyControllers.rows[0].cnt}`);
    console.log(`[Import]   ✓ Total fieldbuses in Neon: ${verifyFieldbuses.rows[0].cnt}`);

    console.log('\n[Import] ✓ Import complete!');

  } catch (error) {
    console.error('\n[Import] ✗ Error:', error.message);
    if (error.code) console.error(`[Import] Error code: ${error.code}`);
    process.exit(1);
  } finally {
    if (targetPool) await targetPool.end();
  }
}

importControllers();
