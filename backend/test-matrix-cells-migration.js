#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');

async function testMigration() {
  const pool = new Pool({
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
  });

  try {
    // Check table structure
    console.log('[TEST] Checking composite_matrix_cells table...');
    const res = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'composite_matrix_cells'
      ORDER BY ordinal_position
    `);

    console.log('[TEST] Current columns:');
    res.rows.forEach(row => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    // Test migration: add id if missing
    const hasId = res.rows.some(r => r.column_name === 'id');
    if (!hasId) {
      console.log('[TEST] id column missing, attempting migration...');
      try {
        await pool.query('ALTER TABLE composite_matrix_cells DROP CONSTRAINT IF EXISTS composite_matrix_cells_pkey');
        console.log('[TEST] Dropped old PK constraint');

        await pool.query('ALTER TABLE composite_matrix_cells ADD COLUMN id SERIAL PRIMARY KEY');
        console.log('[TEST] Added id column as primary key');

        await pool.query('ALTER TABLE composite_matrix_cells ADD CONSTRAINT composite_matrix_cells_mode_id_column_name_key UNIQUE(mode_id, column_name)');
        console.log('[TEST] Added unique constraint on (mode_id, column_name)');

        console.log('[TEST] Migration completed successfully');
      } catch (e) {
        console.error('[TEST] Migration error:', e.message);
      }
    } else {
      console.log('[TEST] id column already exists, no migration needed');
    }

    // Verify table structure after migration
    const resAfter = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'composite_matrix_cells'
      ORDER BY ordinal_position
    `);

    console.log('[TEST] Columns after migration:');
    resAfter.rows.forEach(row => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    // Test INSERT with RETURNING id
    console.log('[TEST] Testing INSERT ... RETURNING id');
    try {
      const result = await pool.query(
        `INSERT INTO composite_matrix_cells (mode_id, column_name, value) VALUES ($1, $2, $3) RETURNING id`,
        [9999, 'TEST_COL', 42]
      );
      console.log('[TEST] INSERT successful, returned id:', result.rows[0]?.id);

      // Clean up test row
      await pool.query('DELETE FROM composite_matrix_cells WHERE mode_id = 9999');
      console.log('[TEST] Test row deleted');
    } catch (e) {
      console.error('[TEST] INSERT error:', e.message);
    }

  } catch (err) {
    console.error('[TEST] Error:', err.message);
  } finally {
    await pool.end();
    console.log('[TEST] Done');
  }
}

testMigration();
