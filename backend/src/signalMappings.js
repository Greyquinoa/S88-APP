// src/signalMappings.js — Signal-to-Instance mapping (standalone module)
//
// Attaches hardware signal tags to block ControlVariables of an instance.
// This layer is purely additive: it stores mappings in the `signal_mappings`
// table and exposes helpers that the export engine uses to *inject* the
// <SignalName>/<VariableType>Signal markup during XML generation. No existing
// table, import, or PCS7 instance-generation logic depends on it.
'use strict';

// ── Datatype compatibility ────────────────────────────────────────────────────
// Maps a hardware signal type (DI/DO/AI/AO + a few aliases) to the PCS7 variable
// datatypes it can legitimately drive. Used to *warn* on mismatches — never to
// block an assignment (per product decision: warn but allow).
const DTYPE_COMPAT = {
  DI: ['Bool'],
  DO: ['Bool'],
  BI: ['Bool'],
  BO: ['Bool'],
  AI: ['Real', 'Word', 'Int', 'Integer', 'DoubleInt', 'DoubleWord', 'DWord'],
  AO: ['Real', 'Word', 'Int', 'Integer', 'DoubleInt', 'DoubleWord', 'DWord'],
};

// Validate a signal type against a variable datatype.
// Returns { ok: boolean, reason?: string }. Unknown types pass (ok:true) so we
// never block on data we don't understand.
function validateDatatype(signalType, varDtype) {
  if (!signalType || !varDtype) return { ok: true };
  const allowed = DTYPE_COMPAT[String(signalType).toUpperCase()];
  if (!allowed) return { ok: true };
  const ok = allowed.some(d => d.toLowerCase() === String(varDtype).toLowerCase());
  return ok
    ? { ok: true }
    : { ok: false, reason: `Signal type ${signalType} is not compatible with datatype ${varDtype}` };
}

// ── Latest HW import for a project ────────────────────────────────────────────
// The signal pool is drawn from the project's most recent hw_import.
function latestHwImportId(db, projectId) {
  const row = db.prepare(
    `SELECT id FROM hw_imports WHERE project_id = ? ORDER BY id DESC LIMIT 1`
  ).get(projectId);
  return row ? row.id : null;
}

// ── Load mappings for export ──────────────────────────────────────────────────
// Returns a lookup keyed for O(1) access during emit:
//   { [instanceName]: { "<block>.<var>": { tag, varDtype, signalType, ioAddress, comment } } }
// Joins hw_signals via hw_signal_id so IOTag generation gets the hardware address.
function loadMappingsForProject(db, projectId) {
  const { hwSignalToAddr, resolveHwIdentifier } = require('./connections');
  const rows = db.prepare(
    `SELECT sm.instance_name, sm.block_name, sm.var_name, sm.signal_tag, sm.var_dtype,
            sm.signal_type, hw.station_address, hw.slot, hw.channel, hw.description,
            hw.module_order_no AS hw_module_order_no, hw.signal_type AS hw_signal_type
     FROM signal_mappings sm
     LEFT JOIN hw_signals hw ON sm.hw_signal_id = hw.id
     WHERE sm.project_id = ?`
  ).all(projectId);
  // Card catalogue for identifier resolution (same source as CFG generation), so an
  // output pin yields "Q"/"QW" instead of the input default "I".
  const templateMap = new Map(
    db.prepare('SELECT order_no, signal_type, in_identifier, out_identifier FROM hw_module_templates')
      .all().map(t => [t.order_no, t])
  );
  const out = {};
  for (const r of rows) {
    // Hardware signal_type is authoritative for direction; fall back to the mapping's.
    const sigType = r.hw_signal_type || r.signal_type;
    const ioAddress = (r.station_address != null && r.slot != null && r.channel != null)
      ? hwSignalToAddr(r.station_address, r.slot, r.channel, sigType,
          resolveHwIdentifier(templateMap, r.hw_module_order_no, sigType))
      : null;
    (out[r.instance_name] ||= {})[`${r.block_name}.${r.var_name}`] = {
      tag:        r.signal_tag,
      varDtype:   r.var_dtype,
      signalType: r.signal_type,
      ioAddress,
      comment:    r.description || null,
    };
  }
  return out;
}

module.exports = {
  DTYPE_COMPAT,
  validateDatatype,
  latestHwImportId,
  loadMappingsForProject,
};
