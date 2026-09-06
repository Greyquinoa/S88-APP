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
  if (st === 'AI' || st === 'AO' || st === 'PA') return true;
  // IB (Input Byte) and QB (Output Byte) are byte-oriented single-direction types
  // that live in the analog address space, same as AI/AO. They differ only in their
  // default SYMBOL identifier (IB / QB instead of IW / QW).
  if (st === 'IB' || st === 'QB') return true;
  // MIXED only means "has both input and output bytes" (see cfgCatalogueParser's
  // deriveSignalType) — it covers two unrelated shapes. A card with no declared
  // datatype is bit-packed digital (DIQ8) and belongs in the digital image; one
  // that declares a byte/word datatype (e.g. an IO-Link byte port) is word-
  // oriented and belongs in the analog image alongside AI/AO.
  if (st === 'MIXED' && tpl && tpl.default_datatype) return true;
  return false;
}

/**
 * Default SYMBOL-line address identifiers for a card, scoped by direction.
 * Returns { in, out } where each is the PCS7 identifier string (or null when the
 * direction is not used by that signal type). These are catalogue DEFAULTS — a card
 * may override either via hw_module_templates.in_identifier / .out_identifier.
 *
 *   DI    → I  / —      AI  → IW / —
 *   DO    → — / Q       AO  → — / QW
 *   IB    → IB / —      QB  → — / QB  (byte-oriented, analog space, no word alignment)
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
    case 'IB': return { in: 'IB', out: null };
    case 'QB': return { in: null, out: 'QB' };
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
 * sequential packing strategy. Allocation is SCOPED PER CONTROLLER — each controller
 * has independent address cursors that start fresh and reset when moving to a new controller.
 *
 * Stations are grouped by controller; within each controller, they are ordered by
 * ascending IOADDRESS, and slots by ascending slot number.
 *
 * Four independent cursors per controller (pointers):
 *   digIn  — digital input space  (starts at 0, or after baseline max)
 *   digOut — digital output space (starts at 0, or after baseline max)
 *   anaIn  — analog input space   (starts at 512, or after baseline max)
 *   anaOut — analog output space  (starts at 512, or after baseline max)
 *
 * Each cursor advances by exactly tpl.input_bytes / tpl.output_bytes with NO
 * alignment padding between modules — strict sequential packing.
 *
 * @param {Map}    stations     - Map<stationAddr, {slots: Map<slotNo, slot>, controllerId: number|null}>
 * @param {Map}    templateMap  - Map<orderNo, template>
 * @param {number} baseInput    - highest existing digital/analog input byte in baseline (-1 if none)
 * @param {number} baseOutput   - highest existing digital/analog output byte in baseline (-1 if none)
 * @param {Map}    controllerMap - Map<controllerId, {baseInput, baseOutput}> per-controller baseline offsets (optional; if absent, all use global baseline)
 *
 * Enriches each slot object in-place with:
 *   slot.inputAddr   {number|null}
 *   slot.outputAddr  {number|null}
 */
/**
 * Allocate process image addresses to a slot's subslot children, in ascending
 * position order, from the same per-controller cursors the slot loop uses.
 *
 * Enriches each entry of slot.subslots in-place with inputAddr / outputAddr
 * (null when that direction carries no bytes). The child's profile — whatever
 * the station actually has plugged into that position — supplies the byte
 * counts, so this is family-free: any catalogued subslot with input_bytes /
 * output_bytes participates, and one with neither is skipped entirely.
 */
