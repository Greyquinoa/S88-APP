// services/cfgCatalogueParser.js — Extract catalogue-worthy device types from a STEP7 .cfg file
//
// Only parses IOSUBSYSTEM IOADDRESS blocks (ET200SP-style IO station heads and
// IO card slots). RACK/SLOT CPU/PS blocks are intentionally ignored.
//
// Returns an array of candidate objects, deduplicated by order_no:
//   { order_no, version, display_name, family, signal_type,
//     input_bytes, output_bytes, in_addr_fmt, out_addr_fmt,
//     param_template, channel_count, parseError }
'use strict';

// ── Family derivation ─────────────────────────────────────────────────────────
// Rules are matched in order — most specific first.
// All rules apply ONLY inside IOSUBSYSTEM context (caller guarantees this),
// so 6ES7 3xx is always ET200M (never rack S7-300), and 6ES7 1xx sub-ranges
// can be safely split by the character at position 9 (after "6ES7 1xx-").
//
// 6ES7 1xx suffix key (character after the 3rd dash):
//   0 → ET200eco PN   1 → ET200S   4 → ET200M (IM)
//   6 → ET200SP       7 → ET200pro  8 → ET200AL
//
// 6ES7 3xx in IOSUBSYSTEM → always ET200M I/O cards (321/322/331/332/...)
//
// 6GK7 4xx → CP 443 (S7-400 CP, lives in RACK, but handle gracefully)
// 6GK7 3xx → CP 343 (S7-300 CP)
// 6GK other → SCALANCE
//
// 3RK → ET200pro motor starters / ASi safety
// 6GF → CFU (Common Foundation Unit, field multiplexer)
// 6AG1 → SIPLUS (harsh-environment variants — same family as base module)
// 7KM → SENTRON PAC meters
// 6DL / 6NH → SINAUT RTU
const FAMILY_RULES = [
  // ── CFU / PA fieldbus ──────────────────────────────────────────────────────
  [/^META[/\\]PA/i,         'CFU_PA'],   // forward or back slash — both seen in real CFG files
  [/^_S7H_HSP_CFU_PA/i,    'CFU_PA'],
  [/^6GF/,                  'CFU'],

  // ── ET200AL — I/O modules (6ES7 141-6, 142-6...) and IM (6ES7 157-0...) ──
  // 6ES7 140-6 is ET200eco PN head, so only 141+ maps to ET200AL here.
  // Must come BEFORE the general ET200SP 1xx-6 rule.
  [/^6ES7 14[1-9]-6/,       'ET200AL'],
  [/^6ES7 157-0/,           'ET200AL'],   // IM 157-1 PN
  [/^6AG1 14[1-9]-6/,       'ET200AL'],   // SIPLUS ET200AL

  // ── ET200SP (6ES7 13x-6, 15x-6, 19x-6) ──────────────────────────────────
  [/^6ES7 1[3589]\d-6/,     'ET200SP'],
  [/^6AG1 1[3589]\d-6/,     'ET200SP'],   // SIPLUS ET200SP

  // ── ET200pro (6ES7 1xx-7... or 3RK1) ─────────────────────────────────────
  [/^6ES7 1\d\d-7/,         'ET200pro'],
  [/^3RK1/,                 'ET200pro'],

  // ── ET200S (6ES7 1xx-1...) ────────────────────────────────────────────────
  [/^6ES7 1\d\d-1/,         'ET200S'],

  // ── ET200M interface modules (6ES7 153-4, 154-4...) ──────────────────────
  [/^6ES7 1[45]\d-4/,       'ET200M'],

  // ── ET200eco PN — IM (6ES7 154-8, 6ES7 140-6) and I/O (6ES7 14x-4) ───────
  [/^6ES7 154-8/,           'ET200eco'],  // IM 154-8 PN
  [/^6ES7 140-6/,           'ET200eco'],  // IM 140-6 PN (head module)
  [/^6ES7 14\d-4/,          'ET200eco'],  // ET200eco I/O modules

  // ── ET200M I/O cards (6ES7 3xx in IOSUBSYSTEM context) ───────────────────
  // 321/322 = DI/DO, 331/332 = AI/AO, 338 = FM, 340/341 = CP
  [/^6ES7 3/,               'ET200M'],
  [/^6AG1 3/,               'ET200M'],    // SIPLUS ET200M

  // ── ET200iSP (6ES7 6xx — ATEX/Ex zone) ───────────────────────────────────
  [/^6ES7 6/,               'ET200iSP'],

  // ── S7-400 CPU / CP / IM ──────────────────────────────────────────────────
  [/^6ES7 4/,               'S7400'],
  [/^6GK7 4/,               'S7400'],     // CP 443

  // ── S7-300 CP (6GK7 3xx) ─────────────────────────────────────────────────
  [/^6GK7 3/,               'S7300'],

  // ── SCALANCE network switches ─────────────────────────────────────────────
  [/^6GK[15]/,              'SCALANCE'],
  [/^6GK/,                  'SCALANCE'],
  [/SCALANCE/i,             'SCALANCE'],

  // ── ASi safety / motor management ────────────────────────────────────────
  [/^3RK2/,                 'ASi'],

  // ── SENTRON PAC power meters ──────────────────────────────────────────────
  [/^7KM/,                  'SENTRON'],

  // ── SINAUT / RTU ──────────────────────────────────────────────────────────
  [/^6DL/,                  'SINAUT'],
  [/^6NH/,                  'SINAUT'],

  // ── HMI panels (GSDML filename contains "HMI" or "PP") ───────────────────
  [/^GSDML.*(?:HMI|_PP[-_])/i, 'HMI'],

  // ── SCALANCE via GSDML ───────────────────────────────────────────────────
  [/^GSDML.*SCALANCE/i,     'SCALANCE'],

  // ── 3rd-party GSDML (catch-all) ──────────────────────────────────────────
  [/^GSDML/i,               'GSDML'],

  // ── Internal PCS7 pseudo-order strings ───────────────────────────────────
  [/^DEFAULT:/,             'ET200SP'],   // port submodule default entries
  [/^V\d+_\d+:/,            'ET200SP'],   // versioned pseudo-order (e.g. "V1_1:6ES7...")
  [/^_S7H_HSP/,             'ET200SP'],   // PCS7 internal interface blocks
];

