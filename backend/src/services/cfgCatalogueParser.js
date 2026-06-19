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

// ── Main par───────────────────────────────────────────────────────
function parseCfgForCatalogue(text) {
  const lines = text.split(/\r?\n/);

  // Collect all IOSUBSYSTEM IOADDRESS blocks (device heads + slot cards).
  // Each candidate block: { header_line, body_lines[] }
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const l = lines[i].trimEnd();

    // Match: IOSUBSYSTEM <no>, IOADDRESS <addr>[, SLOT <s>[, SUBSLOT <ss>]], "<orderNo>", "<label>"
    if (/^IOSUBSYSTEM\s+\d+,\s*IOADDRESS\s+\d+/.test(l)) {
      // Skip SUBSLOT ≥ 2 — these are ethernet ports, secondary interfaces, etc.
      // SUBSLOT 1 = main device/IFACE head → keep.
      // No SUBSLOT  = plain IO card in a numbered slot → keep.
      const ssm = l.match(/\bSUBSLOT\s+(\d+)/i);
      if (ssm && parseInt(ssm[1], 10) >= 2) {
        // Consume the block without storing it
        i++;
        let depth = 0;
        while (i < lines.length) {
          const bl = lines[i].trimEnd();
          if (/\bBEGIN\b/.test(bl)) depth++;
          if (/^\s*END\b/.test(bl)) { if (depth <= 1) { i++; break; } depth--; }
          i++;
        }
        continue;
      }

      const headerLine = l;
      const bodyLines = [];
      i++;
      // Collect up to the matching END (handle nested BEGIN/END)
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

      // Estimate channel count from bytes (rough heuristic for DI/DO = 1ch/bit, AI/AO = 2 or 4 bytes/ch)
      // We leave channel_count as 0 — the user can correct it; we don't have enough info from .cfg alone
      const channel_count = 0;

      let signal_type = deriveSignalType(input_bytes, output_bytes);
      signal_type = refineSignalType(signal_type, label);

      // Family: COMMENT override > order-number derivation
      const derivedFamily = deriveFamily(order_no);
      const family = commentFamily || derivedFamily;
      const familySource = commentFamily ? 'comment' : (derivedFamily === 'Unknown' ? 'unknown' : 'auto');

      const param_template = paramLines.length > 0 ? paramLines.join('\n') : null;
      const display_name = label || order_no;

      const isSubslot1 = !!(slotM && subslotM && parseInt(subslotM[1], 10) === 1);
      let hw_category;
      if (isSubslot1) {
        hw_category = 'subslot';
      } else if (slotM) {
        hw_category = 'slot';
      } else {
        hw_category = 'station';
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
        slotInfo,      // e.g. "Slot 1", "Station head", "Slot 0 / Subslot 1" — for display only
        ioAddress,     // numeric IO station address — used to group entries in the import UI
        hw_category,   // 'station' | 'slot' | 'subslot'
        // Background entries (SUBSLOT 1 IFACE heads) are hidden from the preview list but
        // auto-imported alongside their visible parent station when any sibling row is checked.
        isBackground: isSubslot1,
        parseError: null,
      };

      // Dedup: if same order_no seen before, keep the one with more info (has addresses)
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

  return { error: null, candidates: [...byOrderNo.values()] };
}

module.exports = { parseCfgForCatalogue, deriveFamily };
