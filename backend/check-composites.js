#!/usr/bin/env node
/**
 * Compare composite CM type data between two databases.
 *
 * Usage:
 *   # Local (uses .env)
 *   node check-composites.js
 *
 *   # Neon — pass the connection string
 *   node check-composites.js "postgresql://user:pass@host/db?sslmode=require"
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

async function main() {
  const connStr = process.argv[2];
  const pool = connStr
    ? new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } })
    : new Pool({
        host:     process.env.PGHOST || 'localhost',
        port:     Number(process.env.PGPORT) || 5432,
        user:     process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 's88_app',
        ssl:      false,
      });

  const label = connStr ? 'REMOTE' : 'LOCAL';
  console.log(`\n=== ${label} ===\n`);

  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

  for (const t of ['composite_cm_types', 'composite_cm_members', 'unit_types', 'unit_type_members']) {
    const [{ count }] = await q(`SELECT COUNT(*)::int AS count FROM ${t}`);
    console.log(`${t.padEnd(24)} ${count} rows`);
  }

  console.log('\n--- Composite types and their member counts ---');
  const comps = await q(`
    SELECT c.id, c.name, COUNT(m.id)::int AS members
    FROM composite_cm_types c
    LEFT JOIN composite_cm_members m ON m.composite_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.id
  `);
  for (const c of comps) {
    const flag = c.members === 0 ? '  <-- EMPTY' : '';
    console.log(`  [${c.id}] ${c.name}: ${c.members} members${flag}`);
  }

  console.log('\n--- Unit type members and the composites they reference ---');
  const refs = await q(`
    SELECT ut.name AS unit_type, utm.alias, utm.composite_cm_id,
           c.name AS composite_name,
           (SELECT COUNT(*)::int FROM composite_cm_members m
             WHERE m.composite_id = utm.composite_cm_id) AS member_count
    FROM unit_type_members utm
    JOIN unit_types ut ON ut.id = utm.unit_type_id
    LEFT JOIN composite_cm_types c ON c.id = utm.composite_cm_id
    WHERE utm.composite_cm_id IS NOT NULL
    ORDER BY ut.name, utm.sort_order
  `);
  for (const r of refs) {
    const problem = r.composite_name === null
      ? '  <-- DANGLING: composite does not exist'
      : r.member_count === 0
        ? '  <-- composite has no members'
        : '';
    console.log(`  ${r.unit_type}.${r.alias} -> composite ${r.composite_cm_id} (${r.composite_name ?? '???'}), ${r.member_count} members${problem}`);
  }

  console.log('');
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
