#!/usr/bin/env node
/**
 * Sync the is_valid flag on lib_variables from local to remote.
 *
 * The lib_variables table exists on both sides (with blocks already synced
 * by migrate-data.js), but the is_valid flag marking variables as exposed
 * for wiring may differ. This script updates is_valid to match local without
 * touching other columns.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Usage:
 *   node sync-variable-flags.js "postgresql://user:pass@host/db?sslmode=require"
 *   node sync-variable-flags.js "postgresql://..." --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

async function main() {
  const connStr = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!connStr || connStr.startsWith('--')) {
    console.error('Usage: node sync-variable-flags.js "<remote-connection-string>" [--apply]');
    process.exit(1);
  }

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connStr);
  const local = new Pool({
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
    ssl:      false,
  });
  const remote = new Pool({
    connectionString: connStr,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  console.log(apply
    ? '\n*** APPLY MODE — remote is_valid flags will be updated ***\n'
    : '\n--- DRY RUN — no changes written (pass --apply to write) ---\n');

  // Get the local is_valid map: { block_id: { var_name: is_valid } }
  const localVars = (await local.query(`
    SELECT lb.id AS block_id, lv.name, lv.is_valid
    FROM lib_variables lv
    JOIN lib_blocks lb ON lb.id = lv.block_id
    ORDER BY lb.id, lv.name
  `)).rows;

  const localMap = {};
  for (const v of localVars) {
    if (!localMap[v.block_id]) localMap[v.block_id] = {};
    localMap[v.block_id][v.name] = v.is_valid;
  }

  // Get the remote is_valid map (same structure)
  const remoteVars = (await remote.query(`
    SELECT lb.id AS block_id, lv.name, lv.is_valid
    FROM lib_variables lv
    JOIN lib_blocks lb ON lb.id = lv.block_id
    ORDER BY lb.id, lv.name
  `)).rows;

  const remoteMap = {};
  for (const v of remoteVars) {
    if (!remoteMap[v.block_id]) remoteMap[v.block_id] = {};
    remoteMap[v.block_id][v.name] = v.is_valid;
  }

  // Find mismatches
  let diffs = 0;
  for (const blockId of Object.keys(localMap)) {
    const lBlock = localMap[blockId];
    const rBlock = remoteMap[blockId] || {};
    for (const varName of Object.keys(lBlock)) {
      const lVal = lBlock[varName];
      const rVal = rBlock[varName];
      if (lVal !== rVal) diffs++;
    }
  }

  console.log(`Local variables with is_valid=true: ${localVars.filter(v => v.is_valid).length}`);
  console.log(`Remote variables with is_valid=true: ${remoteVars.filter(v => v.is_valid).length}`);
  console.log(`Differences: ${diffs} variables have mismatched is_valid flags\n`);

  if (diffs === 0) {
    console.log('Flags already match. Nothing to do.\n');
    await local.end(); await remote.end();
    return;
  }

  if (!apply) {
    console.log('Dry run complete. Re-run with --apply to write.\n');
    await local.end(); await remote.end();
    return;
  }

  const client = await remote.connect();
  try {
    await client.query('BEGIN');

    let updated = 0;
    for (const blockId of Object.keys(localMap)) {
      const lBlock = localMap[blockId];
      const rBlock = remoteMap[blockId] || {};
      for (const varName of Object.keys(lBlock)) {
        const lVal = lBlock[varName];
        const rVal = rBlock[varName];
        if (lVal !== rVal) {
          await client.query(
            `UPDATE lib_variables SET is_valid = $1
             WHERE block_id = $2 AND name = $3`,
            [lVal, blockId, varName]
          );
          updated++;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`Updated ${updated} variables.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nRolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await local.end();
    await remote.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
