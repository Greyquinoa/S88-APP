// services/hardwareAutoSync.js — Automated (no-review) hardware sync + CFG generation
// for the workflow engine. This is intentionally standalone: it does NOT import from
// or modify routes/hwConfig.js, so the manual "Import Hardware" UI flow (upload
// baseline → Import Hardware → HwImportReview → apply → generate) is completely
// unaffected by anything in this file.
//
// Behavior (confirmed): only ever INSERT new hw_signals rows. Modified/Missing rows
// versus the existing hardware config are skipped and logged — never updated, never
// deleted. This makes the sync side-effect-safe to run unattended inside a bigger
// automated workflow.
'use strict';
const { parseRawExcelRows } = require('./hwExcelParser');
const { parseCfg } = require('./cfgParser');
const { allocateAddresses } = require('./hwAddressEngine');
const { generateCfg } = require('./cfgGenerator');
const { findStationConflicts, loadExistingStations, buildConflictTable } = require('./stationUniqueness');

function chKey(channel, tag, signalType) {
  if (!tag && !signalType) return 'null';
  return channel ?? 'null';
}

/**
 * Copy an IO import's raw rows into a HW import's hw_excel_raw table, then parse +
 * diff them against existing hw_signals, and insert only the New rows.
 *
 * @param {object} db
 * @param {object} params
 * @param {number} params.hwImportId
 * @param {number} params.ioImportId
 * @param {object} params.columnMap - { column: hw_field } as stored in the column-map
 *   config's mappings.hardware (UnifiedColumnMappingScreen shape). Inverted internally
 *   to the { hw_field: column } shape parseRawExcelRows expects.
 * @returns {{ log: object, stationCount: number, signalCount: number }}
 */
