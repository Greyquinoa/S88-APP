#!/usr/bin/env node
/**
 * Import Generated CFG to Neon Script
 *
 * This imports the hw_generated_cfgs table which contains the parsed CFG structure
 * needed to display controller details and subslot information.
 *
 * Usage:
 *   NEON_HOST=... NEON_USER=... NEON_PASSWORD=... node import-cfg-to-neon.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');

const sourceConfig = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
};

const targetConfig = {
  host: process.env.NEON_HOST,
  port: Number(process.env.NEON_PORT) || 5432,
  user: process.env.NEON_USER,
  password: process.env.NEON_PASSWORD,
  database: process.env.NEON_DATABASE || 's88_app',
  ssl: { rejectUnauthorized: false },
};

async function importCfg() {
  let sourcePool, targetPool;

  try {
    console.log('[Import CFG] Starting CFG import to Neon...\n');

    if (!targetConfig.host || !targetConfig.user || !targetConfig.password) {
      throw new Error('Missing Neon credentials. Set: NEON_HOST, NEON_USER, NEON_PASSWORD');
    }

    console.log('[Import CFG] Connecting to source (local)...');
    sourcePool = new Pool(sourceConfig);
    await sourcePool.query('SELECT 1');
    console.log('[Import CFG] ✓ Connected to source\n');

    console.log('[Import CFG] Connecting to target (Neon)...');
    targetPool = new Pool(targetConfig);
    await targetPool.query('SELECT 1');
    console.log('[Import CFG] ✓ Connected to target\n');

    // Get CFGs from local
    console.log('[Import CFG] Fetching hw_generated_cfgs from local...');
    const cfgsResult = await sourcePool.query('SELECT * FROM hw_generated_cfgs');
    const cfgs = cfgsResult.rows;
    console.log(`[Import CFG] ✓ Found ${cfgs.length} CFGs\n`);

    // Import mapping: local import_id → neon import_id
    // For now, assume local import_id 1 → neon import_id 5 (the latest)
    const importIdMap = { 1: 5 };

    console.log('[Import CFG] Inserting hw_generated_cfgs...');
    for (const cfg of cfgs) {
      const neonImportId = importIdMap[cfg.hw_import_id];
      if (!neonImportId) {
        console.log(`[Import CFG]   ⚠ Skipping CFG ${cfg.id}: import ${cfg.hw_import_id} not mapped`);
        continue;
      }

      await targetPool.query(
        `INSERT INTO hw_generated_cfgs (
          hw_import_id, cfg_text, stats
        ) VALUES ($1, $2, $3)`,
        [
          neonImportId,
          cfg.cfg_text || null,
          cfg.stats || null,
        ]
      );
      console.log(`[Import CFG]   ✓ Inserted CFG for import ${neonImportId} (${cfg.cfg_text ? (cfg.cfg_text.length / 1024).toFixed(1) : 0} KB)`);
    }
    console.log('');

    // Verify
    console.log('[Import CFG] Verifying import...');
    const verify = await targetPool.query('SELECT COUNT(*) as cnt FROM hw_generated_cfgs');
    console.log(`[Import CFG]   ✓ Total hw_generated_cfgs: ${verify.rows[0].cnt}`);

    console.log('\n[Import CFG] ✓ Import complete!');

  } catch (error) {
    console.error('\n[Import CFG] ✗ Error:', error.message);
    if (error.code) console.error(`[Import CFG] Error code: ${error.code}`);
    process.exit(1);
  } finally {
    if (sourcePool) await sourcePool.end();
    if (targetPool) await targetPool.end();
  }
}

importCfg();
