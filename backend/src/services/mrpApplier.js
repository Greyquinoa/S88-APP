// services/mrpApplier.js — Patch a baseline CFG text with MRP ring configuration
// This performs targeted text substitutions; it never touches blocks unrelated to MRP.
'use strict';

/**
 * Build the hex string for MRP_MULTI_CONFIGURATION.
 *
 * Format (space-separated uppercase hex bytes):
 *   <domainName ASCII bytes> 09 <roleDigit> 09 <tailBytes...> 00
 *
 * For devices with a single MRP instance (CPU, CFU-PA, most field devices):
 *   domainName 09 role 09 00
 *
 * For SCALANCE switches (support up to 4 instances — 4 role slots):
 *   domainName 09 role 09 domainName 09 00 09 domainName 09 00 09 domainName 09 00 09 00
 *
 * The baseline CFG already has the no-MRP version; we only replace the single
 * role byte (30→32 or 33) at the correct position.
 */
function buildMrpMultiConfig(domainName, role, isSwitch) {
  const domBytes = Buffer.from(domainName, 'ascii')
    .toString('hex').toUpperCase().match(/.{2}/g).join(' ');
  const TAB  = '09';
  const NULL = '00';
  // Role is encoded as its ASCII digit character (e.g. role 2 → 0x32, not 0x02).
  const roleHex = (0x30 + role).toString(16).toUpperCase();

  if (isSwitch) {
    // 4-slot layout: slot1=role, slots 2-4=0 (not participating)
    const slot = (r) => `${domBytes} ${TAB} ${r} ${TAB}`;
    return `${slot(roleHex)} ${slot('30')} ${slot('30')} ${slot('30')} ${NULL}`;
  }
  // Single-slot layout
  return `${domBytes} ${TAB} ${roleHex} ${TAB} ${NULL}`;
}

/**
 * Replace the value of a key inside a specific CFG block region.
 * Operates on the text between blockStart..blockEnd only.
 *
 * @param {string} text  - full CFG text
 * @param {number} start - character index of the block's BEGIN
 * @param {number} end   - character index of the block's END (exclusive)
 * @param {string} key   - e.g. "MRP_CONFIGURATION"
 * @param {string} newValue - the new quoted value e.g. `"mrpdomain-1\t2"`
 * @returns {string} updated full text
 */
function replaceInBlock(text, start, end, key, newValue) {
  const region = text.slice(start, end);
  // CFG block properties use either "KEY, value" (PARAMETER section) or "KEY value" (main block).
  // The separator group is preserved so the replacement keeps the original format.
  const re = new RegExp(`(${key}(?:\\s*,\\s*|\\s+))("?[^"\\n]*"?)`, '');
  if (!re.test(region)) return text; // key not present — leave unchanged
  const updated = region.replace(re, `$1${newValue}`);
  return text.slice(0, start) + updated + text.slice(end);
}

/**
 * Insert a key value line directly after the ASSET_ID line inside a block.
 * If the key already exists, replaces it instead.
 */
function insertOrReplaceInBlock(text, start, end, key, newValue) {
  const region = text.slice(start, end);
  const existing = new RegExp(`(${key}(?:\\s*,\\s*|\\s+))("?[^"\\n]*"?)`, '');
  if (existing.test(region)) {
    return replaceInBlock(text, start, end, key, newValue);
  }
  // Insert after ASSET_ID line (handles both "ASSET_ID, value" and "ASSET_ID value")
  const assetIdRe = /ASSET_ID(?:\s*,\s*|\s+)[^\n]*\n/;
  const m = assetIdRe.exec(region);
  const insertAfter = m ? m.index + m[0].length : 0;
  const line = `  ${key} ${newValue}\n`;
  const updated = region.slice(0, insertAfter) + line + region.slice(insertAfter);
  return text.slice(0, start) + updated + text.slice(end);
}

/**
 * Find the BEGIN...END block content for a flat top-level CFG entry.
 * The CFG is flat: every RACK/SLOT/SUBSLOT and IOSUBSYSTEM/SLOT/SUBSLOT entry
 * is its own top-level block — subslots are NOT nested inside device headers.
 *
 * Searches for headerRe (a regex matching the entry's header line) in text,
 * then finds the next BEGIN...END pair after it.
 * Returns { start, end } of the content (exclusive of BEGIN/END keywords themselves)
 * so that replaceInBlock can operate directly on the content.
 */
