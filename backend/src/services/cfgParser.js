// services/cfgParser.js — Parse a PCS7 STEP7 .cfg baseline file
'use strict';

/**
 * Parse a baseline .cfg text into sections the generator can use verbatim.
 *
 * Returns:
 *   {
 *     header:             string,
 *     station:            string,
 *     stationName:        string,    // e.g. "AS01"
 *     stationType:        string,    // e.g. "S7400"
 *     subnets:            string[],
 *     subnetNames:        string[],  // display names, e.g. ["PlantBus", "Fieldbus"]
 *     irtDomains:         string[],
 *     racks:              string[],
 *     rackModules:        [{slot, subslot, orderNo, name}],
 *     ioControllers:      [{no, subnetName, deviceName}],  // from CONTROLLER IOSUBSYSTEM lines
 *     ioSubsystemHeaders: [{no, text}],  // all non-IOADDRESS IOSUBSYSTEM blocks
 *     ioSubsystemHeader:  string,    // backward-compat: first header text
 *     ioSubsystemNo:      number,    // backward-compat: first header no
 *     existingDevices:    [{no, addr, orderNo, name}],  // for display only
 *     existingAddresses:  { maxInput: number, maxOutput: number }
 *   }
 */
function parseCfg(text) {
  const lines = text.split(/\r?\n/);

  const result = {
    header:             '',
    station:            '',
    stationName:        '',
    stationType:        '',
    subnets:            [],
    subnetNames:        [],
    irtDomains:         [],
    racks:              [],
    rackModules:        [],
    ioControllers:      [],
    ioSubsystemHeaders: [],
    ioSubsystemHeader:  '',
    ioSubsystemNo:      100,
    existingDevices:    [],
    existingAddresses:  { maxInput: -1, maxOutput: -1 },
    minDiag:            16384, // lowest diagnostic address (>=16000) seen; device diag counts down from here-1
    pipMappings:        [],    // [{pipNo, ob, executionTime, timeScale}] from CPU PARAMETER block
  };

  let i = 0;

  // ── Collect header lines (before first keyword block) ─────────────────────
  // Preserve each line verbatim (PCS7 keeps trailing spaces on some lines); only
  // trim a COPY for keyword detection. \r was already removed by the split above.
  const headerLines = [];
  while (i < lines.length) {
    const raw = lines[i];
    if (/^(STATION|SUBNET|IRT_DOMAIN|RACK|IOSUBSYSTEM)\b/.test(raw.trimStart())) break;
    headerLines.push(raw);
    i++;
  }
  result.header = headerLines.join('\n');

  // ── State machine: collect named blocks ───────────────────────────────────
  while (i < lines.length) {
    const l = lines[i].trimEnd();

    // IOSUBSYSTEM block: collect controller headers, stop at first device block
    if (/^IOSUBSYSTEM\b/.test(l)) {
      if (/IOADDRESS\s+\d/.test(l)) {
        // First device IOSUBSYSTEM — stop here; generator recreates from this point
        break;
      } else {
        // Controller/subsystem definition block — capture verbatim
        const block = collectBlock(lines, i);
        const m = l.match(/^IOSUBSYSTEM\s+(\d+)/);
        const no = m ? parseInt(m[1], 10) : 100;
        result.ioSubsystemHeaders.push({ no, text: block.text });
        i = block.nextLine;
        continue;
      }
    }

    if (/^STATION\b/.test(l)) {
      const block = collectBlock(lines, i);
      result.station = block.text;
      // Extract station type + name: STATION S7400 , "AS01"
      const sm = l.match(/^STATION\s+(\S+)\s*,\s*"([^"]+)"/);
      if (sm) { result.stationType = sm[1]; result.stationName = sm[2]; }
      i = block.nextLine;
      continue;
    }

    if (/^SUBNET\b/.test(l)) {
      const block = collectBlock(lines, i);
      result.subnets.push(block.text);
      // Extract subnet display name: SUBNET INDUSTRIAL_ETHERNET , "PlantBus"
      const nm = l.match(/^SUBNET\s+\S+\s*,\s*"([^"]+)"/);
      if (nm) result.subnetNames.push(nm[1]);
      i = block.nextLine;
      continue;
    }

    if (/^IRT_DOMAIN\b/.test(l)) {
      const block = collectBlock(lines, i);
      result.irtDomains.push(block.text);
      i = block.nextLine;
      continue;
    }

    if (/^RACK\b/.test(l)) {
      const rackLines = [];
      while (i < lines.length) {
        const raw = lines[i];               // preserve trailing spaces verbatim
        const rl  = raw.trimEnd();           // trimmed copy for keyword detection
        if (/^(STATION|SUBNET|IRT_DOMAIN|IOSUBSYSTEM)\b/.test(rl) && rackLines.length > 0) break;
        if (/^RACK\b/.test(rl) && rackLines.length > 0) break;
        rackLines.push(raw);
        i++;
      }
      // Strip trailing newlines only — preserve PCS7's trailing space on "END ".
      result.racks.push(rackLines.join('\n').replace(/[\r\n]+$/, ''));
      continue;
    }

    i++;
  }

  // ── Post-process racks: extract slot/subslot modules + CONTROLLER refs ───
  const fullRackText = result.racks.join('\n');
  for (const rackText of result.racks) {
    // RACK N, SLOT S, "orderNo" ["ver"], "name"
    const slotRe = /^RACK \d+, SLOT (\d+), "([^"]+)"[^,\n]*,\s*"([^"]+)"/gm;
    for (const m of rackText.matchAll(slotRe)) {
      result.rackModules.push({ slot: parseInt(m[1]), subslot: null, orderNo: m[2], name: m[3], ip: null });
    }
    // RACK N, SLOT S, SUBSLOT SS, "orderNo", "name"
    const subRe = /^RACK \d+, SLOT (\d+), SUBSLOT (\d+), "([^"]+)"[^,\n]*,\s*"([^"]+)"/gm;
    for (const m of rackText.matchAll(subRe)) {
      result.rackModules.push({ slot: parseInt(m[1]), subslot: parseInt(m[2]), orderNo: m[3], name: m[4], ip: null });
    }
    // CONTROLLER IOSUBSYSTEM N, "SubnetName", IOADDRESS 0
    const ctrlRe = /CONTROLLER IOSUBSYSTEM (\d+),\s*"([^"]+)"/g;
    for (const m of rackText.matchAll(ctrlRe)) {
      const no = parseInt(m[1]);
      if (!result.ioControllers.find(c => c.no === no)) {
        result.ioControllers.push({ no, subnetName: m[2] });
      }
    }
  }

  // ── Enrich subslot modules with IP address from their BEGIN...END block ───
  for (const mod of result.rackModules) {
    if (mod.subslot === null) continue;
    const marker = `SLOT ${mod.slot}, SUBSLOT ${mod.subslot},`;
    const start = fullRackText.indexOf(marker);
    if (start === -1) continue;
    // Bound the search to this subslot's block (stop at next SLOT/RACK line)
    const tail = fullRackText.slice(start + marker.length);
    const boundary = tail.search(/\nRACK \d+, SLOT \d+/);
    const segment = boundary === -1 ? tail : tail.slice(0, boundary);
    const ipM = segment.match(/\bIPADDRESS "([0-9A-Fa-f]{8})"/);
    if (ipM) {
      const h = ipM[1];
      mod.ip = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16)).join('.');
    }
  }

  // ── Scan all lines for existing device blocks (for display summary) ───────
  const devRe = /^IOSUBSYSTEM (\d+), IOADDRESS (\d+), "([^"]+)"[^,\n]*, "([^"]+)"/;
  for (const line of lines) {
    const m = line.match(devRe);
    if (m && !/SLOT/.test(line)) {
      result.existingDevices.push({
        no: parseInt(m[1]), addr: parseInt(m[2]), orderNo: m[3], name: m[4],
      });
    }
  }

  // ── Enrich ioControllers with IP from IOSUBSYSTEM header blocks ──────────
  // IPPARAM lines carry: "ip", "router", "subnet-mask" — we want the first field.
  for (const hdr of result.ioSubsystemHeaders) {
    const ctrl = result.ioControllers.find(c => c.no === hdr.no);
    if (!ctrl) continue;
    const ipM = hdr.text.match(/IPPARAM\s+"([^"]+)"/);
    if (ipM) ctrl.ip = ipM[1];
  }

  // ── Parse CPU PIP (Process Image Partition) mappings ─────────────────────
  // The CPU PARAMETER block uses two naming conventions (both present in real files):
  //
  // Convention A (OB-keyed, maps OB→pipNo):
  //   PART_PROCESS_IMAGE_INPUTS_OB30, "1"   ← OB30 uses PIP1
  //   PART_PROCESS_IMAGE_INPUTS_OB31, "2"   ← OB31 uses PIP2
  //
  // Convention B (PIP-keyed, maps pipNo→OB):
  //   PART_PROCESS_IMAGE_1_OF_INPUTS_OB, "30"  ← PIP1 is served by OB30
  //
  // Both may be present; prefer convention A (it's always present in real files).
  // EXECUTION_OBnn / TIMESCALE_OBnn carry cycle time and unit for each OB.
  {
    const fullRackText2 = result.racks.join('\n');
    const obMap = {};   // obNo → { executionTime, timeScale }
    const pipMap = {};  // pipNo → obNo

    // Collect execution time + timescale for each OB
    for (const m of fullRackText2.matchAll(/EXECUTION_OB(\d+)\s*,\s*"([^"]*)"/g)) {
      const obNo = parseInt(m[1], 10);
      if (!obMap[obNo]) obMap[obNo] = {};
      obMap[obNo].executionTime = m[2];
    }
    for (const m of fullRackText2.matchAll(/TIMESCALE_OB(\d+)\s*,\s*"([^"]*)"/g)) {
      const obNo = parseInt(m[1], 10);
      if (!obMap[obNo]) obMap[obNo] = {};
      obMap[obNo].timeScale = m[2];
    }

    // Convention A: PART_PROCESS_IMAGE_INPUTS_OB<ob>, "<pipNo>"
    // (value = PIP number assigned to that OB, 0 = unassigned)
    for (const m of fullRackText2.matchAll(/PART_PROCESS_IMAGE_INPUTS_OB(\d+)\s*,\s*"(\d+)"/g)) {
      const obNo  = parseInt(m[1], 10);
      const pipNo = parseInt(m[2], 10);
      if (pipNo !== 0) pipMap[pipNo] = obNo;
    }

    // Convention B fallback: PART_PROCESS_IMAGE_<N>_OF_INPUTS_OB, "<ob>"
    // Only applies where convention A left no entry for this PIP
    for (const m of fullRackText2.matchAll(/PART_PROCESS_IMAGE_(\d+)_OF_INPUTS_OB\s*,\s*"(\d+)"/g)) {
      const pipNo = parseInt(m[1], 10);
      const obNo  = parseInt(m[2], 10);
      if (obNo !== 0 && !pipMap[pipNo]) pipMap[pipNo] = obNo;
    }

    // Build sorted array of active PIPs, skipping OBs with no timing info
    result.pipMappings = Object.keys(pipMap)
      .map(n => parseInt(n, 10))
      .sort((a, b) => a - b)
      .filter(pipNo => {
        const obNo = pipMap[pipNo];
        const meta = obMap[obNo] || {};
        // Skip OBs whose execution time is "NONE" or missing
        return meta.executionTime && meta.executionTime !== 'NONE';
      })
      .map(pipNo => {
        const obNo = pipMap[pipNo];
        const meta = obMap[obNo] || {};
        const time = meta.executionTime;
        const unit = meta.timeScale ? meta.timeScale.toLowerCase() : 'ms';
        return { pipNo, ob: obNo, executionTime: time, timeScale: unit };
      });
  }

  // ── Backward-compat single-header fields ─────────────────────────────────
  if (result.ioSubsystemHeaders.length > 0) {
    result.ioSubsystemNo     = result.ioSubsystemHeaders[0].no;
    result.ioSubsystemHeader = result.ioSubsystemHeaders[0].text;
  }

  // ── Scan all lines for ADDRESS values → maxInput / maxOutput ─────────────
  // Track the END address of each block (start + length) so the allocator knows
  // exactly where to resume without leaving a gap or overlapping.
  // ADDRESS format: start, bit_offset, length, sub_index, pip, flag
  let inContext = false;
  let outContext = false;
  for (const line of lines) {
    const tl = line.trim();
    if (tl === 'LOCAL_IN_ADDRESSES')  { inContext = true;  outContext = false; continue; }
    if (tl === 'LOCAL_OUT_ADDRESSES') { outContext = true; inContext = false;  continue; }
    if (tl === '' || /^END\b/.test(tl)) { inContext = false; outContext = false; }

    // ADDRESS  start, bit_offset, length, sub_index, pip, flag
    const am = tl.match(/^ADDRESS\s+(\d+)\s*,\s*\d+\s*,\s*(\d+)/);
    if (am) {
      const start  = parseInt(am[1], 10);
      const length = parseInt(am[2], 10) || 0;
      if (start >= 16000) {
        if (start < result.minDiag) result.minDiag = start; // track lowest diagnostic address
        continue; // diagnostic — skip process-image scan
      }
      // Record end-of-block: last byte used = start + length - 1
      const endAddr = start + length - 1;
      if (inContext  && endAddr > result.existingAddresses.maxInput)  result.existingAddresses.maxInput  = endAddr;
      if (outContext && endAddr > result.existingAddresses.maxOutput) result.existingAddresses.maxOutput = endAddr;
    }
  }

  return result;
}

