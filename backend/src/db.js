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

  // ── HW Engineering Extension ─────────────────────────────────────────────────
  _db.run(`CREATE TABLE IF NOT EXISTS hw_module_templates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no       TEXT NOT NULL UNIQUE,
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
    hw_category    TEXT
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS hw_imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id),
    baseline_cfg TEXT,
    excel_name   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    imported_at  TEXT DEFAULT (datetime('now'))
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_hwi_proj ON hw_imports(project_id)`);

  _db.run(`CREATE TABLE IF NOT EXISTS hw_signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
  _db.run(`CREATE INDEX IF NOT EXISTS idx_hws_import ON hw_signals(hw_import_id)`);

  // Migration: add subsystem_no to hw_signals if missing
  const hwSigCols = rawAll('PRAGMA table_info(hw_signals)').map(c => c.name);
  if (!hwSigCols.includes('subsystem_no')) {
    _db.run('ALTER TABLE hw_signals ADD COLUMN subsystem_no INTEGER');
  }
  if (!hwSigCols.includes('router_address')) {
    _db.run('ALTER TABLE hw_signals ADD COLUMN router_address TEXT');
  }
  if (!hwSigCols.includes('approved')) {
    _db.run('ALTER TABLE hw_signals ADD COLUMN approved INTEGER NOT NULL DEFAULT 0');
  }
  if (!hwSigCols.includes('pip_no')) {
    _db.run('ALTER TABLE hw_signals ADD COLUMN pip_no INTEGER');
  }
  if (!hwSigCols.includes('potential_group')) {
    _db.run("ALTER TABLE hw_signals ADD COLUMN potential_group TEXT");
  }

  // Migration: add hw_category to hw_module_templates
  // Values: 'station' (IM / station head), 'slot' (IO card), 'subslot' (IFACE block), null (unknown)
  const hwTplCols = rawAll('PRAGMA table_info(hw_module_templates)').map(c => c.name);
  if (!hwTplCols.includes('hw_category')) {
    _db.run('ALTER TABLE hw_module_templates ADD COLUMN hw_category TEXT');
    // Infer category for existing rows from order_no patterns.
    // Slot cards:   IO card order numbers (DI/DO/AI/AO modules — they have I/O bytes in practice,
    //               but we key off order_no prefix here for reliability).
    //   ET200SP IO cards: 6ES7 13x-6, 6ES7 134-6, 6ES7 135-6 (these are the slot cards)
    //   ET200SP IMs:      6ES7 155-6, 6ES7 193-6 → station
    //   ET200AL IO:       6ES7 141-6, 6ES7 142-6 → slot  |  6ES7 157-0 (IM) → station
    //   ET200eco IO:      6ES7 14x-4 → slot       |  6ES7 154-8, 6ES7 140-6 → station
    //   ET200M IMs:       6ES7 153-4, 6ES7 154-4 → station  |  6ES7 3xx → slot
    //   SCALANCE/HMI/GSDML → station (they are network heads, not slot cards)
    //   _S7H_HSP_... → subslot (PCS7 IFACE blocks)
    //   CFU/PA META\... → slot
    _db.run(`UPDATE hw_module_templates SET hw_category = 'subslot' WHERE order_no LIKE '_S7H_HSP_%'`);
    _db.run(`UPDATE hw_module_templates SET hw_category = 'station'
      WHERE hw_category IS NULL AND (
        order_no LIKE '6ES7 155-6%'  OR  -- ET200SP IM 155
        order_no LIKE '6ES7 193-6%'  OR  -- ET200SP server module / BU
        order_no LIKE '6ES7 157-0%'  OR  -- ET200AL IM 157
        order_no LIKE '6ES7 154-8%'  OR  -- ET200eco IM 154-8
        order_no LIKE '6ES7 140-6%'  OR  -- ET200eco IM 140-6
        order_no LIKE '6ES7 153-4%'  OR  -- ET200M IM 153
        order_no LIKE '6ES7 154-4%'  OR  -- ET200M IM 154
        order_no LIKE '6ES7 15%-4%'  OR  -- ET200M IM general
        order_no LIKE '6ES7 4%'      OR  -- S7-400 CPU / CP / IM
        order_no LIKE '6GK%'         OR  -- SCALANCE / CP
        order_no LIKE 'GSDML%'       OR  -- 3rd-party GSDML heads
        order_no LIKE '7KM%'         OR  -- SENTRON PAC
        order_no LIKE '6DL%'         OR  -- SINAUT RTU
        order_no LIKE '6NH%'             -- SINAUT RTU
      )`);
    // Versioned pseudo-order for ET200SP IMs (e.g. "V1_1:6ES7 193-6...")
    _db.run(`UPDATE hw_module_templates SET hw_category = 'station'
      WHERE hw_category IS NULL AND order_no LIKE 'V%:%'`);
    // ET200SP / ET200AL / ET200eco / ET200M IO cards — remaining unclassified Siemens modules
    _db.run(`UPDATE hw_module_templates SET hw_category = 'slot'
      WHERE hw_category IS NULL AND (
        order_no LIKE '6ES7 13%'  OR
        order_no LIKE '6ES7 14%'  OR
        order_no LIKE '6ES7 3%'   OR
        order_no LIKE '3RK%'      OR
        order_no LIKE 'META\\%'
      )`);
  }

  // Migration: add device_name to hw_imports (PROFINET device name for the station head)
  const hwImpCols = rawAll('PRAGMA table_info(hw_imports)').map(c => c.name);
  if (!hwImpCols.includes('baseline_info')) {
    _db.run('ALTER TABLE hw_imports ADD COLUMN baseline_info TEXT');
  }

  _db.run(`CREATE TABLE IF NOT EXISTS hw_generated_cfgs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hw_import_id INTEGER NOT NULL REFERENCES hw_imports(id),
    cfg_text     TEXT NOT NULL,
    stats        TEXT,
    generated_at TEXT DEFAULT (datetime('now'))
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_hwcfg_import ON hw_generated_cfgs(hw_import_id)`);

  // ── HW Controller & Fieldbus (migrated from App2) ─────────────────────────
  _db.run(`CREATE TABLE IF NOT EXISTS hw_controllers (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
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
    YN_Redundant           INTEGER DEFAULT 0,
    YN_Slave               INTEGER DEFAULT 0,
    MEM_Doc_Change         TEXT,
    created_at             TEXT DEFAULT (datetime('now')),
    updated_at             TEXT DEFAULT (datetime('now'))
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_hwctrl_proj ON hw_controllers(project_id)`);

  _db.run(`CREATE TABLE IF NOT EXISTS hw_fieldbuses (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    hw_controller_id    INTEGER NOT NULL REFERENCES hw_controllers(id),
    INT_DP_Subsystem    INTEGER,
    INT_Bus_DP_Address  INTEGER,
    T50_Fieldbus_Name   TEXT,
    LINT_T_Driver       TEXT,
    T15_IP_Address      TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now'))
  )`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_hwfb_ctrl ON hw_fieldbuses(hw_controller_id)`);

  // Seed common module templates. Idempotent: INSERT OR IGNORE adds any template
  // missing from an existing DB (e.g. modules added to this list after the DB was
  // first created) without overwriting user-edited rows. order_no is UNIQUE, so a
  // row already present is left untouched.
  {
    // order_no, display_name, family, signal_type, ch, in_bytes, out_bytes, in_fmt, out_fmt, param, version, gsdml, dap, hw_category
    const hwTemplates = [
      // NOTE: PCS7's own export of these ST modules emits NO PARAMETER block
      // (no POTENTIAL_GROUP, no DIAGNOSTICS_WIRE_BREAK). Keep param_template null
      // so generated blocks match the golden and reimport cleanly.
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
      // Additional ET200SP modules from real CFG
      ['6ES7 135-6TD00-0CA1', 'ET200SP AQ4×I HART', 'ET200SP', 'AO', 4, 0, 8,
        null, '{{addr}}, 0, 8, 0, 2, 0', `  POTENTIAL_GROUP, "NEW_GROUP"`, null, null, null, 'slot'],
      // AI4 ST V1.0: golden header carries NO version string and NO PARAMETER block.
      ['6ES7 134-6HD00-0BA1', 'ET200SP AI4×U/I ST', 'ET200SP', 'AI', 4, 8, 0,
        '{{addr}}, 0, 8, 0, 0, 32', null, null, null, null, null, 'slot'],
      ['V1_1:6ES7 193-6PA00-0AA0', 'ET200SP Server Module V1.1', 'ET200SP', 'INFRA', 0, 0, 0,
        null, null, null, 'V1.1', null, null, 'station'],
      ['6ES7 155-6AU00-0CN0', 'ET200SP IM 155-6 PN HF V4.2', 'ET200SP', 'INFRA', 0, 0, 0,
        null, null, null, 'V4.2', null, null, 'station'],

      // ── CFU_PA (Common Foundation Unit – PROFIBUS PA) ─────────────────────────
      // Station IM — "V_2_0_PA:6ES7 655-5PX11-0XX0"
      ['V_2_0_PA:6ES7 655-5PX11-0XX0', 'CFU-PA IM V2.0', 'CFU_PA', 'INFRA', 0, 0, 0,
        null, null, null, 'V2.0', null, null, 'station'],
      // Slot 0 ethernet head (AUTOCREATED in CFG — order used verbatim for SLOT 0 block)
      ['V_2_0_PA_ETER:6ES7 655-5PX11-0XX0', 'CFU-PA Ethernet Head (Slot 0)', 'CFU_PA', 'INFRA', 0, 0, 0,
        null, null, null, 'V2.0', null, null, 'subslot'],
      // Slot 1 — DIQ8 (digital DI+DQ, 1 byte each — goes in digital address space)
      // channel_count=16: channels 0-7 are DI, channels 8-15 are DO
      ['_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT', 'CFU-PA DIQ8 DC24V/0.5A', 'CFU_PA', 'MIXED', 16, 1, 1,
        '{{addr}}, 0, 1, 0, 1, 0', '{{addr}}, 0, 1, 0, 1, 0',
        null, null, null, null, 'slot'],
      // Slot 2 — PROFIBUS PA Master (AUTOCREATED). The Subslot 2 Status+Notifications block
      // carries 4 DI bytes + 2 DQ bytes in the ANALOG process image. These bytes ARE drawn
      // from the global analog pool (e.g. 528→532 for DI, 528→530 for DQ), advancing the
      // pointer so that PA transmitter Slot 3+ addresses start correctly after Slot 2.
      // signal_type='PA' makes isAnalog() return true; input_bytes=4, output_bytes=2.
      ['_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT', 'CFU-PA PA Master (Slot 2)', 'CFU_PA', 'PA', 0, 4, 2,
        '{{addr}}, 0, 4, 0, 0, 0', '{{addr}}, 0, 2, 0, 0, 0', null, null, null, null, 'slot'],
    ];

    const insSql = `INSERT OR IGNORE INTO hw_module_templates
       (order_no, display_name, family, signal_type, channel_count, input_bytes, output_bytes,
        in_addr_fmt, out_addr_fmt, param_template, version, gsdml_file, dap_id, hw_category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    for (const t of hwTemplates) _db.run(insSql, t);
  }

  // Migration: correct templates whose seeded PARAMETER/version blocks did not
  // match PCS7's own export (caused HW import errors). Idempotent.
  const fixTpl = (orderNo, param, version) =>
    _db.run('UPDATE hw_module_templates SET param_template = ?, version = ? WHERE order_no = ?',
      [param, version, orderNo]);
  fixTpl('6ES7 131-6BH01-0BA0', null, null);                       // DI16 ST — no PARAMETER
  fixTpl('6ES7 132-6BH01-0BA0', null, null);                       // DQ16 ST — no PARAMETER
  fixTpl('6ES7 134-6HD00-0BA1', null, null);                       // AI4 ST V1.0 — no PARAMETER, no version str
  fixTpl('6ES7 135-6TD00-0CA1', '  POTENTIAL_GROUP, "NEW_GROUP"', null); // AQ4 HART

  // Migration: DIQ8 channel_count was seeded as 8 (DI only) — must be 16 (8 DI + 8 DO)
  {
    const diq8 = rawGet("SELECT channel_count FROM hw_module_templates WHERE order_no='_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT'");
    if (diq8 && diq8.channel_count !== 16) {
      _db.run("UPDATE hw_module_templates SET channel_count=16 WHERE order_no='_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT'");
    }
  }

  // Migration: PA Master must use signal_type='PA', input_bytes=4, output_bytes=2 so that
  // allocateAddresses reserves the correct analog addresses for Subslot 2 (Status+Notifications)
  // and advances the pointer so Slot 3+ PA transmitters start at the right address.
  {
    const paMaster = rawGet("SELECT signal_type, input_bytes, output_bytes FROM hw_module_templates WHERE order_no='_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT'");
    if (paMaster && (paMaster.signal_type !== 'PA' || paMaster.input_bytes !== 4 || paMaster.output_bytes !== 2)) {
      _db.run(`UPDATE hw_module_templates SET signal_type='PA', input_bytes=4, output_bytes=2,
        in_addr_fmt='{{addr}}, 0, 4, 0, 0, 0', out_addr_fmt='{{addr}}, 0, 2, 0, 0, 0'
        WHERE order_no='_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT'`);
    }
  }

  saveDb();
  console.log('[DB] Schema ready');
}

module.exports = { initDb, getDb, saveDb, ensureSchema };
