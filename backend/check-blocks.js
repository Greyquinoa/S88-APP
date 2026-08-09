#!/usr/bin/env node
/**
 * Compare lib_cm_types / lib_blocks / lib_variables between local and remote.
 *
 * Usage:
 *   node check-blocks.js "postgresql://user:pass@host/db?sslmode=require"
 *   node check-blocks.js "postgresql://..." IF_FRONT      # drill into one block
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

async function main() {
  const connStr = process.argv[2];
  const blockFilter = process.argv[3];

  if (!connStr || connStr.startsWith('--')) {
    console.error('Usage: node check-blocks.js "<remote-connection-string>" [blockName]');
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

  const q = async (pool, sql, p = []) => (await pool.query(sql, p)).rows;

  // --- Table counts ---
  console.log('\ntable                    local  remote');
  console.log('----------------------------------------');
  for (const t of ['lib_cm_types', 'lib_blocks', 'lib_variables']) {
    const [l] = await q(local,  `SELECT COUNT(*)::int AS n FROM ${t}`);
    const [r] = await q(remote, `SELECT COUNT(*)::int AS n FROM ${t}`);
    const flag = l.n !== r.n ? '  <-- DIFFERS' : '';
    console.log(`${t.padEnd(24)} ${String(l.n).padStart(5)}  ${String(r.n).padStart(6)}${flag}`);
  }

  // --- CM types side by side ---
  const cmSql = `
    SELECT c.id, c.name,
           (SELECT COUNT(*)::int FROM lib_blocks b WHERE b.cm_type_id = c.id) AS blocks,
           (SELECT COUNT(*)::int FROM lib_variables v
              JOIN lib_blocks b ON b.id = v.block_id
             WHERE b.cm_type_id = c.id) AS vars,
           (SELECT COUNT(*)::int FROM lib_variables v
              JOIN lib_blocks b ON b.id = v.block_id
             WHERE b.cm_type_id = c.id AND v.is_valid) AS valid
    FROM lib_cm_types c ORDER BY c.name`;
  const lCm = await q(local, cmSql);
  const rCm = await q(remote, cmSql);
  const rCmByName = Object.fromEntries(rCm.map(c => [c.name, c]));

  console.log('\n--- CM types: blocks / vars / valid ---');
  console.log('name                          local                remote');
  for (const c of lCm) {
    const r = rCmByName[c.name];
    const lStr = `${c.blocks}b ${c.vars}v ${c.valid}valid`;
    const rStr = r ? `${r.blocks}b ${r.vars}v ${r.valid}valid` : 'MISSING';
    const diff = !r || r.blocks !== c.blocks || r.vars !== c.vars || r.valid !== c.valid
      ? '  <-- DIFFERS' : '';
    console.log(`${c.name.padEnd(28)}  ${lStr.padEnd(20)} ${rStr}${diff}`);
  }
  for (const c of rCm) {
    if (!lCm.find(x => x.name === c.name)) {
      console.log(`${c.name.padEnd(28)}  ${'--'.padEnd(20)} ${c.blocks}b ${c.vars}v  <-- REMOTE ONLY`);
    }
  }

  // --- Blocks for a named block (or all blocks per CM type) ---
  if (blockFilter) {
    const blkSql = `
      SELECT b.id, b.name, c.name AS cm_type,
             (SELECT COUNT(*)::int FROM lib_variables v WHERE v.block_id = b.id) AS vars,
             (SELECT COUNT(*)::int FROM lib_variables v WHERE v.block_id = b.id AND v.is_valid) AS valid
      FROM lib_blocks b JOIN lib_cm_types c ON c.id = b.cm_type_id
      WHERE b.name = $1 ORDER BY c.name`;
    console.log(`\n--- Blocks named "${blockFilter}" ---`);
    for (const [label, pool] of [['LOCAL', local], ['REMOTE', remote]]) {
      const rows = await q(pool, blkSql, [blockFilter]);
      console.log(`  ${label}:`);
      if (!rows.length) console.log('    (none)');
      for (const b of rows) {
        console.log(`    [${b.id}] ${b.cm_type}.${b.name}: ${b.vars} vars, ${b.valid} valid`);
      }
    }

    // Variable-level diff for the first matching block id present on both.
    const lB = await q(local,  blkSql, [blockFilter]);
    const rB = await q(remote, blkSql, [blockFilter]);
    for (const b of lB) {
      const rb = rB.find(x => x.id === b.id);
      if (!rb) { console.log(`\n  block id ${b.id} missing on remote`); continue; }
      const vSql = `SELECT name, is_valid, direction FROM lib_variables WHERE block_id = $1 ORDER BY name`;
      const lV = await q(local,  vSql, [b.id]);
      const rV = await q(remote, vSql, [b.id]);
      const rMap = Object.fromEntries(rV.map(v => [v.name, v]));
      const diffs = [];
      for (const v of lV) {
        const rv = rMap[v.name];
        if (!rv) diffs.push(`    ${v.name}: MISSING on remote (local is_valid=${v.is_valid})`);
        else if (rv.is_valid !== v.is_valid)
          diffs.push(`    ${v.name}: local=${v.is_valid} remote=${rv.is_valid}`);
      }
      for (const v of rV) if (!lV.find(x => x.name === v.name))
        diffs.push(`    ${v.name}: REMOTE ONLY (is_valid=${v.is_valid})`);
      console.log(`\n  Variable diffs for block ${b.id} (${b.cm_type}.${b.name}): ${diffs.length}`);
      for (const d of diffs.slice(0, 40)) console.log(d);
      if (diffs.length > 40) console.log(`    ... and ${diffs.length - 40} more`);
    }
  }

  console.log('');
  await local.end(); await remote.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
