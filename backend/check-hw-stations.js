#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

const localConfig = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 's88_app',
};

async function check() {
  let pool;
  try {
    console.log('[Check] Connecting to local database...\n');
    pool = new Pool(localConfig);
    await pool.query('SELECT 1');

    console.log('=== HW IMPORTS ===');
    const imports = await pool.query('SELECT * FROM hw_imports ORDER BY id DESC LIMIT 5');
    console.log(`Found ${imports.rows.length} imports:`);
    imports.rows.forEach(i => {
      console.log(`  - ID ${i.id}: ${i.baseline_filename} (${i.status})`);
    });

    if (imports.rows.length === 0) {
      console.log('\n⚠ No HW imports found!\n');
      return;
    }

    const latestImportId = imports.rows[0].id;
    console.log(`\nUsing latest import ID: ${latestImportId}\n`);

    console.log('=== HW STATIONS ===');
    const stations = await pool.query(
      'SELECT * FROM hw_stations WHERE hw_import_id = $1 ORDER BY address',
      [latestImportId]
    );
    console.log(`Found ${stations.rows.length} stations`);
    stations.rows.forEach(s => {
      console.log(`  - Address ${s.address}: ${s.name} (approved: ${s.approved})`);
    });

    console.log('\n=== HW SLOTS ===');
    const slots = await pool.query(
      'SELECT s.*, st.name as station_name FROM hw_slots s JOIN hw_stations st ON s.hw_station_id = st.id WHERE st.hw_import_id = $1 ORDER BY st.address, s.slot',
      [latestImportId]
    );
    console.log(`Found ${slots.rows.length} slots`);
    slots.rows.forEach(s => {
      console.log(`  - Station ${s.station_name} / Slot ${s.slot}: ${s.order_no}`);
    });

    console.log('\n=== GENERATED CFGs ===');
    const cfgs = await pool.query(
      'SELECT * FROM hw_generated_cfgs WHERE hw_import_id = $1 ORDER BY id DESC',
      [latestImportId]
    );
    console.log(`Found ${cfgs.rows.length} CFGs`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    if (pool) await pool.end();
  }
}

check();
