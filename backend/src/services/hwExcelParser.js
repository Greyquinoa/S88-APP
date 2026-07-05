// services/hwExcelParser.js — Parse HW IO list Excel into structured station/slot data
'use strict';
const { listSheets, parseSheet } = require('./ioParser');

// Standard column names (case-insensitive match)
const FIELD_ALIASES = {
  station_address: ['station_address', 'stationaddress', 'station address', 'io address', 'ioaddress', 'address'],
  station_name:    ['station_name', 'stationname', 'station name', 'device name', 'devicename', 'device_name'],
  ip_address:      ['ip_address', 'ipaddress', 'ip address', 'ip'],
  slot:            ['slot', 'slot_no', 'slot number', 'slotnumber'],
  module_order_no: ['module_order_no', 'moduleorderno', 'module_orderno', 'module order no', 'order_no', 'order no', 'orderno', 'module', 'ordernum', 'card_mlfb_no', 'card_mlfb'],
  module_name:     ['module_name', 'modulename', 'module name', 'module label'],
  tag:             ['tag', 'tag_name', 'tagname', 'instrument_tag', 'instrument tag'],
  description:     ['description', 'desc', 'signal description', 'comment'],
  signal_type:     ['signal_type', 'signaltype', 'signal type', 'type', 'io_type'],
  channel:         ['channel', 'channel_no', 'channelno', 'channel number', 'ch'],
  subsystem_no:    ['subsystem_no', 'subsystemno', 'subsystem no', 'io_subsystem', 'iosubsystem', 'pn_system', 'pnsystem'],
  router_address:  ['router_address', 'routeraddress', 'router address', 'gateway', 'gateway_ip', 'gatewayip', 'default_gateway'],
  protocol:        ['protocol', 'comm_protocol', 'communication', 'bus_type', 'protocoltype', 'commtype', 'comm_type'],
};

function detectColumnMap(headers) {
  const map = {};
  const lower = headers.map(h => ({ orig: h, lc: String(h).toLowerCase().trim() }));
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const found = lower.find(h => aliases.includes(h.lc));
    if (found) map[field] = found.orig;
  }
  return map;
}

/**
 * Tier 2 Hardware Resolution: resolve card MLFB from Protocol + SignalType via lookup table.
 * @param {Object} db - Database instance (getDb() result)
 * @param {string} protocol - Protocol value from Excel
 * @param {string} signalType - Signal type value from Excel
 * @returns {string|null} - Resolved card_mlfb if found, null otherwise
 */
function resolveTier2(db, protocol, signalType) {
  if (!db || !protocol || !signalType) return null;
  try {
    const result = db.prepare(
      'SELECT card_mlfb FROM hw_hardware_resolution WHERE protocol=? AND signal_type=?'
    ).get(protocol.trim(), signalType.trim());
    return result ? result.card_mlfb : null;
  } catch (e) {
    console.warn(`[Tier2 lookup] Error querying hw_hardware_resolution:`, e.message);
    return null;
  }
}

/**
 * Parse an HW IO list Excel buffer.
 * Returns { headers, colMap, rows, stations, resolutionStats }
 *
 * stations: Map<stationAddress(number), {
 *   address: number,
 *   name: string,
 *   ip: string,
 *   slots: Map<slot(number), { slot, orderNo, name, channels: [{channel, tag, desc, signalType}] }>
 * }>
 *
 * @param {Buffer} buffer - Excel file buffer
 * @param {string} sheetName - Sheet name to parse (optional, defaults to first sheet)
 * @param {object} overrideColumnMap - User-provided column mapping (optional). If provided, uses this instead of auto-detection.
 *                                    Format: { appField: "excelColumnName", ... }
 * @param {Object} db - Database instance (optional). If provided, enables Tier 2 resolution via Protocol+SignalType.
 */
