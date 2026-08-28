'use strict';
// Prints the exact local index definitions for the tables whose unique
// indexes are missing on Neon, so they can be replayed verbatim.
const { Pool } = require('pg');

const local = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'super@123',
  database: 's88_app',
});

const TABLES = [
  'composite_cm_types', 'composite_matrix_cells', 'eph_em_column_mappings',
  'eph_em_function_map_configs', 'eph_em_type_mapping_configs', 'hw_controllers',
  'hw_imports', 'hw_module_templates', 'hw_signal_types', 'hw_station_auto_slots',
  'instance_matrix_overrides', 'io_column_mappings', 'io_function_map_configs',
  'lib_cm_types', 'lib_valve_commands', 'projects', 'signal_mappings', 'unit_types',
];

(async () => {
  try {
    const r = await local.query(`
      SELECT c.relname AS table_name, pg_get_indexdef(idx.indexrelid) AS def
      FROM pg_index idx
      JOIN pg_class c ON c.oid = idx.indrelid
      JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND idx.indisunique AND NOT idx.indisprimary
        AND c.relname = ANY($1)
      ORDER BY c.relname
    `, [TABLES]);

    r.rows.forEach(x => console.log(x.def + ';'));
  } finally {
    await local.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
