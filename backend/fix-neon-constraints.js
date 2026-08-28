#!/usr/bin/env node
'use strict';

/**
 * Fix missing unique constraints on Neon database
 * This resolves: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 */

const { Pool } = require('pg');

const NEON = {
  host: 'ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_Wv3K9xtgUhme',
  database: 's88_app',
  ssl: { rejectUnauthorized: false }
};

async function main() {
  let neon;

  try {
    console.log('🔌 Connecting to Neon...');
    neon = new Pool(NEON);
    await neon.query('SELECT 1');
    console.log('✓ Connected\n');

    const constraints = [
      {
        table: 'user_io_column_prefs',
        constraint: 'user_io_column_prefs_import_id_key',
        sql: 'ALTER TABLE user_io_column_prefs ADD CONSTRAINT user_io_column_prefs_import_id_key UNIQUE(import_id)'
      },
      {
        table: 'user_cm_block_prefs',
        constraint: 'user_cm_block_prefs_cm_type_name_key',
        sql: 'ALTER TABLE user_cm_block_prefs ADD CONSTRAINT user_cm_block_prefs_cm_type_name_key UNIQUE(cm_type_name)'
      },
      {
        table: 'io_imports',
        constraint: 'io_imports_unique_import',
        sql: 'ALTER TABLE io_imports ADD CONSTRAINT io_imports_unique_import UNIQUE(id)'
      },
      {
        table: 'hw_hardware_resolution',
        constraint: 'hw_hardware_resolution_protocol_signal_key',
        sql: 'ALTER TABLE hw_hardware_resolution ADD CONSTRAINT hw_hardware_resolution_protocol_signal_key UNIQUE(protocol, signal_type)'
      },
      {
        table: 'hw_slot_subslots',
        constraint: 'hw_slot_subslots_slot_subslot_key',
        sql: 'ALTER TABLE hw_slot_subslots ADD CONSTRAINT hw_slot_subslots_slot_subslot_key UNIQUE(hw_import_id, station_address, slot, subslot_no)'
      },
      {
        table: 'hw_slot_subslot_compat',
        constraint: 'hw_slot_subslot_compat_key',
        sql: 'ALTER TABLE hw_slot_subslot_compat ADD CONSTRAINT hw_slot_subslot_compat_key UNIQUE(slot_order_no, subslot_order_no)'
      },
      {
        table: 'instance_ios',
        constraint: 'instance_ios_key',
        sql: 'ALTER TABLE instance_ios ADD CONSTRAINT instance_ios_key UNIQUE(project_id, instance_name, block_name, var_name)'
      },
      {
        table: 'instance_derived_values',
        constraint: 'instance_derived_values_key',
        sql: 'ALTER TABLE instance_derived_values ADD CONSTRAINT instance_derived_values_key UNIQUE(project_id, instance_name, to_var_name)'
      },
      {
        table: 'project_config',
        constraint: 'project_config_proj_userproj_unique',
        sql: 'ALTER TABLE project_config ADD CONSTRAINT project_config_proj_userproj_unique UNIQUE(project_id, user_project)'
      },
      {
        table: 'project_cmt_profiles',
        constraint: 'project_cmt_profiles_project_id_cm_type_key',
        sql: 'ALTER TABLE project_cmt_profiles ADD CONSTRAINT project_cmt_profiles_project_id_cm_type_key UNIQUE(project_id, cm_type)'
      },
      {
        table: 'project_user_projects',
        constraint: 'project_user_projects_project_id_name_key',
        sql: 'ALTER TABLE project_user_projects ADD CONSTRAINT project_user_projects_project_id_name_key UNIQUE(project_id, name)'
      },
      {
        table: 'hw_module_parameters',
        constraint: 'hw_module_parameters_key',
        sql: 'ALTER TABLE hw_module_parameters ADD CONSTRAINT hw_module_parameters_key UNIQUE(template_id, parameter_name, channel_no)'
      }
    ];

    console.log('🔗 Adding unique constraints...\n');
    let added = 0;

    for (const c of constraints) {
      try {
        // Check if constraint already exists
        const check = await neon.query(`
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = $1 AND constraint_name = $2
        `, [c.table, c.constraint]);

        if (check.rows.length > 0) {
          console.log(`✓ ${c.constraint} — already exists`);
        } else {
          await neon.query(c.sql);
          console.log(`✓ Added: ${c.constraint}`);
          added++;
        }
      } catch (e) {
        console.log(`⚠️  ${c.constraint}: ${e.message.split('\n')[0]}`);
      }
    }

    console.log(`\n✅ Added ${added} new constraints\n`);
    console.log('✓ Neon database is now ready for Render deployment');

  } catch (e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  } finally {
    if (neon) await neon.end();
  }
}

main().catch(console.error);
