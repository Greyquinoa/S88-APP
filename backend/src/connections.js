// src/connections.js — Connection generation (dummy ↔ hardware reconciliation)
//
// The bridge between Part 1 (CM instance dummy IOs) and Part 2 (hardware symbols).
// A CM instance's connection rules (stored on project_instances.connections) define
// dummy IO signal names (prefix + instanceName + suffix) pre-wired to a block pin —
// e.g. rule {target_block:"FB_OPEN", target_pin:"PV_In", suffix:"_GSH"} on instance
// "XV01" yields the dummy "XV01_GSH" bound to FB_OPEN.PV_In.
//
// reconcileConnections() looks up each dummy name against the project's hardware
// symbols (hw_signals.tag, exact match) and materializes the result into the
// instance_ios table: status='real' + hw_signal_id when a hardware symbol matches,
// status='dummy' otherwise. It is a full rebuild per project, so it is safe to
// re-run at any time after IO re-imports, hardware edits, or tag renames without
// touching CM instances or hardware.
//
// loadConnectionIOsForProject() reads that materialized result back for the export
// engine (routes/generate.js), which injects <SignalName> for REAL pins and applies
// the "no block if required+unmatched" rule for DUMMY pins.
'use strict';

const { latestHwImportId } = require('./signalMappings');
const { findTemplate, defaultIdentifiers } = require('./services/hwAddressEngine');
const { loadSlotAddressBases, baseForSignal, loadSlotAddressBasesByImport, baseForSignalIn } = require('./services/slotAddressMap');

// Parse a project_instances.connections JSON column into rule objects.
function parseConnections(raw) {
  let conns = [];
  try { conns = JSON.parse(raw || '[]'); } catch { conns = []; }
  return Array.isArray(conns) ? conns : [];
}

// Derive the dummy signal name for a rule on a given instance.
function dummySignalName(rule, instanceName) {
  return `${rule.prefix || ''}${instanceName}${rule.suffix || ''}`;
}

// Build a childBlocks map from a list of rules: { parentBlockName: [childNames] }
function buildChildBlockMap(rules) {
  const childMap = {};
  for (const rule of rules) {
    if (!rule.target_block || !rule.childBlocks || !Array.isArray(rule.childBlocks)) continue;
    if (rule.childBlocks.length === 0) continue;
    childMap[rule.target_block] ??= [];
    for (const child of rule.childBlocks) {
      if (!childMap[rule.target_block].includes(child)) {
        childMap[rule.target_block].push(child);
      }
    }
  }
  return childMap;
}

// Cascade block omissions: if a parent is omitted, all children are also omitted.
// Uses fixed-point iteration to handle chains (A→B→C).
// Returns a Set of block names that should be cascaded (omitted due to parent omission).
function cascadeBlockOmissions(omitBlocksSet, childBlockMap) {
  const cascaded = new Set(omitBlocksSet);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parent, children] of Object.entries(childBlockMap)) {
      if (cascaded.has(parent)) {
        for (const child of children) {
          if (!cascaded.has(child)) {
            cascaded.add(child);
            changed = true;
          }
        }
      }
    }
  }
  return cascaded;
}

