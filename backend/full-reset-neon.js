#!/usr/bin/env node
'use strict';

/**
 * Full reset: Drop all tables and recreate from local database
 * This is the nuclear option - use when you need a clean slate
 */

const { Pool } = require('pg');

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
    console.log('🔌 Connecting to Neon...');
    neonPool = new Pool(NEON_CONFIG);
    await neonPool.query('SELECT 1');
    console.log('✓ Connected to Neon\n');

    // Drop all tables and sequences
    console.log('🗑️  Dropping all tables and sequences...');
    const tables = await neonPool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `);

    for (const t of tables.rows) {
      try {
        await neonPool.query(`DROP TABLE IF EXISTS ${t.tablename} CASCADE`);
        console.log(`  Dropped: ${t.tablename}`);
      } catch (e) {
        console.log(`  ⚠️  ${t.tablename}: ${e.message}`);
      }
    }

    const sequences = await neonPool.query(`
      SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
    `);

    for (const s of sequences.rows) {
      try {
        await neonPool.query(`DROP SEQUENCE IF EXISTS ${s.sequencename}`);
      } catch (e) {}
    }

    console.log('✓ Cleaned Neon database\n');

    // Now copy schema and data from local
    console.log('🔌 Connecting to local database...');
    localPool = new Pool(LOCAL_CONFIG);
    await localPool.query('SELECT 1');
    console.log('✓ Connected\n');

    // Get DDL for all tables from local
    console.log('📋 Creating tables from local schema...');
    const tableDefs = await localPool.query(`
      SELECT
        tablename,
        pg_get_table_def(('public.' || tablename)::regclass) as table_def
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    for (const t of tableDefs.rows) {
      try {
        await neonPool.query(t.table_def);
        console.log(`  Created: ${t.tablename}`);
      } catch (e) {
        console.log(`  ⚠️  ${t.tablename}: ${e.message.split('\n')[0]}`);
      }
    }

    console.log('\n📦 Syncing data...');

    // Get table list
    const tables2 = await localPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    let totalRows = 0;
    for (const t of tables2.rows) {
      const tableName = t.table_name;

      // Get all columns
      const cols = await localPool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      if (cols.rows.length === 0) continue;

      const colNames = cols.rows.map(c => c.column_name);

      // Get all data
      const data = await localPool.query(`SELECT * FROM ${tableName}`);

      if (data.rows.length === 0) continue;

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
          console.log(`  ⚠️  Error inserting into ${tableName}: ${e.message.split('\n')[0]}`);
        }
      }

      totalRows += data.rows.length;
      console.log(`  ${tableName}: ${data.rows.length} rows`);
    }

    console.log(`\n✅ Sync complete! Inserted ${totalRows} rows`);

  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  } finally {
    if (neonPool) await neonPool.end();
    if (localPool) await localPool.end();
  }
}

main().catch(console.error);