async function parseHwExcel(buffer, sheetName, overrideColumnMap, db) {
  const sheets = await listSheets(buffer);
  const target = sheetName || sheets[0];
  const { headers, rows } = await parseSheet(buffer, target);

  // Use override map if provided, otherwise auto-detect
  const colMap = overrideColumnMap || detectColumnMap(headers);

  const stations = new Map();
  const rawRows = [];
  const rawExcelRows = rows.map(r => r.data); // original column→value objects

  // Track resolution stats for Tier 1 vs Tier 2
  const resolutionStats = {
    total: 0,
    tier1: 0,
    tier2Resolved: 0,
    tier2Unresolved: 0,
  };

  for (const { rowNum, data } of rows) {
    const get = field => {
      const col = colMap[field];
      if (!col) return null;
      const v = data[col];
      return v != null ? String(v).trim() : null;
    };

    const stationAddrRaw = get('station_address');
    const slotRaw        = get('slot');
    let orderNo        = get('module_order_no');  // Tier 1: direct MLFB from Excel

    if (!stationAddrRaw) continue; // skip rows without station address

    // Tier 2: If no direct MLFB, try Protocol + SignalType lookup
    let tier2Used = false;
    let unresolved = false;
    if (!orderNo && db) {
      const protocol = get('protocol');
      const signalType = get('signal_type');
      if (protocol && signalType) {
        const resolved = resolveTier2(db, protocol, signalType);
        if (resolved) {
          orderNo = resolved;
          tier2Used = true;
          resolutionStats.tier2Resolved++;
        } else {
          // Unresolved: create placeholder for user review
          orderNo = `UNRESOLVED_${protocol.toUpperCase()}_${signalType.toUpperCase()}`;
          tier2Used = true;
          unresolved = true;
          resolutionStats.tier2Unresolved++;
        }
      }
    }

    if (!orderNo) continue; // skip rows without any module order number

    resolutionStats.total++;
    if (!tier2Used) resolutionStats.tier1++;

    const stationAddr = parseInt(stationAddrRaw, 10);
    const slot        = slotRaw != null ? parseInt(slotRaw, 10) : 0;

    if (isNaN(stationAddr)) continue;

    const stationName = get('station_name') || `Station_${stationAddr}`;
    const ip          = get('ip_address') || '';
    const moduleName    = get('module_name') || orderNo;
    const tag           = get('tag') || '';
    const desc          = get('description') || '';
    const signalType    = get('signal_type') || '';
    const channelRaw    = get('channel');
    const channel       = channelRaw != null ? parseInt(channelRaw, 10) : null;
    const subsystemRaw  = get('subsystem_no');
    const subsystemNo   = subsystemRaw != null ? parseInt(subsystemRaw, 10) : null;
    const routerAddress = get('router_address') || '';

    // Build station
    if (!stations.has(stationAddr)) {
      stations.set(stationAddr, { address: stationAddr, name: stationName, ip, routerAddress, slots: new Map(), subsystemNo });
    }
    const station = stations.get(stationAddr);
    // Update name/ip/subsystemNo/routerAddress from first row that specifies them
    if (!station.name && stationName) station.name = stationName;
    if (!station.ip && ip) station.ip = ip;
    if (!station.routerAddress && routerAddress) station.routerAddress = routerAddress;
    if (station.subsystemNo == null && subsystemNo != null) station.subsystemNo = subsystemNo;

    // Build slot
    if (!station.slots.has(slot)) {
      station.slots.set(slot, { slot, orderNo, name: moduleName, channels: [] });
    }
    const slotObj = station.slots.get(slot);

    // Each row with a tag/channel adds a channel entry
    if (tag || channel != null) {
      slotObj.channels.push({ channel: channel ?? slotObj.channels.length, tag, desc, signalType });
    }

    rawRows.push({
      rowNum, stationAddr, slot, orderNo, moduleName, tag, desc, signalType, channel, ip, stationName, subsystemNo, routerAddress,
      resolvedByTier2: tier2Used ? 1 : 0,
      unresolved: unresolved ? 1 : 0,
    });
  }

  return { headers, colMap, rows: rawRows, stations, rawExcelRows, resolutionStats };
}

/**
 * Parse raw Excel rows (already in memory) using a column map.
 * Used when replaying stored raw rows with a different column mapping.
 * @param {Array} rawExcelRows - Array of {columnName: value} objects
 * @param {Object} colMap - Column mapping {appField: "excelColumnName", ...}
 */
