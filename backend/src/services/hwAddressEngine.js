// services/hwAddressEngine.js — Allocate process image addresses to HW modules
'use strict';

// PCS7 process image layout:
//   Digital (binary) modules: byte space starting at 0
//   Analog/PA modules:        byte space starting at ANALOG_BASE (512)
//   Diagnostic addresses:     ≥ 16000 (count downward, handled by cfgGenerator)
//
// Address packing is STRICTLY SEQUENTIAL — no natural alignment padding between
// consecutive modules. PCS7 itself places modules back-to-back:
//   next_start = previous_start + previous_length
//
// The only time alignment occurs is at the BASE (start of a new space), where
// PCS7 begins on an even boundary. Once packing starts, no gaps are inserted.
const ANALOG_BASE = 512;
const DIAG_BASE   = 16000; // addresses >= this are diagnostic, never process image

/** True when this template's bytes live in the analog (≥ 512) process image. */
function isAnalog(tpl) {
  const st = (tpl && tpl.signal_type ? String(tpl.signal_type) : '').toUpperCase();
  return st === 'AI' || st === 'AO' || st === 'PA';
}

/**
 * Default SYMBOL-line address identifiers for a card, scoped by direction.
 * Returns { in, out } where each is the PCS7 identifier string (or null when the
 * direction is not used by that signal type). These are catalogue DEFAULTS — a card
 * may override either via hw_module_templates.in_identifier / .out_identifier.
 *
 *   DI    → I  / —      AI  → IW / —
 *   DO    → — / Q       AO  → — / QW
 *   MIXED → I  / Q   (DIQ8: DI channels on input, DO channels on output)
 *   PA    → I  / Q   (CFU_PA transmitter telegrams)
 *   INFRA / unknown → — / —
 */
function defaultIdentifiers(signalType) {
  const st = (signalType ? String(signalType) : '').toUpperCase();
  switch (st) {
    case 'DI': return { in: 'I',  out: null };
    case 'DO': return { in: null, out: 'Q'  };
    case 'AI': return { in: 'IW', out: null };
    case 'AO': return { in: null, out: 'QW' };
    case 'MIXED': return { in: 'I', out: 'Q' };
    case 'PA':    return { in: 'I', out: 'Q' };
    default:      return { in: null, out: null };
  }
}

/**
 * Fallback template for GSD-referenced PA device profiles (META\...\... paths).
 * These are PROFIBUS PA transmitter slots. The byte length is fixed per GSD module
 * identifier (Kennung) — we default to 5 bytes for the "AI short" profile.
 *
 * The golden CFG shows:
 *   "Analog Input (AI)short" → 5 bytes  (Kennung 148, 0x94)
 *   "Analog Input (AI)long"  → 5 bytes  (Kennung 66,  0x42)
 *   "SP (short)"             → 5 bytes  (Kennung 164, 0xA4)
 *
 * All common PA profiles use 5-byte input telegrams. If a template is found in
 * the catalogue, its input_bytes value takes precedence.
 */
const PA_GSD_FALLBACK_BYTES = 5;


/**
 * Allocate process image byte addresses for all new stations, replicating PCS7's
 * sequential packing strategy. Allocation is GLOBAL across the entire import —
 * stations ordered by ascending IOADDRESS, slots by ascending slot number.
 *
 * Four independent cursors (pointers):
 *   digIn  — digital input space  (starts at 0, or after baseline max)
 *   digOut — digital output space (starts at 0, or after baseline max)
 *   anaIn  — analog input space   (starts at 512, or after baseline max)
 *   anaOut — analog output space  (starts at 512, or after baseline max)
 *
 * Each cursor advances by exactly tpl.input_bytes / tpl.output_bytes with NO
 * alignment padding between modules — strict sequential packing.
 *
 * @param {Map}    stations    - Map<stationAddr, {slots: Map<slotNo, slot>}>
 * @param {Map}    templateMap - Map<orderNo, template>
 * @param {number} baseInput   - highest existing digital/analog input byte in baseline (-1 if none)
 * @param {number} baseOutput  - highest existing digital/analog output byte in baseline (-1 if none)
 *
 * Enriches each slot object in-place with:
 *   slot.inputAddr   {number|null}
 *   slot.outputAddr  {number|null}
 */