function findFlatBlock(text, headerRe) {
  const m = headerRe.exec(text);
  if (!m) return null;

  // Walk lines from after the header to find BEGIN, skipping interstitial lines
  // (AUTOCREATED, CONTROLLER IOSUBSYSTEM ..., etc.)
  const afterHeader = text.slice(m.index + m[0].length);
  const beginM = /\bBEGIN\b/.exec(afterHeader);
  if (!beginM) return null;

  const beginAbs = m.index + m[0].length + beginM.index + beginM[0].length;

  // Find matching END (depth 1 — flat blocks do not nest BEGIN/END)
  let depth = 1, pos = beginAbs;
  const tokenRe = /\b(BEGIN|END)\b/g;
  tokenRe.lastIndex = pos;
  let tok;
  while ((tok = tokenRe.exec(text)) !== null) {
    if (tok[0] === 'BEGIN') depth++;
    else { depth--; if (depth === 0) { pos = tok.index + tok[0].length; break; } }
  }
  return { start: beginAbs, end: pos };
}

/**
 * Find the BEGIN...END block for an IO device subslot (flat CFG format).
 * Header format: IOSUBSYSTEM N, IOADDRESS A, SLOT S, SUBSLOT SS, "orderNo", "name"
 */
function findIoSubslotBlock(text, subsystemNo, ioAddress, slotNo, subslotNo) {
  // subsystemNo may be unknown (-1) — use \d+ if so
  const sysPattern = subsystemNo >= 0 ? subsystemNo : '\\d+';
  const re = new RegExp(
    `^IOSUBSYSTEM\\s+${sysPattern},\\s*IOADDRESS\\s+${ioAddress},\\s*SLOT\\s+${slotNo},\\s*SUBSLOT\\s+${subslotNo},`,
    'm'
  );
  return findFlatBlock(text, re);
}

/**
 * Find the BEGIN...END block for a rack-mounted CPU subslot (flat CFG format).
 * Header format: RACK N, SLOT S, SUBSLOT SS, "orderNo", "name"
 */
function findRackSubslotBlock(text, rackSlot, subslotNo) {
  const re = new RegExp(
    `^RACK\\s+\\d+,\\s*SLOT\\s+${rackSlot},\\s*SUBSLOT\\s+${subslotNo},`,
    'm'
  );
  return findFlatBlock(text, re);
}

/**
 * Patch the PN_RINGSTATUS_STRUCT field: flip first byte from 00 to 01.
 * Only operates within the supplied text region.
 */