/**
 * Collect a BEGIN...END block starting at line i.
 * Handles nested BEGIN/END blocks (e.g. REDUNDANCY BEGIN END inside a slot).
 */
function collectBlock(lines, startLine) {
  const collected = [];
  let depth = 0;
  let i = startLine;

  while (i < lines.length) {
    const raw = lines[i];          // preserve trailing spaces verbatim
    const l   = raw.trimEnd();      // trimmed copy for BEGIN/END detection
    collected.push(raw);

    if (/\bBEGIN\b/.test(l)) depth++;
    if (/^\s*END\b/.test(l)) {
      depth--;
      if (depth <= 0) { i++; break; }
    }
    i++;
  }

  // Skip trailing blank lines between blocks
  while (i < lines.length && lines[i].trim() === '') i++;

  return { text: collected.join('\n'), nextLine: i };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseCfgDevices — extract every IO device from a CFG file into a structured
// list that can be written directly into hw_signals + hw_slot_subslots.
//
// Returns an array of station objects:
// [
//   {
//     subsystemNo:   number,       // IOSUBSYSTEM number (100, 101, …)
//     address:       number,       // IOADDRESS
//     name:          string,       // device name from header line
//     orderNo:       string,       // module order number (version prefix stripped)
//     ip:            string|null,  // hex→dotted from IPADDRESS in SLOT 0 block
//     routerAddress: string|null,
//     slots: [
//       {
//         slot:           number,
//         orderNo:        string,
//         name:           string,
//         pipNo:          number|null,   // 5th field of ADDRESS line (0 = unassigned)
//         potentialGroup: string|null,   // POTENTIAL_GROUP value
//         symbols: [{ channel: number, tag: string, description: string }],
//         subslots: [{ subslotNo: number, orderNo: string, name: string }],
//       }
//     ]
//   }
// ]
//
// Slots 0 (IM interface) and its auto-created sub-slots (port/iface) are skipped
// because they are not stored as hw_signals rows — only functional module slots
// (slot ≥ 1) are included.
// ─────────────────────────────────────────────────────────────────────────────
function parseCfgDevices(text) {
  const lines = text.split(/\r?\n/);
  const stations = new Map(); // addr → station object

  // Regex for device header lines:
  //   IOSUBSYSTEM <no>, IOADDRESS <addr>, "orderNo" ["ver"], "name"
  //   IOSUBSYSTEM <no>, IOADDRESS <addr>, SLOT <s>, "orderNo" ["ver"], "name"
  //   IOSUBSYSTEM <no>, IOADDRESS <addr>, SLOT <s>, SUBSLOT <ss>, "orderNo" ["ver"], "name"
  const devRe    = /^IOSUBSYSTEM\s+(\d+),\s*IOADDRESS\s+(\d+),\s*"([^"]+)"(?:\s+"[^"]*")?,\s*"([^"]+)"/;
  const slotRe   = /^IOSUBSYSTEM\s+(\d+),\s*IOADDRESS\s+(\d+),\s*SLOT\s+(\d+),\s*"([^"]+)"(?:\s+"[^"]*")?,\s*"([^"]+)"/;
  const subslotRe= /^IOSUBSYSTEM\s+(\d+),\s*IOADDRESS\s+(\d+),\s*SLOT\s+(\d+),\s*SUBSLOT\s+(\d+),\s*"([^"]+)"(?:\s+"[^"]*")?,\s*"([^"]+)"/;

  // Strip version prefix from order number: "V1_1:6ES7 193-6PA00-0AA0" → "6ES7 193-6PA00-0AA0"
  // Also handle "DEFAULT:..." form used for port/iface subslots
  const stripVersion = (raw) => raw.replace(/^[A-Za-z0-9_]+:/, '');

  let i = 0;

  // Skip everything before the first device IOSUBSYSTEM line
  while (i < lines.length) {
    const l = lines[i].trimEnd();
    if (/^IOSUBSYSTEM\s+\d+,\s*IOADDRESS\s+\d+/.test(l)) break;
    i++;
  }

  while (i < lines.length) {
    const l = lines[i].trimEnd();

    // ── Sub-slot line ──────────────────────────────────────────────────────
    const ssm = l.match(subslotRe);
    if (ssm) {
      const [, , addr, slotNo, subslotNo, rawOrder, name] = ssm;
      const addrN   = parseInt(addr, 10);
      const slotN   = parseInt(slotNo, 10);
      const subN    = parseInt(subslotNo, 10);
      const orderNo = stripVersion(rawOrder);
      // Skip DEFAULT: port/iface subslots (they are AUTOCREATED infrastructure)
      const isPort = /DEFAULT:/i.test(rawOrder) || /^_S7H_/.test(rawOrder);
      if (!isPort) {
        const st   = stations.get(addrN);
        const slot = st && st.slots.find(s => s.slot === slotN);
        if (slot) {
          slot.subslots.push({ subslotNo: subN, orderNo, name });
        }
      }
      // Collect the block to extract IP from slot 0 subslot 0/1
      const block = collectBlock(lines, i);
      // Extract IP from slot 0 IPADDRESS field (hex string)
      if (slotN === 0) {
        const ipM = block.text.match(/\bIPADDRESS\s+"([0-9A-Fa-f]{8})"/);
        const rtM = block.text.match(/\bROUTERADDRESS\s+"([0-9A-Fa-f]{8})"/);
        const st  = stations.get(addrN);
        if (st) {
          if (ipM && !st.ip) {
            st.ip = hexToIp(ipM[1]);
          }
          if (rtM && !st.routerAddress) {
            st.routerAddress = hexToIp(rtM[1]);
          }
        }
      }
      i = block.nextLine;
      continue;
    }

    // ── Slot line ──────────────────────────────────────────────────────────
    const sm = l.match(slotRe);
    if (sm) {
      const [, , addr, slotNo, rawOrder, name] = sm;
      const addrN   = parseInt(addr, 10);
      const slotN   = parseInt(slotNo, 10);
      const orderNo = stripVersion(rawOrder);

      // Collect the block to extract pip, potentialGroup, symbols
      const block = collectBlock(lines, i);
      i = block.nextLine;

      // Slot 0 = IM/interface module — extract IP + MLFB then skip (not a hw_signals row)
      if (slotN === 0) {
        const ipM = block.text.match(/\bIPADDRESS\s+"([0-9A-Fa-f]{8})"/);
        const rtM = block.text.match(/\bROUTERADDRESS\s+"([0-9A-Fa-f]{8})"/);
        const mlM = block.text.match(/\bMLFB\s+"([^"]+)"/);
        const st  = stations.get(addrN);
        if (st) {
          if (ipM && !st.ip)            st.ip            = hexToIp(ipM[1]);
          if (rtM && !st.routerAddress) st.routerAddress = hexToIp(rtM[1]);
          if (mlM && !st.mlfbNo)        st.mlfbNo        = mlM[1].trim();
        }
        continue;
      }

      const st = stations.get(addrN);
      if (!st) continue;

      // PIP: 5th field (index 4) of ADDRESS line  → "start, bit, length, subidx, pip, flag"
      let pipNo = null;
      const addrLineM = block.text.match(/\bADDRESS\s+\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)/);
      if (addrLineM) {
        const p = parseInt(addrLineM[1], 10);
        if (p > 0) pipNo = p;
      }

      // POTENTIAL_GROUP
      let potentialGroup = null;
      const pgM = block.text.match(/\bPOTENTIAL_GROUP\s*,\s*"([^"]*)"/);
      if (pgM && pgM[1]) potentialGroup = pgM[1];

      // SYMBOL lines: SYMBOL  I/Q/... , <byte_offset>, "tag", "description"
      const symbols = [];
      const symRe = /^SYMBOL\s+\S+\s*,\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/gm;
      for (const sm2 of block.text.matchAll(symRe)) {
        symbols.push({
          channel:     parseInt(sm2[1], 10),
          tag:         sm2[2],
          description: sm2[3],
        });
      }

      st.slots.push({ slot: slotN, orderNo, name, pipNo, potentialGroup, symbols, subslots: [] });
      continue;
    }

    // ── Device header line ─────────────────────────────────────────────────
    const dm = l.match(devRe);
    if (dm) {
      const [, subsysNo, addr, rawOrder, name] = dm;
      const addrN     = parseInt(addr, 10);
      const subsysN   = parseInt(subsysNo, 10);
      // Do NOT strip the version prefix here — for CFU_PA/GSDML devices the
      // prefix (e.g. "V_2_0_PA:") is part of the catalogue order_no key.
      // Regular ET200SP device headers never carry a prefix, so no change there.
      const orderNo   = rawOrder;

      if (!stations.has(addrN)) {
        stations.set(addrN, {
          subsystemNo:   subsysN,
          address:       addrN,
          name,
          orderNo,
          ip:            null,
          routerAddress: null,
          mlfbNo:        null,   // filled from SLOT 0 MLFB field (GSDML devices)
          slots:         [],
        });
      }
      // Collect and skip the device-level block (no useful data for hw_signals at this level)
      const block = collectBlock(lines, i);
      i = block.nextLine;
      continue;
    }

    i++;
  }

  return [...stations.values()];
}

function hexToIp(hex) {
  return [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16)).join('.');
}

module.exports = { parseCfg, parseCfgDevices };
