// src/db.js — Postgres via pg (node-postgres)
'use strict';
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = require('pg');

let _pool = null;
const _txStorage = new AsyncLocalStorage();

async function initDb() {
  if (_pool) return _pool;
  const isProduction = process.env.NODE_ENV === 'production';
  _pool = new Pool({
    host:     process.env.PGHOST || 'localhost',
    port:     Number(process.env.PGPORT) || 5432,
    user:     process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 's88_app',
    ssl:      isProduction ? { rejectUnauthorized: false } : false,
  });
  await _pool.query('SELECT 1');
  console.log(`[DB] Connected — postgres://${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 's88_app'}`);
  return _pool;
}

// ── Helper: translate `?` positional placeholders to $1, $2, ... ──────────────
const _placeholderCache = new Map();
function toPgSql(sql) {
  let cached = _placeholderCache.get(sql);
  if (cached) return cached;
  let i = 0;
  const converted = sql.replace(/\?/g, () => `$${++i}`);
  _placeholderCache.set(sql, converted);
  return converted;
}

function needsReturningId(sql) {
  return /^\s*INSERT\s+INTO/i.test(sql) && !/\bRETURNING\b/i.test(sql);
}

function currentExecutor() {
  return _txStorage.getStore() || _pool;
}

async function rawRun(sql, params = []) {
  const executor = currentExecutor();
  let pgSql = toPgSql(sql);
  const appendReturning = needsReturningId(sql);
  if (appendReturning) pgSql = `${pgSql} RETURNING id`;
  const result = await executor.query(pgSql, params);
  return {
    lastInsertRowid: appendReturning ? (result.rows[0]?.id ?? 0) : undefined,
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

async function rawAll(sql, params = []) {
  const executor = currentExecutor();
  const result = await executor.query(toPgSql(sql), params);
  return result.rows;
}

async function rawGet(sql, params = []) {
  const executor = currentExecutor();
  const result = await executor.query(toPgSql(sql), params);
  return result.rows[0];
}

// ── Public DB interface ───────────────────────────────────────────────────────
function getDb() {
  if (!_pool) throw new Error('DB not initialised — call initDb() first');

  return {
    prepare(sql) {
      return {
        run: async (...params) => rawRun(sql, params.flat()),
        all: async (...params) => rawAll(sql, params.flat()),
        get: async (...params) => rawGet(sql, params.flat()),
      };
    },

    transaction(fn) {
      return async (...args) => {
        const client = await _pool.connect();
        try {
          await client.query('BEGIN');
          const result = await _txStorage.run(client, () => fn(...args));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      };
    },
  };
}

// ── Schema introspection helper (replaces PRAGMA table_info) ──────────────────
async function tableColumns(tableName) {
  const rows = await rawAll(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?`,
    [tableName]
  );
  return rows.map(r => r.name);
}

async function addColumnIfMissing(table, column, ddl) {
  const cols = await tableColumns(table);
  if (!cols.includes(column)) {
    await rawRun(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────
async function ensureSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS lib_cm_types (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      cm_type       TEXT,
      comment       TEXT,
      sampling_time TEXT,
      loaded_at     TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS lib_blocks (
      id          SERIAL PRIMARY KEY,
      cm_type_id  INTEGER NOT NULL,
      name        TEXT NOT NULL,
      comment     TEXT,
      optional    BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lib_variables (
      id          SERIAL PRIMARY KEY,
      block_id    INTEGER NOT NULL,
      lib_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      dir         TEXT,
      dtype       TEXT,
      val         TEXT,
      comment     TEXT,
      vtype       TEXT,
      enumeration TEXT,
      negation    BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lib_var_links (
      id             SERIAL PRIMARY KEY,
      var_id         INTEGER NOT NULL,
      target_lib_id  TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS lib_messages (
      id         SERIAL PRIMARY KEY,
      block_id   INTEGER NOT NULL,
      name       TEXT NOT NULL,
      batch      TEXT,
      cls        TEXT,
      event      TEXT,
      origin     TEXT,
      osarea     TEXT,
      prio       TEXT,
      ack        BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lib_em_roles (
      id          SERIAL PRIMARY KEY,
      cm_type_id  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_em_roles_cm ON lib_em_roles(cm_type_id)`,
    `CREATE TABLE IF NOT EXISTS audit_generations (
      id             SERIAL PRIMARY KEY,
      project_name   TEXT NOT NULL,
      generated_by   TEXT,
      generated_at   TIMESTAMPTZ DEFAULT NOW(),
      instance_count INTEGER,
      block_count    INTEGER,
      var_count      INTEGER,
      msg_count      INTEGER,
      link_count     INTEGER,
      xml_size_kb    REAL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_instances (
      id             SERIAL PRIMARY KEY,
      generation_id  INTEGER NOT NULL,
      cm_type        TEXT NOT NULL,
      instance_name  TEXT NOT NULL,
      sampling_time  TEXT,
      enabled_blocks TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      comment    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS project_instances (
      id            SERIAL PRIMARY KEY,
      project_id    INTEGER NOT NULL,
      cm_type       TEXT NOT NULL,
      instance_name TEXT NOT NULL,
      sampling_time TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS project_cmt_profiles (
      id             SERIAL PRIMARY KEY,
      project_id     INTEGER NOT NULL,
      cm_type        TEXT NOT NULL,
      enabled_blocks TEXT NOT NULL,
      UNIQUE (project_id, cm_type)
    )`,
    `CREATE TABLE IF NOT EXISTS project_user_projects (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS project_hierarchy_folders (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      parent_id   INTEGER,
      name        TEXT NOT NULL,
      s88_type    TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_blocks_cm   ON lib_blocks(cm_type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_vars_block  ON lib_variables(block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_links_var   ON lib_var_links(var_id)`,
    `CREATE INDEX IF NOT EXISTS idx_msgs_block  ON lib_messages(block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_date  ON audit_generations(generated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_pi_proj     ON project_instances(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pcp_proj    ON project_cmt_profiles(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pup_proj    ON project_user_projects(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_phf_proj    ON project_hierarchy_folders(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_phf_parent  ON project_hierarchy_folders(parent_id)`,

    // ── Unit Type System ──────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS unit_types (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS unit_type_members (
      id               SERIAL PRIMARY KEY,
      unit_type_id     INTEGER NOT NULL REFERENCES unit_types(id),
      alias            TEXT NOT NULL,
      cm_type_name     TEXT NOT NULL,
      hierarchy_folder TEXT,
      sort_order       INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS unit_type_member_roles (
      id             SERIAL PRIMARY KEY,
      member_id      INTEGER NOT NULL REFERENCES unit_type_members(id),
      role           TEXT NOT NULL,
      assigned_alias TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS unit_instances (
      id           SERIAL PRIMARY KEY,
      project_id   INTEGER NOT NULL REFERENCES projects(id),
      unit_type_id INTEGER NOT NULL REFERENCES unit_types(id),
      unit_name    TEXT NOT NULL,
      sort_order   INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_utm_unit   ON unit_type_members(unit_type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_utmr_mem   ON unit_type_member_roles(member_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ui_proj    ON unit_instances(project_id)`,

    // ── Composite CM Type System ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS composite_cm_types (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS composite_cm_members (
      id               SERIAL PRIMARY KEY,
      composite_id     INTEGER NOT NULL REFERENCES composite_cm_types(id),
      cm_type_name     TEXT NOT NULL,
      hierarchy_folder TEXT NOT NULL DEFAULT 'CM',
      name_prefix      TEXT NOT NULL DEFAULT '',
      name_suffix      TEXT NOT NULL DEFAULT '',
      is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order       INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ccm_comp    ON composite_cm_members(composite_id)`,

    `CREATE TABLE IF NOT EXISTS composite_cm_connections (
      id                SERIAL PRIMARY KEY,
      composite_id      INTEGER NOT NULL REFERENCES composite_cm_types(id),
      from_member_idx   INTEGER NOT NULL,
      from_var_name     TEXT NOT NULL,
      to_member_idx     INTEGER NOT NULL,
      to_var_name       TEXT NOT NULL,
      sort_order        INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ccc_comp ON composite_cm_connections(composite_id)`,

    `CREATE TABLE IF NOT EXISTS unit_type_member_connections (
      id                SERIAL PRIMARY KEY,
      unit_type_id      INTEGER NOT NULL REFERENCES unit_types(id) ON DELETE CASCADE,
      from_alias        TEXT NOT NULL,
      from_sub_idx      INTEGER NOT NULL DEFAULT 0,
      from_var_name     TEXT NOT NULL,
      to_alias          TEXT NOT NULL,
      to_sub_idx        INTEGER NOT NULL DEFAULT 0,
      to_var_name       TEXT NOT NULL,
      conn_type         TEXT NOT NULL DEFAULT 'interconnection',
      static_value      TEXT,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_utmc_unit ON unit_type_member_connections(unit_type_id)`,

    `CREATE TABLE IF NOT EXISTS unit_resolved_connections (
      id                SERIAL PRIMARY KEY,
      project_id        INTEGER NOT NULL REFERENCES projects(id),
      unit_instance_id  INTEGER NOT NULL,
      from_instance     TEXT NOT NULL,
      from_var_name     TEXT NOT NULL,
      to_instance       TEXT NOT NULL,
      to_var_name       TEXT NOT NULL,
      conn_type         TEXT NOT NULL DEFAULT 'interconnection',
      static_value      TEXT,
      user_project      TEXT,
      sort_order        INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_urc_proj ON unit_resolved_connections(project_id)`,
  ];

  for (const s of stmts) await rawRun(s);

  // Migrations: add columns to project_instances if missing
  await addColumnIfMissing('project_instances', 'user_project', 'user_project TEXT');
  await addColumnIfMissing('project_instances', 'folder_id', 'folder_id INTEGER');
  await addColumnIfMissing('project_instances', 'role_assignments', 'role_assignments TEXT');

  // Migrations: add role_kind to lib_em_roles if missing (EPH uses EquipmentModuleAssignment)
  await addColumnIfMissing('lib_em_roles', 'role_kind', `role_kind TEXT NOT NULL DEFAULT 'cm'`);

  // Migrations: add source_unit_instance_id to project_instances and project_hierarchy_folders
  await addColumnIfMissing('project_instances', 'source_unit_instance_id', 'source_unit_instance_id INTEGER');
  await rawRun('CREATE INDEX IF NOT EXISTS idx_pi_srcui ON project_instances(source_unit_instance_id)');

  await addColumnIfMissing('project_hierarchy_folders', 'source_unit_instance_id', 'source_unit_instance_id INTEGER');
  await rawRun('CREATE INDEX IF NOT EXISTS idx_phf_srcui ON project_hierarchy_folders(source_unit_instance_id)');

  // Migrations: add description to project_hierarchy_folders
  await addColumnIfMissing('project_hierarchy_folders', 'description', 'description TEXT');

  // Migrations: add user_project + parent_path to unit_instances
  await addColumnIfMissing('unit_instances', 'user_project', 'user_project TEXT');
  await addColumnIfMissing('unit_instances', 'parent_path', 'parent_path TEXT');

  // Migration: add composite_cm_id to unit_type_members
  await addColumnIfMissing('unit_type_members', 'composite_cm_id', 'composite_cm_id INTEGER');

  // Migration: add instantiation scope to composite_cm_members.
  await addColumnIfMissing('composite_cm_members', 'scope', `scope TEXT NOT NULL DEFAULT 'unit'`);

  // Migration: add role assignments to composite_cm_members (for EM/EPH types)
  await addColumnIfMissing('composite_cm_members', 'roles', 'roles JSONB');

  // Migration: extend unit_type_member_roles to address composite sub-members.
  await addColumnIfMissing('unit_type_member_roles', 'source_member_idx', 'source_member_idx INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('unit_type_member_roles', 'target_member_idx', 'target_member_idx INTEGER NOT NULL DEFAULT 0');

  // Migrations: add composite wiring metadata to project_instances.
  // composite_group_id is a client-generated grouping token (Date.now()), which
  // exceeds INT4 range — must be BIGINT. Older DBs created it as INTEGER, so widen it.
  await addColumnIfMissing('project_instances', 'composite_group_id', 'composite_group_id BIGINT');
  await addColumnIfMissing('project_instances', 'composite_id', 'composite_id INTEGER');
  await addColumnIfMissing('project_instances', 'member_idx', 'member_idx INTEGER');
  await rawRun(`ALTER TABLE project_instances ALTER COLUMN composite_group_id TYPE BIGINT`).catch(() => {});


  // Migration: add conn_type + static_value to composite_cm_connections
  await addColumnIfMissing('composite_cm_connections', 'conn_type', `conn_type TEXT NOT NULL DEFAULT 'interconnection'`);
  await addColumnIfMissing('composite_cm_connections', 'static_value', `static_value TEXT`);

  // Migration: add is_matrix flag + matrix tables to composite CM
  await addColumnIfMissing('composite_cm_types', 'is_matrix', `is_matrix BOOLEAN NOT NULL DEFAULT FALSE`);
  await rawRun(`CREATE TABLE IF NOT EXISTS composite_matrix_columns (
    id           SERIAL PRIMARY KEY,
    composite_id INTEGER NOT NULL REFERENCES composite_cm_types(id),
    column_name  TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_cmc_comp ON composite_matrix_columns(composite_id)`);
  await rawRun(`CREATE TABLE IF NOT EXISTS composite_matrix_modes (
    id           SERIAL PRIMARY KEY,
    composite_id INTEGER NOT NULL REFERENCES composite_cm_types(id),
    mode_nr      INTEGER NOT NULL,
    mode_name    TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_cmm_comp ON composite_matrix_modes(composite_id)`);
  await rawRun(`CREATE TABLE IF NOT EXISTS composite_matrix_cells (
    mode_id      INTEGER NOT NULL REFERENCES composite_matrix_modes(id),
    column_name  TEXT NOT NULL,
    value        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mode_id, column_name)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_cmc_mode ON composite_matrix_cells(mode_id)`);

  // Migration: add is_valid to lib_variables (marks a variable as exposed for composite wiring)
  await addColumnIfMissing('lib_variables', 'is_valid', 'is_valid BOOLEAN NOT NULL DEFAULT FALSE');

  // Migration: add project_config table (per-project PCS7 hardware IDs)
  await rawRun(`CREATE TABLE IF NOT EXISTS project_config (
    id               SERIAL PRIMARY KEY,
    project_id       INTEGER NOT NULL UNIQUE REFERENCES projects(id),
    project_name     TEXT,
    project_id_val   TEXT,
    device_name      TEXT,
    device_id        TEXT,
    cpu_id           TEXT,
    process_cell     TEXT,
    process_cell_id  TEXT,
    unit_name        TEXT,
    unit_id          TEXT,
    cm_folder_id     TEXT,
    export_user      TEXT,
    unit_author      TEXT,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── IO Import System ──────────────────────────────────────────────
  const ioStmts = [
    `CREATE TABLE IF NOT EXISTS io_imports (
      id              SERIAL PRIMARY KEY,
      project_id      INTEGER NOT NULL REFERENCES projects(id),
      file_name       TEXT NOT NULL,
      file_size_bytes INTEGER,
      sheet_name      TEXT,
      total_rows      INTEGER,
      valid_rows      INTEGER DEFAULT 0,
      invalid_rows    INTEGER DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      imported_by     TEXT,
      imported_at     TIMESTAMPTZ DEFAULT NOW(),
      column_map_id   INTEGER,
      function_map_id INTEGER,
      notes           TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS io_tags (
      id                 SERIAL PRIMARY KEY,
      import_id          INTEGER NOT NULL REFERENCES io_imports(id),
      row_number         INTEGER NOT NULL,
      raw_data           TEXT NOT NULL,
      tag_name           TEXT,
      function_val       TEXT,
      description        TEXT,
      signal_type        TEXT,
      area               TEXT,
      process_cell       TEXT,
      unit_id            TEXT,
      equipment_module   TEXT,
      assigned_cm_type   TEXT,
      assignment_status  TEXT DEFAULT 'pending',
      assigned_by        TEXT,
      assigned_at        TEXT,
      override_reason    TEXT,
      hierarchy_node_id  INTEGER,
      validation_status  TEXT DEFAULT 'unchecked',
      validation_flags   TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS io_column_mappings (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      mappings    TEXT NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS io_hierarchy_configs (
      id                    SERIAL PRIMARY KEY,
      column_map_id         INTEGER NOT NULL REFERENCES io_column_mappings(id),
      process_cell_col      TEXT,
      unit_col              TEXT,
      equipment_module_col  TEXT,
      area_col              TEXT,
      cm_group_rule         TEXT DEFAULT 'by_tag'
    )`,
    `CREATE TABLE IF NOT EXISTS io_function_map_configs (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS io_function_mappings (
      id             SERIAL PRIMARY KEY,
      config_id      INTEGER NOT NULL REFERENCES io_function_map_configs(id),
      function_value TEXT NOT NULL,
      cm_type_name   TEXT NOT NULL,
      priority       INTEGER DEFAULT 0,
      match_mode     TEXT DEFAULT 'exact',
      match_pattern  TEXT,
      notes          TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS io_hierarchy_nodes (
      id                 SERIAL PRIMARY KEY,
      import_id          INTEGER NOT NULL REFERENCES io_imports(id),
      parent_id          INTEGER REFERENCES io_hierarchy_nodes(id),
      level              TEXT NOT NULL,
      name               TEXT NOT NULL,
      s88_type           TEXT,
      sort_order         INTEGER DEFAULT 0,
      promoted           BOOLEAN DEFAULT FALSE,
      promoted_folder_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS io_validation_log (
      id          SERIAL PRIMARY KEY,
      import_id   INTEGER NOT NULL REFERENCES io_imports(id),
      tag_id      INTEGER,
      rule_code   TEXT NOT NULL,
      severity    TEXT NOT NULL,
      message     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS io_audit_trail (
      id          SERIAL PRIMARY KEY,
      import_id   INTEGER NOT NULL REFERENCES io_imports(id),
      tag_id      INTEGER,
      action      TEXT NOT NULL,
      actor       TEXT,
      before_val  TEXT,
      after_val   TEXT,
      reason      TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_iotags_import   ON io_tags(import_id)`,
    `CREATE INDEX IF NOT EXISTS idx_iotags_tag      ON io_tags(tag_name)`,
    `CREATE INDEX IF NOT EXISTS idx_iotags_function ON io_tags(function_val)`,
    `CREATE INDEX IF NOT EXISTS idx_iotags_status   ON io_tags(assignment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_iotags_hier     ON io_tags(hierarchy_node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_iofm_config     ON io_function_mappings(config_id)`,
    `CREATE INDEX IF NOT EXISTS idx_iohn_import     ON io_hierarchy_nodes(import_id)`,
    `CREATE INDEX IF NOT EXISTS idx_iohn_parent     ON io_hierarchy_nodes(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ioimports_proj  ON io_imports(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_iovlog_import   ON io_validation_log(import_id)`,
  ];
  for (const s of ioStmts) await rawRun(s);

  // Migration: add included column to io_column_mappings
  await addColumnIfMissing('io_column_mappings', 'included', `included TEXT`);

  // ── EPH/EM Import System ──────────────────────────────────────────────────────
  const ephEmStmts = [
    `CREATE TABLE IF NOT EXISTS eph_em_type_mapping_configs (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      mappings    TEXT NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS eph_em_column_mappings (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      mappings    TEXT NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS eph_em_function_map_configs (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS eph_em_function_mappings (
      id              SERIAL PRIMARY KEY,
      config_id       INTEGER NOT NULL REFERENCES eph_em_function_map_configs(id),
      eph_em_type     TEXT NOT NULL,
      cm_type_name    TEXT NOT NULL,
      naming_template TEXT DEFAULT '{eph_em_type}',
      priority        INTEGER DEFAULT 0,
      match_mode      TEXT DEFAULT 'exact',
      match_pattern   TEXT,
      notes           TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS eph_em_imports (
      id              SERIAL PRIMARY KEY,
      project_id      INTEGER NOT NULL REFERENCES projects(id),
      file_name       TEXT NOT NULL,
      file_size_bytes INTEGER,
      sheet_name      TEXT,
      total_rows      INTEGER,
      valid_rows      INTEGER DEFAULT 0,
      invalid_rows    INTEGER DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      imported_by     TEXT,
      imported_at     TIMESTAMPTZ DEFAULT NOW(),
      column_map_id   INTEGER REFERENCES eph_em_column_mappings(id),
      function_map_id INTEGER REFERENCES eph_em_function_map_configs(id),
      notes           TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS eph_em_import_rows (
      id               SERIAL PRIMARY KEY,
      import_id        INTEGER NOT NULL REFERENCES eph_em_imports(id),
      row_number       INTEGER NOT NULL,
      raw_data         TEXT NOT NULL,
      unit_name        TEXT,
      eph_em_types     TEXT DEFAULT '{}',
      assignment       TEXT,
      assigned_cm_types TEXT DEFAULT '{}',
      assignment_status TEXT DEFAULT 'pending',
      validation_status TEXT DEFAULT 'unchecked',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ephemfm_config ON eph_em_function_mappings(config_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ephemrows_import ON eph_em_import_rows(import_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ephemrows_unit ON eph_em_import_rows(unit_name)`,
    `CREATE INDEX IF NOT EXISTS idx_ephemrows_status ON eph_em_import_rows(assignment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_ephemimports_proj ON eph_em_imports(project_id)`,
  ];
  for (const s of ephEmStmts) await rawRun(s);

  // Migration: add columns metadata to eph_em_imports for persistent storage
  await addColumnIfMissing('eph_em_imports', 'columns', `columns TEXT DEFAULT '[]'`);

  // Migration: add AS assignment column to eph_em_import_rows
  await addColumnIfMissing('eph_em_import_rows', 'assignment', 'assignment TEXT');

  // Migration: eph_em_import_rows moved from one-type-per-row (eph_em_type /
  // assigned_cm_type) to many-types-per-row JSON maps. CREATE TABLE IF NOT EXISTS
  // skips tables built by earlier versions, so add the new columns explicitly.
  await addColumnIfMissing('eph_em_import_rows', 'eph_em_types', `eph_em_types TEXT DEFAULT '{}'`);
  await addColumnIfMissing('eph_em_import_rows', 'assigned_cm_types', `assigned_cm_types TEXT DEFAULT '{}'`);
  // Drop the superseded singular columns and the index that referenced one of them.
  await rawRun('DROP INDEX IF EXISTS idx_ephemrows_type');
  for (const col of ['eph_em_type', 'assigned_cm_type', 'hierarchy', 'destination_folder',
                     'assigned_by', 'assigned_at', 'override_reason', 'validation_flags']) {
    await rawRun(`ALTER TABLE eph_em_import_rows DROP COLUMN IF EXISTS ${col}`);
  }

  // Migrations: add instrument_tag, hierarchy, assignment columns to io_tags
  await addColumnIfMissing('io_tags', 'instrument_tag', 'instrument_tag TEXT');
  await addColumnIfMissing('io_tags', 'hierarchy', 'hierarchy TEXT');
  await addColumnIfMissing('io_tags', 'assignment', 'assignment TEXT');
  await rawRun('CREATE INDEX IF NOT EXISTS idx_iotags_instrument ON io_tags(instrument_tag)');
  await rawRun('CREATE INDEX IF NOT EXISTS idx_iotags_hierarchy  ON io_tags(hierarchy)');

  // Migration: persist hierarchy level map on io_imports
  await addColumnIfMissing('io_imports', 'level_map', 'level_map TEXT');

  // Migration: source_column_map_id preserves the user's originally-selected column
  // map config (e.g. one with a hardware mapping), independent of column_map_id —
  // which the "Import Instances" flow overwrites with a transient instance-only
  // config. The automated workflow reads the hardware mapping from this column so
  // it survives that overwrite.
  await addColumnIfMissing('io_imports', 'source_column_map_id', 'source_column_map_id INTEGER');

  // Migration: lib_valve_commands — user-editable name→value lookup for matrix dropdowns
  await rawRun(`CREATE TABLE IF NOT EXISTS lib_valve_commands (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    value      INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  // Seed defaults if table is empty
  const vcCount = (await rawGet('SELECT COUNT(*) AS n FROM lib_valve_commands')).n;
  if (Number(vcCount) === 0) {
    const defaults = [
      ['IDLE', 0], ['CLOSE', 100], ['OPEN', 101], ['CLOSEDELAY', 102], ['OPENDELAY', 103],
      ['ACTIVE', 110], ['RUN1', 111], ['RUN2', 112], ['PROGRAM', 120], ['PROGRAM1', 121],
      ['PROGRAM2', 122], ['INTERLOCK', 130], ['LOCK', 130], ['LOCAL', 139], ['OFFDELAY', 140],
      ['TRACKING', 141], ['RUN1DLY', 141], ['RUN2DLY', 142], ['PULSE', 150], ['PULSE1', 151],
      ['PULSE2', 152], ['CALCOFFSET', 160], ['RESETOFFSET', 161], ['OLC', 170], ['CLC', 171],
      ['TWOPOINT', 172], ['RESETTOTAL1_2', 180], ['RESETTOTAL1', 181], ['RESETTOTAL2', 182],
      ['HOLDTOTAL1_2', 183], ['HOLDTOTAL1', 184], ['HOLDTOTAL2', 185], ['LAST', 198], ['DEFAULT', 199],
    ];
    for (let i = 0; i < defaults.length; i++) {
      const [name, value] = defaults[i];
      await rawRun('INSERT INTO lib_valve_commands (name, value, sort_order) VALUES (?, ?, ?)', [name, value, i]);
    }
  }

  // ── HW Engineering Extension ─────────────────────────────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_module_templates (
    id             SERIAL PRIMARY KEY,
    order_no       TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    family         TEXT NOT NULL,
    signal_type    TEXT,
    channel_count  INTEGER DEFAULT 0,
    input_bytes    INTEGER DEFAULT 0,
    output_bytes   INTEGER DEFAULT 0,
    in_addr_fmt    TEXT,
    out_addr_fmt   TEXT,
    param_template TEXT,
    version        TEXT,
    gsdml_file     TEXT,
    dap_id         TEXT,
    hw_category    TEXT,
    in_identifier  TEXT,
    out_identifier TEXT,
    UNIQUE (order_no, hw_category)
  )`);

  await rawRun(`CREATE TABLE IF NOT EXISTS hw_imports (
    id           SERIAL PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES projects(id),
    baseline_cfg TEXT,
    excel_name   TEXT,
    column_map   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    imported_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwi_proj ON hw_imports(project_id)`);

  // Migration: add column_map to hw_imports if missing
  await addColumnIfMissing('hw_imports', 'column_map', 'column_map TEXT');

  await rawRun(`CREATE TABLE IF NOT EXISTS hw_signals (
    id              SERIAL PRIMARY KEY,
    hw_import_id    INTEGER NOT NULL REFERENCES hw_imports(id),
    row_number      INTEGER,
    station_address INTEGER NOT NULL,
    station_name    TEXT,
    ip_address      TEXT,
    slot            INTEGER NOT NULL,
    channel         INTEGER,
    module_order_no TEXT NOT NULL,
    module_name     TEXT,
    tag             TEXT,
    description     TEXT,
    signal_type     TEXT,
    subsystem_no    INTEGER,
    router_address  TEXT
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hws_import ON hw_signals(hw_import_id)`);

  // Migration: add subsystem_no to hw_signals if missing
  await addColumnIfMissing('hw_signals', 'subsystem_no', 'subsystem_no INTEGER');
  await addColumnIfMissing('hw_signals', 'router_address', 'router_address TEXT');
  await addColumnIfMissing('hw_signals', 'approved', 'approved BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumnIfMissing('hw_signals', 'pip_no', 'pip_no INTEGER');
  await addColumnIfMissing('hw_signals', 'potential_group', 'potential_group TEXT');
  // Stores the user-selected PROFIBUS PA subslot-1 profile for CFU_PA device slots (slot >= 3).
  // Valid values: 'Analog Input (AI)short' | 'Analog Input (AI)long' | 'SP (short)' | null
  await addColumnIfMissing('hw_signals', 'pa_profile', 'pa_profile TEXT');
  // Flag: true if this row was resolved by Tier 2 (Protocol+SignalType lookup), false otherwise
  await addColumnIfMissing('hw_signals', 'resolved_by_tier2', 'resolved_by_tier2 BOOLEAN NOT NULL DEFAULT FALSE');
  // Flag: true if Tier 2 lookup failed (placeholder used), needs manual resolution
  await addColumnIfMissing('hw_signals', 'unresolved', 'unresolved BOOLEAN NOT NULL DEFAULT FALSE');
  // Station MLFB: resolved from hw_hardware_resolution lookup (Tier 2 resolution)
  await addColumnIfMissing('hw_signals', 'station_mlfb', 'station_mlfb TEXT');

  // Raw Excel rows stored during parse-headers for preview/mapping without re-upload
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_excel_raw (
    id           SERIAL PRIMARY KEY,
    hw_import_id INTEGER NOT NULL REFERENCES hw_imports(id),
    row_index    INTEGER NOT NULL,
    row_json     TEXT NOT NULL
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwer_import ON hw_excel_raw(hw_import_id)`);

  // Per-subslot PA profile assignments (one row per function subslot of a CFU_PA device slot)
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_slot_subslots (
    id              SERIAL PRIMARY KEY,
    hw_import_id    INTEGER NOT NULL REFERENCES hw_imports(id),
    station_address INTEGER NOT NULL,
    slot            INTEGER NOT NULL,
    subslot_no      INTEGER NOT NULL,
    pa_profile      TEXT,
    UNIQUE(hw_import_id, station_address, slot, subslot_no)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwss_import ON hw_slot_subslots(hw_import_id)`);

  // ── Signal-to-Instance Mapping (standalone, additive) ────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS signal_mappings (
    id            SERIAL PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id),
    instance_name TEXT NOT NULL,
    block_name    TEXT NOT NULL,
    var_name      TEXT NOT NULL,
    signal_tag    TEXT NOT NULL,
    hw_signal_id  INTEGER,
    var_dtype     TEXT,
    signal_type   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (project_id, instance_name, block_name, var_name)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_sigmap_proj_inst
    ON signal_mappings(project_id, instance_name)`);

  // One-time migration: copy existing pa_profile values from hw_signals into hw_slot_subslots as subslot_no=1
  {
    const existing = await rawAll(
      "SELECT hw_import_id, station_address, slot, pa_profile FROM hw_signals WHERE pa_profile IS NOT NULL"
    );
    for (const r of existing) {
      await rawRun(
        `INSERT INTO hw_slot_subslots (hw_import_id, station_address, slot, subslot_no, pa_profile)
         VALUES (?, ?, ?, 1, ?) ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO NOTHING`,
        [r.hw_import_id, r.station_address, r.slot, r.pa_profile]
      );
    }
  }

  // Migration: add hw_category-related columns to hw_module_templates
  await addColumnIfMissing('hw_module_templates', 'subslot_defaults', 'subslot_defaults TEXT');
  await addColumnIfMissing('hw_module_templates', 'port_config', 'port_config TEXT');
  await addColumnIfMissing('hw_module_templates', 'in_identifier', 'in_identifier TEXT');
  await addColumnIfMissing('hw_module_templates', 'out_identifier', 'out_identifier TEXT');
  {
    const hwTplCols = await tableColumns('hw_module_templates');
    if (!hwTplCols.includes('hw_category')) {
      await rawRun('ALTER TABLE hw_module_templates ADD COLUMN hw_category TEXT');
      // Infer category for existing rows from order_no patterns.
      await rawRun(`UPDATE hw_module_templates SET hw_category = 'subslot' WHERE order_no LIKE '\\_S7H\\_HSP\\_%' ESCAPE '\\'`);
      await rawRun(`UPDATE hw_module_templates SET hw_category = 'station'
        WHERE hw_category IS NULL AND (
          order_no LIKE '6ES7 155-6%'  OR
          order_no LIKE '6ES7 193-6%'  OR
          order_no LIKE '6ES7 157-0%'  OR
          order_no LIKE '6ES7 154-8%'  OR
          order_no LIKE '6ES7 140-6%'  OR
          order_no LIKE '6ES7 153-4%'  OR
          order_no LIKE '6ES7 154-4%'  OR
          order_no LIKE '6ES7 15%-4%'  OR
          order_no LIKE '6ES7 4%'      OR
          order_no LIKE '6GK%'         OR
          order_no LIKE 'GSDML%'       OR
          order_no LIKE '7KM%'         OR
          order_no LIKE '6DL%'         OR
          order_no LIKE '6NH%'
        )`);
      await rawRun(`UPDATE hw_module_templates SET hw_category = 'station'
        WHERE hw_category IS NULL AND order_no LIKE 'V%:%'`);
      await rawRun(`UPDATE hw_module_templates SET hw_category = 'slot'
        WHERE hw_category IS NULL AND (
          order_no LIKE '6ES7 13%'  OR
          order_no LIKE '6ES7 14%'  OR
          order_no LIKE '6ES7 3%'   OR
          order_no LIKE '3RK%'      OR
          order_no LIKE 'META\\%' ESCAPE '\\'
        )`);
    }
  }

  // Note: hw_module_templates is created above with UNIQUE(order_no, hw_category)
  // directly — the SQLite version needed a table-rebuild migration to reach this
  // shape from an older UNIQUE(order_no)-only schema; not needed starting fresh
  // on Postgres.

  // Migration: add mlfb column to hw_module_templates (module type ID from CFG MLFB field)
  {
    const hwTplMlfbCols = await tableColumns('hw_module_templates');
    if (!hwTplMlfbCols.includes('mlfb')) {
      await rawRun('ALTER TABLE hw_module_templates ADD COLUMN mlfb TEXT');
      console.log('[DB] Migration: Added mlfb column to hw_module_templates');
    }
  }

  // Migration: add device_name to hw_imports (PROFINET device name for the station head)
  await addColumnIfMissing('hw_imports', 'baseline_info', 'baseline_info TEXT');

  await rawRun(`CREATE TABLE IF NOT EXISTS hw_generated_cfgs (
    id           SERIAL PRIMARY KEY,
    hw_import_id INTEGER NOT NULL REFERENCES hw_imports(id),
    cfg_text     TEXT NOT NULL,
    stats        TEXT,
    generated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwcfg_import ON hw_generated_cfgs(hw_import_id)`);

  // ── HW Controller & Fieldbus ─────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_controllers (
    id                     SERIAL PRIMARY KEY,
    project_id             INTEGER NOT NULL REFERENCES projects(id),
    T16_Controller_TagName TEXT,
    T16_Station_Type       TEXT,
    T24_Program_Container  TEXT,
    INT_Controller_No      INTEGER,
    T8_Version             TEXT,
    T15_IP_Address         TEXT,
    T50_Rack_Order_No      TEXT,
    T50_Rack_Name          TEXT,
    T50_PS_Order_No        TEXT,
    T50_PS_Name            TEXT,
    YN_Redundant           BOOLEAN DEFAULT FALSE,
    YN_Slave               BOOLEAN DEFAULT FALSE,
    MEM_Doc_Change         TEXT,
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW()
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwctrl_proj ON hw_controllers(project_id)`);

  await rawRun(`CREATE TABLE IF NOT EXISTS hw_fieldbuses (
    id                  SERIAL PRIMARY KEY,
    hw_controller_id    INTEGER NOT NULL REFERENCES hw_controllers(id),
    INT_DP_Subsystem    INTEGER,
    INT_Bus_DP_Address  INTEGER,
    T50_Fieldbus_Name   TEXT,
    LINT_T_Driver       TEXT,
    T15_IP_Address      TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwfb_ctrl ON hw_fieldbuses(hw_controller_id)`);

  // Seed common module templates. Idempotent via ON CONFLICT DO NOTHING: order_no+hw_category
  // is UNIQUE, so a row already present is left untouched.
  {
    const hwTemplates = [
      ['6ES7 131-6BH01-0BA0', 'ET200SP DI 16×24VDC', 'ET200SP', 'DI', 16, 2, 0,
        '{{addr}}, 0, 2, 0, 0, 16', null, null, null, null, null, 'slot'],
      ['6ES7 132-6BH01-0BA0', 'ET200SP DO 16×24VDC', 'ET200SP', 'DO', 16, 0, 2,
        null, '{{addr}}, 0, 2, 0, 0, 16', null, null, null, null, 'slot'],
      ['6ES7 134-6HD01-0BA1', 'ET200SP AI 4×U/I/RTD', 'ET200SP', 'AI', 4, 8, 0,
        '{{addr}}, 0, 8, 0, 0, 32', null, null, 'V2.0', null, null, 'slot'],
      ['6ES7 135-6HD00-0BA1', 'ET200SP AO 4×U/I', 'ET200SP', 'AO', 4, 0, 8,
        null, '{{addr}}, 0, 8, 0, 0, 32', null, null, null, null, 'slot'],
      ['6ES7 155-6AU01-0CN0', 'ET200SP IM 155-6 PN HF', 'ET200SP', 'INFRA', 0, 0, 0,
        null, null, null, 'V4.2', null, null, 'station'],
      ['META\\PA139700.GSD\\Transmitter 1 AI (Phy MBP)', 'CFU-PA AI Transmitter', 'CFU_PA', 'PA', 1, 5, 0,
        '{{addr}}, 0, 5, 0, 8, 0', null, null, null, null, null, 'slot'],
      ['_S7H_HSP_CFU_PA_V1_2_DI8_DQ8_CT', 'CFU-PA DIQ8 DC24V/0.5A', 'CFU_PA', 'MIXED', 8, 1, 1,
        '{{addr}}, 0, 1, 0, 1, 0', '{{addr}}, 0, 1, 0, 1, 0', null, null, null, null, 'subslot'],
      ['GSDML-V2.4-Siemens-002A-SCALANCE_XC200-20210310.xml', 'SCALANCE XC208', 'SCALANCE', 'INFRA', 8, 0, 0,
        null, null, null, 'V4.3', 'GSDML-V2.4-Siemens-002A-SCALANCE_XC200-20210310.xml', '4F', 'station'],
      ['GSDML-V2.4-Siemens-002A-SCALANCE_XB200-20201026.xml', 'SCALANCE XB208', 'SCALANCE', 'INFRA', 8, 0, 0,
        null, null, null, 'V4.3', 'GSDML-V2.4-Siemens-002A-SCALANCE_XB200-20201026.xml', '71', 'station'],
      ['GSDML-V2.25-Siemens-HMI_PP-20110915.xml', 'Siemens KP8 Panel', 'HMI', 'MIXED', 0, 2, 4,
        '{{addr}}, 0, 2, 3, 0, 0', '{{addr}}, 0, 4, 3, 0, 0', null, null,
        'GSDML-V2.25-Siemens-HMI_PP-20110915.xml', '1', 'station'],
      ['GSDML-V2.3-MT-IND570-PIR-20150930.XML', 'Mettler Toledo IND570', 'GSDML', 'MIXED', 0, 8, 8,
        '{{addr}}, 0, 8, 3, 0, 0', '{{addr}}, 0, 8, 3, 0, 0', null, null,
        'GSDML-V2.3-MT-IND570-PIR-20150930.XML', null, 'station'],
      ['6ES7 410-5HX08-0AB0', 'CPU 410-5H', 'S7400', 'INFRA', 0, 0, 0, null, null, null, 'V8.2.3', null, null, 'station'],
      ['6GK7 443-1EX30-0XE1', 'CP 443-1 EX30', 'S7400', 'INFRA', 0, 0, 0, null, null, null, 'V3.0', null, null, 'station'],
      ['6ES7 135-6TD00-0CA1', 'ET200SP AQ4×I HART', 'ET200SP', 'AO', 4, 0, 8,
        null, '{{addr}}, 0, 8, 0, 2, 0', `  POTENTIAL_GROUP, "NEW_GROUP"`, null, null, null, 'slot'],
      ['6ES7 134-6HD00-0BA1', 'ET200SP AI4×U/I ST', 'ET200SP', 'AI', 4, 8, 0,
        '{{addr}}, 0, 8, 0, 0, 32', null, null, null, null, null, 'slot'],
      ['V1_1:6ES7 193-6PA00-0AA0', 'ET200SP Server Module V1.1', 'ET200SP', 'INFRA', 0, 0, 0,
        null, null, null, 'V1.1', null, null, 'station'],
      ['6ES7 155-6AU00-0CN0', 'ET200SP IM 155-6 PN HF V4.2', 'ET200SP', 'INFRA', 0, 0, 0,
        null, null, null, 'V4.2', null, null, 'station'],
      ['6ES7 155-6AU00-0CN0', 'ET200SP IM 155-6 PN HF V4.2 (Slot 0)', 'ET200SP', 'INFRA', 0, 0, 0,
        null, null, null, 'V4.2', null, null, 'slot'],
      ['V_2_0_PA:6ES7 655-5PX11-0XX0', 'CFU-PA IM V2.0', 'CFU_PA', 'INFRA', 0, 0, 0,
        null, null, null, 'V2.0', null, null, 'station'],
      ['V_2_0_PA_ETER:6ES7 655-5PX11-0XX0', 'CFU-PA Ethernet Head (Slot 0)', 'CFU_PA', 'INFRA', 0, 0, 0,
        null, null, null, 'V2.0', null, null, 'subslot'],
      ['_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT', 'CFU-PA DIQ8 DC24V/0.5A', 'CFU_PA', 'MIXED', 16, 1, 1,
        '{{addr}}, 0, 1, 0, 1, 0', '{{addr}}, 0, 1, 0, 1, 0',
        null, null, null, null, 'slot'],
      ['_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT', 'CFU-PA PA Master (Slot 2)', 'CFU_PA', 'PA', 0, 4, 2,
        '{{addr}}, 0, 4, 0, 0, 0', '{{addr}}, 0, 2, 0, 0, 0', null, null, null, null, 'slot'],
    ];

    const insSql = `INSERT INTO hw_module_templates
       (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
        in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (order_no, hw_category) DO NOTHING`;
    for (const t of hwTemplates) await rawRun(insSql, t);
  }

  // Migration: correct templates whose seeded PARAMETER/version blocks did not
  // match PCS7's own export (caused HW import errors). Idempotent.
  const fixTpl = (orderNo, param, version) =>
    rawRun('UPDATE hw_module_templates SET param_template = ?, version = ? WHERE order_no = ?',
      [param, version, orderNo]);
  await fixTpl('6ES7 131-6BH01-0BA0', null, null);
  await fixTpl('6ES7 132-6BH01-0BA0', null, null);
  await fixTpl('6ES7 134-6HD00-0BA1', null, null);
  await fixTpl('6ES7 135-6TD00-0CA1', '  POTENTIAL_GROUP, "NEW_GROUP"', null);

  // Migration: DIQ8 channel_count was seeded as 8 (DI only) — must be 16 (8 DI + 8 DO)
  {
    const diq8 = await rawGet("SELECT channel_count FROM hw_module_templates WHERE order_no='_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT'");
    if (diq8 && diq8.channel_count !== 16) {
      await rawRun("UPDATE hw_module_templates SET channel_count=16 WHERE order_no='_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT'");
    }
  }

  // Migration: PA Master must use signal_type='PA', input_bytes=4, output_bytes=2
  {
    const paMaster = await rawGet("SELECT signal_type, input_bytes, output_bytes FROM hw_module_templates WHERE order_no='_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT'");
    if (paMaster && (paMaster.signal_type !== 'PA' || paMaster.input_bytes !== 4 || paMaster.output_bytes !== 2)) {
      await rawRun(`UPDATE hw_module_templates SET signal_type='PA', input_bytes=4, output_bytes=2,
        in_addr_fmt='{{addr}}, 0, 4, 0, 0, 0', out_addr_fmt='{{addr}}, 0, 2, 0, 0, 0'
        WHERE order_no='_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT'`);
    }
  }

  // Backfill per-card SYMBOL identifiers from signal_type defaults for any row that
  // hasn't got an explicit value yet. Idempotent: only NULLs are touched.
  {
    const { defaultIdentifiers } = require('./services/hwAddressEngine');
    const rows = await rawAll(
      `SELECT id, signal_type FROM hw_module_templates
       WHERE in_identifier IS NULL OR out_identifier IS NULL`
    );
    for (const r of rows) {
      const def = defaultIdentifiers(r.signal_type);
      await rawRun(
        `UPDATE hw_module_templates
         SET in_identifier  = COALESCE(in_identifier, ?),
             out_identifier = COALESCE(out_identifier, ?)
         WHERE id = ?`,
        [def.in, def.out, r.id]
      );
    }
  }

  // ── Signal types (user-extensible list) ─────────────────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_signal_types (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 999
  )`);
  const builtinTypes = [
    ['DI', 1], ['DO', 2], ['AI', 3], ['AO', 4],
    ['PA', 5], ['INFRA', 6], ['MIXED', 7],
    ['CFU_STATION', 8],
  ];
  for (const [name, sort_order] of builtinTypes) {
    await rawRun(`INSERT INTO hw_signal_types (name, sort_order) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`, [name, sort_order]);
  }
  {
    const existing = await rawAll(`SELECT DISTINCT signal_type FROM hw_module_templates WHERE signal_type IS NOT NULL`);
    for (const row of existing) {
      await rawRun(`INSERT INTO hw_signal_types (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, [row.signal_type]);
    }
  }

  // ── Tier 2 Hardware Resolution (Protocol + SignalType → Card MLFB + Station MLFB) ──
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_hardware_resolution (
    id             SERIAL PRIMARY KEY,
    protocol       TEXT NOT NULL,
    signal_type    TEXT NOT NULL,
    card_mlfb      TEXT NOT NULL,
    station_mlfb   TEXT NOT NULL,
    description    TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(protocol, signal_type)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwres_proto_sig ON hw_hardware_resolution(protocol, signal_type)`);

  await addColumnIfMissing('hw_hardware_resolution', 'station_mlfb', `station_mlfb TEXT NOT NULL DEFAULT ''`);

  const hwResCount = (await rawGet('SELECT COUNT(*) AS n FROM hw_hardware_resolution')).n;
  if (Number(hwResCount) === 0) {
    const resolutions = [
      ['SoftIO', 'DI', 'GSDML-V2.35-Festo-CPX-AP-I-20240606.xml|Module_8199', '6ES7 155-6AU00-0CN0', 'Festo CPX SoftIO DI Module'],
      ['STD', 'DI', '6ES7 131-6BH01-0BA0', '6ES7 155-6AU00-0CN0', 'ET200SP DI 16x24VDC'],
      ['STD', 'DO', '6ES7 132-6BH01-0BA0', '6ES7 155-6AU00-0CN0', 'ET200SP DO 16x24VDC'],
      ['STD', 'AI', '6ES7 134-6HD01-0BA1', '6ES7 155-6AU00-0CN0', 'ET200SP AI 4xU/I/RTD'],
      ['STD', 'AO', '6ES7 135-6HD00-0BA1', '6ES7 155-6AU00-0CN0', 'ET200SP AO 4xU/I'],
      ['PF', 'DO', 'GSDML-V2.35-Festo-CPX-AP-I-20240606.xml|Module_8505', '6ES7 155-6AU00-0CN0', 'Festo CPX PF DO Module'],
    ];
    for (const [protocol, signalType, cardMlfb, stationMlfb, desc] of resolutions) {
      await rawRun(
        'INSERT INTO hw_hardware_resolution (protocol, signal_type, card_mlfb, station_mlfb, description) VALUES (?,?,?,?,?)',
        [protocol, signalType, cardMlfb, stationMlfb, desc]
      );
    }
  }

  // ── Station Auto-Slot Configuration ────────────────────────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_station_auto_slots (
    id                    SERIAL PRIMARY KEY,
    order_no              TEXT NOT NULL UNIQUE,
    auto_slots_config     TEXT NOT NULL,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Migration: Add order_no column if it doesn't exist (for databases with old 'family' column)
  {
    const hsasCols = await tableColumns('hw_station_auto_slots');
    if (!hsasCols.includes('order_no') && hsasCols.includes('family')) {
      await rawRun('ALTER TABLE hw_station_auto_slots RENAME COLUMN family TO order_no');
      console.log('[DB] Migrated hw_station_auto_slots: family → order_no');
    }
  }

  // Seed auto-slot configurations from the existing hardcoded logic
  const autoSlotConfigCount = (await rawGet('SELECT COUNT(*) AS n FROM hw_station_auto_slots')).n;
  if (Number(autoSlotConfigCount) === 0) {
    const autoSlotConfigs = [
      {
        order_no: '6ES7 155-6AU00-0CN0',
        config: {
          slots: [
            {
              slot: 0,
              type: 'interface',
              order_no: '6ES7 155-6AU00-0CN0',
              version: 'V4.2',
              label: 'IM155-6PN-HF-V4.2',
              subslots: [
                { subslot: 1, type: 'subslot', order_no: '_S7H_HSP_155_6AU00_0CN0_V4_2_IFACE_CT', label: 'PN-IO' },
                { subslot: 2, type: 'port', port_label: 'Port 1 RJ45', order_no: 'DEFAULT:6ES7 193-6AR00-0AA0' },
                { subslot: 3, type: 'port', port_label: 'Port 2 RJ45', order_no: 'DEFAULT:6ES7 193-6AR00-0AA0' }
              ]
            }
          ],
          rules: {
            server_module_enabled: true
          }
        }
      },
      {
        order_no: 'V_2_0_PA_ETER:6ES7 655-5PX11-0XX0',
        config: {
          slots: [
            {
              slot: 0,
              type: 'interface',
              order_no: 'V_2_0_PA_ETER:6ES7 655-5PX11-0XX0',
              subslots: [
                { subslot: 1, type: 'subslot', order_no: '_S7H_HSP_CFU_PA_V2_0_IFACE_CT', label: 'PN-IO' },
                { subslot: 2, type: 'port', port_label: 'Port 1 RJ45', order_no: 'V_2_0_PORT_1:6DL1 193-6AR00-0AA0' },
                { subslot: 3, type: 'port', port_label: 'Port 2 RJ45', order_no: 'V_2_0_PORT_2:6DL1 193-6AR00-0AA0' }
              ]
            },
            {
              slot: 2,
              type: 'pa_master',
              subslots: [
                { subslot: 1, type: 'pa_master_param' },
                { subslot: 2, type: 'pa_master_status' }
              ]
            }
          ],
          rules: {
            server_module_enabled: false
          }
        }
      }
    ];

    for (const item of autoSlotConfigs) {
      await rawRun(
        'INSERT INTO hw_station_auto_slots (order_no, auto_slots_config) VALUES (?, ?)',
        [item.order_no, JSON.stringify(item.config)]
      );
    }
  }

  // ── Migration: Convert port_label to label for interface subslots ────────────────
  try {
    const autoSlotRows = await rawAll('SELECT id, auto_slots_config FROM hw_station_auto_slots');
    let migratedCount = 0;
    for (const row of autoSlotRows) {
      const config = JSON.parse(row.auto_slots_config);
      let updated = false;

      if (config.slots) {
        for (const slot of config.slots) {
          if (slot.subslots) {
            for (const subslot of slot.subslots) {
              if ((subslot.type === 'iface' || subslot.type === 'subslot') && !subslot.label) {
                subslot.label = subslot.port_label || 'PN-IO';
                delete subslot.port_label;
                updated = true;
              }
            }
          }
        }
      }

      if (updated) {
        await rawRun('UPDATE hw_station_auto_slots SET auto_slots_config = ? WHERE id = ?', [JSON.stringify(config), row.id]);
        migratedCount++;
      }
    }
    if (migratedCount > 0) {
      console.log(`[DB] Migrated ${migratedCount} auto-slot config(s) to use label field`);
    }
  } catch (e) {
    console.log(`[DB] Auto-slot config migration skipped or failed:`, e.message);
  }

  // ── Slot ↔ Subslot compatibility (M2M) ───────────────────────────────────────
  // Note: slot_order_no/subslot_order_no intentionally have no FK to
  // hw_module_templates.order_no — that column is not unique on its own
  // (unique key is (order_no, hw_category)), and the original SQLite schema
  // never actually enforced this reference either.
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_slot_subslot_compat (
    id              SERIAL PRIMARY KEY,
    slot_order_no   TEXT NOT NULL,
    subslot_order_no TEXT NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(slot_order_no, subslot_order_no)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_compat_slot    ON hw_slot_subslot_compat(slot_order_no)`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_compat_subslot ON hw_slot_subslot_compat(subslot_order_no)`);

  // ── MRP Configuration Module ─────────────────────────────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS mrp_configs (
    id              SERIAL PRIMARY KEY,
    hw_import_id    INTEGER NOT NULL REFERENCES hw_imports(id),
    domain_name     TEXT NOT NULL DEFAULT 'mrpdomain-1',
    fieldbus_no     INTEGER NOT NULL,
    station_name    TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_mrpcfg_import ON mrp_configs(hw_import_id)`);

  await rawRun(`CREATE TABLE IF NOT EXISTS mrp_device_roles (
    id            SERIAL PRIMARY KEY,
    mrp_config_id INTEGER NOT NULL REFERENCES mrp_configs(id) ON DELETE CASCADE,
    device_alias  TEXT NOT NULL,
    io_address    INTEGER,
    subsystem_no  INTEGER,
    mrp_role      INTEGER NOT NULL DEFAULT 0,
    mrp_instances INTEGER NOT NULL DEFAULT 0
  )`);
  await addColumnIfMissing('mrp_device_roles', 'io_address', 'io_address INTEGER');
  await addColumnIfMissing('mrp_device_roles', 'subsystem_no', 'subsystem_no INTEGER');
  await addColumnIfMissing('mrp_device_roles', 'ring_port_1', 'ring_port_1 INTEGER');
  await addColumnIfMissing('mrp_device_roles', 'ring_port_2', 'ring_port_2 INTEGER');
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_mrpdr_cfg ON mrp_device_roles(mrp_config_id)`);

  await rawRun(`CREATE TABLE IF NOT EXISTS mrp_port_links (
    id                   SERIAL PRIMARY KEY,
    mrp_config_id        INTEGER NOT NULL REFERENCES mrp_configs(id) ON DELETE CASCADE,
    from_device          TEXT NOT NULL,
    from_iface_subslot   INTEGER NOT NULL,
    from_port_subslot    INTEGER NOT NULL,
    to_device            TEXT NOT NULL,
    to_iface_subslot     INTEGER NOT NULL,
    to_port_subslot      INTEGER NOT NULL
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_mrppl_cfg ON mrp_port_links(mrp_config_id)`);

  // ── IO Connection Rules & Instance IOs ──────────────────────────────────────
  await rawRun(`CREATE TABLE IF NOT EXISTS lib_io_connections (
    id           SERIAL PRIMARY KEY,
    cm_type_id   INTEGER NOT NULL REFERENCES lib_cm_types(id) ON DELETE CASCADE,
    block_name   TEXT NOT NULL,
    var_name     TEXT NOT NULL,
    suffix       TEXT NOT NULL DEFAULT '',
    prefix       TEXT NOT NULL DEFAULT '',
    signal_type  TEXT NOT NULL DEFAULT 'DI',
    required     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_lioc_cmtype ON lib_io_connections(cm_type_id)`);

  await rawRun(`CREATE TABLE IF NOT EXISTS instance_ios (
    id               SERIAL PRIMARY KEY,
    project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    instance_name    TEXT NOT NULL,
    io_connection_id INTEGER REFERENCES lib_io_connections(id),
    block_name       TEXT NOT NULL,
    var_name         TEXT NOT NULL,
    signal_name      TEXT NOT NULL,
    signal_type      TEXT,
    required         BOOLEAN NOT NULL DEFAULT TRUE,
    status           TEXT NOT NULL DEFAULT 'dummy' CHECK(status IN ('dummy','real')),
    hw_signal_id     INTEGER REFERENCES hw_signals(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, instance_name, block_name, var_name)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_iios_proj_inst ON instance_ios(project_id, instance_name)`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_iios_signal    ON instance_ios(signal_name)`);

  await rawRun(`CREATE TABLE IF NOT EXISTS instance_derived_values (
    id             SERIAL PRIMARY KEY,
    project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    instance_name  TEXT NOT NULL,
    to_var_name    TEXT NOT NULL,
    block_name     TEXT,
    symbol_name    TEXT NOT NULL,
    column_name    TEXT NOT NULL,
    value          TEXT,
    status         TEXT NOT NULL DEFAULT 'unresolved' CHECK(status IN ('resolved','unresolved')),
    io_tag_id      INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, instance_name, to_var_name)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_idv_proj_inst ON instance_derived_values(project_id, instance_name)`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_iios_hwsig     ON instance_ios(hw_signal_id)`);

  // Per-instance matrix override — lets a single matrix CM instance carry edited
  // valve-state values distinct from its composite type's defaults, gated by one
  // `enabled` flag for the whole matrix. `cells` is JSON keyed by mode_nr →
  // { colName: intValue }; only overridden cells are stored (missing → composite
  // default → 0). Consumed by the Parameters modal and XML export.
  await rawRun(`CREATE TABLE IF NOT EXISTS instance_matrix_overrides (
    id            SERIAL PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    instance_name TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    cells         TEXT NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, instance_name)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_imo_proj_inst ON instance_matrix_overrides(project_id, instance_name)`);

  // Migration: manual override for a derived Value connection — takes priority over
  // the auto-resolved IO-list value everywhere it's consumed (modal display,
  // getDerivedValues, and XML export). NULL means "no override, use resolved value".
  await addColumnIfMissing('instance_derived_values', 'override_value', 'override_value TEXT');

  await addColumnIfMissing('instance_ios', 'signal_type', 'signal_type TEXT');
  await addColumnIfMissing('instance_ios', 'required', 'required BOOLEAN NOT NULL DEFAULT TRUE');

  // Migration: add source column to project_instances.
  await addColumnIfMissing('project_instances', 'source', `source TEXT NOT NULL DEFAULT 'manual'`);

  // Migration: add connections column to project_instances.
  await addColumnIfMissing('project_instances', 'connections', `connections TEXT NOT NULL DEFAULT '[]'`);

  // Clear orphaned lib_io_connections records (old approach; now using composite_cm_connections)
  await rawRun(`DELETE FROM lib_io_connections`);

  // User preferences for optional block selections in Type Configuration
  await rawRun(`CREATE TABLE IF NOT EXISTS user_cm_block_prefs (
    id            SERIAL PRIMARY KEY,
    cm_type_name  TEXT NOT NULL,
    enabled_blocks TEXT NOT NULL DEFAULT '[]',
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(cm_type_name)
  )`);

  // User preferences for selected columns in IO imports
  await rawRun(`CREATE TABLE IF NOT EXISTS user_io_column_prefs (
    id            SERIAL PRIMARY KEY,
    import_id     INTEGER NOT NULL,
    active_columns TEXT NOT NULL DEFAULT '[]',
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(import_id),
    FOREIGN KEY(import_id) REFERENCES io_imports(id) ON DELETE CASCADE
  )`);

  // ── Hardware Module Parameters ─────────────────────────────────────────────────
  // Migration: an earlier version of this table keyed on hw_signal_id. If that shape
  // is detected, drop and recreate with template_id.
  {
    const mpCols = await tableColumns('hw_module_parameters');
    if (mpCols.includes('hw_signal_id')) {
      await rawRun('DROP TABLE hw_module_parameters');
      console.log('[DB] Migration: dropped old hw_module_parameters (hw_signal_id → template_id)');
    }
  }
  await rawRun(`CREATE TABLE IF NOT EXISTS hw_module_parameters (
    id              SERIAL PRIMARY KEY,
    template_id     INTEGER NOT NULL REFERENCES hw_module_templates(id) ON DELETE CASCADE,
    parameter_name  TEXT NOT NULL,
    parameter_value TEXT,
    spare_value     TEXT,
    is_dynamic      BOOLEAN DEFAULT FALSE,
    channel_type    TEXT,
    channel_no      INTEGER,
    parameter_type  TEXT DEFAULT 'module',
    is_visible      BOOLEAN DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (template_id, parameter_name, channel_no)
  )`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwmp_template ON hw_module_parameters(template_id)`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwmp_param_name ON hw_module_parameters(parameter_name)`);
  await rawRun(`CREATE INDEX IF NOT EXISTS idx_hwmp_channel ON hw_module_parameters(channel_no)`);

  await addColumnIfMissing('hw_module_parameters', 'spare_value', 'spare_value TEXT');
  await addColumnIfMissing('hw_module_parameters', 'is_dynamic', 'is_dynamic BOOLEAN DEFAULT FALSE');
  await addColumnIfMissing('hw_module_parameters', 'is_visible', 'is_visible BOOLEAN DEFAULT TRUE');

  // One-time backfill: populate hw_module_parameters for templates that already have a
  // param_template but no normalized rows yet. Idempotent.
  {
    const pending = await rawAll(`
      SELECT t.id, t.param_template
      FROM hw_module_templates t
      WHERE t.param_template IS NOT NULL AND t.param_template != ''
        AND NOT EXISTS (SELECT 1 FROM hw_module_parameters p WHERE p.template_id = t.id)
    `);
    if (pending.length > 0) {
      const ModuleParameterExtractor = require('./services/moduleParameterExtractor');
      const extractor = new ModuleParameterExtractor();
      let backfilled = 0;
      for (const t of pending) {
        try {
          const params = extractor.parseParamTemplate(t.param_template);
          for (const p of params) {
            await rawRun(
              `INSERT INTO hw_module_parameters
                (template_id, parameter_name, parameter_value, channel_type, channel_no, parameter_type, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (template_id, parameter_name, channel_no) DO UPDATE SET
                 parameter_value = EXCLUDED.parameter_value,
                 channel_type    = EXCLUDED.channel_type,
                 parameter_type  = EXCLUDED.parameter_type,
                 sort_order      = EXCLUDED.sort_order`,
              [t.id, p.parameter_name, p.parameter_value ?? null,
                p.channel_type ?? null, p.channel_no ?? null,
                p.parameter_type || 'module', p.sort_order ?? 0]
            );
            backfilled++;
          }
        } catch (_) { /* skip a bad template, don't block startup */ }
      }
      if (backfilled > 0) {
        console.log(`[DB] Backfilled ${backfilled} module parameter rows for ${pending.length} existing templates`);
      }
    }
  }

  // ── Migration: Fix NULL updated_at in projects ──────────────────────
  try {
    const nullProjects = await rawAll(
      `SELECT COUNT(*) as count FROM projects WHERE updated_at IS NULL`
    );
    if (nullProjects[0]?.count > 0) {
      await rawRun(`UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL`);
      console.log(`[DB] Fixed ${nullProjects[0].count} projects with NULL updated_at`);
    }
  } catch (e) {
    console.warn('[DB] Migration: failed to fix NULL updated_at in projects:', e.message);
  }

  console.log('[DB] Schema ready');
}

module.exports = { initDb, getDb, ensureSchema };
