/**
 * db-backup-restore.js — full logical backup/restore of the local Postgres
 * database. No pg_dump available on this machine, so this uses the app's
 * own `pg` connection to dump every table's full row data to JSON and
 * restore it back on demand.
 *
 * Usage:
 *   node db-backup-restore.js backup <label>     -> writes ../db-backups/<label>.json
 *   node db-backup-restore.js restore <file>     -> wipes and restores from that file
 *
 * WARNING: restore truncates every table in the database before reloading
 * data from the backup file. Only run it when you actually intend to roll
 * back to that snapshot.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { initDb, getDb } = require('./src/db');

const BACKUP_DIR = path.join(__dirname, '..', 'db-backups');

async function listTables(db) {
  const rows = await db.prepare(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name
  `).all();
  return rows.map(r => r.table_name);
}

async function backup(label) {
  await initDb();
  const db = getDb();
  const tables = await listTables(db);
  console.log(`Found ${tables.length} tables.`);

  const dump = { createdAt: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const rows = await db.prepare(`SELECT * FROM "${t}"`).all();
    dump.tables[t] = rows;
    console.log(`  ${t}: ${rows.length} rows`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const outFile = path.join(BACKUP_DIR, `${label}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dump));
  const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
  console.log(`\nBackup written: ${outFile} (${sizeMb} MB)`);
}

async function restore(file) {
  await initDb();
  const db = getDb();
  const raw = fs.readFileSync(file, 'utf8');
  const dump = JSON.parse(raw);
  const tableNames = Object.keys(dump.tables);
  console.log(`Restoring from backup created at ${dump.createdAt}`);
  console.log(`${tableNames.length} tables in backup.`);

  // Disable FK checks for the duration of the restore so table order doesn't matter.
  await db.prepare(`SET session_replication_role = 'replica'`).run();
  try {
    for (const t of tableNames) {
      await db.prepare(`TRUNCATE TABLE "${t}" CASCADE`).run();
    }
    for (const t of tableNames) {
      const rows = dump.tables[t];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const colList = cols.map(c => `"${c}"`).join(',');
      const placeholders = cols.map(() => '?').join(',');
      const insert = db.prepare(`INSERT INTO "${t}" (${colList}) VALUES (${placeholders})`);
      for (const row of rows) {
        const values = cols.map(c => row[c]);
        await insert.run(...values);
      }
      console.log(`  restored ${t}: ${rows.length} rows`);
    }
  } finally {
    await db.prepare(`SET session_replication_role = 'origin'`).run();
  }
  console.log('\nRestore complete.');
}

(async () => {
  const [, , cmd, arg] = process.argv;
  if (cmd === 'backup') {
    await backup(arg || `backup-${Date.now()}`);
  } else if (cmd === 'restore') {
    if (!arg) throw new Error('restore requires a file path');
    await restore(arg);
  } else {
    console.log('Usage: node db-backup-restore.js backup <label> | restore <file>');
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
