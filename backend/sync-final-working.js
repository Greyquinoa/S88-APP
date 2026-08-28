#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const LOCAL = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'super@123',
  database: 's88_app'
};

const NEON = {
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false }
};

async function main() {
  let local, neon;

  try {
    console.log('🔌 Connecting...');
    local = new Pool(LOCAL);
    neon = new Pool(NEON);
    await Promise.all([local.query('SELECT 1'), neon.query('SELECT 1')]);
    console.log('✓ Connected\n');

    // Get all tables
    const tables = await local.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);

    const tableNames = tables.rows.map(r => r.table_name);

    // Determine sync order
    const fks = await local.query(`
      SELECT tc.table_name, ccu.table_name AS ftable FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      GROUP BY tc.table_name, ccu.table_name
    `);

    const deps = new Map(tableNames.map(t => [t, new Set()]));
    fks.rows.forEach(fk => {
      if (deps.has(fk.table_name) && deps.has(fk.ftable)) {
        deps.get(fk.table_name).add(fk.ftable);
      }
    });

    const result = [], visited = new Set();
    function visit(t) {
      if (visited.has(t)) return;
      visited.add(t);
      (deps.get(t) || new Set()).forEach(d => visit(d));
      result.push(t);
    }
    tableNames.forEach(t => visit(t));

    // Find and drop self-referential FKs
    console.log('🔧 Handling self-referential constraints...');
    const selfRefFks = await local.query(`
      SELECT tc.table_name, tc.constraint_name FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      AND tc.table_name = ccu.table_name
    `);

    for (const fk of selfRefFks.rows) {
      try {
        await neon.query(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT ${fk.constraint_name}`);
        console.log(`  Dropped: ${fk.constraint_name}`);
      } catch (e) {
        // Might not exist yet
      }
    }
    console.log('✓ Ready\n');

    console.log('📦 Syncing data...');
    let totalRows = 0;
    let tableIdx = 0;

    for (const tableName of result) {
      tableIdx++;
      const cols = await local.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position
      `, [tableName]);

      const colNames = cols.rows.map(c => c.column_name);
      const data = await local.query(`SELECT * FROM ${tableName}`);

      if (data.rows.length === 0) continue;

      // Find the ID column if it exists
      const idCol = colNames.find(c => ['id'].includes(c));

      // Set sequence to max ID + 1 if ID column exists
      if (idCol) {
        const maxRes = await local.query(`SELECT MAX(${idCol}) as max_id FROM ${tableName}`);
        const maxId = maxRes.rows[0].max_id || 0;

        if (maxId > 0) {
          const seqName = `${tableName}_${idCol}_seq`;
          try {
            await neon.query(`SELECT setval('${seqName}', ${maxId})`);
          } catch (e) {
            // Sequence might not exist or already set
          }
        }
      }

      // Insert data
      const batchSize = 500;
      for (let i = 0; i < data.rows.length; i += batchSize) {
        const batch = data.rows.slice(i, i + batchSize);
        const placeholders = batch.map((_, idx) =>
          `(${colNames.map((_, j) => `$${idx * colNames.length + j + 1}`).join(', ')})`
        ).join(', ');

        const vals = [];
        batch.forEach(row => colNames.forEach(col => vals.push(row[col] ?? null)));

        const insertSql = `INSERT INTO ${tableName} (${colNames.join(', ')}) VALUES ${placeholders}`;
        try {
          await neon.query(insertSql, vals);
        } catch (e) {
          console.error(`\n❌ ${tableName}: ${e.message}`);
          throw e;
        }
      }

      totalRows += data.rows.length;
      process.stdout.write(`\r  [${tableIdx}/${result.length}] ${totalRows} rows synced`);
    }

    console.log(`\n✓ Synced ${totalRows} rows`);

    // Restore self-referential FKs
    console.log('\n🔗 Restoring self-referential constraints...');
    for (const fk of selfRefFks.rows) {
      try {
        await neon.query(`ALTER TABLE ${fk.table_name} ADD CONSTRAINT ${fk.constraint_name} FOREIGN KEY (parent_id) REFERENCES ${fk.table_name}(id)`);
      } catch (e) {
        console.log(`  ⚠️  ${fk.constraint_name}: ${e.message.split('\n')[0]}`);
      }
    }

    console.log('✅ Database sync complete!');

  } catch (e) {
    console.error('\n❌', e.message);
    process.exit(1);
  } finally {
    if (local) await local.end();
    if (neon) await neon.end();
  }
}

main().catch(console.error);
