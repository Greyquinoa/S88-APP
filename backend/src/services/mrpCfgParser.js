// services/mrpCfgParser.js — Extract MRP-relevant devices from a baseline CFG.
//
// CFG structure is FLAT — each RACK/SLOT/SUBSLOT and IOSUBSYSTEM/IOADDRESS/SLOT/SUBSLOT
// entry is its own top-level block.  Subslots are NOT nested inside their device header.
//
// CPU example (in RACK section):
//   RACK 0, SLOT 3, SUBSLOT 5, "...", "PN-IO-X8"
//   AUTOCREATED
//   CONTROLLER IOSUBSYSTEM 101, "Fieldbus", IOADDRESS 0   ← between header and BEGIN
//   BEGIN
//     MRP_CONFIGURATION "mrpdomain-1	0"                  ← interface marker
//   END
//   RACK 0, SLOT 3, SUBSLOT 9, "...", "Port 1"
//   AUTOCREATED
//   BEGIN
//     MRP_DOMAIN ""                                       ← port marker
//   END
//
// IO device example (in IOSUBSYSTEM section):
//   IOSUBSYSTEM 101, IOADDRESS 1, "orderNo", "IM155-6PN-HF"   ← device header
//   BEGIN ... END
//   IOSUBSYSTEM 101, IOADDRESS 1, SLOT 0, SUBSLOT 1, "...", "PN-IO"
//   AUTOCREATED
//   BEGIN
//     MRP_CONFIGURATION "mrpdomain-1	0"
//   END
//   IOSUBSYSTEM 101, IOADDRESS 1, SLOT 0, SUBSLOT 2, "...", "Port 1 RJ45"
//   AUTOCREATED
//   BEGIN
//     MRP_DOMAIN ""
//   END
'use strict';

/**
 * Collect the BEGIN...END block starting at line index startIdx.
 * The line at startIdx must contain BEGIN (or be BEGIN itself).
 * Returns { text, nextLine }.
 */
function collectBlock(lines, startIdx) {
  let depth = 0;
  const collected = [];
  let i = startIdx;
  while (i < lines.length) {
    const l = lines[i];
    collected.push(l);
    if (/\bBEGIN\b/.test(l)) depth++;
    if (/\bEND\b/.test(l))   { depth--; if (depth === 0) { i++; break; } }
    i++;
  }
  return { text: collected.join('\n'), nextLine: i };
}

/**
 * Parse CPU PN-IO devices from the RACK section of the CFG.
 * Identifies subslots with CONTROLLER IOSUBSYSTEM → interface.
 * Subsequent subslots in the same slot with MRP_DOMAIN or "Port N" name → ports.
 */
function parseCpuPnioFromRack(rackText, ioControllers) {
  const results = [];
  const lines = rackText.split(/\r?\n/);

  // Match: RACK N, SLOT S, SUBSLOT SS, "orderNo" [ver], "name"
  const subslotRe = /^RACK\s+\d+,\s*SLOT\s+(\d+),\s*SUBSLOT\s+(\d+),\s*"[^"]*"[^,\n]*,\s*"([^"]*)"/;

  let currentDevice = null; // { alias, subsystemNo, ifaceSubslot, ports, isSwitch }

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(subslotRe);
    if (!m) continue;

    const slotNo      = parseInt(m[1], 10);
    const subslotNo   = parseInt(m[2], 10);
    const subslotName = m[3];

    // Scan lines between the header and the next BEGIN to find CONTROLLER IOSUBSYSTEM
    let subsystemNo = null;
    let j = i + 1;
    while (j < lines.length && !/\bBEGIN\b/.test(lines[j])) {
      const ctrlM = lines[j].match(/CONTROLLER IOSUBSYSTEM\s+(\d+)/);
      if (ctrlM) subsystemNo = parseInt(ctrlM[1], 10);
      j++;
    }

    // Find and collect the BEGIN...END block
    if (j >= lines.length || !/\bBEGIN\b/.test(lines[j])) continue;
    const block = collectBlock(lines, j);
    const blockText = block.text;

    const hasMrpConfig    = /\bMRP_CONFIGURATION\b/.test(blockText);
    const hasMrpDomain    = /\bMRP_DOMAIN\b/.test(blockText);
    const hasMrpInstances = /\bMRP_INSTANCES\b/.test(blockText);
    const isPortByName    = /^Port\s+\d+/i.test(subslotName);

    if (hasMrpConfig && subsystemNo !== null) {
      // This is a PN-IO controller interface subslot
      const ctrl  = ioControllers.find(c => c.no === subsystemNo);
      const alias = subslotName || (ctrl ? ctrl.subnetName : `PN-IO-${subsystemNo}`);
      // Extract LINKED_SUBNETNAME from the block body (e.g. LINKED_SUBNETNAME "Fieldbus")
      const linkedSubnetM = blockText.match(/\bLINKED_SUBNETNAME\s+"([^"]*)"/);
      const subnetName = linkedSubnetM ? linkedSubnetM[1] : (ctrl ? ctrl.subnetName : null);
      currentDevice = {
        alias,
        ioAddress:    null,
        rackSlot:     slotNo,
        ifaceSubslot: subslotNo,
        ports:        [],
        isSwitch:     hasMrpInstances,
        deviceType:   'cpu',
        subsystemNo,
        subnetName,
      };
      results.push(currentDevice);
    } else if ((hasMrpDomain || isPortByName) && currentDevice !== null) {
      // Port subslot of the most-recently-seen interface
      currentDevice.ports.push({ subslot: subslotNo, label: subslotName });
    }
  }

  return results;
}

