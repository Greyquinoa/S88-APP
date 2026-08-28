const { Pool } = require('pg');

const neon = new Pool({
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    // Get all tables
    const tables = await neon.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    // Delete from all tables in reverse order of FK dependencies
    for (const t of tables.rows.reverse()) {
      try {
        await neon.query(`TRUNCATE TABLE ${t.tablename} CASCADE`);
        console.log(`Truncated: ${t.tablename}`);
      } catch (e) {
        console.log(`⚠️  ${t.tablename}`);
      }
    }

    console.log('\n✓ Neon database cleaned');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await neon.end();
  }
})();
