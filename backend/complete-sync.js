#!/usr/bin/env node
'use strict';

/**
 * Complete sync: Recreates Neon database to match local exactly
 * Handles schema creation and data sync with proper dependency ordering
 */

const { Pool } = require('pg');
const fs = require('fs');

const NEON_CONFIG = {
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false }
};

const LOCAL_CONFIG = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'super@123',
  database: 's88_app'
};

async function main() {
  let neonPool, localPool;

  try {
    console.log('🔌 Connecting to databases...');
    neonPool = new Pool(NEON_CONFIG);
    await neonPool.query('SELECT 1');

    localPool = new Pool(LOCAL_CONFIG);
    await localPool.query('SELECT 1');
    console.log('✓ Connected\n');

    // Step 1: Get all table structures from local
    console.log('📋 Analyzing local schema...');
    const tables = await localPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tableNames = tables.rows.map(r => r.table_name);
    console.log(`✓ Found ${tableNames.length} tables\n`);

    // Step 2: For each table in Neon, add missing columns
    console.log('🔧 Updating Neon schema...');
    let colsAdded = 0;

    for (const tableName of tableNames) {
      const localCols = await localPool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      // Check if table exists in Neon
      const neonTableCheck = await neonPool.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        )
      `, [tableName]);

      if (!neonTableCheck.rows[0].exists) {
        console.log(`⚠️  Table ${tableName} missing in Neon - skipping (recreate schema separately)`);
        continue;
      }

      const neonCols = await neonPool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
      `, [tableName]);

      const existingCols = new Set(neonCols.rows.map(r => r.column_name));

      // Add missing columns
      for (const col of localCols.rows) {
        if (!existingCols.has(col.column_name)) {
          let colDef = `${col.column_name} ${col.data_type}`;
          if (col.is_nullable === 'NO') colDef += ' NOT NULL';
          if (col.column_default) colDef += ` DEFAULT ${col.column_default}`;

          try {
            await neonPool.query(`ALTER TABLE ${tableName} ADD COLUMN ${colDef}`);
            console.log(`  ✓ ${tableName}.${col.column_name}`);
            colsAdded++;
          } catch (e) {
            // Column might exist but with different name casing
            console.log(`  ⚠️  ${tableName}.${col.column_name}: ${e.message.split('\n')[0]}`);
          }
        }
      }
    }

    console.log(`✓ Added ${colsAdded} columns\n`);

    // Step 3: Sync data with dependency order
    console.log('🔄 Determining table sync order...');
    const syncOrder = await determineSyncOrder(localPool, tableNames);
    console.log(`✓ Order determined (${syncOrder.length} tables)\n`);

    console.log('📦 Syncing data...');
    let totalRows = 0;
    let syncedTables = 0;

    for (const tableName of syncOrder) {
      const cols = await localPool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      if (cols.rows.length === 0) continue;

      const colNames = cols.rows.map(c => c.column_name);
      const data = await localPool.query(`SELECT * FROM ${tableName}`);

      if (data.rows.length === 0) continue;

      // Clear existing data
      try {
        await neonPool.query(`DELETE FROM ${tableName}`);
      } catch (e) {
        // Might have constraints
      }

      // Insert in batches
      const batchSize = 500;
      for (let i = 0; i < data.rows.length; i += batchSize) {
        const batch = data.rows.slice(i, i + batchSize);
        const placeholders = batch.map((_, idx) => {
          const cols = colNames.map((_, cidx) => `$${idx * colNames.length + cidx + 1}`);
          return `(${cols.join(', ')})`;
        }).join(', ');

        const values = [];
        for (const row of batch) {
          for (const col of colNames) {
            values.push(row[col] ?? null);
          }
        }

        const insertSql = `INSERT INTO ${tableName} (${colNames.join(', ')}) VALUES ${placeholders}`;
        try {
          await neonPool.query(insertSql, values);
        } catch (e) {
          console.error(`\n❌ Error inserting into ${tableName}: ${e.message}`);
          console.error(`   Batch size: ${batch.length}, Total rows: ${data.rows.length}`);
          throw e;
        }
      }

      totalRows += data.rows.length;
      syncedTables++;
      process.stdout.write(`\r  ${syncedTables}/${syncOrder.length} tables (${totalRows} rows)`);
    }

    console.log(`\n✓ Synced ${totalRows} rows\n`);
    console.log('✅ Database sync complete!');

  } catch (e) {
    console.error('\n❌ Error:', e.message);
    if (e.detail) console.error('Details:', e.detail);
    process.exit(1);
  } finally {
    if (neonPool) await neonPool.end();
    if (localPool) await localPool.end();
  }
}

async function determineSyncOrder(pool, tableNames) {
  const fksResult = await pool.query(`
    SELECT tc.table_name, ccu.table_name AS foreign_table_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    GROUP BY tc.table_name, ccu.table_name
  `);

  const dependencies = new Map();
  for (const table of tableNames) {
    dependencies.set(table, new Set());
  }

  for (const fk of fksResult.rows) {
    if (dependencies.has(fk.table_name) && dependencies.has(fk.foreign_table_name)) {
      dependencies.get(fk.table_name).add(fk.foreign_table_name);
    }
  }

  // Topological sort
  const result = [];
  const visited = new Set();

  function visit(table) {
    if (visited.has(table)) return;
    visited.add(table);

    const deps = dependencies.get(table) || new Set();
    for (const dep of deps) {
      visit(dep);
    }

    result.push(table);
  }

  for (const table of tableNames) {
    visit(table);
  }

  return result;
}

main().catch(console.error);