async function autoSyncHardware(db, { hwImportId, ioImportId, columnMap }) {
  const hwImport = await db.prepare('SELECT id FROM hw_imports WHERE id=?').get(hwImportId);
  if (!hwImport) throw new Error('HW import not found');

  const ioRows = await db.prepare(
    'SELECT raw_data FROM io_tags WHERE import_id=? ORDER BY row_number, id'
  ).all(ioImportId);
  if (ioRows.length === 0) throw new Error('IO import has no rows to sync into hardware');

  // io_tags.raw_data is {column: value} JSON — identical shape to hw_excel_raw.row_json.
  await db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id=?').run(hwImportId);
  const insertRaw = db.prepare('INSERT INTO hw_excel_raw (hw_import_id, row_index, row_json) VALUES (?,?,?)');
  const insertRawBatch = db.transaction(async (rows) => {
    for (let i = 0; i < rows.length; i++) await insertRaw.run(hwImportId, i, rows[i].raw_data || '{}');
  });
  await insertRawBatch(ioRows);

  // Stored shape is { column: hw_field }; parseRawExcelRows wants { hw_field: column }.
  const fieldToColumn = {};
  for (const [col, field] of Object.entries(columnMap || {})) fieldToColumn[field] = col;

  const rawExcelRows = ioRows.map(r => JSON.parse(r.raw_data || '{}'));
  const { rows: parsedRows } = await parseRawExcelRows(rawExcelRows, fieldToColumn, db);

  const incoming = new Map();
  for (const r of parsedRows) {
    const key = `${r.stationAddr}:${r.slot}:${chKey(r.channel, r.tag, r.signalType)}`;
    incoming.set(key, r);
  }

  const dbRows = await db.prepare(
    `SELECT station_address, station_name, slot, channel, module_order_no, module_name, tag, signal_type, description
     FROM hw_signals WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'`
  ).all(hwImportId);
  const current = new Map();
  for (const r of dbRows) {
    const key = `${r.station_address}:${r.slot}:${chKey(r.channel, r.tag, r.signal_type)}`;
    current.set(key, r);
  }

  const CMP_FIELDS = ['station_address', 'station_name', 'slot', 'module_order_no', 'module_name', 'channel', 'tag', 'signal_type', 'description'];
  const newRows = [];
  const skippedModified = [];
  const skippedMissing = [];
  let unchangedCount = 0;

  for (const [key, inc] of incoming) {
    const cur = current.get(key);
    if (!cur) { newRows.push(inc); continue; }

    const incomingNorm = {
      station_address: inc.stationAddr, station_name: inc.stationName || null,
      slot: inc.slot, module_order_no: inc.orderNo || null, module_name: inc.moduleName || null,
      channel: chKey(inc.channel, inc.tag, inc.signalType), tag: inc.tag || null,
      signal_type: inc.signalType || null, description: inc.desc || null,
    };
    const curNorm = {
      station_address: cur.station_address, station_name: cur.station_name,
      slot: cur.slot, module_order_no: cur.module_order_no, module_name: cur.module_name,
      channel: chKey(cur.channel, cur.tag, cur.signal_type), tag: cur.tag,
      signal_type: cur.signal_type, description: cur.description,
    };
    const changedFields = CMP_FIELDS.filter(f => String(curNorm[f] ?? '') !== String(incomingNorm[f] ?? ''));

    if (changedFields.length > 0) {
      skippedModified.push({ key, station: inc.stationAddr, slot: inc.slot, tag: inc.tag || null, changedFields });
    } else {
      unchangedCount++;
    }
  }

  for (const [key, cur] of current) {
    if (!incoming.has(key)) {
      skippedMissing.push({ key, station: cur.station_address, slot: cur.slot, tag: cur.tag || null });
    }
  }

  // Validate station uniqueness (address / name / IP) across existing stations plus the
  // new stations about to be inserted. Insert-only sync must never introduce a duplicate.
  {
    const incomingNewStations = new Map();
    for (const r of newRows) {
      if (r.stationAddr == null) continue;
      if (!incomingNewStations.has(r.stationAddr)) {
        incomingNewStations.set(r.stationAddr, { address: r.stationAddr, name: r.stationName, ip: r.ip });
      }
    }
    const existingStations = await loadExistingStations(db, hwImportId);
    const conflictStations = [...existingStations, ...incomingNewStations.values()];
    const conflicts = findStationConflicts(conflictStations);
    if (conflicts.length) {
      const e = new Error('Duplicate stations: ' + conflicts.join('; '));
      e.conflictRows = buildConflictTable(conflictStations);
      throw e;
    }
  }

  const ins = db.prepare(`
    INSERT INTO hw_signals
      (hw_import_id, row_number, station_address, station_name, ip_address,
       slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
       station_mlfb, resolved_by_tier2, unresolved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertNew = db.transaction(async (rows) => {
    let rowIdx = 0;
    for (const r of rows) {
      await ins.run(hwImportId, r.rowNum ?? rowIdx, r.stationAddr, r.stationName, r.ip,
        r.slot, r.channel ?? null, r.orderNo, r.moduleName, r.tag, r.desc,
        r.signalType, r.subsystemNo ?? null, r.routerAddress || null,
        r.stationMlfb || null, !!r.resolvedByTier2, !!r.unresolved);
      rowIdx++;
    }
  });
  await insertNew(newRows);

  // Tier 2: create slot 0 rows for stations resolved via Protocol+SignalType lookup,
  // matching the manual-flow behavior so downstream CFG generation sees consistent data.
  const tier2Stations = await db.prepare(`
    SELECT DISTINCT station_address, station_name, ip_address, router_address, subsystem_no, station_mlfb
    FROM hw_signals
    WHERE hw_import_id=? AND resolved_by_tier2=true AND station_mlfb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM hw_signals s2 WHERE s2.hw_import_id=? AND s2.station_address=hw_signals.station_address AND s2.slot=0)
  `).all(hwImportId, hwImportId);
  if (tier2Stations.length > 0) {
    const insSlot0 = db.prepare(`
      INSERT INTO hw_signals
        (hw_import_id, row_number, station_address, station_name, ip_address,
         slot, channel, module_order_no, module_name, tag, description, signal_type, subsystem_no, router_address,
         station_mlfb, resolved_by_tier2, unresolved)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const s of tier2Stations) {
      await insSlot0.run(
        hwImportId, null, s.station_address, s.station_name, s.ip_address,
        0, null, s.station_mlfb, s.station_name,
        null, null, null, s.subsystem_no, s.router_address,
        s.station_mlfb, true, false
      );
    }
  }

  await db.prepare('UPDATE hw_imports SET status=? WHERE id=?').run('ready', hwImportId);

  const stationCount = Number((await db.prepare(
    'SELECT COUNT(DISTINCT station_address) AS cnt FROM hw_signals WHERE hw_import_id=?'
  ).get(hwImportId)).cnt);
  const signalCount = Number((await db.prepare(
    'SELECT COUNT(*) AS cnt FROM hw_signals WHERE hw_import_id=?'
  ).get(hwImportId)).cnt);

  const log = {
    imported: newRows.length,
    unchanged: unchangedCount,
    skippedModified,
    skippedMissing,
  };

  return { log, stationCount, signalCount };
}

