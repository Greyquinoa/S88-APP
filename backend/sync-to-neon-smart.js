#!/usr/bin/env node
'use strict';

/**
 * Smart sync: Syncs only missing schema columns and data to Neon
 */

const { Pool } = require('pg');

const LOCAL_CONFIG = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'super@123',
  database: 's88_app'
};

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
    console.log('🔌 Connecting to databases...');
    localPool = new Pool(LOCAL_CONFIG);
    await localPool.query('SELECT 1');

    neonPool = new Pool(NEON_CONFIG);
    await neonPool.query('SELECT 1');
    console.log('✓ Connected to both databases\n');

    // Get all tables from local
    const tables = await localPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tableNames = tables.rows.map(r => r.table_name);

    let addedCols = 0;
    let syncedTables = 0;

    for (const tableName of tableNames) {
      // Get columns from both databases
      const localCols = await localPool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

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
            console.log(`✓ Added column: ${tableName}.${col.column_name}`);
            addedCols++;
          } catch (e) {
            console.log(`⚠️  Column ${tableName}.${col.column_name}: ${e.message}`);
          }
        }
      }

      // Sync data
      const localData = await localPool.query(`SELECT * FROM ${tableName}`);

      if (localData.rows.length === 0) continue;

      // Get current max ID in Neon for each table
      const pkCol = localCols.rows.find(c => c.column_default && c.column_default.includes('nextval'));
      if (!pkCol) continue;

      const neonMax = await neonPool.query(`SELECT MAX(${pkCol.column_name}) as max_id FROM ${tableName}`);
      const maxId = neonMax.rows[0]?.max_id || 0;

      // Only sync rows that don't exist
      const newRows = localData.rows.filter(r => !r[pkCol.column_name] || r[pkCol.column_name] > maxId);

      if (newRows.length > 0) {
        const cols = localCols.rows.map(c => c.column_name);
        const batchSize = 1000;

        for (let i = 0; i < newRows.length; i += batchSize) {
          const batch = newRows.slice(i, i + batchSize);
          const placeholders = batch.map((_, idx) => {
            const rowCols = cols.map((_, cidx) => `$${idx * cols.length + cidx + 1}`);
            return `(${rowCols.join(', ')})`;
          }).join(', ');

          const values = [];
          for (const row of batch) {
            for (const col of cols) {
              values.push(row[col] ?? null);
            }
          }

          const insertSql = `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`;
          await neonPool.query(insertSql, values);
        }

        console.log(`📦 Synced ${newRows.length} rows to ${tableName}`);
        syncedTables++;
      }
    }

    console.log(`\n✅ Sync complete!`);
    console.log(`   Added ${addedCols} columns`);
    console.log(`   Synced data to ${syncedTables} tables`);

  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  } finally {
    if (localPool) await localPool.end();
    if (neonPool) await neonPool.end();
  }
}

main().catch(console.error);