// ── Reconcile ─────────────────────────────────────────────────────────────────
// Rebuilds instance_ios for one project. Returns a summary:
//   { importId, total, real, dummy, conflicts: [...], warnings: [...] }
async function reconcileConnections(db, projectId) {
  const { loadSlotAddressBasesByImport, baseForSignalIn } = require('./services/slotAddressMap');

  // Hardware symbol lookup from ALL project imports, keyed by lowercase tag.
  // Deterministic order: hw_import_id, then station/slot/channel, so duplicate tags
  // across controllers are both reported with their full context.
  const hwMap = new Map();  // tag_lower -> { id, signal_type, station_address, slot, channel, count, tag_orig, hw_import_id, controller_name }
  {
    const rows = await db.prepare(
      `SELECT s.id, s.tag, s.signal_type, s.station_address, s.slot, s.channel,
              s.hw_import_id, c.T16_Controller_TagName AS controller_name
       FROM hw_signals s
       JOIN hw_imports i ON s.hw_import_id = i.id
       LEFT JOIN hw_controllers c ON i.hw_controller_id = c.id
       WHERE i.project_id = ? AND s.tag IS NOT NULL AND s.tag != ''
       ORDER BY s.hw_import_id, s.station_address, s.slot, s.channel, s.id`
    ).all(projectId);
    for (const r of rows) {
      const tagLower = r.tag.toLowerCase();
      const existing = hwMap.get(tagLower);
      if (existing) { existing.count++; continue; }
      hwMap.set(tagLower, {
        id: r.id, signal_type: r.signal_type,
        station_address: r.station_address, slot: r.slot, channel: r.channel, count: 1,
        tag_orig: r.tag,
        hw_import_id: r.hw_import_id,
        controller_name: r.controller_name || '(no controller)',
      });
    }
  }

  // Load address bases keyed by import for per-signal resolution
  const basesByImport = await loadSlotAddressBasesByImport(db, projectId);

  const instRows = await db.prepare(
    `SELECT instance_name, connections FROM project_instances WHERE project_id = ?`
  ).all(projectId);

  const desired   = [];          // instance_ios rows to write
  const conflicts = [];          // duplicate-symbol matches
  const warnings  = [];          // signal-type mismatches
  const seen      = new Set();   // dedupe (instance, block, var)
  const instOmitBlocks = new Map();  // instance_name -> Set of omitted blocks (after cascade)
  let real = 0, dummy = 0;

  // Pass 1: Compute base omit blocks and build desired list
  for (const row of instRows) {
    const instName = row.instance_name;
    const conns = parseConnections(row.connections);
    const omitSet = new Set();  // blocks marked for omission (required unmatched)
    const childBlockMap = buildChildBlockMap(conns);

    for (const rule of conns) {
      if (!rule.target_block || !rule.target_pin) continue;
      const dedupeKey = `${instName} ${rule.target_block} ${rule.target_pin}`;
      if (seen.has(dedupeKey)) continue;   // first rule per pin wins
      seen.add(dedupeKey);

      const signalName = dummySignalName(rule, instName);
      const match  = hwMap.get(signalName.toLowerCase());  // case-insensitive lookup
      const status = match ? 'real' : 'dummy';
      const isRequired = !(rule.required === 0 || rule.required === false);

      // Mark for omission if this block's rule is required+unmatched
      if (status === 'dummy' && isRequired) {
        omitSet.add(rule.target_block);
      }

      if (match) {
        real++;
        if (match.count > 1) {
          conflicts.push({
            signalName, instance: instName,
            block: rule.target_block, pin: rule.target_pin, matches: match.count,
          });
        }
        // Only warn if the rule has an EXPLICIT IO signal type (DI/DO/AI/AO) that doesn't match hardware.
        // Ignore if rule.signal_type is a datatype (Bool, Int, Real, etc.) — those are variable types,
        // not IO constraints. The hardware type is authoritative for REAL connections.
        if (rule.signal_type && match.signal_type) {
          const ruleType = String(rule.signal_type).trim().toUpperCase();
          const hwType = String(match.signal_type).trim().toUpperCase();
          // IO signal types are: DI, DO, BI, BO, AI, AO. Skip warning if rule type is a datatype.
          const isIoType = /^(DI|DO|BI|BO|AI|AO)$/i.test(ruleType);
          if (isIoType && ruleType !== hwType) {
            warnings.push(`${signalName}: rule type ${rule.signal_type} ≠ hardware type ${match.signal_type}`);
          }
        }
      } else {
        dummy++;
      }

      // For REAL signals, store the hardware's original tag name; for DUMMY, store
      // the derived dummy name.
      const storedSignalName = (match ? match.tag_orig : signalName);
      desired.push({
        instance_name: instName,
        block_name:    rule.target_block,
        var_name:      rule.target_pin,
        signal_name:   storedSignalName,
        signal_type:   rule.signal_type || (match ? match.signal_type : null) || null,
        required:      isRequired,
        status,
        hw_signal_id:  match ? match.id : null,
        cascade_status: null,  // computed in pass 2
      });
    }

    // Cascade omissions for this instance: if a parent is omitted, all children are too
    const cascadedSet = cascadeBlockOmissions(omitSet, childBlockMap);
    instOmitBlocks.set(instName, cascadedSet);
  }

  // Pass 2: Mark cascade_status on cascaded rows
  for (const d of desired) {
    const cascadedSet = instOmitBlocks.get(d.instance_name) || new Set();
    if (cascadedSet.has(d.block_name) && d.status === 'dummy') {
      d.cascade_status = 'cascaded_from_parent';
    }
  }

  const rebuild = db.transaction(async () => {
    await db.prepare(`DELETE FROM instance_ios WHERE project_id = ?`).run(projectId);
    const ins = db.prepare(
      `INSERT INTO instance_ios
         (project_id, instance_name, io_connection_id, block_name, var_name,
          signal_name, signal_type, required, status, hw_signal_id, cascade_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const d of desired) {
      await ins.run(projectId, d.instance_name, null, d.block_name, d.var_name,
        d.signal_name, d.signal_type, d.required, d.status, d.hw_signal_id, d.cascade_status);
    }
  });
  await rebuild();

  return { importId, total: desired.length, real, dummy, conflicts, warnings };
}

// ── IO address computation ────────────────────────────────────────────────────
// Resolve the PCS7 address identifier (I / Q / IW / QW) for a hardware signal the
// SAME way CFG generation does: the module's catalogue identifier
// (hw_module_templates.in_identifier / .out_identifier) wins, else the signal-type
// default. Direction (input vs output) comes from the hardware signal's own type —
// so a DO channel correctly yields "Q", not "I".
function resolveHwIdentifier(templateMap, moduleOrderNo, signalType) {
  const isOutput = signalType && /^(AO|DO|Q|BO)$/i.test(signalType);
  const dir = isOutput ? 'out' : 'in';
  const tpl = templateMap ? findTemplate(templateMap, moduleOrderNo) : null;
  const explicit = tpl ? (dir === 'out' ? tpl.out_identifier : tpl.in_identifier) : null;
  return explicit || defaultIdentifiers(signalType)[dir] || null;
}

// Convert hw_signal (channel, signalType) to the PCS7 process-image address.
// The address is the card's allocated base byte plus the channel's offset within
// the card:
//   For digital signals: channel 0-7 → +0, channel 8-15 → +1, etc.
//   For analog signals (16-bit, 2 bytes per channel): +channel * 2.
//
// `slotBase` is the slot's start byte from hwAddressEngine.allocateAddresses() —
// the same allocation CFG SYMBOL generation uses, so both exports agree. It
// defaults to 0, which reproduces the legacy channel-only behaviour for callers
// that have no allocation available (and for slots the allocator left unassigned).
//
// `identifier` is the catalogue-resolved prefix (I/Q/IW/QW). When supplied it is used
// verbatim — this is the single source of truth, matching CFG SYMBOL generation.
// When omitted, the prefix is inferred from the signal direction/kind (legacy fallback).
function hwSignalToAddr(station, slot, channel, signalType, identifier, slotBase = 0) {
  if (station == null || slot == null || channel == null) return null;
  const isOutput = signalType && /^(AO|DO|Q|BO)$/i.test(signalType);
  const isAnalog = signalType && /^(AI|AO)$/i.test(signalType);
  const prefix = identifier || ((isOutput ? 'Q' : 'I') + (isAnalog ? 'W' : ''));
  const base = Number.isFinite(slotBase) ? slotBase : 0;
  const byte = base + (isAnalog ? channel * 2 : Math.floor(channel / 8));
  const bit  = isAnalog ? 0 : channel % 8;
  // Analog addresses use word syntax (omit bit): "IW 512", "QW 516"
  if (isAnalog) return `${prefix} ${byte}`;
  return `${prefix} ${byte}.${bit}`;
}

// ── Load for export ───────────────────────────────────────────────────────────
// Returns a lookup keyed for O(1) emit-time access:
//   { [instanceName]: { "<block>.<var>": { tag, signalType, dummy, required, ioAddress } } }
// REAL rows → dummy:false (emit <SignalName>); unmatched rows → dummy:true.
async function loadConnectionIOsForProject(db, projectId) {
  // For REAL signals, join with hw_signals to get address + the hardware module's own
  // signal type (authoritative direction) and order number (catalogue identifier).
  const rows = await db.prepare(
    `SELECT io.instance_name, io.block_name, io.var_name, io.signal_name, io.signal_type,
            io.required, io.status, io.cascade_status, hw.station_address, hw.slot, hw.channel, hw.description,
            hw.module_order_no AS hw_module_order_no, hw.signal_type AS hw_signal_type, hw.hw_import_id
     FROM instance_ios io
     LEFT JOIN hw_signals hw ON io.hw_signal_id = hw.id
     WHERE io.project_id = ?`
  ).all(projectId);
  // Card catalogue for identifier resolution (same source as CFG generation).
  const templateRows = await db.prepare('SELECT order_no, signal_type, in_identifier, out_identifier, default_datatype FROM hw_module_templates').all();
  const templateMap = new Map(templateRows.map(t => [t.order_no, t]));
  // Per-slot base addresses keyed by import to avoid collisions across controllers
  const basesByImport = await loadSlotAddressBasesByImport(db, projectId);
  const out = {};
  for (const r of rows) {
    // Hardware signal_type is authoritative for direction; fall back to the rule's.
    const sigType = r.hw_signal_type || r.signal_type;
    const ident   = resolveHwIdentifier(templateMap, r.hw_module_order_no, sigType);
    const isOut   = sigType && /^(AO|DO|Q|BO)$/i.test(sigType);
    const ioAddress = (r.status === 'real')
      ? hwSignalToAddr(r.station_address, r.slot, r.channel, sigType, ident,
          baseForSignalIn(basesByImport, r.hw_import_id, r.station_address, r.slot, isOut))
      : null;
    // IOTag datatype comes from the hardware card, not the signal: the catalogue
    // entry for the module carries default_datatype. Null leaves the emitter's
    // 'Bool' fallback in place.
    const varDtype = templateMap.get(r.hw_module_order_no)?.default_datatype || null;
    (out[r.instance_name] ||= {})[`${r.block_name}.${r.var_name}`] = {
      tag:             r.signal_name,
      signalType:      r.signal_type,
      varDtype,
      dummy:           r.status !== 'real',
      required:        r.required ? 1 : 0,
      station_address: r.station_address,
      slot:            r.slot,
      channel:         r.channel,
      ioAddress,
      comment:         r.description || null,
      cascade_status:  r.cascade_status || null,
    };
  }
  return out;
}

module.exports = {
  reconcileConnections,
  loadConnectionIOsForProject,
  dummySignalName,
  parseConnections,
  hwSignalToAddr,
  resolveHwIdentifier,
  buildChildBlockMap,
  cascadeBlockOmissions,
};
