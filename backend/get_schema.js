const { Pool } = require('pg');

async function getSchema() {
  const pool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'super@123',
    database: 's88_app'
  });

  try {
    // Get all tables
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    
    console.log('=== TABLES IN LOCAL DATABASE ===');
    for (const t of tables.rows) {
      const cols = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [t.table_name]);
      
      console.log(`\n${t.table_name}:`);
      cols.rows.forEach(c => {
        const nullable = c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
        console.log(`  ${c.column_name}: ${c.data_type} ${nullable}${def}`);
      });
    }
  } finally {
    await pool.end();
  }
}

getSchema().catch(console.error);
