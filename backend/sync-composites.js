#!/usr/bin/env node
/**
 * Sync composite CM type definitions from the local database to a remote one.
 *
 * Matches composites by NAME, not id — ids differ between databases. For each
 * local composite, finds the remote composite with the same name and replaces
 * its members with the local set.
 *
 * Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   node sync-composites.js "postgresql://user:pass@host/db?sslmode=require"
 *   node sync-composites.js "postgresql://..." --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

const MEMBER_COLS = [
  'cm_type_name', 'hierarchy_folder', 'name_prefix', 'name_suffix',
  'is_primary', 'sort_order', 'scope', 'roles',
];

async function main() {
  const connStr = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!connStr || connStr.startsWith('--')) {
    console.error('Usage: node sync-composites.js "<remote-connection-string>" [--apply]');
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
  const remote = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });

  console.log(apply
    ? '\n*** APPLY MODE — changes will be written ***\n'
    : '\n--- DRY RUN — no changes will be written (pass --apply to write) ---\n');

  // Local composites with their members.
  const localComps = (await local.query(
    'SELECT id, name FROM composite_cm_types ORDER BY name'
  )).rows;

  const plan = [];

  for (const lc of localComps) {
    const lMembers = (await local.query(
      `SELECT ${MEMBER_COLS.join(', ')} FROM composite_cm_members
       WHERE composite_id = $1 ORDER BY sort_order, id`,
      [lc.id]
    )).rows;

    const rc = (await remote.query(
      'SELECT id, name FROM composite_cm_types WHERE name = $1', [lc.name]
    )).rows[0];

    if (!rc) {
      plan.push({ kind: 'missing-composite', name: lc.name, localMembers: lMembers.length });
      continue;
    }

    const rMembers = (await remote.query(
      'SELECT COUNT(*)::int AS n FROM composite_cm_members WHERE composite_id = $1', [rc.id]
    )).rows[0].n;

    if (lMembers.length === 0) {
      plan.push({ kind: 'skip-empty-local', name: lc.name, remoteId: rc.id, remoteMembers: rMembers });
      continue;
    }
    if (rMembers === lMembers.length) {
      plan.push({ kind: 'already-populated', name: lc.name, remoteId: rc.id, remoteMembers: rMembers });
      continue;
    }

    plan.push({
      kind: 'sync', name: lc.name, remoteId: rc.id,
      remoteMembers: rMembers, members: lMembers,
    });
  }

  // Report.
  for (const p of plan) {
    switch (p.kind) {
      case 'missing-composite':
        console.log(`SKIP  ${p.name}: no composite with this name on remote (${p.localMembers} local members)`);
        break;
      case 'skip-empty-local':
        console.log(`SKIP  ${p.name}: local has no members either`);
        break;
      case 'already-populated':
        console.log(`OK    ${p.name}: remote already has ${p.remoteMembers} members`);
        break;
      case 'sync':
        console.log(`SYNC  ${p.name} (remote id ${p.remoteId}): ${p.remoteMembers} -> ${p.members.length} members`);
        for (const m of p.members) {
          console.log(`        + ${m.cm_type_name} [folder="${m.hierarchy_folder}" scope=${m.scope}` +
            `${m.is_primary ? ' primary' : ''}${m.name_prefix ? ` prefix="${m.name_prefix}"` : ''}]`);
        }
        break;
    }
  }

  const toSync = plan.filter(p => p.kind === 'sync');
  console.log(`\n${toSync.length} composite(s) to sync.`);

  if (!apply) {
    console.log('Dry run complete. Re-run with --apply to write these changes.\n');
    await local.end(); await remote.end();
    return;
  }

  if (toSync.length === 0) {
    console.log('Nothing to do.\n');
    await local.end(); await remote.end();
    return;
  }

  const client = await remote.connect();
  try {
    await client.query('BEGIN');
    for (const p of toSync) {
      await client.query('DELETE FROM composite_cm_members WHERE composite_id = $1', [p.remoteId]);
      for (const m of p.members) {
        await client.query(
          `INSERT INTO composite_cm_members
             (composite_id, ${MEMBER_COLS.join(', ')})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [p.remoteId, ...MEMBER_COLS.map(c => m[c])]
        );
      }
      console.log(`  wrote ${p.members.length} members to ${p.name}`);
    }
    await client.query('COMMIT');
    console.log('\nCommitted.\n');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nRolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await local.end();
    await remote.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
