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
    const result = await neon.query(`
      SELECT constraint_name, table_name FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND constraint_type = 'UNIQUE'
      ORDER BY table_name
    `);

    console.log('✅ Unique constraints on Neon:\n');
    result.rows.forEach(r => {
      console.log(`  ${r.table_name}: ${r.constraint_name}`);
    });

    console.log(`\n✓ Total: ${result.rows.length} unique constraints`);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await neon.end();
  }
})();