/**
 * Parse IO devices (IOSUBSYSTEM N, IOADDRESS A, ...) from the flat CFG text.
 *
 * Step 1 — collect device aliases from lines that have IOADDRESS but no SLOT.
 * Step 2 — scan SLOT/SUBSLOT lines to classify interface vs port subslots.
 */
function parseIoDevicesFromCfg(text) {
  const lines = text.split(/\r?\n/);

  // Step 1: Device header lines: IOSUBSYSTEM N, IOADDRESS A, "orderNo" [ver], "alias"
  // Must NOT contain SLOT or SUBSLOT keyword after IOADDRESS.
  const devMap = new Map(); // "subsys:addr" → device record
  const deviceHeaderRe = /^IOSUBSYSTEM\s+(\d+),\s*IOADDRESS\s+(\d+),\s*"([^"]+)"[^,\n]*,\s*"([^"]+)"/;
  const hasSlotRe      = /^IOSUBSYSTEM\s+\d+,\s*IOADDRESS\s+\d+,\s*SLOT/;

  for (const line of lines) {
    if (hasSlotRe.test(line)) continue; // skip SLOT/SUBSLOT lines
    const m = line.match(deviceHeaderRe);
    if (!m) continue;
    const subsystemNo = parseInt(m[1], 10);
    const ioAddress   = parseInt(m[2], 10);
    const orderNo     = m[3];
    const alias       = m[4];
    const key = `${subsystemNo}:${ioAddress}`;
    if (!devMap.has(key)) {
      devMap.set(key, {
        subsystemNo, ioAddress, orderNo, alias,
        ifaceSubslot: null, ports: [], isSwitch: false,
        deviceType: 'device',
        subnetName: null,
      });
    }
  }

  if (devMap.size === 0) return [];

  // Step 2: SUBSLOT lines: IOSUBSYSTEM N, IOADDRESS A, SLOT S, SUBSLOT SS, "orderNo" [ver], "name"
  const subslotLineRe = /^IOSUBSYSTEM\s+(\d+),\s*IOADDRESS\s+(\d+),\s*SLOT\s+\d+,\s*SUBSLOT\s+(\d+),\s*"[^"]*"[^,\n]*,\s*"([^"]*)"/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(subslotLineRe);
    if (!m) continue;

    const subsystemNo = parseInt(m[1], 10);
    const ioAddress   = parseInt(m[2], 10);
    const subslotNo   = parseInt(m[3], 10);
    const subslotName = m[4];
    const key = `${subsystemNo}:${ioAddress}`;
    const dev = devMap.get(key);
    if (!dev) continue;

    // Find the BEGIN...END block for this subslot
    let j = i + 1;
    while (j < lines.length && !/\bBEGIN\b/.test(lines[j])) j++;
    if (j >= lines.length) continue;
    const block = collectBlock(lines, j);
    const blockText = block.text;

    const hasMrpConfig    = /\bMRP_CONFIGURATION\b/.test(blockText);
    const hasMrpDomain    = /\bMRP_DOMAIN\b/.test(blockText);
    const hasMrpInstances = /\bMRP_INSTANCES\b/.test(blockText);
    const isPortByName    = /^Port\s+\d+/i.test(subslotName);

    if (hasMrpConfig) {
      dev.ifaceSubslot = subslotNo;
      if (hasMrpInstances) dev.isSwitch = true;
      // Extract LINKED_SUBNETNAME from interface block (e.g. LINKED_SUBNETNAME "Fieldbus")
      const linkedSubnetM = blockText.match(/\bLINKED_SUBNETNAME\s+"([^"]*)"/);
      if (linkedSubnetM) dev.subnetName = linkedSubnetM[1];
    } else if (hasMrpDomain || isPortByName) {
      // Avoid duplicate ports
      if (!dev.ports.find(p => p.subslot === subslotNo)) {
        dev.ports.push({ subslot: subslotNo, label: subslotName });
      }
    }
  }

  // Return all devices that have at least an interface OR ports identified
  return [...devMap.values()].filter(d => d.ifaceSubslot !== null || d.ports.length > 0);
}

