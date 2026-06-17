// src/db.js — SQLite via sql.js (pure JavaScript, no native compilation)
'use strict';
const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_PATH = process.env.DB_PATH || './data/pcs7_library.db';
const dbFile  = path.resolve(__dirname, '..', DB_PATH);

fs.mkdirSync(path.dirname(dbFile), { recursive: true });

let _db    = null;
let _inTx  = false;   // tracks whether we're inside a transaction

async function initDb() {
  if (_db) return _db;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  if (fs.existsSync(dbFile)) {
    _db = new SQL.Database(fs.readFileSync(dbFile));
    console.log(`[DB] Loaded — ${dbFile}`);
  } else {
    _db = new SQL.Database();
    console.log(`[DB] Created — ${dbFile}`);
  }
  _db.run('PRAGMA foreign_keys = ON');
  return _db;
}

function saveDb() {
  if (!_db) return;
  fs.writeFileSync(dbFile, Buffer.from(_db.export()));
}

// ── Helper: run a single SQL statement with positional params ─────────────────
function rawRun(sql, params = []) {
  _db.run(sql, params);
  const rid = _db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0;
  return { lastInsertRowid: rid };
}

function rawAll(sql, params = []) {
  const stmt   = _db.prepare(sql);
  const rows   = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function rawGet(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

// ── Public DB interface ───────────────────────────────────────────────────────
function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb() first');

  return {
    prepare(sql) {
      return {
        run(...params)  {
          const r = rawRun(sql, params.flat());
          // Only save to disk when NOT inside a transaction
          // (transaction() handles the save itself after COMMIT)
          if (!_inTx) saveDb();
          return r;
        },
        all(...params)  { return rawAll(sql, params.flat()); },
        get(...params)  { return rawGet(sql, params.flat()); },
      };
    },

    transaction(fn) {
      return (...args) => {
        _db.run('BEGIN');
        _inTx = true;
        try {
          const result = fn(...args);
          _db.run('COMMIT');
          _inTx = false;
          saveDb();          // single save after entire transaction
          return result;
        } catch (err) {
          _inTx = false;
          try { _db.run('ROLLBACK'); } catch (_) {}
          throw err;
        }
      };
    },
  };
}

// ── Schema ────────────────────────────────────────────────────────────────────
function ensureSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS lib_cm_types (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      cm_type       TEXT,
      comment       TEXT,
      sampling_time TEXT,
      loaded_at     TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS lib_blocks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cm_type_id  INTEGER NOT NULL,
      name        TEXT NOT NULL,
      comment     TEXT,
      optional    INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lib_variables (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id    INTEGER NOT NULL,
      lib_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      dir         TEXT,
      dtype       TEXT,
      val         TEXT,
      comment     TEXT,
      vtype       TEXT,
      enumeration TEXT,
      negation    INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lib_var_links (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      var_id         INTEGER NOT NULL,
      target_lib_id  TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS lib_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id   INTEGER NOT NULL,
      name       TEXT NOT NULL,
      batch      TEXT,
      cls        TEXT,
      event      TEXT,
      origin     TEXT,
      osarea     TEXT,
      prio       TEXT,
      ack        INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS lib_em_roles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cm_type_id  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_em_roles_cm ON lib_em_roles(cm_type_id)`,
    `CREATE TABLE IF NOT EXISTS audit_generations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name   TEXT NOT NULL,
      generated_by   TEXT,
      generated_at   TEXT DEFAULT (datetime('now')),
      instance_count INTEGER,
      block_count    INTEGER,
      var_count      INTEGER,
      msg_count      INTEGER,
      link_count     INTEGER,
      xml_size_kb    REAL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_instances (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id  INTEGER NOT NULL,
      cm_type        TEXT NOT NULL,
      instance_name  TEXT NOT NULL,
      sampling_time  TEXT,
      enabled_blocks TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      comment    TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS project_instances (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL,
      cm_type       TEXT NOT NULL,
      instance_name TEXT NOT NULL,
      sampling_time TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS project_cmt_profiles (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL,
      cm_type        TEXT NOT NULL,
      enabled_blocks TEXT NOT NULL,
      UNIQUE (project_id, cm_type)
    )`,
    `CREATE TABLE IF NOT EXISTS project_user_projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS project_hierarchy_folders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS unit_type_members (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_type_id     INTEGER NOT NULL REFERENCES unit_types(id),
      alias            TEXT NOT NULL,
      cm_type_name     TEXT NOT NULL,
      hierarchy_folder TEXT,
      sort_order       INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS unit_type_member_roles (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id      INTEGER NOT NULL REFERENCES unit_type_members(id),
      role           TEXT NOT NULL,
      assigned_alias TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS unit_instances (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER NOT NULL REFERENCES projects(id),
      unit_type_id INTEGER NOT NULL REFERENCES unit_types(id),
      unit_name    TEXT NOT NULL,
      sort_order   INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_utm_unit   ON unit_type_members(unit_type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_utmr_mem   ON unit_type_member_roles(member_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ui_proj    ON unit_instances(project_id)`,

    // ── Composite CM Type System ──────────────────────────────────────────────
    // A composite CM is a named group of library CM types that expand together
    // into one logical unit (e.g. CM_AO + NIF_C), each placed in its own
    // hierarchy folder with an optional prefix/suffix applied to the instance name.
    `CREATE TABLE IF NOT EXISTS composite_cm_types (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS composite_cm_members (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      composite_id     INTEGER NOT NULL REFERENCES composite_cm_types(id),
      cm_type_name     TEXT NOT NULL,
      hierarchy_folder TEXT NOT NULL DEFAULT 'CM',
      name_prefix      TEXT NOT NULL DEFAULT '',
      name_suffix      TEXT NOT NULL DEFAULT '',
      is_primary       INTEGER NOT NULL DEFAULT 0,
      sort_order       INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ccm_comp    ON composite_cm_members(composite_id)`,

    // Interconnections between composite members (output→input wiring)
    `CREATE TABLE IF NOT EXISTS composite_cm_connections (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      composite_id      INTEGER NOT NULL REFERENCES composite_cm_types(id),
      from_member_idx   INTEGER NOT NULL,  -- index into composite_cm_members (sort_order position)
      from_var_name     TEXT NOT NULL,     -- variable name on the source side (output)
      to_member_idx     INTEGER NOT NULL,  -- index into composite_cm_members (sort_order position)
      to_var_name       TEXT NOT NULL,     -- variable name on the destination side (input)
      sort_order        INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ccc_comp ON composite_cm_connections(composite_id)`,
  ];

  for (const s of stmts) _db.run(s);

  // Migrations: add columns to project_instances if missing
  const piCols = rawAll('PRAGMA table_info(project_instances)').map(c => c.name);
  if (!piCols.includes('user_project')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN user_project TEXT');
  }
  if (!piCols.includes('folder_id')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN folder_id INTEGER');
  }
  if (!piCols.includes('role_assignments')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN role_assignments TEXT');
  }

  // Migrations: add role_kind to lib_em_roles if missing (EPH uses EquipmentModuleAssignment)
  const erCols = rawAll('PRAGMA table_info(lib_em_roles)').map(c => c.name);
  if (!erCols.includes('role_kind')) {
    _db.run(`ALTER TABLE lib_em_roles ADD COLUMN role_kind TEXT NOT NULL DEFAULT 'cm'`);
  }

  // Migrations: add source_unit_instance_id to project_instances and project_hierarchy_folders
  const piCols2 = rawAll('PRAGMA table_info(project_instances)').map(c => c.name);
  if (!piCols2.includes('source_unit_instance_id')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN source_unit_instance_id INTEGER');
  }
  _db.run('CREATE INDEX IF NOT EXISTS idx_pi_srcui ON project_instances(source_unit_instance_id)');

  const phfCols = rawAll('PRAGMA table_info(project_hierarchy_folders)').map(c => c.name);
  if (!phfCols.includes('source_unit_instance_id')) {
    _db.run('ALTER TABLE project_hierarchy_folders ADD COLUMN source_unit_instance_id INTEGER');
  }
  _db.run('CREATE INDEX IF NOT EXISTS idx_phf_srcui ON project_hierarchy_folders(source_unit_instance_id)');

  // Migrations: add user_project + parent_path to unit_instances
  const uiCols = rawAll('PRAGMA table_info(unit_instances)').map(c => c.name);
  if (!uiCols.includes('user_project')) {
    _db.run('ALTER TABLE unit_instances ADD COLUMN user_project TEXT');
  }
  if (!uiCols.includes('parent_path')) {
    _db.run('ALTER TABLE unit_instances ADD COLUMN parent_path TEXT');
  }

  // Migration: add composite_cm_id to unit_type_members
  // When set, the member represents a whole composite (multiple sub-instances expand from one row).
  const utmCols = rawAll('PRAGMA table_info(unit_type_members)').map(c => c.name);
  if (!utmCols.includes('composite_cm_id')) {
    _db.run('ALTER TABLE unit_type_members ADD COLUMN composite_cm_id INTEGER');
  }

  // Migration: add instantiation scope to composite_cm_members.
  // 'unit'    → one instance per generated unit (default, legacy behaviour).
  // 'project' → a single shared instance per User Project; references reuse it.
  const ccmCols = rawAll('PRAGMA table_info(composite_cm_members)').map(c => c.name);
  if (!ccmCols.includes('scope')) {
    _db.run(`ALTER TABLE composite_cm_members ADD COLUMN scope TEXT NOT NULL DEFAULT 'unit'`);
  }

  // Migration: extend unit_type_member_roles to address composite sub-members.
  // A role lives on an EM/EPH sub-member of the member's composite (source_member_idx),
  // and targets a sub-member of another (or the same) unit member's composite
  // (assigned_alias = target unit-member alias, target_member_idx = sub-member index).
  const utmrCols = rawAll('PRAGMA table_info(unit_type_member_roles)').map(c => c.name);
  if (!utmrCols.includes('source_member_idx')) {
    _db.run('ALTER TABLE unit_type_member_roles ADD COLUMN source_member_idx INTEGER NOT NULL DEFAULT 0');
  }
  if (!utmrCols.includes('target_member_idx')) {
    _db.run('ALTER TABLE unit_type_member_roles ADD COLUMN target_member_idx INTEGER NOT NULL DEFAULT 0');
  }

  // Migrations: add composite wiring metadata to project_instances
  // These three columns let a saved/loaded project reconstruct connGroups for XML generation.
  const piCols3 = rawAll('PRAGMA table_info(project_instances)').map(c => c.name);
  if (!piCols3.includes('composite_group_id')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN composite_group_id INTEGER');
  }
  if (!piCols3.includes('composite_id')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN composite_id INTEGER');
  }
  if (!piCols3.includes('member_idx')) {
    _db.run('ALTER TABLE project_instances ADD COLUMN member_idx INTEGER');
  }

  // Migration: add conn_type + static_value to composite_cm_connections
  // conn_type: 'interconnection' (output→input) or 'value' (static value → input)
  const cccCols = rawAll('PRAGMA table_info(composite_cm_connections)').map(c => c.name);
  if (!cccCols.includes('conn_type')) {
    _db.run(`ALTER TABLE composite_cm_connections ADD COLUMN conn_type TEXT NOT NULL DEFAULT 'interconnection'`);
  }
  if (!cccCols.includes('static_value')) {
    _db.run(`ALTER TABLE composite_cm_connections ADD COLUMN static_value TEXT`);
  }

  // Migration: add is_matrix flag + matrix tables to composite CM
  const cctCols = rawAll('PRAGMA table_info(composite_cm_types)').map(c => c.name);
  if (!cctCols.includes('is_matrix')) {
    _db.run(`ALTER TABLE composite_cm_types ADD COLUMN is_matrix INTEGER NOT NULL DEFAULT 0`);
  }
  _db.run(`CREATE TABLE IF NOT EXISTS composite_matrix_columns (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    composite_id INTEGER NOT NULL REFERENCES composite_cm_types(id),
    column_name  TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_cmc_comp ON composite_matrix_columns(composite_id)`);
  _db.run(`CREATE TABLE IF NOT EXISTS composite_matrix_modes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    composite_id INTEGER NOT NULL REFERENCES composite_cm_types(id),
    mode_nr      INTEGER NOT NULL,
    mode_name    TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_cmm_comp ON composite_matrix_modes(composite_id)`);
  _db.run(`CREATE TABLE IF NOT EXISTS composite_matrix_cells (
    mode_id      INTEGER NOT NULL REFERENCES composite_matrix_modes(id),
    column_name  TEXT NOT NULL,
    value        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mode_id, column_name)
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_cmc_mode ON composite_matrix_cells(mode_id)`);

  // Migration: add is_valid to lib_variables (marks a variable as exposed for composite wiring)
  const lvCols = rawAll('PRAGMA table_info(lib_variables)').map(c => c.name);
  if (!lvCols.includes('is_valid')) {
    _db.run('ALTER TABLE lib_variables ADD COLUMN is_valid INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: add project_config table (per-project PCS7 hardware IDs)
  _db.run(`CREATE TABLE IF NOT EXISTS project_config (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
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
    updated_at       TEXT DEFAULT (datetime('now'))
  )`);

  // ── IO Import System ──────────────────────────────────────────────
  const ioStmts = [
    `CREATE TABLE IF NOT EXISTS io_imports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER NOT NULL REFERENCES projects(id),
      file_name       TEXT NOT NULL,
      file_size_bytes INTEGER,
      sheet_name      TEXT,
      total_rows      INTEGER,
      valid_rows      INTEGER DEFAULT 0,
      invalid_rows    INTEGER DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      imported_by     TEXT,
      imported_at     TEXT DEFAULT (datetime('now')),
      column_map_id   INTEGER,
      function_map_id INTEGER,
      notes           TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS io_tags (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS io_column_mappings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      mappings    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS io_hierarchy_configs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      column_map_id         INTEGER NOT NULL REFERENCES io_column_mappings(id),
      process_cell_col      TEXT,
      unit_col              TEXT,
      equipment_module_col  TEXT,
      area_col              TEXT,
      cm_group_rule         TEXT DEFAULT 'by_tag'
    )`,
    `CREATE TABLE IF NOT EXISTS io_function_map_configs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS io_function_mappings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id      INTEGER NOT NULL REFERENCES io_function_map_configs(id),
      function_value TEXT NOT NULL,
      cm_type_name   TEXT NOT NULL,
      priority       INTEGER DEFAULT 0,
      match_mode     TEXT DEFAULT 'exact',
      match_pattern  TEXT,
      notes          TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS io_hierarchy_nodes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id          INTEGER NOT NULL REFERENCES io_imports(id),
      parent_id          INTEGER REFERENCES io_hierarchy_nodes(id),
      level              TEXT NOT NULL,
      name               TEXT NOT NULL,
      s88_type           TEXT,
      sort_order         INTEGER DEFAULT 0,
      promoted           INTEGER DEFAULT 0,
      promoted_folder_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS io_validation_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id   INTEGER NOT NULL REFERENCES io_imports(id),
      tag_id      INTEGER,
      rule_code   TEXT NOT NULL,
      severity    TEXT NOT NULL,
      message     TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS io_audit_trail (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id   INTEGER NOT NULL REFERENCES io_imports(id),
      tag_id      INTEGER,
      action      TEXT NOT NULL,
      actor       TEXT,
      before_val  TEXT,
      after_val   TEXT,
      reason      TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
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
  for (const s of ioStmts) _db.run(s);

  // Migration: add included column to io_column_mappings
  const ioCmCols = rawAll('PRAGMA table_info(io_column_mappings)').map(c => c.name);
  if (!ioCmCols.includes('included')) {
    _db.run(`ALTER TABLE io_column_mappings ADD COLUMN included TEXT`);
  }

  // Migrations: add instrument_tag, hierarchy, assignment columns to io_tags
  const ioTagCols = rawAll('PRAGMA table_info(io_tags)').map(c => c.name);
  if (!ioTagCols.includes('instrument_tag')) {
    _db.run('ALTER TABLE io_tags ADD COLUMN instrument_tag TEXT');
  }
  if (!ioTagCols.includes('hierarchy')) {
    _db.run('ALTER TABLE io_tags ADD COLUMN hierarchy TEXT');
  }
  if (!ioTagCols.includes('assignment')) {
    _db.run('ALTER TABLE io_tags ADD COLUMN assignment TEXT');
  }
  _db.run('CREATE INDEX IF NOT EXISTS idx_iotags_instrument ON io_tags(instrument_tag)');
  _db.run('CREATE INDEX IF NOT EXISTS idx_iotags_hierarchy  ON io_tags(hierarchy)');

  // Migration: persist hierarchy level map on io_imports
  const ioImportCols = rawAll('PRAGMA table_info(io_imports)').map(c => c.name);
  if (!ioImportCols.includes('level_map')) {
    _db.run('ALTER TABLE io_imports ADD COLUMN level_map TEXT');
  }

  // Migration: lib_valve_commands — user-editable name→value lookup for matrix dropdowns
  _db.run(`CREATE TABLE IF NOT EXISTS lib_valve_commands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    value      INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  // Seed defaults if table is empty
  const vcCount = rawGet('SELECT COUNT(*) AS n FROM lib_valve_commands').n;
  if (!vcCount) {
    const defaults = [
      ['IDLE', 0], ['CLOSE', 100], ['OPEN', 101], ['CLOSEDELAY', 102], ['OPENDELAY', 103],
      ['ACTIVE', 110], ['RUN1', 111], ['RUN2', 112], ['PROGRAM', 120], ['PROGRAM1', 121],
      ['PROGRAM2', 122], ['INTERLOCK', 130], ['LOCK', 130], ['LOCAL', 139], ['OFFDELAY', 140],
      ['TRACKING', 141], ['RUN1DLY', 141], ['RUN2DLY', 142], ['PULSE', 150], ['PULSE1', 151],
      ['PULSE2', 152], ['CALCOFFSET', 160], ['RESETOFFSET', 161], ['OLC', 170], ['CLC', 171],
      ['TWOPOINT', 172], ['RESETTOTAL1_2', 180], ['RESETTOTAL1', 181], ['RESETTOTAL2', 182],
      ['HOLDTOTAL1_2', 183], ['HOLDTOTAL1', 184], ['HOLDTOTAL2', 185], ['LAST', 198], ['DEFAULT', 199],
    ];
    defaults.forEach(([name, value], i) => {
      _db.run('INSERT INTO lib_valve_commands (name, value, sort_order) VALUES (?, ?, ?)', [name, value, i]);
    });
  }

  saveDb();
  console.log('[DB] Schema ready');
}

module.exports = { initDb, getDb, saveDb, ensureSchema };
