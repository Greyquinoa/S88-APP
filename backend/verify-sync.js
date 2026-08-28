const { Pool } = require('pg');

const LOCAL = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'super@123',
  database: 's88_app'
};

const NEON = {
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false }
};

(async () => {
  let local, neon;
  try {
    local = new Pool(LOCAL);
    neon = new Pool(NEON);

    const tables = await local.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);

    console.log('📊 Verifying database sync...\n');
    let allMatch = true;

    for (const t of tables.rows) {
      const tableName = t.table_name;

      const localCount = await local.query(`SELECT COUNT(*) as cnt FROM ${tableName}`);
      const neonCount = await neon.query(`SELECT COUNT(*) as cnt FROM ${tableName}`);

      const localCnt = Number(localCount.rows[0].cnt);
      const neonCnt = Number(neonCount.rows[0].cnt);

      const match = localCnt === neonCnt;
      const status = match ? '✓' : '✗';

      if (!match) {
        allMatch = false;
        console.log(`${status} ${tableName}: local=${localCnt}, neon=${neonCnt}`);
      }
    }

    if (allMatch) {
      console.log('✅ All tables synced perfectly! Row counts match.\n');
    } else {
      console.log('\n⚠️ Some tables have mismatched row counts.');
    }

    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    if (local) await local.end();
    if (neon) await neon.end();
  }
})();