/**
 * Main entry point.
 * @param {string} cfgText  - full baseline .cfg text
 * @param {object} parsed   - result of parseCfg() (stationName, ioControllers, racks)
 * @returns {{ stationName, subnets, devices }}
 */
function extractMrpDevices(cfgText, parsed) {
  const rackText = parsed.racks.join('\n');

  const cpuDevices = parseCpuPnioFromRack(rackText, parsed.ioControllers || []);
  const ioDevices  = parseIoDevicesFromCfg(cfgText);

  // Collect unique subsystem numbers
  const subsystemSet = new Set();
  for (const d of [...cpuDevices, ...ioDevices]) {
    if (d.subsystemNo != null) subsystemSet.add(d.subsystemNo);
  }

  return {
    stationName: parsed.stationName,
    subnets:     [...subsystemSet].sort((a, b) => a - b),
    devices:     [...cpuDevices, ...ioDevices],
  };
}

/**
 * Parse MRP roles and port links from an already-configured CFG file.
 *
 * Reads:
 *   MRP_CONFIGURATION "domainName\t<role>"  — on interface subslots
 *   LINKED_PORT "STATION\alias.ifaceOrRack.portSubslot" — on port subslots
 *
 * Returns { domainName, stationName, roles, links } where:
 *   roles: [{ alias, ioAddress, subsystemNo, mrpRole, rackSlot, ifaceSubslot }]
 *   links: [{ fromDevice, fromIfaceSubslot, fromPortSubslot,
 *              toDevice,   toIfaceSubslot,   toPortSubslot }]
 */
