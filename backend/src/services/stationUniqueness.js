// services/stationUniqueness.js — station-level uniqueness checks for HW imports.
//
// A "station" is identified by its slot-0 row in hw_signals; every station within one
// hw_import_id must have a unique station_address, station_name, and ip_address.
// Many signal rows legitimately share a station's addr/name/ip (one row per channel),
// so callers must dedupe to one entry per station_address before validating.
'use strict';

/**
 * Load the existing stations of an import as [{ address, name, ip }] (one per station).
 * @param {Object} db - getDb() result
 * @param {number} importId
 * @returns {Promise<Array<{address:number, name:string, ip:string}>>}
 */
async function loadExistingStations(db, importId) {
  const rows = await db.prepare(
    `SELECT DISTINCT station_address, station_name, ip_address
     FROM hw_signals WHERE hw_import_id=? AND slot=0`
  ).all(importId);
  return rows.map(r => ({
    address: r.station_address,
    name:    r.station_name,
    ip:      r.ip_address,
  }));
}

/**
 * Given a list of stations, return human-readable conflict messages for any duplicated
 * station_address, station_name, or ip_address. Blank/null name and ip are ignored.
 * The input may contain repeated addresses (e.g. existing ∪ incoming); rows sharing the
 * SAME address are treated as one logical station and never collide with themselves —
 * unless the same address appears with genuinely different identities, which is itself a
 * conflict (an incoming station reusing an existing address in additive mode).
 *
 * @param {Array<{address:(number|string), name:(string|null), ip:(string|null)}>} stations
 * @returns {string[]} conflict messages (empty = OK)
 */
function findStationConflicts(stations) {
  const conflicts = [];

  // Group by address so multiple rows of the same station collapse to one.
  // If one address maps to more than one distinct (name|ip) identity, that address is
  // being reused by a different station → address conflict.
  const byAddress = new Map();
  for (const s of stations) {
    const addr = s.address;
    if (addr == null || addr === '') continue;
    const key = String(addr);
    const identity = `${s.name ?? ''}||${s.ip ?? ''}`;
    if (!byAddress.has(key)) byAddress.set(key, new Set());
    byAddress.get(key).add(identity);
  }
  for (const [addr, identities] of byAddress) {
    if (identities.size > 1) {
      conflicts.push(`Device Number ${addr} is used by ${identities.size} stations`);
    }
  }

  // One representative station per address for name/ip comparison.
  const uniqueStations = [];
  const seenAddr = new Set();
  for (const s of stations) {
    if (s.address == null || s.address === '') continue;
    const key = String(s.address);
    if (seenAddr.has(key)) continue;
    seenAddr.add(key);
    uniqueStations.push(s);
  }

  // Name collisions across distinct stations.
  const byName = new Map();
  for (const s of uniqueStations) {
    const name = (s.name ?? '').trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s.address);
  }
  for (const [name, addrs] of byName) {
    if (addrs.length > 1) {
      conflicts.push(`Device Name "${name}" is used by stations ${addrs.join(', ')}`);
    }
  }

  // IP collisions across distinct stations.
  const byIp = new Map();
  for (const s of uniqueStations) {
    const ip = (s.ip ?? '').trim();
    if (!ip) continue;
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(s.address);
  }
  for (const [ip, addrs] of byIp) {
    if (addrs.length > 1) {
      conflicts.push(`IP ${ip} is used by stations ${addrs.join(', ')}`);
    }
  }

  return conflicts;
}

/**
 * Given the same station list passed to findStationConflicts, return a flat table of
 * only the stations actually involved in a conflict — one row per station address, each
 * carrying which field(s) collided. Meant for rendering as a table in the UI instead of
 * (or alongside) the human-readable message strings from findStationConflicts.
 *
 * @param {Array<{address:(number|string), name:(string|null), ip:(string|null)}>} stations
 * @returns {Array<{address:(number|string), name:(string|null), ip:(string|null), reasons:string[]}>}
 */
function buildConflictTable(stations) {
  const byAddress = new Map(); // addr -> Set(identity)
  for (const s of stations) {
    const addr = s.address;
    if (addr == null || addr === '') continue;
    const key = String(addr);
    const identity = `${s.name ?? ''}||${s.ip ?? ''}`;
    if (!byAddress.has(key)) byAddress.set(key, new Set());
    byAddress.get(key).add(identity);
  }
  const addrConflictAddrs = new Set();
  for (const [addr, identities] of byAddress) {
    if (identities.size > 1) addrConflictAddrs.add(addr);
  }

  // One representative station per address (first occurrence wins).
  const uniqueStations = [];
  const seenAddr = new Set();
  for (const s of stations) {
    if (s.address == null || s.address === '') continue;
    const key = String(s.address);
    if (seenAddr.has(key)) continue;
    seenAddr.add(key);
    uniqueStations.push(s);
  }

  const byName = new Map();
  for (const s of uniqueStations) {
    const name = (s.name ?? '').trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s.address);
  }
  const nameConflictAddrs = new Set();
  for (const addrs of byName.values()) {
    if (addrs.length > 1) addrs.forEach(a => nameConflictAddrs.add(a));
  }

  const byIp = new Map();
  for (const s of uniqueStations) {
    const ip = (s.ip ?? '').trim();
    if (!ip) continue;
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(s.address);
  }
  const ipConflictAddrs = new Set();
  for (const addrs of byIp.values()) {
    if (addrs.length > 1) addrs.forEach(a => ipConflictAddrs.add(a));
  }

  const rows = [];
  for (const s of uniqueStations) {
    const reasons = [];
    if (addrConflictAddrs.has(s.address)) reasons.push('Device Number');
    if (nameConflictAddrs.has(s.address)) reasons.push('Device Name');
    if (ipConflictAddrs.has(s.address)) reasons.push('IP');
    if (reasons.length > 0) {
      rows.push({ address: s.address, name: s.name ?? null, ip: s.ip ?? null, reasons });
    }
  }
  // Sort by address for stable, readable output.
  rows.sort((a, b) => Number(a.address) - Number(b.address));
  return rows;
}

module.exports = { findStationConflicts, loadExistingStations, buildConflictTable };
