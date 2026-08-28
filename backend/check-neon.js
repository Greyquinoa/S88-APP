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
      SELECT currval('composite_cm_types_id_seq') as currval, max(id) as max_id FROM composite_cm_types
    `);
    console.log(result.rows[0]);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    await neon.end();
  }
})();