function patchRingStatus(text, start, end) {
  const region = text.slice(start, end);
  // "00 XX XX XX XX XX XX XX" → "01 XX XX XX XX XX XX XX"
  const re = /(PN_RINGSTATUS_STRUCT\s*,\s*"?)00(\s)/;
  if (!re.test(region)) return text;
  const updated = region.replace(re, '$101$2');
  return text.slice(0, start) + updated + text.slice(end);
}

/**
 * Apply MRP configuration to a baseline CFG text.
 *
 * @param {string} baseCfg  - the full baseline .cfg text
 * @param {object} mrpConfig - {
 *   domainName: string,
 *   stationName: string,
 *   devices: [{
 *     alias: string,          // device name, e.g. "S1", "PN-IO-X8", "cfu-pa"
 *     ioAddress: number|null, // null for rack-mounted sub-interfaces
 *     rackSlot: number|null,  // for rack-mounted: slot in rack (e.g. 3 for CPU)
 *     ifaceSubslot: number,   // subslot of the PN-IO interface block (e.g. 8)
 *     role: number,           // 0=off, 2=client/manager, 3=manager
 *     isSwitch: boolean,
 *     ringPorts: [{
 *       portSubslot: number,  // subslot number of the port (e.g. 9, 10, 2, 3)
 *       linkedDevice: string, // target device alias
 *       linkedIfaceSubslot: number,
 *       linkedPortSubslot: number,
 *     }]
 *   }]
 * }
 * @returns {string} patched CFG text
 */
function applyMrp(baseCfg, mrpConfig) {
  let text = baseCfg;
  const { domainName, stationName, devices } = mrpConfig;

  for (const dev of devices) {
    if (dev.role === 0) continue;

    const isSwitch     = dev.isSwitch;
    const roleStr      = String(dev.role);
    const multiConfig  = `"${buildMrpMultiConfig(domainName, dev.role, isSwitch)}"`;
    const mrpCfgVal    = `"${domainName}\t${roleStr}"`;
    const mrpInstances = (dev.role === 1 || dev.role === 3) ? '"1"' : '"0"';

    // ── Locate the interface subslot block (flat CFG format) ─────────────────
    let ifaceBlock;
    if (dev.ioAddress != null) {
      // IO device: IOSUBSYSTEM N, IOADDRESS A, SLOT 0, SUBSLOT SS, ...
      ifaceBlock = findIoSubslotBlock(text, -1, dev.ioAddress, 0, dev.ifaceSubslot);
    } else {
      // Rack-mounted CPU: RACK N, SLOT S, SUBSLOT SS, ...
      ifaceBlock = findRackSubslotBlock(text, dev.rackSlot, dev.ifaceSubslot);
    }

    if (!ifaceBlock) {
      console.warn(`[MRP] Interface subslot ${dev.ifaceSubslot} not found for ${dev.alias}`);
      continue;
    }

    // Patch interface-level MRP fields (text offsets shift after each replace,
    // so re-find the block between interface patches)
    text = replaceInBlock(text, ifaceBlock.start, ifaceBlock.end, 'MRP_CONFIGURATION', mrpCfgVal);
    ifaceBlock = dev.ioAddress != null
      ? findIoSubslotBlock(text, -1, dev.ioAddress, 0, dev.ifaceSubslot)
      : findRackSubslotBlock(text, dev.rackSlot, dev.ifaceSubslot);
    if (!ifaceBlock) continue;

    text = replaceInBlock(text, ifaceBlock.start, ifaceBlock.end, 'MRP_MULTI_CONFIGURATION', multiConfig);
    if (dev.role === 1 || dev.role === 3) {
      ifaceBlock = dev.ioAddress != null
        ? findIoSubslotBlock(text, -1, dev.ioAddress, 0, dev.ifaceSubslot)
        : findRackSubslotBlock(text, dev.rackSlot, dev.ifaceSubslot);
      if (ifaceBlock) text = replaceInBlock(text, ifaceBlock.start, ifaceBlock.end, 'MRP_INSTANCES', mrpInstances);
    }

    // ── Patch each ring port ───────────────────────────────────────────────
    for (const port of dev.ringPorts) {
      let portBlock;
      if (dev.ioAddress != null) {
        portBlock = findIoSubslotBlock(text, -1, dev.ioAddress, 0, port.portSubslot);
      } else {
        portBlock = findRackSubslotBlock(text, dev.rackSlot, port.portSubslot);
      }
      if (!portBlock) { console.warn(`[MRP] Port subslot ${port.portSubslot} not found for ${dev.alias}`); continue; }

      // LINKED_PORT format: "STATION\deviceAlias.ifaceSubslot.portSubslot"
      const linkedPort = `"${stationName}\\${port.linkedDevice}.${port.linkedIfaceSubslot}.${port.linkedPortSubslot}"`;

      text = insertOrReplaceInBlock(text, portBlock.start, portBlock.end, 'LINKED_PORT', linkedPort);
      portBlock = dev.ioAddress != null
        ? findIoSubslotBlock(text, -1, dev.ioAddress, 0, port.portSubslot)
        : findRackSubslotBlock(text, dev.rackSlot, port.portSubslot);
      if (!portBlock) continue;

      text = replaceInBlock(text, portBlock.start, portBlock.end, 'MRP_DOMAIN', `"${domainName}"`);
      portBlock = dev.ioAddress != null
        ? findIoSubslotBlock(text, -1, dev.ioAddress, 0, port.portSubslot)
        : findRackSubslotBlock(text, dev.rackSlot, port.portSubslot);
      if (portBlock) text = patchRingStatus(text, portBlock.start, portBlock.end);

      if (isSwitch) {
        portBlock = dev.ioAddress != null
          ? findIoSubslotBlock(text, -1, dev.ioAddress, 0, port.portSubslot)
          : findRackSubslotBlock(text, dev.rackSlot, port.portSubslot);
        if (portBlock) text = replaceInBlock(text, portBlock.start, portBlock.end, 'MRP_INSTANCE_NUMBER', '"1"');
      }
    }
  }

  return text;
}

module.exports = { applyMrp, buildMrpMultiConfig };
