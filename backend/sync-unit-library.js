#!/usr/bin/env node
/**
 * Replace the unit-type / composite-CM library on a remote database with the
 * local one. Local is master.
 *
 * Copies these tables verbatim (ids preserved, so cross-table references and
 * project_instances.composite_id stay valid):
 *
 *   composite_cm_types
 *   composite_cm_members
 *   composite_cm_connections
 *   composite_matrix_columns
 *   composite_matrix_modes
 *   composite_matrix_cells
 *   unit_types
 *   unit_type_members
 *   unit_type_member_roles
 *   unit_type_member_connections
 *
 * Does NOT touch: projects, project_instances, project_hierarchy_folders,
 * io_*, hw_*, eph_em_*, or the CM type library (lib_*).
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Usage:
 *   node sync-unit-library.js "postgresql://user:pass@host/db?sslmode=require"
 *   node sync-unit-library.js "postgresql://..." --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

// Order matters: parents before children on insert, reverse on delete.
const TABLES = [
  'composite_cm_types',
  'composite_cm_members',
  'composite_cm_connections',
  'composite_matrix_columns',
  'composite_matrix_modes',
  'composite_matrix_cells',
  'unit_types',
  'unit_type_members',
  'unit_type_member_roles',
  'unit_type_member_connections',
];

// Tables with a SERIAL id whose sequence must be bumped past the copied rows.
const SERIAL_TABLES = TABLES.filter(t => t !== 'composite_matrix_cells');

async function columnsOf(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`, [table]
  );
  return r.rows.map(x => x.column_name);
}

async function main() {
  const connStr = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!connStr || connStr.startsWith('--')) {
    console.error('Usage: node sync-unit-library.js "<remote-connection-string>" [--apply]');
    process.exit(1);
  }

  const local = new Pool({
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
    ssl:      false,
  });
  // Neon and other hosted providers require SSL; a plain local server rejects it.
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connStr);
  const remote = new Pool({
    connectionString: connStr,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  console.log(apply
    ? '\n*** APPLY MODE — remote tables will be replaced ***\n'
    : '\n--- DRY RUN — no changes written (pass --apply to write) ---\n');

  // Snapshot both sides, and verify the column sets agree.
  const data = {};
  let mismatch = false;

  console.log('table                          local -> remote');
  console.log('-------------------------------------------------');
  for (const t of TABLES) {
    const lCols = await columnsOf(local, t);
    const rCols = await columnsOf(remote, t);

    if (rCols.length === 0) {
      console.log(`${t.padEnd(30)} MISSING ON REMOTE`);
      mismatch = true;
      continue;
    }
    // Copy only columns present on both sides.
    const cols = lCols.filter(c => rCols.includes(c));
    const onlyLocal = lCols.filter(c => !rCols.includes(c));
    const onlyRemote = rCols.filter(c => !lCols.includes(c));

    const rows = (await local.query(`SELECT ${cols.join(', ')} FROM ${t}`)).rows;
    const rCount = (await remote.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
    data[t] = { cols, rows };

    let note = '';
    if (onlyLocal.length)  note += `  [local-only cols skipped: ${onlyLocal.join(',')}]`;
    if (onlyRemote.length) note += `  [remote-only cols left default: ${onlyRemote.join(',')}]`;
    console.log(`${t.padEnd(30)} ${String(rows.length).padStart(4)} -> ${String(rCount).padStart(4)}${note}`);
  }

  if (mismatch) {
    console.error('\nAborting: some tables do not exist on the remote. Run the app once against');
    console.error('Neon so ensureSchema() creates them, then re-run this script.\n');
    await local.end(); await remote.end();
    process.exit(1);
  }

  // Show what the unit types will look like afterward.
  console.log('\nUnit types being copied:');
  for (const ut of data['unit_types'].rows) {
    const members = data['unit_type_members'].rows.filter(m => m.unit_type_id === ut.id);
    console.log(`  ${ut.name} (${members.length} members): ${members.map(m => m.alias).join(', ')}`);
  }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to write.\n');
    await local.end(); await remote.end();
    return;
  }

  const client = await remote.connect();
  try {
    await client.query('BEGIN');

    // Delete children first.
    for (const t of [...TABLES].reverse()) {
      const r = await client.query(`DELETE FROM ${t}`);
      console.log(`  cleared ${t} (${r.rowCount} rows)`);
    }

    // Insert parents first.
    for (const t of TABLES) {
      const { cols, rows } = data[t];
      if (!rows.length) continue;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`;
      for (const row of rows) {
        await client.query(sql, cols.map(c => row[c]));
      }
      console.log(`  inserted ${rows.length} rows into ${t}`);
    }

    // Bump SERIAL sequences past the copied ids so future inserts don't collide.
    for (const t of SERIAL_TABLES) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`,
        [t]
      );
    }
    console.log('  reset id sequences');

    await client.query('COMMIT');
    console.log('\nCommitted.\n');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nRolled back — remote is unchanged:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await local.end();
    await remote.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