function deriveFamily(orderNo) {
  // Strip leading version prefix like "V1_1:" or "DEFAULT:" before matching
  const bare = orderNo.replace(/^(?:DEFAULT:|V\d+_\d+:)/, '');
  for (const [re, family] of FAMILY_RULES) {
    if (re.test(bare) || re.test(orderNo)) return family;
  }
  return 'Unknown';
}

// ── Signal type derivation from address bytes ──────────────────────────────────
function deriveSignalType(inBytes, outBytes) {
  if (inBytes > 0 && outBytes > 0) return 'MIXED';
  if (inBytes > 0) return 'AI';   // could be DI; caller may override from display_name hints
  if (outBytes > 0) return 'AO';  // could be DO
  return 'INFRA';
}

// Refine AI/AO guesses using the display_name (module label from the .cfg)
function refineSignalType(signalType, label) {
  if (!label) return signalType;
  const l = label.toUpperCase();
  // DI/DQ labels start with "DI" or contain " DI " — match prefix too (e.g. "DI16 x 24VDC")
  if (signalType === 'AI' && /^DI\d|[^A-Z]DI[^A-Z]/.test(l)) return 'DI';
  if (signalType === 'AO' && (/^DQ\d|^DO\d|[^A-Z]DQ|[^A-Z]DO[^A-Z]/).test(l)) return 'DO';
  return signalType;
}

// Build {{addr}} format string from a length.
// PCS7 ADDRESS line: start_byte, bit_offset, length, pip, consistency, update
// We preserve all fields except start_byte which becomes {{addr}}.
function addrFmt(fields) {
  // fields is the raw comma-separated string after "ADDRESS"
  // e.g. "512, 0, 8, 0, 0, 32"
  const parts = fields.split(',').map(s => s.trim());
  if (parts.length < 3) return null;
  // Replace start_byte with {{addr}}, keep the rest
  parts[0] = '{{addr}}';
  return parts.join(', ');
}

