#!/usr/bin/env node
'use strict';

/**
 * Final comprehensive sync - creates sequences, tables, FKs, and syncs all data
 */

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

    // Step 1: Create all sequences
    console.log('🔢 Creating sequences...');
    const sequences = await local.query(`
      SELECT sequence_name FROM information_schema.sequences
      WHERE sequence_schema = 'public'
    `);

    for (const seq of sequences.rows) {
      const seqName = seq.sequence_name;
      try {
        await neon.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName}`);
      } catch (e) {
        console.log(`⚠️  ${seqName}`);
      }
    }
    console.log(`✓ Created ${sequences.rows.length} sequences\n`);

    // Step 2: Create all tables
    console.log('📋 Creating tables...');
    const tables = await local.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);

    for (const t of tables.rows) {
      const tableName = t.table_name;
      const cols = await local.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      const colDefs = cols.rows.map(c => {
        let def = c.column_name + ' ' + c.data_type;
        if (c.is_nullable === 'NO') def += ' NOT NULL';
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        return def;
      });

      const pk = await local.query(`
        SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class t ON i.indrelid = t.oid
        WHERE t.relname = $1 AND i.indisprimary
      `, [tableName]);

      if (pk.rows.length > 0) {
        colDefs.push(`PRIMARY KEY (${pk.rows.map(r => r.attname).join(', ')})`);
      }

      const createSql = `CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(', ')})`;
      try {
        await neon.query(createSql);
      } catch (e) {
        console.log(`⚠️  ${tableName}: ${e.message.split('\n')[0]}`);
      }
    }
    console.log(`✓ Created ${tables.rows.length} tables\n`);

    // Step 3: Add foreign keys
    console.log('🔗 Adding foreign keys...');
    const fks = await local.query(`
      SELECT
        tc.table_name, kcu.column_name,
        ccu.table_name AS ftable, ccu.column_name AS fcol,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);

    for (const fk of fks.rows) {
      const sql = `ALTER TABLE ${fk.table_name} ADD CONSTRAINT ${fk.constraint_name}
        FOREIGN KEY (${fk.column_name}) REFERENCES ${fk.ftable}(${fk.fcol})`;
      try {
        await neon.query(sql);
      } catch (e) {
        if (!e.message.includes('already')) {
          console.log(`⚠️  ${fk.constraint_name}`);
        }
      }
    }
    console.log(`✓ Added foreign keys\n`);

    // Step 4: Sync data with dependency order
    console.log('📦 Syncing data...');
    const depOrder = await getSyncOrder(local, tables.rows.map(r => r.table_name));

    let totalRows = 0;
    for (const tableName of depOrder) {
      const cols = await local.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position
      `, [tableName]);

      const colNames = cols.rows.map(c => c.column_name);
      const data = await local.query(`SELECT * FROM ${tableName}`);

      if (data.rows.length === 0) continue;

      // Clear and insert
      try {
        await neon.query(`DELETE FROM ${tableName}`);
      } catch (e) {}

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
          // For self-referential tables, drop FK constraint temporarily
          if (tableName === 'io_hierarchy_nodes') {
            await neon.query('ALTER TABLE io_hierarchy_nodes DROP CONSTRAINT io_hierarchy_nodes_parent_id_fkey');
            await neon.query(insertSql, vals);
            await neon.query('ALTER TABLE io_hierarchy_nodes ADD CONSTRAINT io_hierarchy_nodes_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES io_hierarchy_nodes(id)');
          } else if (tableName === 'project_hierarchy_folders') {
            await neon.query('ALTER TABLE project_hierarchy_folders DROP CONSTRAINT project_hierarchy_folders_parent_id_fkey');
            await neon.query(insertSql, vals);
            await neon.query('ALTER TABLE project_hierarchy_folders ADD CONSTRAINT project_hierarchy_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES project_hierarchy_folders(id)');
          } else if (tableName === 'unit_type_member_roles') {
            await neon.query('ALTER TABLE unit_type_member_roles DROP CONSTRAINT unit_type_member_roles_member_id_fkey');
            await neon.query(insertSql, vals);
            await neon.query('ALTER TABLE unit_type_member_roles ADD CONSTRAINT unit_type_member_roles_member_id_fkey FOREIGN KEY (member_id) REFERENCES unit_type_members(id)');
          } else {
            await neon.query(insertSql, vals);
          }
        } catch (e) {
          console.error(`\n❌ ${tableName}: ${e.message}`);
          throw e;
        }
      }

      totalRows += data.rows.length;
      process.stdout.write(`\r  ${totalRows} rows synced`);
    }

    console.log(`\n✓ Synced ${totalRows} rows\n✅ Complete!`);

  } catch (e) {
    console.error('\n❌', e.message);
    process.exit(1);
  } finally {
    if (local) await local.end();
    if (neon) await neon.end();
  }
}

async function getSyncOrder(pool, tableNames) {
  const fks = await pool.query(`
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
  return result;
}

main().catch(console.error);