/**
 * Build the STEP7 .cfg text from the baseline + current hw_signals for a HW import,
 * and persist it to hw_generated_cfgs (same table the manual /generate route writes
 * to, so the HW Config screen can see/reuse the latest generated CFG).
 */
async function generateCfgForWorkflow(db, hwImportId) {
  const hwImport = await db.prepare('SELECT * FROM hw_imports WHERE id=?').get(hwImportId);
  if (!hwImport) throw new Error('HW import not found');
  if (!hwImport.baseline_cfg) throw new Error('No baseline CFG uploaded for this hardware import');

  const tplRows = await db.prepare('SELECT * FROM hw_module_templates').all();
  const templateMap = new Map(tplRows.map(t => [t.order_no, t]));

  const signals = await db.prepare(
    "SELECT * FROM hw_signals WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER' ORDER BY station_address, slot, channel, row_number"
  ).all(hwImportId);
  if (signals.length === 0) throw new Error('No signals or modules configured — nothing to generate a CFG from');

  const subslotRows = await db.prepare(
    'SELECT station_address, slot, subslot_no, pa_profile FROM hw_slot_subslots WHERE hw_import_id=? ORDER BY station_address, slot, subslot_no'
  ).all(hwImportId);
  const subslotMap = new Map();
  for (const r of subslotRows) {
    const key = `${r.station_address}:${r.slot}`;
    if (!subslotMap.has(key)) subslotMap.set(key, []);
    subslotMap.get(key).push({ subslotNo: r.subslot_no, paProfile: r.pa_profile || null });
  }

  const stations = new Map();
  for (const sig of signals) {
    const addr = sig.station_address;
    if (!stations.has(addr)) {
      stations.set(addr, {
        address: addr, name: sig.station_name, ip: sig.ip_address,
        routerAddress: sig.router_address || null,
        subsystemNo: sig.subsystem_no,
        slots: new Map(),
      });
    }
    const station = stations.get(addr);
    if (!station.name && sig.station_name) station.name = sig.station_name;
    if (!station.ip && sig.ip_address) station.ip = sig.ip_address;
    if (!station.routerAddress && sig.router_address) station.routerAddress = sig.router_address;
    if (station.subsystemNo == null && sig.subsystem_no != null) station.subsystemNo = sig.subsystem_no;

    if (!station.slots.has(sig.slot)) {
      station.slots.set(sig.slot, {
        slot: sig.slot, orderNo: sig.module_order_no, name: sig.module_name,
        pipNo: sig.pip_no != null ? sig.pip_no : null,
        potentialGroup: sig.potential_group != null ? sig.potential_group : null,
        paProfile: sig.pa_profile || null, mlfb: sig.station_mlfb || null,
        subslots: subslotMap.get(`${addr}:${sig.slot}`) || [],
        channels: [],
      });
    }
    if (sig.tag || sig.channel != null) {
      station.slots.get(sig.slot).channels.push({
        channel: sig.channel, tag: sig.tag, desc: sig.description, signalType: sig.signal_type,
      });
    }
  }

  const parsedBaseline = parseCfg(hwImport.baseline_cfg);
  allocateAddresses(stations, templateMap,
    parsedBaseline.existingAddresses.maxInput,
    parsedBaseline.existingAddresses.maxOutput
  );

  const { cfg: cfgText, warnings } = await generateCfg(parsedBaseline, stations, templateMap, db);

  let moduleCount = 0;
  for (const st of stations.values()) moduleCount += st.slots.size;
  const stats = { stations: stations.size, modules: moduleCount, signals: signals.length, warnings };

  await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id=?').run(hwImportId);
  const r = await db.prepare(
    'INSERT INTO hw_generated_cfgs (hw_import_id, cfg_text, stats) VALUES (?,?,?)'
  ).run(hwImportId, cfgText, JSON.stringify(stats));
  await db.prepare('UPDATE hw_imports SET status=? WHERE id=?').run('generated', hwImportId);

  return { cfgId: r.lastInsertRowid, cfgText, stats, warnings };
}

module.exports = { autoSyncHardware, generateCfgForWorkflow };