function allocateAddresses(stations, templateMap, baseInput, baseOutput) {
  // Determine starting cursors from baseline high-water marks.
  // Digital space starts at 0 (after any existing digital bytes).
  // Analog space starts at ANALOG_BASE, but advances if the baseline already
  // used analog addresses (baseInput/baseOutput >= ANALOG_BASE).
  const ptr = {
    digIn:  baseInput  >= 0 && baseInput  < ANALOG_BASE ? baseInput  + 1 : 0,
    digOut: baseOutput >= 0 && baseOutput < ANALOG_BASE ? baseOutput + 1 : 0,
    anaIn:  baseInput  >= ANALOG_BASE ? baseInput  + 1 : ANALOG_BASE,
    anaOut: baseOutput >= ANALOG_BASE ? baseOutput + 1 : ANALOG_BASE,
  };

  // Ensure digital cursors start on an even boundary (PCS7 requirement at base).
  if (ptr.digIn  % 2 !== 0) ptr.digIn++;
  if (ptr.digOut % 2 !== 0) ptr.digOut++;

  const sortedAddrs = [...stations.keys()].sort((a, b) => a - b);

  for (const stationAddr of sortedAddrs) {
    const station = stations.get(stationAddr);
    const sortedSlots = [...station.slots.keys()].sort((a, b) => a - b);

    for (const slotNo of sortedSlots) {
      // Slot 0 = station head (IM / ethernet head) — no process image bytes.
      if (slotNo === 0) continue;

      const slot = station.slots.get(slotNo);
      const tpl  = findTemplate(templateMap, slot.orderNo);

      // Resolve byte counts. If no template, check for GSD PA fallback.
      let inBytes  = 0;
      let outBytes = 0;
      let analog   = false;
      let inFmt    = null;
      let outFmt   = null;

      if (tpl && tpl.signal_type === 'PA' && (tpl.input_bytes || 0) === 0 && isGsdPaPath(slot.orderNo)) {
        // GSD-referenced PA device slot (META\...): bytes come from per-subslot profile assignments.
        // Each function subslot (1..channel_count) gets its own address block.
        const funcCount = (tpl.channel_count || 0) > 0 ? tpl.channel_count : 1;
        const ssMap = new Map((slot.subslots || []).map(ss => [ss.subslotNo, ss.paProfile]));
        analog = true;
        slot.subslotAddrs = [];
        for (let ssNo = 1; ssNo <= funcCount; ssNo++) {
          const profile  = ssMap.get(ssNo) || slot.paProfile || null;
          const pTpl     = profile ? templateMap.get(profile) : null;
          const ssBytes  = pTpl ? (pTpl.input_bytes || PA_GSD_FALLBACK_BYTES) : PA_GSD_FALLBACK_BYTES;
          const ssAddr   = ptr.anaIn;
          ptr.anaIn += ssBytes;
          inBytes   += ssBytes;
          slot.subslotAddrs.push({ subslotNo: ssNo, inputAddr: ssAddr, bytes: ssBytes });
        }
      } else if (tpl) {
        // Standard module: multiply template bytes by channel_count for multi-channel PA slots.
        const funcCount = (isAnalog(tpl) && tpl.signal_type !== 'MIXED' && (tpl.channel_count || 0) > 1)
          ? tpl.channel_count : 1;
        inBytes  = (tpl.input_bytes  || 0) * funcCount;
        outBytes = (tpl.output_bytes || 0) * funcCount;
        analog   = isAnalog(tpl);
        inFmt    = tpl.in_addr_fmt  || null;
        outFmt   = tpl.out_addr_fmt || null;
      } else if (isGsdPaPath(slot.orderNo)) {
        // GSD-referenced PA device with no catalogue template: fallback byte count.
        if (slot.paProfile) {
          const profileTpl = templateMap.get(slot.paProfile);
          inBytes = profileTpl ? (profileTpl.input_bytes || PA_GSD_FALLBACK_BYTES) : PA_GSD_FALLBACK_BYTES;
        } else {
          inBytes = PA_GSD_FALLBACK_BYTES;
        }
        analog  = true;
      }

      if (slot.subslotAddrs) {
        // Per-subslot PA: ptr already advanced inside the loop above.
        // Slot-level inputAddr = first subslot's start address (for display / baseline tracking).
        slot.inputAddr  = slot.subslotAddrs.length > 0 ? slot.subslotAddrs[0].inputAddr : null;
        slot.outputAddr = null;
      } else {
        if (inBytes > 0) {
          const key = analog ? 'anaIn' : 'digIn';
          slot.inputAddr = ptr[key];
          ptr[key] += inBytes;                   // strict sequential, no gap
        } else {
          slot.inputAddr = null;
        }

        if (outBytes > 0) {
          const key = analog ? 'anaOut' : 'digOut';
          slot.outputAddr = ptr[key];
          ptr[key] += outBytes;                  // strict sequential, no gap
        } else {
          slot.outputAddr = null;
        }
      }
    }
  }

  return stations;
}

/**
 * True when an order number looks like a GSD file path for a PROFIBUS PA device.
 * These are expressed as  META\<gsdfile>\<module name>  in PCS7 CFG exports.
 */
function isGsdPaPath(orderNo) {
  if (!orderNo) return false;
  return /^META[/\\]/i.test(orderNo.trim());
}

/**
 * Find a template by order number.
 * Exact match first, then prefix match (handles GSD paths that embed the order string).
 */
function findTemplate(templateMap, orderNo) {
  if (!orderNo) return null;
  const key = orderNo.trim();
  if (templateMap.has(key)) return templateMap.get(key);
  for (const [k, v] of templateMap) {
    if (key.startsWith(k) || k.startsWith(key)) return v;
  }
  return null;
}

module.exports = { allocateAddresses, findTemplate, isAnalog, isGsdPaPath, defaultIdentifiers, ANALOG_BASE };
