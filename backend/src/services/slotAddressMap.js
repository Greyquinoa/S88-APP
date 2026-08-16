// services/slotAddressMap.js — Shared per-slot process-image address resolution
//
// A hardware signal's exported address is the sum of two parts:
//   1. the SLOT's base byte address, allocated globally across the import by
//      hwAddressEngine.allocateAddresses(), and
//   2. the CHANNEL's offset within that slot.
//
// Historically only (2) was applied when formatting ioAddress for IOTag export,
// so every card behaved as if it started at byte 0 — a 4-channel AI card in the
// analog space emitted "IW 0/2/4/6" instead of "IW 512/514/516/518". CFG SYMBOL
// generation used the allocator and was correct, so the two exports disagreed.
//
// This module is the single place that rebuilds the allocator's view of an import
// and exposes the resulting per-slot bases, so the export path and the
// preview-addresses endpoint cannot drift apart again.
'use strict';

const { allocateAddresses } = require('./hwAddressEngine');
const { parseCfg } = require('./cfgParser');

/**
 * Rebuild the station/slot tree for an import exactly as the preview-addresses
 * endpoint does, run the allocator over it, and return the enriched stations Map.
 *
 * @param {object} db
 * @param {number} importId
 * @returns {Promise<Map>} Map<stationAddr, { slots: Map<slotNo, slot> }>
 */
async function buildAllocatedStations(db, importId) {
  const hwImport = await db.prepare(
    'SELECT id, baseline_cfg, hw_controller_id FROM hw_imports WHERE id=?'
  ).get(importId);
  if (!hwImport) return new Map();

  const signals = await db.prepare(
    `SELECT station_address, station_name, ip_address, router_address, subsystem_no,
            slot, module_order_no, pip_no, pa_profile
     FROM hw_signals
     WHERE hw_import_id=? AND module_order_no != 'PLACEHOLDER'
     ORDER BY station_address, slot`
  ).all(importId);

  const tplRows     = await db.prepare('SELECT * FROM hw_module_templates').all();
  const templateMap = new Map(tplRows.map(t => [t.order_no, t]));

  const subslotRows = await db.prepare(
    `SELECT station_address, slot, subslot_no, pa_profile
     FROM hw_slot_subslots WHERE hw_import_id=?
     ORDER BY station_address, slot, subslot_no`
  ).all(importId);
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
        routerAddress: sig.router_address || null, subsystemNo: sig.subsystem_no,
        // The controller lives on the import, not on the signal row (one import per
        // controller). allocateAddresses() groups by this to keep address cursors
        // isolated per controller; without it every station lands in the untagged
        // fallback group. Same source generateCfgForWorkflow() uses.
        controllerId: hwImport.hw_controller_id || null,
        slots: new Map(),
      });
    }
    if (!stations.get(addr).slots.has(sig.slot)) {
      stations.get(addr).slots.set(sig.slot, {
        slot: sig.slot, orderNo: sig.module_order_no,
        pipNo: sig.pip_no != null ? sig.pip_no : null,
        paProfile: sig.pa_profile || null,
        subslots: subslotMap.get(`${addr}:${sig.slot}`) || [],
        channels: [],
      });
    }
  }

  let maxIn = -1, maxOut = -1;
  if (hwImport.baseline_cfg) {
    const parsed = parseCfg(hwImport.baseline_cfg);
    maxIn  = parsed.existingAddresses.maxInput;
    maxOut = parsed.existingAddresses.maxOutput;
  }

  // controllerMap is intentionally null: this runs per-import and every import
  // belongs to exactly one controller, so all stations share a controllerId and
  // fall through to the global baseline high-water marks below.
  allocateAddresses(stations, templateMap, maxIn, maxOut, null);
  return stations;
}

/**
 * Per-slot base byte addresses for an import, keyed "<stationAddr>:<slot>".
 * Values: { inputAddr, outputAddr, subslotAddrs }, any of which may be null when
 * the slot uses no bytes in that direction.
 *
 * @returns {Promise<Map<string, {inputAddr:?number, outputAddr:?number, subslotAddrs:?Array}>>}
 */
async function loadSlotAddressBases(db, importId) {
  const bases = new Map();
  if (importId == null) return bases;
  const stations = await buildAllocatedStations(db, importId);
  for (const [stAddr, station] of stations) {
    for (const [slotNo, slot] of station.slots) {
      bases.set(`${stAddr}:${slotNo}`, {
        inputAddr:    slot.inputAddr  != null ? slot.inputAddr  : null,
        outputAddr:   slot.outputAddr != null ? slot.outputAddr : null,
        subslotAddrs: slot.subslotAddrs || null,
      });
    }
  }
  return bases;
}

/**
 * The base byte for one signal, picking the direction that matches its type.
 * Returns 0 when the slot has no allocated base, preserving the previous
 * channel-only behaviour rather than dropping the address entirely.
 */
function baseForSignal(bases, stationAddr, slot, isOutput) {
  if (!bases) return 0;
  const entry = bases.get(`${stationAddr}:${slot}`);
  if (!entry) return 0;
  const base = isOutput ? entry.outputAddr : entry.inputAddr;
  return base != null ? base : 0;
}

/**
 * Load slot address bases for all imports of a project.
 * Returns a Map<importId, Map<"addr:slot", {inputAddr,outputAddr,subslotAddrs}>>.
 * Station addresses are unique per import, so keying by import prevents collisions.
 */
async function loadSlotAddressBasesByImport(db, projectId) {
  const basesByImport = new Map();
  // Load all imports for this project
  const imports = await db.prepare(
    'SELECT id FROM hw_imports WHERE project_id = ?'
  ).all(projectId);
  // Build bases per import
  for (const imp of imports) {
    const bases = await loadSlotAddressBases(db, imp.id);
    basesByImport.set(imp.id, bases);
  }
  return basesByImport;
}

/**
 * Get the base byte for one signal, looking up via its hw_import_id.
 * Returns 0 when missing (preserving prior behavior).
 */
function baseForSignalIn(basesByImport, importId, stationAddr, slot, isOutput) {
  if (!basesByImport || !importId) return 0;
  const bases = basesByImport.get(importId);
  return baseForSignal(bases, stationAddr, slot, isOutput);
}

module.exports = {
  buildAllocatedStations,
  loadSlotAddressBases,
  baseForSignal,
  loadSlotAddressBasesByImport,
  baseForSignalIn,
};
