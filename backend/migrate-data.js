#!/usr/bin/env node
/**
 * Data Migration Script: Local PostgreSQL → Neon
 *
 * Copy all tables and data from local database to Neon cloud database
 *
 * Usage:
 *   node migrate-data.js
 *
 * Set environment variables for Neon target:
 *   NEON_HOST, NEON_PORT, NEON_USER, NEON_PASSWORD, NEON_DATABASE
 */

const { Pool } = require('pg');
const fs = require('fs');

// Source: Local PostgreSQL
const sourceConfig = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
};

// Target: Neon
const targetConfig = {
  host: process.env.NEON_HOST,
  port: Number(process.env.NEON_PORT) || 5432,
  user: process.env.NEON_USER,
  password: process.env.NEON_PASSWORD,
  database: process.env.NEON_DATABASE || 's88_app',
  ssl: { rejectUnauthorized: false },
};

async function migrate() {
  let sourcePool, targetPool;

  try {
    console.log('[Migration] Starting data migration...\n');

    // Validate Neon credentials
    if (!targetConfig.host || !targetConfig.user || !targetConfig.password) {
      throw new Error(
        'Missing Neon credentials. Set: NEON_HOST, NEON_USER, NEON_PASSWORD\n\n' +
        'Example:\n' +
        '  NEON_HOST=abc123.neon.tech \\\n' +
        '  NEON_USER=myuser \\\n' +
        '  NEON_PASSWORD=mypass \\\n' +
        '  node migrate-data.js'
      );
    }

    // Connect to both databases
    console.log(`[Migration] Connecting to source (local): ${sourceConfig.host}:${sourceConfig.port}`);
    sourcePool = new Pool(sourceConfig);
    await sourcePool.query('SELECT 1');
    console.log('[Migration] ✓ Connected to source\n');

    console.log(`[Migration] Connecting to target (Neon): ${targetConfig.host}`);
    targetPool = new Pool(targetConfig);
    await targetPool.query('SELECT 1');
    console.log('[Migration] ✓ Connected to target\n');

    // Get all tables from source
    console.log('[Migration] Fetching table list...');
    const tableResult = await sourcePool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const tables = tableResult.rows.map(r => r.table_name);
    console.log(`[Migration] Found ${tables.length} tables\n`);

    // Disable foreign keys on target (for clean insert)
    await targetPool.query('SET session_replication_role = REPLICA');
    console.log('[Migration] Disabled foreign key checks on target\n');

    // Copy each table
    let totalRows = 0;
    for (const table of tables) {
      try {
        // Get data from source
        const dataResult = await sourcePool.query(`SELECT * FROM "${table}"`);
        const rows = dataResult.rows;

        if (rows.length === 0) {
          console.log(`[Migration] ${table}: No data (skipped)`);
          continue;
        }

        // Clear target table
        await targetPool.query(`TRUNCATE TABLE "${table}" CASCADE`);

        // Prepare insert query
        const columns = Object.keys(rows[0]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const columnNames = columns.map(c => `"${c}"`).join(', ');
        const insertQuery = `INSERT INTO "${table}" (${columnNames}) VALUES (${placeholders})`;

        // Insert rows in batches
        const batchSize = 100;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          for (const row of batch) {
            const values = columns.map(col => row[col]);
            await targetPool.query(insertQuery, values);
          }
        }

        console.log(`[Migration] ✓ ${table}: ${rows.length} rows copied`);
        totalRows += rows.length;
      } catch (err) {
        console.error(`[Migration] ✗ ${table}: Error - ${err.message}`);
      }
    }

    // Re-enable foreign keys
    await targetPool.query('SET session_replication_role = DEFAULT');
    console.log('\n[Migration] Re-enabled foreign key checks\n');

    console.log(`[Migration] ✓ Migration complete!`);
    console.log(`[Migration] Total rows migrated: ${totalRows}\n`);

  } catch (error) {
    console.error('\n[Migration] ✗ Error:', error.message);
    process.exit(1);
  } finally {
    if (sourcePool) await sourcePool.end();
    if (targetPool) await targetPool.end();
  }
}

migrate();