function allocateSubslotAddresses(slot, templateMap, ptr) {
  if (!slot.subslots || slot.subslots.length === 0) return;
  const ordered = [...slot.subslots]
    .filter(ss => ss && ss.subslotNo != null)
    .sort((a, b) => a.subslotNo - b.subslotNo);

  for (const ss of ordered) {
    const profile = ss.paProfile || ss.childOrderNo || null;
    const tpl = profile ? findTemplate(templateMap, profile) : null;
    ss.inputAddr = null;
    ss.outputAddr = null;
    if (!tpl) continue;

    const analog = isAnalog(tpl);
    const inBytes  = tpl.input_bytes  || 0;
    const outBytes = tpl.output_bytes || 0;

    if (inBytes > 0) {
      const key = analog ? 'anaIn' : 'digIn';
      ss.inputAddr = ptr[key];
      ptr[key] += inBytes;
    }
    if (outBytes > 0) {
      const key = analog ? 'anaOut' : 'digOut';
      ss.outputAddr = ptr[key];
      ptr[key] += outBytes;
    }
  }
}

function allocateAddresses(stations, templateMap, baseInput, baseOutput, controllerMap) {
  // Group stations by controller. If no station has a controllerId, treat all as one group.
  const stationsByController = new Map();
  let hasControllerIds = false;

  for (const [stAddr, station] of stations) {
    const ctrlId = station.controllerId != null ? station.controllerId : null;
    if (ctrlId != null) hasControllerIds = true;
    if (!stationsByController.has(ctrlId)) {
      stationsByController.set(ctrlId, []);
    }
    stationsByController.get(ctrlId).push({ addr: stAddr, station });
  }

  // If no controller IDs were found, treat all stations as a single controller group.
  // This preserves backward compatibility with single-controller imports.
  if (!hasControllerIds) {
    stationsByController.clear();
    const allStations = [];
    for (const [stAddr, station] of stations) {
      allStations.push({ addr: stAddr, station });
    }
    stationsByController.set(null, allStations);
  }

  // Process each controller group independently
  for (const [controllerId, stationList] of stationsByController) {
    // Determine starting cursors from baseline high-water marks (per-controller if provided).
    // Digital space starts at 0 (after any existing digital bytes).
    // Analog space starts at ANALOG_BASE, but advances if the baseline already
    // used analog addresses (baseInput/baseOutput >= ANALOG_BASE).
    let ctrlBaseInput = baseInput;
    let ctrlBaseOutput = baseOutput;
    if (controllerMap && controllerId != null && controllerMap.has(controllerId)) {
      const ctrlBase = controllerMap.get(controllerId);
      ctrlBaseInput = ctrlBase.baseInput ?? baseInput;
      ctrlBaseOutput = ctrlBase.baseOutput ?? baseOutput;
    }

    const ptr = {
      digIn:  ctrlBaseInput  >= 0 && ctrlBaseInput  < ANALOG_BASE ? ctrlBaseInput  + 1 : 0,
      digOut: ctrlBaseOutput >= 0 && ctrlBaseOutput < ANALOG_BASE ? ctrlBaseOutput + 1 : 0,
      anaIn:  ctrlBaseInput  >= ANALOG_BASE ? ctrlBaseInput  + 1 : ANALOG_BASE,
      anaOut: ctrlBaseOutput >= ANALOG_BASE ? ctrlBaseOutput + 1 : ANALOG_BASE,
    };

    // Ensure digital cursors start on an even boundary (PCS7 requirement at base).
    if (ptr.digIn  % 2 !== 0) ptr.digIn++;
    if (ptr.digOut % 2 !== 0) ptr.digOut++;

    // Sort stations within this controller group by address
    const sortedStations = stationList.sort((a, b) => a.addr - b.addr);

    for (const { station } of sortedStations) {
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
          // A slot whose own module carries no process image (e.g. an IO-Link
          // master: signal_type INFRA, 0 bytes) can still hold subslot children
          // that each do. Those children are the addressable units, so allocate
          // per subslot from the same cursors, in ascending position order —
          // driven purely by each child profile's own catalogue bytes, no
          // per-family knowledge. Runs before the slot's own allocation below so
          // a slot that has both keeps subslots ahead of it, matching print order.
          allocateSubslotAddresses(slot, templateMap, ptr);
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