function parseMrpConfig(cfgText, parsed) {
  const { stationName } = parsed;
  const rackText = parsed.racks.join('\n');

  // ── Collect roles from interface subslots ─────────────────────────────────
  // Re-use the device structure already extracted, then read MRP_CONFIGURATION
  // and LINKED_PORT from each block.

  const cpuDevices = parseCpuPnioFromRack(rackText, parsed.ioControllers || []);
  const ioDevices  = parseIoDevicesFromCfg(cfgText);
  const allDevices = [...cpuDevices, ...ioDevices];

  const roles = [];
  const links = [];

  const lines = cfgText.split(/\r?\n/);

  for (const dev of allDevices) {
    if (dev.ifaceSubslot == null) continue;

    // Find the interface block and read MRP_CONFIGURATION
    let ifaceBlock = null;
    if (dev.ioAddress != null) {
      // IO device: IOSUBSYSTEM N, IOADDRESS A, SLOT 0, SUBSLOT SS
      const re = new RegExp(
        `^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+${dev.ioAddress},\\s*SLOT\\s+0,\\s*SUBSLOT\\s+${dev.ifaceSubslot},`,
        'm'
      );
      ifaceBlock = findFlatBlock(cfgText, re);
    } else {
      // Rack-mounted CPU: RACK N, SLOT S, SUBSLOT SS
      const re = new RegExp(
        `^RACK\\s+\\d+,\\s*SLOT\\s+${dev.rackSlot},\\s*SUBSLOT\\s+${dev.ifaceSubslot},`,
        'm'
      );
      ifaceBlock = findFlatBlock(cfgText, re);
    }

    let mrpRole = 0;
    let domainName = 'mrpdomain-1';
    if (ifaceBlock) {
      const region = cfgText.slice(ifaceBlock.start, ifaceBlock.end);
      // MRP_CONFIGURATION "mrpdomain-1\t2"  (tab-separated: domain + role digit)
      const m = region.match(/MRP_CONFIGURATION\s+"([^\t"]*)\t(\d)"/);
      if (m) {
        domainName = m[1];
        mrpRole    = parseInt(m[2], 10);
      }
    }

    // ── Collect port links from each port subslot ─────────────────────────
    // Also track which ports have LINKED_PORT set (= active ring ports in a configured CFG)
    const linkedPortSubslots = [];
    for (const port of dev.ports) {
      let portBlock = null;
      if (dev.ioAddress != null) {
        const re = new RegExp(
          `^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+${dev.ioAddress},\\s*SLOT\\s+0,\\s*SUBSLOT\\s+${port.subslot},`,
          'm'
        );
        portBlock = findFlatBlock(cfgText, re);
      } else {
        const re = new RegExp(
          `^RACK\\s+\\d+,\\s*SLOT\\s+${dev.rackSlot},\\s*SUBSLOT\\s+${port.subslot},`,
          'm'
        );
        portBlock = findFlatBlock(cfgText, re);
      }
      if (!portBlock) continue;

      const region = cfgText.slice(portBlock.start, portBlock.end);
      // LINKED_PORT "STATION\alias.ifaceOrRack.portSubslot"
      const lm = region.match(/LINKED_PORT\s+"[^\\]*\\(.+)\.(\d+)\.(\d+)"/);
      if (!lm || !lm[1]) continue;

      linkedPortSubslots.push(port.subslot);
      links.push({
        fromDevice:        dev.alias,
        fromIfaceSubslot:  dev.ifaceSubslot,
        fromPortSubslot:   port.subslot,
        toDevice:          lm[1],
        toIfaceSubslot:    parseInt(lm[2], 10),
        toPortSubslot:     parseInt(lm[3], 10),
      });
    }

    // Ring ports: prefer ports that have LINKED_PORT (active in configured CFG),
    // fall back to the first 2 port subslots for a baseline CFG (no links yet).
    const ringPortSources = linkedPortSubslots.length > 0 ? linkedPortSubslots
      : (dev.ports || []).slice(0, 2).map(p => p.subslot);
    const ringPort1 = ringPortSources[0] ?? null;
    const ringPort2 = ringPortSources[1] ?? null;

    roles.push({
      alias:        dev.alias,
      ioAddress:    dev.ioAddress ?? null,
      subsystemNo:  dev.subsystemNo ?? null,
      rackSlot:     dev.rackSlot ?? null,
      ifaceSubslot: dev.ifaceSubslot,
      mrpRole,
      domainName,
      ringPort1,
      ringPort2,
    });
  }

  // Pick domain name from the first device that has a non-default role
  const activeDomain = roles.find(r => r.mrpRole !== 0)?.domainName ?? 'mrpdomain-1';

  return { domainName: activeDomain, stationName, roles, links };
}

/**
 * Small helper re-exported from mrpApplier so this file stays self-contained.
 * Finds the BEGIN...END content block for a flat CFG header matched by headerRe.
 */
function findFlatBlock(text, headerRe) {
  const m = headerRe.exec(text);
  if (!m) return null;
  const afterHeader = text.slice(m.index + m[0].length);
  const beginM = /\bBEGIN\b/.exec(afterHeader);
  if (!beginM) return null;
  const beginAbs = m.index + m[0].length + beginM.index + beginM[0].length;
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

module.exports = { extractMrpDevices, parseMrpConfig };