// ── Scalance GSDML device detection ──────────────────────────────────────────
// Detects GSDML-referenced IOSUBSYSTEM devices (e.g. SCALANCE switches) that are
// identified by a GSDML XML path rather than a Siemens order number.
// Returns a Map<ioAddress, { gsdmlPath, gsdmlFile, dapId, version, name, mlfb, ports[], vendorId, deviceId, minVersion }>
function extractScalanceDevices(lines) {
  const devices = new Map(); // ioAddress → device record
  let i = 0;

  while (i < lines.length) {
    const l = lines[i].trimEnd();

    if (!/^IOSUBSYSTEM\s+\d+,\s*IOADDRESS\s+\d+/.test(l)) { i++; continue; }

    const ioAddrM = l.match(/\bIOADDRESS\s+(\d+)/i);
    const slotM   = l.match(/\bSLOT\s+(\d+)/i);
    const ssM     = l.match(/\bSUBSLOT\s+(\d+)/i);
    const ioAddr  = ioAddrM ? parseInt(ioAddrM[1], 10) : null;

    // Extract all quoted strings from the header line
    const quoted = [];
    const qRe = /"([^"]*)"/g; let qm;
    while ((qm = qRe.exec(l)) !== null) quoted.push(qm[1]);
    const orderNo = quoted[0] || '';

    // Only care about GSDML-path devices (order_no starts with "GSDML")
    if (!/^GSDML/i.test(orderNo) || ioAddr === null) { i++; continue; }

    // Parse the GSDML path: "GSDML-V2.42-...-SCALANCE_XC200-20230619.xml<DAP 87>EXTENDED"
    // → gsdmlFile = "GSDML-V2.42-...-SCALANCE_XC200-20230619.xml", dapId = "87"
    const gsdmlBase  = orderNo.replace(/EXTENDED$/i, '').replace(/<DAP\s*\d+>/i, '').trim();
    const gsdmlFileM = gsdmlBase.match(/(GSDML[^<]+\.xml)/i);
    const gsdmlFile  = gsdmlFileM ? gsdmlFileM[1] : gsdmlBase;
    const dapM       = orderNo.match(/<DAP\s*(\d+)>/i);
    const dapId      = dapM ? dapM[1] : null;
    const gsdmlPath  = dapId ? `${gsdmlFile}<DAP ${dapId}>` : gsdmlFile;

    const version = (quoted.length >= 3 && /^V\d/i.test(quoted[1])) ? quoted[1] : null;
    const devName = quoted[quoted.length - 1] || '';

    // Collect body lines
    i++;
    const bodyLines = [];
    let depth = 0;
    while (i < lines.length) {
      const bl = lines[i].trimEnd();
      if (/\bBEGIN\b/.test(bl)) depth++;
      if (/^\s*END\b/.test(bl)) { if (depth <= 1) { i++; break; } depth--; }
      bodyLines.push(bl); i++;
    }

    // ── Case 1: No SLOT — this is the device-level header block ──────────────
    if (!slotM && !ssM) {
      // Extract device-level properties from body (PN_VENDOR_ID, PN_DEVICE_ID, etc.)
      const vendorIdM  = bodyLines.join('\n').match(/PN_VENDOR_ID\s+"(\w+)"/);
      const deviceIdM  = bodyLines.join('\n').match(/PN_DEVICE_ID\s+"(\w+)"/);
      const minVerM    = bodyLines.join('\n').match(/PN_MIN_VERSION\s+"([^"]+)"/);
      const hwRelM     = bodyLines.join('\n').match(/PN_HW_RELEASE\s+"([^"]+)"/);
      const swRelM     = bodyLines.join('\n').match(/PN_SW_RELEASE\s+"([^"]+)"/);
      if (!devices.has(ioAddr)) devices.set(ioAddr, { gsdmlPath, gsdmlFile, dapId, version, name: devName, mlfb: null, ports: [],
        vendorId: vendorIdM ? vendorIdM[1] : null, deviceId: deviceIdM ? deviceIdM[1] : null,
        minVersion: minVerM ? minVerM[1] : null, hwRelease: hwRelM ? hwRelM[1] : null,
        swRelease: swRelM ? swRelM[1] : null });
      continue;
    }

    // ── Case 2: SLOT 0 (no subslot) — device DAP, contains MLFB ─────────────
    if (slotM && parseInt(slotM[1], 10) === 0 && !ssM) {
      const mlfbM = bodyLines.join('\n').match(/MLFB\s+"([^"]+)"/);
      if (mlfbM) {
        if (!devices.has(ioAddr)) devices.set(ioAddr, { gsdmlPath, gsdmlFile, dapId, version, name: devName, mlfb: null, ports: [],
          vendorId: null, deviceId: null, minVersion: null, hwRelease: null, swRelease: null });
        devices.get(ioAddr).mlfb = mlfbM[1];
      }
      continue;
    }

    // ── Case 3: SLOT 0, SUBSLOT N — port subslot entries ─────────────────────
    if (slotM && parseInt(slotM[1], 10) === 0 && ssM) {
      const ssNo    = parseInt(ssM[1], 10);
      const portName = devName; // e.g. "Port 1 - RJ45", "PN-IO"

      if (!devices.has(ioAddr)) devices.set(ioAddr, { gsdmlPath, gsdmlFile, dapId, version, name: '', mlfb: null, ports: [],
        vendorId: null, deviceId: null, minVersion: null, hwRelease: null, swRelease: null });
      const dev = devices.get(ioAddr);

      // Detect port type: PN-IO interface or physical port
      const isInterface = orderNo.startsWith('_S7H_');
      let medium = null;
      if (!isInterface) {
        // Derive medium from port name: "Port N - RJ45" → "RJ45", "Port N - FO" → "FO"
        const medM = portName.match(/[-–]\s*(RJ45|FO|SFP|LC|SC|MT-RJ)/i);
        medium = medM ? medM[1].toUpperCase() : 'RJ45';
      }

      dev.ports.push({ subslot: ssNo, name: portName, type: isInterface ? 'interface' : 'port',
        medium, orderNo });
      continue;
    }

    // Other SLOT entries (slot ≠ 0) — not relevant for Scalance
  }

  return devices;
}

