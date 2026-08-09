#!/usr/bin/env node
/**
 * Replace the CM type library (lib_cm_types / lib_blocks / lib_variables) on a
 * remote database with the local one. Local is master.
 *
 * Unlike sync-unit-library.js, this cannot upsert by id: the two libraries were
 * generated independently and their block ids do not overlap at all (local has
 * no IF_FRONT blocks; remote's live at ids 3720-3978). So the three tables are
 * deleted and reinserted wholesale, ids preserved from local.
 *
 * This is safe because nothing references these tables by id — the only FK is
 * lib_io_connections.cm_type_id, which is empty. Every other consumer
 * (composite_cm_members, project_instances, project_cmt_profiles, ...) stores
 * the CM type *name* as text, so references survive as long as the name exists
 * locally. Names in use on the remote that local lacks are reported before any
 * write; --force proceeds anyway.
 *
 * Does NOT touch: projects, project_instances, composites, unit types, io_*,
 * hw_*, eph_em_*.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Usage:
 *   node sync-cm-library.js "postgresql://user:pass@host/db?sslmode=require"
 *   node sync-cm-library.js "postgresql://..." --apply
 *   node sync-cm-library.js "postgresql://..." --apply --force
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

// Parents before children on insert; reversed on delete.
const TABLES = ['lib_cm_types', 'lib_blocks', 'lib_variables'];

// Tables elsewhere in the schema that name a CM type as free text. Checked for
// dangling references before the swap.
const NAME_REFS = [
  ['composite_cm_members', 'cm_type_name'],
  ['unit_type_members',    'cm_type_name'],
  ['project_instances',    'cm_type'],
  ['project_cmt_profiles', 'cm_type'],
  ['user_cm_block_prefs',  'cm_type_name'],
];

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
  const force = process.argv.includes('--force');

  if (!connStr || connStr.startsWith('--')) {
    console.error('Usage: node sync-cm-library.js "<remote-connection-string>" [--apply] [--force]');
    process.exit(1);
  }

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connStr);
  const local = new Pool({
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
    ssl:      false,
  });
  const remote = new Pool({
    connectionString: connStr,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  console.log(apply
    ? '\n*** APPLY MODE — remote CM library will be replaced ***\n'
    : '\n--- DRY RUN — no changes written (pass --apply to write) ---\n');

  // Snapshot local, compare shapes.
  const data = {};
  let mismatch = false;

  console.log('table                     local -> remote');
  console.log('------------------------------------------');
  for (const t of TABLES) {
    const lCols = await columnsOf(local, t);
    const rCols = await columnsOf(remote, t);
    if (rCols.length === 0) {
      console.log(`${t.padEnd(25)} MISSING ON REMOTE`);
      mismatch = true;
      continue;
    }
    const cols = lCols.filter(c => rCols.includes(c));
    const onlyLocal  = lCols.filter(c => !rCols.includes(c));
    const onlyRemote = rCols.filter(c => !lCols.includes(c));

    const rows = (await local.query(`SELECT ${cols.join(', ')} FROM ${t}`)).rows;
    const rCount = (await remote.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
    data[t] = { cols, rows };

    let note = '';
    if (onlyLocal.length)  note += `  [local-only cols skipped: ${onlyLocal.join(',')}]`;
    if (onlyRemote.length) note += `  [remote-only cols left default: ${onlyRemote.join(',')}]`;
    console.log(`${t.padEnd(25)} ${String(rows.length).padStart(5)} -> ${String(rCount).padStart(5)}${note}`);
  }

  if (mismatch) {
    console.error('\nAborting: some tables do not exist on the remote.\n');
    await local.end(); await remote.end();
    process.exit(1);
  }

  // Per-CM-type summary of what the remote will end up with.
  const valid = data['lib_variables'].rows.filter(v => v.is_valid).length;
  console.log(`\nLocal library: ${data['lib_cm_types'].rows.length} CM types, ` +
              `${data['lib_blocks'].rows.length} blocks, ` +
              `${data['lib_variables'].rows.length} variables (${valid} marked valid)`);

  // Any FK actually pointing at these tables would block the delete.
  const fks = (await remote.query(`
    SELECT tc.table_name AS child, kcu.column_name AS col, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = ANY($1) AND tc.table_name <> ALL($1)
  `, [TABLES])).rows;

  let blocked = false;
  for (const f of fks) {
    const [{ n }] = (await remote.query(
      `SELECT COUNT(*)::int AS n FROM ${f.child} WHERE ${f.col} IS NOT NULL`)).rows;
    if (n > 0) {
      console.log(`\n  FK ${f.child}.${f.col} -> ${f.parent} has ${n} rows — delete will fail.`);
      blocked = true;
    }
  }
  if (blocked && !force) {
    console.error('\nAborting: live foreign keys reference the CM library. Use --force to override.\n');
    await local.end(); await remote.end();
    process.exit(1);
  }

  // Name-based references that would dangle once local replaces remote.
  const localNames = new Set(data['lib_cm_types'].rows.map(c => c.name));
  const dangling = [];
  for (const [t, c] of NAME_REFS) {
    let rows;
    try {
      rows = (await remote.query(
        `SELECT ${c} AS v, COUNT(*)::int AS n FROM ${t}
         WHERE ${c} IS NOT NULL AND ${c} <> '' GROUP BY ${c}`)).rows;
    } catch { continue; }  // table absent on this remote
    for (const x of rows) if (!localNames.has(x.v)) dangling.push({ t, c, v: x.v, n: x.n });
  }

  if (dangling.length) {
    console.log('\nRemote rows naming a CM type that local does not have:');
    for (const d of dangling) console.log(`  ${d.t}.${d.c} = "${d.v}" (${d.n} rows)`);
    console.log('  These rows survive the swap but will no longer resolve to a CM type.');
  } else {
    console.log('\nAll remote CM-type name references exist in local. No dangling rows.');
  }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to write.\n');
    await local.end(); await remote.end();
    return;
  }

  const client = await remote.connect();
  try {
    await client.query('BEGIN');

    for (const t of [...TABLES].reverse()) {
      const r = await client.query(`DELETE FROM ${t}`);
      console.log(`  cleared ${t} (${r.rowCount} rows)`);
    }

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

    for (const t of TABLES) {
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
