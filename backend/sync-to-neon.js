#!/usr/bin/env node
'use strict';

/**
 * Comprehensive sync script: Copies entire local database schema and data to Neon
 * Usage: node sync-to-neon.js
 */

const { Pool } = require('pg');

// Local database (your master copy)
const LOCAL_CONFIG = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'super@123',
  database: 's88_app'
};

// Neon database (target)
const NEON_CONFIG = {
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false }
};

async function main() {
  let localPool, neonPool;

  try {
    console.log('📍 Connecting to local database...');
    localPool = new Pool(LOCAL_CONFIG);
    await localPool.query('SELECT 1');
    console.log('✓ Connected to local database');

    console.log('📍 Connecting to Neon database...');
    neonPool = new Pool(NEON_CONFIG);
    await neonPool.query('SELECT 1');
    console.log('✓ Connected to Neon database');

    // Step 1: Get all tables from local database
    console.log('\n📋 Fetching schema from local database...');
    const tables = await localPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tableNames = tables.rows.map(r => r.table_name);
    console.log(`✓ Found ${tableNames.length} tables`);

    // Step 2: Clear all data in Neon (foreign keys first)
    console.log('\n🗑️  Clearing Neon database...');
    await clearNeonDatabase(neonPool, tableNames);
    console.log('✓ Cleared Neon database');

    // Step 3: Determine sync order (tables without FKs first)
    console.log('\n🔍 Determining sync order...');
    const syncOrder = await determineSyncOrder(localPool, tableNames);
    console.log(`✓ Calculated sync order (${syncOrder.length} tables)`);

    // Step 4: Sync schema and data
    console.log('\n🔄 Syncing schema and data...');
    let syncedCount = 0;
    for (const tableName of syncOrder) {
      try {
        await syncTable(localPool, neonPool, tableName);
        syncedCount++;
        process.stdout.write(`\r✓ Synced ${syncedCount}/${syncOrder.length} tables`);
      } catch (e) {
        console.error(`\n❌ Error syncing ${tableName}: ${e.message}`);
        throw e;
      }
    }
    console.log('\n✓ All tables synced');

    console.log('\n✅ Database sync complete!');

  } catch (e) {
    console.error('\n❌ Sync failed:', e.message);
    process.exit(1);
  } finally {
    if (localPool) await localPool.end();
    if (neonPool) await neonPool.end();
  }
}

async function clearNeonDatabase(neonPool, tableNames) {
  // Delete all data from all tables in dependency order (tables without FK last)
  // For simplicity, just delete from each table and let cascade handle it
  for (const table of tableNames) {
    try {
      await neonPool.query(`DELETE FROM ${table}`);
    } catch (e) {
      if (e.code === '23503') {
        // Foreign key error - try later
        continue;
      }
      throw e;
    }
  }

  // Second pass for tables with FK constraints
  for (const table of tableNames) {
    try {
      await neonPool.query(`DELETE FROM ${table}`);
    } catch (e) {
      if (e.code !== '23503') throw e;
    }
  }
}

async function syncTable(localPool, neonPool, tableName) {
  // Get table structure from local
  const columns = await localPool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);

  if (columns.rows.length === 0) {
    return; // Skip if no columns
  }

  // Create table in Neon if it doesn't exist
  let createTableSql = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
  const cols = [];
  const primaryKey = await getTablePrimaryKey(localPool, tableName);

  for (const col of columns.rows) {
    let colDef = `${col.column_name} ${col.data_type}`;

    if (col.is_nullable === 'NO') {
      colDef += ' NOT NULL';
    }

    if (col.column_default) {
      colDef += ` DEFAULT ${col.column_default}`;
    }

    cols.push(colDef);
  }

  if (primaryKey) {
    cols.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
  }

  createTableSql += cols.join(', ') + ')';

  try {
    await neonPool.query(createTableSql);
  } catch (e) {
    if (!e.message.includes('already exists')) {
      // Try to add missing columns instead
      const existingCols = await neonPool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
      `, [tableName]);
      const existingNames = new Set(existingCols.rows.map(r => r.column_name));

      for (const col of columns.rows) {
        if (!existingNames.has(col.column_name)) {
          let colDef = `${col.column_name} ${col.data_type}`;
          if (col.is_nullable === 'NO') colDef += ' NOT NULL';
          if (col.column_default) colDef += ` DEFAULT ${col.column_default}`;
          await neonPool.query(`ALTER TABLE ${tableName} ADD COLUMN ${colDef}`);
        }
      }
    }
  }

  // Get all data from local
  const data = await localPool.query(`SELECT * FROM ${tableName}`);

  if (data.rows.length === 0) {
    return; // Nothing to copy
  }

  // Insert data into Neon in batches
  const columnNames = columns.rows.map(c => c.column_name);
  const batchSize = 1000;

  for (let i = 0; i < data.rows.length; i += batchSize) {
    const batch = data.rows.slice(i, i + batchSize);
    const placeholders = batch.map((_, idx) => {
      const cols = columnNames.map((_, cidx) => `$${idx * columnNames.length + cidx + 1}`);
      return `(${cols.join(', ')})`;
    }).join(', ');

    const values = [];
    for (const row of batch) {
      for (const col of columnNames) {
        values.push(row[col] ?? null);
      }
    }

    const insertSql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES ${placeholders}`;
    await neonPool.query(insertSql, values);
  }
}

async function getTablePrimaryKey(pool, tableName) {
  const result = await pool.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid
    AND a.attnum = ANY(i.indkey)
    JOIN pg_class t ON i.indrelid = t.oid
    WHERE t.relname = $1 AND i.indisprimary
  `, [tableName]);

  return result.rows.map(r => r.attname);
}

async function determineSyncOrder(pool, tableNames) {
  // Get all foreign keys
  const fksResult = await pool.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
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

    for (const dep of dependencies.get(table) || []) {
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
