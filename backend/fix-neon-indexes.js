#!/usr/bin/env node
'use strict';

/**
 * Replays the local database's unique indexes onto Neon.
 *
 * Written after fix-neon-constraints.js guessed at the constraint list and
 * missed the ones ensureSchema() actually seeds against (hw_signal_types,
 * hw_module_templates). These definitions are copied verbatim from
 * pg_get_indexdef() on the local master, so shape and column order match.
 *
 * CREATE UNIQUE INDEX (not ADD CONSTRAINT) throughout: two of these are
 * partial indexes with a WHERE clause, which a table constraint cannot express.
 * Postgres accepts a plain unique index as an ON CONFLICT arbiter either way.
 */

const { Pool } = require('pg');

const NEON = {
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false },
};

const INDEXES = [
  ['composite_cm_types_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS composite_cm_types_name_key ON public.composite_cm_types USING btree (name)'],
  ['eph_em_column_mappings_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS eph_em_column_mappings_name_key ON public.eph_em_column_mappings USING btree (name)'],
  ['eph_em_function_map_configs_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS eph_em_function_map_configs_name_key ON public.eph_em_function_map_configs USING btree (name)'],
  ['eph_em_type_mapping_configs_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS eph_em_type_mapping_configs_name_key ON public.eph_em_type_mapping_configs USING btree (name)'],
  ['uq_hwctrl_proj_name', 'CREATE UNIQUE INDEX IF NOT EXISTS uq_hwctrl_proj_name ON public.hw_controllers USING btree (project_id, t16_controller_tagname) WHERE (t16_controller_tagname IS NOT NULL)'],
  ['uq_hwi_proj_ctrl', 'CREATE UNIQUE INDEX IF NOT EXISTS uq_hwi_proj_ctrl ON public.hw_imports USING btree (project_id, hw_controller_id) WHERE (hw_controller_id IS NOT NULL)'],
  ['hw_module_templates_order_no_hw_category_key', 'CREATE UNIQUE INDEX IF NOT EXISTS hw_module_templates_order_no_hw_category_key ON public.hw_module_templates USING btree (order_no, hw_category)'],
  ['hw_signal_types_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS hw_signal_types_name_key ON public.hw_signal_types USING btree (name)'],
  ['hw_station_auto_slots_order_no_key', 'CREATE UNIQUE INDEX IF NOT EXISTS hw_station_auto_slots_order_no_key ON public.hw_station_auto_slots USING btree (order_no)'],
  ['instance_matrix_overrides_project_id_instance_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS instance_matrix_overrides_project_id_instance_name_key ON public.instance_matrix_overrides USING btree (project_id, instance_name)'],
  ['io_column_mappings_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS io_column_mappings_name_key ON public.io_column_mappings USING btree (name)'],
  ['io_function_map_configs_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS io_function_map_configs_name_key ON public.io_function_map_configs USING btree (name)'],
  ['lib_cm_types_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS lib_cm_types_name_key ON public.lib_cm_types USING btree (name)'],
  ['lib_valve_commands_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS lib_valve_commands_name_key ON public.lib_valve_commands USING btree (name)'],
  ['projects_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS projects_name_key ON public.projects USING btree (name)'],
  ['signal_mappings_project_id_instance_name_block_name_var_nam_key', 'CREATE UNIQUE INDEX IF NOT EXISTS signal_mappings_project_id_instance_name_block_name_var_nam_key ON public.signal_mappings USING btree (project_id, instance_name, block_name, var_name)'],
  ['unit_types_name_key', 'CREATE UNIQUE INDEX IF NOT EXISTS unit_types_name_key ON public.unit_types USING btree (name)'],
];

async function main() {
  const neon = new Pool(NEON);
  try {
    await neon.query('SELECT 1');
    console.log('Connected to Neon\n');

    let created = 0, skipped = 0, failed = 0;

    for (const [name, sql] of INDEXES) {
      try {
        const before = await neon.query('SELECT to_regclass($1) AS oid', [`public.${name}`]);
        if (before.rows[0].oid) { console.log(`= ${name} (already present)`); skipped++; continue; }
        await neon.query(sql);
        console.log(`+ ${name}`);
        created++;
      } catch (e) {
        // A duplicate-key failure here means real duplicate rows exist on Neon
        // for those columns — surface it rather than swallowing it.
        console.log(`! ${name}: ${e.message.split('\n')[0]}`);
        failed++;
      }
    }

    // composite_matrix_cells: local PK is (mode_id, column_name); Neon's was
    // created (column_name, mode_id). Column order is part of the arbiter match,
    // so rebuild the PK in the local order.
    console.log('\ncomposite_matrix_cells primary key:');
    const pk = await neon.query(`
      SELECT pg_get_indexdef(i.indexrelid) AS def, con.conname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
      WHERE c.relname = 'composite_matrix_cells' AND i.indisprimary
    `);
    if (pk.rows.length && /\(column_name, mode_id\)/.test(pk.rows[0].def)) {
      await neon.query(`ALTER TABLE composite_matrix_cells DROP CONSTRAINT ${pk.rows[0].conname}`);
      await neon.query('ALTER TABLE composite_matrix_cells ADD PRIMARY KEY (mode_id, column_name)');
      console.log('  rebuilt as (mode_id, column_name)');
      created++;
    } else {
      console.log(`  already ${pk.rows[0]?.def ?? 'absent'}`);
      skipped++;
    }

    console.log(`\ncreated ${created}, already present ${skipped}, failed ${failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    await neon.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