function parseRawExcelRows(rawExcelRows, colMap) {
  const stations = new Map();
  const rows = [];

  for (let rowNum = 0; rowNum < rawExcelRows.length; rowNum++) {
    const data = rawExcelRows[rowNum];

    const get = field => {
      const col = colMap[field];
      if (!col) return null;
      const v = data[col];
      return v != null ? String(v).trim() : null;
    };

    const stationAddrRaw = get('station_address');
    const slotRaw = get('slot');
    const orderNo = get('module_order_no');

    if (!stationAddrRaw || !orderNo) continue; // skip incomplete rows

    const stationAddr = parseInt(stationAddrRaw, 10);
    const slot = slotRaw != null ? parseInt(slotRaw, 10) : 0;

    if (isNaN(stationAddr)) continue;

    const stationName = get('station_name') || `Station_${stationAddr}`;
    const ip = get('ip_address') || '';
    const moduleName = get('module_name') || orderNo;
    const tag = get('tag') || '';
    const desc = get('description') || '';
    const signalType = get('signal_type') || '';
    const channelRaw = get('channel');
    const channel = channelRaw != null ? parseInt(channelRaw, 10) : null;
    const subsystemRaw = get('subsystem_no');
    const subsystemNo = subsystemRaw != null ? parseInt(subsystemRaw, 10) : null;
    const routerAddress = get('router_address') || '';

    // Build station
    if (!stations.has(stationAddr)) {
      stations.set(stationAddr, { address: stationAddr, name: stationName, ip, routerAddress, slots: new Map(), subsystemNo });
    }
    const station = stations.get(stationAddr);
    if (!station.name && stationName) station.name = stationName;
    if (!station.ip && ip) station.ip = ip;
    if (!station.routerAddress && routerAddress) station.routerAddress = routerAddress;
    if (station.subsystemNo == null && subsystemNo != null) station.subsystemNo = subsystemNo;

    // Build slot
    if (!station.slots.has(slot)) {
      station.slots.set(slot, { slot, orderNo, name: moduleName, channels: [] });
    }
    const slotObj = station.slots.get(slot);

    // Each row with a tag/channel adds a channel entry
    if (tag || channel != null) {
      slotObj.channels.push({ channel: channel ?? slotObj.channels.length, tag, desc, signalType });
    }

    rows.push({ rowNum, stationAddr, slot, orderNo, moduleName, tag, desc, signalType, channel, ip, stationName, subsystemNo, routerAddress });
  }

  return { rows, stations };
}

/**
 * Compute Levenshtein distance between two strings.
 * Used for fuzzy matching of column headers.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i || j));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                 : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

/**
 * Normalize string for matching: lowercase, trim, remove common separators.
 */
function normalizeForMatch(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[-_\s]/g, '');
}

/**
 * Suggest column mappings using Levenshtein distance fuzzy matching.
 * Returns { [appField]: bestMatchColumn } for fields where match score > threshold.
 *
 * Fields metadata:
 * @param {string[]} appFields - Fields from the app (e.g., ['station_address', 'module_order_no', ...])
 * @param {string[]} excelColumns - Available column headers from the Excel file
 * @param {number} threshold - Normalized similarity threshold (0-1, default 0.6)
 * @returns {{ [field]: ?string }} - Suggested mappings; undefined if no match found
 */
function suggestColumnMappingByLevenshtein(appFields, excelColumns, threshold = 0.6) {
  if (!excelColumns || excelColumns.length === 0) return {};

  const suggestions = {};

  for (const appField of appFields) {
    const appNorm = normalizeForMatch(appField);
    let bestCol = null;
    let bestScore = 0;

    for (const excelCol of excelColumns) {
      const excelNorm = normalizeForMatch(excelCol);

      // Exact match (case-insensitive, ignoring separators)
      if (appNorm === excelNorm) {
        bestCol = excelCol;
        bestScore = 1;
        break;
      }

      // Levenshtein-based fuzzy match
      const distance = levenshtein(appNorm, excelNorm);
      const maxLen = Math.max(appNorm.length, excelNorm.length);
      const similarity = maxLen === 0 ? 1 : 1 - (distance / maxLen);

      if (similarity > bestScore) {
        bestScore = similarity;
        bestCol = excelCol;
      }
    }

    // Only suggest if score exceeds threshold
    if (bestScore >= threshold) {
      suggestions[appField] = { column: bestCol, score: bestScore };
    }
  }

  return suggestions;
}

module.exports = { parseHwExcel, parseRawExcelRows, detectColumnMap, suggestColumnMappingByLevenshtein, resolveTier2 };
