#!/usr/bin/env node
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const pool = new Pool({
  host:     process.env.PGHOST || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  user:     process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
});

async function checkConstraints() {
  try {
    const res = await pool.query(`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'composite_matrix_cells'
    `);
    console.log('Constraints on composite_matrix_cells:');
    res.rows.forEach(r => console.log(`  - ${r.constraint_name}: ${r.constraint_type}`));
  } finally {
    await pool.end();
  }
}

checkConstraints();