// ── Main par───────────────────────────────────────────────────────
function parseCfgForCatalogue(text) {
  const lines = text.split(/\r?\n/);

  // ── Pre-pass: extract GSDML Scalance device records ──────────────────────────
  const scalanceDevices = extractScalanceDevices(lines);

  // Collect all IOSUBSYSTEM IOADDRESS blocks (device heads + slot cards).
  // Each candidate block: { header_line, body_lines[] }
  const blocks = [];
  // Tracks the highest SUBSLOT number seen for each (ioAddress, slot) pair.
  // The last (highest) subslot is the service module — subslot_no - 1 = function count.
  // Key: "<ioAddress>:<slotNo>", value: highest subslot number seen.
  const maxSubslotByKey = new Map();
  // Tracks every function subslot's order_no for each (ioAddress, slot) pair.
  // Key: "<ioAddress>:<slotNo>", value: Map<ssNo (number), orderNo (string)>
  // The entry at maxSubslotByKey[key] is the service module (excluded from defaults);
  // all others are configurable function subslots used to build subslot_defaults[].
  const funcSubslotsByKey = new Map();
  // Tracks SLOT 0 port subslots per ioAddress (for ET200 / non-Scalance devices).
  // Key: ioAddress (number), value: [{ subslot, name, orderNo }, ...]
  // Subslot 1 = PN-IO interface; subslot ≥ 2 = physical ports.
  const imPortsByAddr = new Map();
  let i = 0;

  while (i < lines.length) {
    const l = lines[i].trimEnd();

    // Match: IOSUBSYSTEM <no>, IOADDRESS <addr>[, SLOT <s>[, SUBSLOT <ss>]], "<orderNo>", "<label>"
    if (/^IOSUBSYSTEM\s+\d+,\s*IOADDRESS\s+\d+/.test(l)) {
      const ssm = l.match(/\bSUBSLOT\s+(\d+)/i);
      const ssNo = ssm ? parseInt(ssm[1], 10) : null;

      // SUBSLOT 1 = IFACE/device head → keep as background (auto-imported, not shown to user)
      // SUBSLOT ≥ 2 = function subslots + service module → keep as visible candidates
      // No SUBSLOT  = plain IO card in a numbered slot / station head → keep

      // Track highest subslot number per (ioAddress, slot) — used to identify service module
      if (ssNo !== null && ssNo >= 1) {
        const ioAddrMss = l.match(/\bIOADDRESS\s+(\d+)/i);
        const slotMss   = l.match(/\bSLOT\s+(\d+)/i);
        if (ioAddrMss && slotMss) {
          const key  = `${ioAddrMss[1]}:${slotMss[1]}`;
          const prev = maxSubslotByKey.get(key) || 0;
          if (ssNo > prev) maxSubslotByKey.set(key, ssNo);
          // Capture order_no for each function subslot (non-META entries)
          const qSsMss = []; const qReMss = /"([^"]*)"/g; let qmMss;
          while ((qmMss = qReMss.exec(l)) !== null) qSsMss.push(qmMss[1]);
          const ssOrderNo = qSsMss[0] || null;
          if (ssOrderNo && !/^META[/\\]/i.test(ssOrderNo)) {
            if (!funcSubslotsByKey.has(key)) funcSubslotsByKey.set(key, new Map());
            funcSubslotsByKey.get(key).set(ssNo, ssOrderNo);
          }
        }
      }

      // Collect SLOT 0 port subslots (≥2) for non-GSDML ET200 IM modules.
      // SUBSLOT 1 is the PN-IO interface head; SUBSLOT ≥ 2 are physical ports.
      const slotMpre   = l.match(/\bSLOT\s+(\d+)/i);
      const ssNoPre    = ssm ? parseInt(ssm[1], 10) : null;
      const ioAddrMpre = l.match(/\bIOADDRESS\s+(\d+)/i);
      if (slotMpre && parseInt(slotMpre[1], 10) === 0 && ssNoPre !== null && ssNoPre >= 1 && ioAddrMpre) {
        const qsPre = []; const qRePre = /"([^"]*)"/g; let qmPre;
        while ((qmPre = qRePre.exec(l)) !== null) qsPre.push(qmPre[1]);
        const portOrderNo = qsPre[0] || '';
        const portLabel   = qsPre[qsPre.length - 1] || `Port ${ssNoPre}`;
        // Skip GSDML-path entries (handled by extractScalanceDevices) and _S7H_ iface heads
        if (!/^GSDML/i.test(portOrderNo)) {
          const addr = parseInt(ioAddrMpre[1], 10);
          if (!imPortsByAddr.has(addr)) imPortsByAddr.set(addr, []);
          imPortsByAddr.get(addr).push({ subslot: ssNoPre, name: portLabel, orderNo: portOrderNo });
        }
      }

      const headerLine = l;
      const bodyLines = [];
      i++;
      let depth = 0;
      while (i < lines.length) {
        const bl = lines[i].trimEnd();
        if (/\bBEGIN\b/.test(bl)) depth++;
        if (/^\s*END\b/.test(bl)) {
          if (depth <= 1) { i++; break; }
          depth--;
        }
        bodyLines.push(bl);
        i++;
      }
      blocks.push({ headerLine, bodyLines });
      continue;
    }
    i++;
  }

  if (blocks.length === 0) {
    return { error: 'No IOSUBSYSTEM device blocks found in this file.', candidates: [] };
  }

  // ── Parse each block into a candidate ────────────────────────────────────
  const byOrderNo = new Map(); // dedup map: order_no → candidate

  for (const { headerLine, bodyLines } of blocks) {
    try {
      // Header formats:
      //   IOSUBSYSTEM 101, IOADDRESS 1, "6ES7 155-6AU00-0CN0" "V4.2", "ET1"        ← station head (no SLOT)
      //   IOSUBSYSTEM 101, IOADDRESS 1, SLOT 1, "6ES7 134-6HD00-0BA1", "AI1"       ← IO card slot
      //   IOSUBSYSTEM 101, IOADDRESS 1, SLOT 0, SUBSLOT 1, "_S7H_HSP_...", "iface" ← device IFACE head (kept)
      // We want: order_no (1st quoted token), version (2nd quoted if inline with 1st), label (last quoted)

      // Extract all quoted strings from the header
      const quoted = [];
      const qRe = /"([^"]*)"/g;
      let qm;
      while ((qm = qRe.exec(headerLine)) !== null) quoted.push(qm[1]);

      if (quoted.length < 1) continue; // malformed — no order no

      let order_no = quoted[0];
      let version  = null;
      let label    = quoted[quoted.length - 1]; // last quoted = device label

      // IO station address — used by the frontend to group entries from the same station
      const ioAddrM  = headerLine.match(/\bIOADDRESS\s+(\d+)/i);
      const ioAddress = ioAddrM ? parseInt(ioAddrM[1], 10) : 0;

      // Derive a human-readable slot label for the preview UI
      const slotM    = headerLine.match(/\bSLOT\s+(\d+)/i);
      const subslotM = headerLine.match(/\bSUBSLOT\s+(\d+)/i);
      let slotInfo;
      if (slotM && subslotM) {
        slotInfo = `Slot ${slotM[1]} / Subslot ${subslotM[1]}`;
      } else if (slotM) {
        slotInfo = `Slot ${slotM[1]}`;
      } else {
        slotInfo = 'Station head';
      }

      // Version may be a separate quoted token immediately after order_no
      // e.g. "6ES7 155-6AU00-0CN0" "V4.2" — two adjacent quoted strings before comma+label
      if (quoted.length >= 3) {
        // quoted[0]=orderNo, quoted[1]=version, quoted[last]=label
        const maybeVer = quoted[1];
        if (/^V\d+/i.test(maybeVer)) version = maybeVer;
      } else if (quoted.length === 2 && quoted[0] !== quoted[1]) {
        // quoted[0]=orderNo, quoted[1]=label (no version)
      }

      // Skip if order_no is suspiciously empty or internal
      if (!order_no || order_no.length < 4) continue;

      // Skip GSDML-path blocks that belong to a detected Scalance device — those are
      // handled by extractScalanceDevices() and injected as a single 'Scalance' candidate.
      if (/^GSDML/i.test(order_no)) {
        const ioAddrN = ioAddrM ? parseInt(ioAddrM[1], 10) : null;
        if (ioAddrN !== null && scalanceDevices.has(ioAddrN)) continue;
      }

      // ── Parse the block body ──────────────────────────────────────────────
      const body = bodyLines.join('\n');

      // LOCAL_IN_ADDRESSES / LOCAL_OUT_ADDRESSES → extract ADDRESS line
      let inAddrFields  = null;
      let outAddrFields = null;
      let inContext  = false;
      let outContext = false;

      // PARAMETER block lines (collect all, excluding instance-specific stuff)
      // COMMENT lines are kept only if they carry a "family:XXX" override tag.
      const PARAM_SKIP = /ASSET_ID|POS_X|POS_Y|SIZE_X|SIZE_Y|CREATOR|CAX_APP|IPADDRESS|MACADDRESS|IOADDRESS|DIAGNOSTICS_ADDRESS/i;
      const paramLines = [];
      let inParam = false;
      let commentFamily = null; // family extracted from COMMENT, "family:XXX"

      for (const bl of bodyLines) {
        const t = bl.trim();

        if (t === 'LOCAL_IN_ADDRESSES')  { inContext = true;  outContext = false; inParam = false; continue; }
        if (t === 'LOCAL_OUT_ADDRESSES') { outContext = true; inContext = false;  inParam = false; continue; }
        if (t === 'PARAMETER')           { inParam = true; inContext = false; outContext = false; continue; }
        if (t === '' || /^END\b/.test(t) || /^LOCAL_/.test(t)) {
          inContext = false; outContext = false;
          if (/^END\b/.test(t)) inParam = false;
        }

        if (inContext || outContext) {
          const am = t.match(/^ADDRESS\s+(.+)/);
          if (am) {
            if (inContext  && !inAddrFields)  inAddrFields  = am[1].trim();
            if (outContext && !outAddrFields) outAddrFields = am[1].trim();
          }
        }

        if (inParam && t) {
          // Check for family override tag in COMMENT before deciding to skip
          const cm = t.match(/^COMMENT\s*,\s*"([^"]*)"/i);
          if (cm) {
            const fm = cm[1].match(/family\s*:\s*(\S+)/i);
            if (fm) commentFamily = fm[1].trim();
            // Don't emit COMMENT lines into param_template
            continue;
          }
          if (!PARAM_SKIP.test(t) && !/^BEGIN\b/.test(t)) {
            paramLines.push('  ' + t);
          }
        }
      }

      // Derive address lengths from fields (3rd comma-separated field)
      function lengthFrom(fields) {
        if (!fields) return 0;
        const parts = fields.split(',');
        return parts.length >= 3 ? (parseInt(parts[2].trim(), 10) || 0) : 0;
      }

      const input_bytes  = lengthFrom(inAddrFields);
      const output_bytes = lengthFrom(outAddrFields);
      const in_addr_fmt  = inAddrFields  ? addrFmt(inAddrFields)  : null;
      const out_addr_fmt = outAddrFields ? addrFmt(outAddrFields) : null;

      // For CFU_PA slot entries (META\... GSD paths), derive function_count and subslot_defaults.
      // The service module is the highest-numbered subslot; all others are configurable functions.
      // subslot_defaults: [{ssNo, paProfile}, ...] — one entry per function subslot (excluding service).
      // e.g. Transmitter: service at SS 2 → 1 function (SS 1); Analyzer: service at SS 33 → 32 functions (SS 1..32).
      let channel_count = 0;
      let subslot_defaults = null;
      if (slotM && /^META[/\\]/i.test(order_no)) {
        const compatKey  = `${ioAddress}:${slotM[1]}`;
        const servicePos = maxSubslotByKey.get(compatKey) || 0;
        if (servicePos > 1) channel_count = servicePos - 1;
        const ssMap = funcSubslotsByKey.get(compatKey);
        if (ssMap && ssMap.size > 0) {
          const entries = [];
          for (const [ssNo, paProfile] of ssMap) {
            if (ssNo !== servicePos) entries.push({ ssNo, paProfile });
          }
          entries.sort((a, b) => a.ssNo - b.ssNo);
          if (entries.length > 0) subslot_defaults = JSON.stringify(entries);
        }
      }

      let signal_type = deriveSignalType(input_bytes, output_bytes);
      signal_type = refineSignalType(signal_type, label);

      // GSD-path PROFIBUS PA transmitter slots (META\...) are always PA signal type,
      // regardless of byte count heuristics which incorrectly classify them as AI.
      if (/^META[/\\]/i.test(order_no)) signal_type = 'PA';

      // Family: COMMENT override > order-number derivation
      const derivedFamily = deriveFamily(order_no);
      const family = commentFamily || derivedFamily;
      const familySource = commentFamily ? 'comment' : (derivedFamily === 'Unknown' ? 'unknown' : 'auto');

      const param_template = paramLines.length > 0 ? paramLines.join('\n') : null;
      const display_name = label || order_no;

      const subslotNo = subslotM ? parseInt(subslotM[1], 10) : null;

      // Determine if this subslot is the service module (highest-numbered subslot for this slot).
      // Service modules are infrastructure-only (AUTOCREATED in PCS7) — not user-importable.
      let isServiceModule = false;
      if (slotM && subslotNo !== null && subslotNo >= 1) {
        const compatKey  = `${ioAddress}:${slotM[1]}`;
        const servicePos = maxSubslotByKey.get(compatKey) || 0;
        // Only mark as service module if there are multiple subslots (servicePos > 1),
        // meaning this is truly the highest = AUTOCREATED one; single-subslot slots are not service modules.
        if (servicePos > 1 && subslotNo === servicePos) isServiceModule = true;
      }

      // SUBSLOT 1 IFACE infrastructure heads have order_no starting with "_S7H_".
      // These are auto-imported alongside their parent and hidden from the user preview.
      // Plain PA profile types appearing at SUBSLOT 1 (e.g. "Analog Input (AI)long") are
      // real function subslots — they should be visible and importable independently.
      const isIfaceHead = !!(slotM && subslotNo === 1 && order_no.startsWith('_S7H_'));

      let hw_category;
      if (subslotNo !== null) {
        hw_category = 'subslot';
      } else if (slotM) {
        hw_category = 'slot';
      } else {
        hw_category = 'station';
      }

      // For station-head entries (hw_category === 'station'), attach any SLOT 0 port subslots
      // collected in the pre-pass so the template can display port sub-rows in the UI.
      // Only applies to non-GSDML (ET200/CFU) IM modules; Scalance gets port_config via extractScalanceDevices.
      let port_config = null;
      if (hw_category === 'station' && !(/^GSDML/i.test(order_no))) {
        const imPorts = imPortsByAddr.get(ioAddress);
        if (imPorts && imPorts.length > 0) {
          const sorted = [...imPorts].sort((a, b) => a.subslot - b.subslot);
          port_config = JSON.stringify(sorted);
        }
      }

      const candidate = {
        order_no,
        version: version || null,
        display_name,
        family,
        familySource,  // 'auto' | 'comment' | 'unknown' — used by frontend to show edit hint
        signal_type,
        input_bytes,
        output_bytes,
        in_addr_fmt,
        out_addr_fmt,
        param_template,
        channel_count,
        subslot_defaults, // CFU_PA slot only: JSON array [{ssNo,paProfile},...] from CFG — null for all others
        port_config,   // ET200/CFU station heads: JSON [{subslot, name, orderNo},...] — null otherwise
        slotInfo,      // e.g. "Slot 1", "Station head", "Slot 3 / Subslot 2" — for display only
        ioAddress,     // numeric IO station address — used to group entries in the import UI
        hw_category,   // 'station' | 'slot' | 'subslot'
        subslotNo,     // null for non-subslot entries; 1-based subslot number otherwise
        // SUBSLOT 1 _S7H_ IFACE heads: hidden from preview, auto-imported alongside their parent slot.
        // Plain PA profile types at SUBSLOT 1 (e.g. "Analog Input (AI)long") are visible function subslots.
        isBackground: isIfaceHead,
        // Service modules (highest-numbered subslot = AUTOCREATED diagnostic block): excluded entirely
        isServiceModule,
        parseError: null,
      };

      // Service modules are AUTOCREATED infrastructure — never import them
      if (isServiceModule) continue;

      // Dedup by order_no — one row per unique type regardless of how many slots use it.
      // For visible subslots (SUBSLOT ≥ 2), the same type (e.g. "Analog Input (AI)short")
      // may appear in many slots; show it once only.
      if (byOrderNo.has(order_no)) {
        const existing = byOrderNo.get(order_no);
        // Prefer the entry that has address info
        if ((input_bytes > 0 || output_bytes > 0) &&
            existing.input_bytes === 0 && existing.output_bytes === 0) {
          byOrderNo.set(order_no, candidate);
        }
      } else {
        byOrderNo.set(order_no, candidate);
      }
    } catch (e) {
      // One bad block shouldn't abort everything; emit a parse-error candidate
      const hm = headerLine.match(/"([^"]+)"/);
      byOrderNo.set(`__err_${blocks.indexOf({ headerLine })}__${Math.random()}`, {
        order_no: hm ? hm[1] : '(unknown)',
        version: null, display_name: '(parse error)', family: 'Unknown',
        signal_type: null, input_bytes: 0, output_bytes: 0,
        in_addr_fmt: null, out_addr_fmt: null, param_template: null, channel_count: 0,
        parseError: e.message,
      });
    }
  }

  // ── Inject Scalance GSDML device candidates ──────────────────────────────────
  // One catalogue entry per unique MLFB (order number). The GSDML path + port_config
  // are stored as template metadata so the CFG generator can reconstruct the full block.
  for (const [, dev] of scalanceDevices) {
    if (!dev.mlfb) continue; // no MLFB found — skip incomplete records

    const order_no = dev.mlfb;
    if (byOrderNo.has(order_no)) continue; // already seen (multi-instance in same CFG)

    dev.ports.sort((a, b) => a.subslot - b.subslot);
    const portCount = dev.ports.filter(p => p.type === 'port').length;
    const portConfig = dev.ports.length > 0 ? JSON.stringify(dev.ports) : null;
    const paramMeta = JSON.stringify({
      PN_VENDOR_ID: dev.vendorId, PN_DEVICE_ID: dev.deviceId,
      PN_MIN_VERSION: dev.minVersion, PN_HW_RELEASE: dev.hwRelease, PN_SW_RELEASE: dev.swRelease,
    });

    byOrderNo.set(order_no, {
      order_no,
      version:       dev.version || null,
      display_name:  dev.name.replace(/-/g, ' ').trim() || order_no,
      family:        'Scalance',
      familySource:  'auto',
      signal_type:   null,
      input_bytes:   0,
      output_bytes:  0,
      in_addr_fmt:   null,
      out_addr_fmt:  null,
      param_template: paramMeta,
      channel_count: portCount,
      subslot_defaults: null,
      port_config:   portConfig,
      gsdml_file:    dev.gsdmlFile || null,
      dap_id:        dev.dapId || null,
      hw_category:   'station',
      slotInfo:      'Station head',
      ioAddress:     0,
      subslotNo:     null,
      isBackground:  false,
      isServiceModule: false,
      parseError:    null,
    });
  }

  return { error: null, candidates: [...byOrderNo.values()] };
}

module.exports = { parseCfgForCatalogue, deriveFamily };
