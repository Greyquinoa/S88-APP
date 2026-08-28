#!/usr/bin/env node
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
  const local = new Pool(LOCAL_CONFIG);
  const neon = new Pool(NEON_CONFIG);

  try {
    console.log('📋 Extracting schema from local...\n');

    // Get all tables
    const tables = await local.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    let createCount = 0;

    for (const t of tables.rows) {
      const tableName = t.table_name;

      // Get columns
      const cols = await local.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      if (cols.rows.length === 0) continue;

      // Build CREATE TABLE statement
      const colDefs = cols.rows.map(c => {
        let def = c.column_name + ' ' + c.data_type;
        if (c.is_nullable === 'NO') def += ' NOT NULL';
        if (c.column_default) {
          // Handle sequence defaults
          if (c.column_default.includes('nextval')) {
            def += ` DEFAULT ${c.column_default}`;
          }
        }
        return def;
      });

      // Get primary key
      const pk = await local.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class t ON i.indrelid = t.oid
        WHERE t.relname = $1 AND i.indisprimary
      `, [tableName]);

      if (pk.rows.length > 0) {
        const pkCols = pk.rows.map(r => r.attname).join(', ');
        colDefs.push(`PRIMARY KEY (${pkCols})`);
      }

      const createTableSql = `CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(', ')})`;

      try {
        await neon.query(createTableSql);
        console.log(`✓ Created: ${tableName}`);
        createCount++;
      } catch (e) {
        console.log(`⚠️  ${tableName}: ${e.message.split('\n')[0]}`);
      }
    }

    console.log(`\n✓ Created ${createCount} tables\n`);

    // Now add foreign keys
    console.log('🔗 Adding foreign keys...\n');
    const fks = await local.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      ORDER BY tc.table_name, tc.constraint_name
    `);

    let fkCount = 0;
    for (const fk of fks.rows) {
      const sql = `ALTER TABLE ${fk.table_name}
        ADD CONSTRAINT ${fk.constraint_name}
        FOREIGN KEY (${fk.column_name})
        REFERENCES ${fk.foreign_table_name}(${fk.foreign_column_name})`;

      try {
        await neon.query(sql);
        fkCount++;
      } catch (e) {
        if (!e.message.includes('already exists')) {
          console.log(`⚠️  FK ${fk.constraint_name}: ${e.message.split('\n')[0]}`);
        }
      }
    }

    console.log(`✓ Added ${fkCount} foreign keys\n✅ Schema ready!`);

  } finally {
    await local.end();
    await neon.end();
  }
}

main().catch(console.error);
