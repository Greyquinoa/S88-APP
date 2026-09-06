// services/cfgGenerator.js — Generate a PCS7 STEP7 .cfg file from baseline + station data
'use strict';
const { findTemplate, isGsdPaPath, defaultIdentifiers } = require('./hwAddressEngine');
const { loadStationAutoSlotConfig, buildSlotMap, buildSubslotMap, isSlotAutocreated, isSubslotAutocreated, resolveSlotOrderNo, resolveSubslotOrderNo } = require('./autoSlotResolver');
const blocks = require('./cfgBlocks');

// `templateMap` is a flat Map<order_no, row> and can collide across hw_category
// values for the same order_no (e.g. a GSDML device's own order_no is reused for
// its 'station' head row AND its 'slot' SLOT-0 row). Resolve SLOT 0's own
// identity via a direct, category-filtered query instead, mirroring the pattern
// already used for CFU_PA's head/slot0 resolution.
async function findSlotZeroTemplate(db, orderNo) {
  if (!db || !orderNo) return null;
  return db.prepare(
    `SELECT * FROM hw_module_templates WHERE order_no = ? AND hw_category = 'slot' LIMIT 1`
  ).get(orderNo);
}

// Same collision as findSlotZeroTemplate, for the device-header ('station') row.
// Falls back to the ambiguous templateMap lookup only when no 'station'-category
// row exists at all for this order_no (defensive — every seen catalogue so far
// has one for any order_no used as a device head).
async function findStationTemplate(db, orderNo, templateMap) {
  if (!orderNo) return null;
  if (db) {
    const row = await db.prepare(
      `SELECT * FROM hw_module_templates WHERE order_no = ? AND hw_category = 'station' LIMIT 1`
    ).get(orderNo);
    if (row) return row;
  }
  return findTemplate(templateMap, orderNo);
}

// The generic (non-ET200SP/CFU/Scalance) fallback's SLOT 0 SUBSLOT 1 (PN-IO
// interface) has no per-device HSP name — PCS7 uses one shared, family-agnostic
// order_no for it regardless of which device is plugged. Not device-specific:
// every device on this fallback path (Festo, GSDML, ~100 future devices) uses
// the exact same catalogue row.
const GENERIC_IFACE_ORDER_NO = '_S7H_IO_NORM_INTERFACE_CT';
async function findGenericIfaceTemplate(db) {
  if (!db) return null;
  return db.prepare(
    `SELECT * FROM hw_module_templates WHERE order_no = ? AND hw_category = 'subslot' LIMIT 1`
  ).get(GENERIC_IFACE_ORDER_NO);
}

// Generic SLOT 0 port lookup (ground-truth rule 6's "both ports" case): unlike
// the interface subslot, a port's identity is the device's OWN order_no, not a
// shared literal — so this is keyed per-device, same shape as findSlotZeroTemplate.
async function findSubslotTemplate(db, orderNo) {
  if (!db || !orderNo) return null;
  return db.prepare(
    `SELECT * FROM hw_module_templates WHERE order_no = ? AND hw_category = 'subslot' LIMIT 1`
  ).get(orderNo);
}

/**
 * Resolve the display label for a slot's subslot position.
 *
 * `hw_slot_subslots.label` is denormalized display text captured once — at CFG
 * parse time, or when the position's default was materialized. Changing a
 * position's profile updates its order_no but can leave that cached label
 * describing the *previous* profile, which would then be emitted alongside the
 * new order_no. Detect that generically: a stored label that is some other
 * catalogue subslot's display_name (not this order_no's own) is stale, so the
 * current profile's display_name is used instead. A label PCS7 itself wrote
 * (often truncated, e.g. "IO-Link I/O 1/1 Byte, P~") matches no display_name at
 * all and is therefore preserved verbatim, keeping CFG round-trips lossless.
 */
async function resolveSubslotLabel(db, real, dflt, ssTpl, subslotOrder) {
  const stored = real && real.label ? real.label : null;
  if (stored) {
    if (ssTpl && ssTpl.display_name === stored) return stored;
    const owner = db ? await db.prepare(
      `SELECT order_no FROM hw_module_templates WHERE hw_category='subslot' AND display_name=? LIMIT 1`
    ).get(stored) : null;
    if (!owner || owner.order_no === subslotOrder) return stored;
  }
  if (ssTpl && ssTpl.display_name) return ssTpl.display_name;
  if (dflt) return dflt.port_label || dflt.label || '';
  return stored || '';
}

// A slot ≥1 module's own header, keyed the same way (per-device, hw_category='slot').
async function findSlotModuleTemplate(db, orderNo) {
  if (!db || !orderNo) return null;
  return db.prepare(
    `SELECT * FROM hw_module_templates WHERE order_no = ? AND hw_category = 'slot' LIMIT 1`
  ).get(orderNo);
}

// I/O modules that PCS7 does NOT wrap in a REDUNDANCY block even on an H-station.
const NON_REDUNDANT_ORDERS = new Set([
  '6ES7 135-6TD00-0CA1', // ET200SP AQ4 x I HART
]);

/**
 * Convert dotted-decimal IP string to the 8-char hex format used in .cfg files.
 * "192.168.1.1" → "C0A80101"
 */
function ipToHex(dotted) {
  if (!dotted) return '00000000';
  return dotted.split('.').map(o => {
    const n = parseInt(o, 10);
    return isNaN(n) ? '00' : n.toString(16).padStart(2, '0').toUpperCase();
  }).join('');
}

/**
 * Convert an 8-character hex IP (as found in .cfg IPADDRESS fields) to dotted-decimal.
 * "C0A81B0A" → "192.168.27.10"
 * Returns null if the input is not a valid 8-hex-char string.
 */
function hexToIp(hex) {
  if (!hex || !/^[0-9A-Fa-f]{8}$/.test(hex.trim())) return null;
  const h = hex.trim().toUpperCase();
  return [0, 2, 4, 6]
    .map(i => parseInt(h.slice(i, i + 2), 16))
    .join('.');
}

/** Fill address format string: replace {{addr}} with the numeric byte address. */
function fillAddrFmt(fmt, addr) {
  return fmt.replace(/\{\{addr\}\}/g, String(addr));
}

/**
 * Patch the 4th comma-separated field (process_image_partition) in an ADDRESS line.
 * Input:  "512, 0, 8, 0, 0, 32"
 * Output: "512, 0, 8, 3, 0, 32"  (when pipNo=3)
 * Returns the original string unchanged if pipNo is null/undefined/0.
 */
function patchPip(addressFields, pipNo) {
  if (pipNo == null || pipNo === 0) return addressFields;
  const parts = addressFields.split(',');
  if (parts.length < 4) return addressFields;
  parts[3] = ' ' + String(pipNo);
  return parts.join(',');
}

function deviceName(station) {
  return station.name || `Station_${station.address}`;
}

/**
 * Build SYMBOL lines for one address direction, using the card's configured
 * identifier (I / Q / IW / QW …) verbatim. The identifier is resolved by the
 * caller from the card catalogue (hw_module_templates.in_identifier / .out_identifier),
 * NOT inferred here — this is the single source of truth the feature centralises on.
 *
 * The SYMBOL offset field is expressed in the module's native addressing unit:
 *   - Word/analog modules (≥ 1 byte per channel, e.g. AI4 = 8 bytes / 4 ch = 2):
 *       offset = channel × bytesPerCh  →  0, 2, 4, 6
 *   - Bit/digital modules (< 1 byte per channel, e.g. DI16 = 2 bytes / 16 ch = 0.125):
 *       offset = channel index (the bit position)  →  0, 1, 2, 3 …
 *     Rounding channel × bytesPerCh here would collapse every sub-byte channel to 0.
 *   - bytesPerCh = 0 (MIXED slots pass totalBytes = 0 deliberately): offset stays 0.
 *
 * Only channels with a non-empty tag are emitted.
 */
function buildSymbolLines(identifier, channels, totalBytes, channelCount) {
  if (!channels || channels.length === 0) return [];
  const bytesPerCh = channelCount > 0 ? totalBytes / channelCount : 0;
  const lines = [];
  for (const ch of channels) {
    if (!ch.tag) continue;
    const chIdx = Number(ch.channel) || 0;
    const byteOfs = (bytesPerCh > 0 && bytesPerCh < 1)
      ? chIdx                              // bit-packed digital → channel/bit index
      : Math.round(chIdx * bytesPerCh);    // word/analog → byte offset (0 when bytesPerCh = 0)
    const desc = ch.desc || '';
    lines.push(`SYMBOL  ${identifier} , ${byteOfs}, "${ch.tag}", "${desc}"`);
  }
  return lines;
}

/**
 * Resolve a card's SYMBOL identifier for one direction: the explicit catalogue value
 * wins; otherwise fall back to the signal-type default. When tagged channels exist in
 * a direction but the card has NO explicit identifier for it, record a warning so the
 * user knows generation relied on an inferred value (requirement: don't silently
 * default a possibly-wrong identifier).
 */
function resolveIdentifier(tpl, dir, hasTaggedChannels, warnings, ctx) {
  const explicit = tpl ? (dir === 'in' ? tpl.in_identifier : tpl.out_identifier) : null;
  const fallback = defaultIdentifiers(tpl ? tpl.signal_type : null)[dir];
  const ident = explicit || fallback || (dir === 'in' ? 'I' : 'Q');
  if (!explicit && hasTaggedChannels && warnings && ctx) {
    warnings.push(
      `Station ${ctx.addr} slot ${ctx.slot} (${ctx.order || tpl?.order_no || '?'}): ` +
      `no ${dir === 'in' ? 'input' : 'output'} identifier defined for signal type ` +
      `${tpl?.signal_type || '?'} — using default "${ident}". Set it in the Catalogue.`
    );
  }
  return ident;
}

/**
 * Build LOCAL_IN/OUT_ADDRESSES lines for an I/O slot from its template.
 *
 * PCS7 block structure requires all SYMBOL lines to come AFTER both address blocks:
 *   LOCAL_IN_ADDRESSES
 *     ADDRESS  ...
 *   LOCAL_OUT_ADDRESSES
 *     ADDRESS  ...
 *   SYMBOL  I , <byteOfs>, "<tag>", "<desc>"
 *   SYMBOL  O , <byteOfs>, "<tag>", "<desc>"
 *
 * SYMBOL identifiers are always "I" (input) or "O" (output) regardless of the
 * module's signal type or catalogue definition. Catalogue definitions are used for
 * XML generation only.
 */
function buildAddressLines(tpl, slot, warnings, ctx) {
  const channels = slot.channels ? [...slot.channels.values()] : [];
  const pipNo = slot.pipNo != null ? slot.pipNo : null;
  const isMixed = tpl && tpl.signal_type === 'MIXED';
  // MIXED covers two unrelated shapes (see isAnalog / deriveSignalType). Only the
  // bit-packed digital kind — no declared datatype, e.g. DIQ8 — splits its
  // channels by DI/DO signal type onto the two directions. A byte/word-oriented
  // MIXED card (an IO-Link port, default_datatype "Byte") has one flat run of
  // typed channels instead, laid out sequentially across the input byte block
  // and then the output one, exactly like every other card in this model.
  const isDigitalMixed = isMixed && !(tpl && tpl.default_datatype);
  const chCount = (tpl && tpl.channel_count) || 0;
  const totalBytes = tpl ? ((tpl.input_bytes || 0) + (tpl.output_bytes || 0)) : 0;
  const bytesPerCh = (isMixed && !isDigitalMixed && chCount > 0) ? totalBytes / chCount : 0;
  // How many of the flat channel run belong to the input block; the rest are output.
  const inChCount = bytesPerCh > 0 ? Math.round((tpl.input_bytes || 0) / bytesPerCh) : 0;

  const addrLines = [];
  const symbolLines = [];

  if (tpl && tpl.input_bytes > 0 && slot.inputAddr != null && tpl.in_addr_fmt) {
    const fields = patchPip(fillAddrFmt(tpl.in_addr_fmt, slot.inputAddr), pipNo);
    addrLines.push('LOCAL_IN_ADDRESSES', `  ADDRESS  ${fields}`);
    if (isDigitalMixed) {
      // Only DI channels → input uses "I"; totalBytes=0 makes byteOfs the bit index.
      symbolLines.push(...buildSymbolLines('I', channels.filter(c => c.signalType === 'DI'), 0, 1));
    } else if (isMixed) {
      const inChannels = channels.filter(c => (Number(c.channel) || 0) < inChCount);
      symbolLines.push(...buildSymbolLines('I', inChannels, tpl.input_bytes, inChCount));
    } else {
      symbolLines.push(...buildSymbolLines('I', channels, tpl.input_bytes, chCount));
    }
  }
  if (tpl && tpl.output_bytes > 0 && slot.outputAddr != null && tpl.out_addr_fmt) {
    const fields = patchPip(fillAddrFmt(tpl.out_addr_fmt, slot.outputAddr), pipNo);
    addrLines.push('LOCAL_OUT_ADDRESSES', `  ADDRESS  ${fields}`);
    if (isDigitalMixed) {
      // Only DO channels → output always uses "O".
      symbolLines.push(...buildSymbolLines('O', channels.filter(c => c.signalType === 'DO'), 0, 1));
    } else if (isMixed) {
      // Output offsets are relative to the output block, so rebase past the inputs.
      const outChannels = channels
        .filter(c => (Number(c.channel) || 0) >= inChCount)
        .map(c => ({ ...c, channel: (Number(c.channel) || 0) - inChCount }));
      symbolLines.push(...buildSymbolLines('O', outChannels, tpl.output_bytes, chCount - inChCount));
    } else {
      symbolLines.push(...buildSymbolLines('O', channels, tpl.output_bytes, chCount));
    }
  }

  // All address blocks first, then all SYMBOL lines — PCS7 requires this order
  return [...addrLines, ...symbolLines];
}

/**
 * Build PARAMETER block lines from a template.
 * Looks up normalized parameters from hw_module_parameters using order_no (version-independent),
 * falls back to param_template. If potentialGroup is provided, it's injected/replaced.
 *
 * @param tpl - Template object { order_no, param_template, ... }
 * @param potentialGroup - "NEW_GROUP" | "LEFT_MODULE" or null
 * @param db - Database handle (optional, for normalized params lookup)
 */
async function buildParamLines(tpl, potentialGroup, db, assignedChannels = null) {
  let lines = [];

  // Try to fetch normalized parameters from DB by exact order_no match
  if (db && tpl && tpl.order_no && tpl.signal_type && ['DI', 'DO', 'AI', 'AO', 'IB', 'QB'].includes(tpl.signal_type)) {
    try {
      const params = await db.prepare(`
        SELECT p.id, p.parameter_name, p.channel_type, p.channel_no, p.parameter_type,
               p.parameter_value, p.spare_value, p.is_dynamic
        FROM hw_module_parameters p
        JOIN hw_module_templates t ON p.template_id = t.id
        WHERE t.signal_type = ? AND t.order_no = ? AND p.is_visible = true
        ORDER BY p.sort_order
      `).all(tpl.signal_type, tpl.order_no);

      if (params.length > 0) {
        // Build lines from normalized parameters
        params.forEach(p => {
          if (p.channel_no !== null) {
            // Channel-level parameter: choose between default and spare based on assignment
            let value = p.parameter_value;
            if (p.is_dynamic && assignedChannels) {
              // For dynamic parameters, use spare_value if channel is NOT assigned
              const isChannelAssigned = assignedChannels.has(p.channel_no);
              if (!isChannelAssigned && p.spare_value !== null) {
                value = p.spare_value;
              }
            }
            // PARAM_NAME, CHANNEL_TYPE , CH_NO, "VALUE"
            lines.push(`  ${p.parameter_name}, ${p.channel_type} , ${p.channel_no}, "${value}"`);
          } else {
            // Module-level: PARAM_NAME, "VALUE"
            lines.push(`  ${p.parameter_name}, "${p.parameter_value}"`);
          }
        });
      }
    } catch (e) {
      // Fall through to param_template if DB lookup fails
      console.warn(`[CFG] Parameter lookup failed for ${tpl.order_no}:`, e.message);
    }
  }

  // Fall back to param_template if no normalized params found
  if (lines.length === 0 && tpl && tpl.param_template) {
    lines = tpl.param_template.split('\n');
  }

  if (!potentialGroup && lines.length === 0) return null;

  // Inject/replace POTENTIAL_GROUP if provided (ET200SP-only)
  if (potentialGroup) {
    const pgLine = `  POTENTIAL_GROUP, "${potentialGroup}"`;
    const idx = lines.findIndex(l => l.trimStart().startsWith('POTENTIAL_GROUP'));
    if (idx >= 0) {
      lines[idx] = pgLine;
    } else {
      lines.push(pgLine);
    }
  }

  return lines.length > 0 ? ['PARAMETER', ...lines] : null;
}

/**
 * Render one full device section (the IM + all submodules + I/O modules) for an
 * ET200SP-family station, reproducing the structure PCS7 exports.
 *
 * @param diag - { ptr } mutable diagnostic-address counter (counts down)
 * @param warnings - mutable array collecting missing-identifier diagnostics
 * @param autoSlotConfig - Auto-slot configuration from database (optional)
 * @param db - Database instance (for loading module parameters)
 */
async function renderEt200sp(station, templateMap, ioNo, diag, warnings, autoSlotConfig, db) {
  const out = [];
  const addr      = station.address;
  const name      = deviceName(station);
  const hexIp     = ipToHex(station.ip);
  const hexRouter = station.routerAddress ? ipToHex(station.routerAddress) : null;

  const headSlot = station.slots.get(0);
  const headTpl  = headSlot ? await findStationTemplate(db, headSlot.orderNo, templateMap) : null;
  const imOrder  = headSlot ? headSlot.orderNo : '6ES7 155-6AU00-0CN0';
  const imVer    = headTpl && headTpl.version ? headTpl.version : 'V4.2';
  const ifaceOrder = blocks.ifaceOrderString(imOrder, imVer);
  // PN_DEVICE_SCF_L and PN_DEVICE_UPD_TIME both reflect configuration
  // complexity: "0" on a bare default station, "32"/"2" respectively once any
  // additional module is plugged (confirmed against all three ET200SP
  // fixtures — a station-shape fact, not a per-order_no constant).
  const stationHasCards = [...station.slots.keys()].some(s => s !== 0);
  const scfL = stationHasCards ? '32' : '0';
  const updTime = stationHasCards ? '2' : '0';

  // Device header + SLOT 0 + interface + auto-created subslots from config.
  // Header body text is per (order_no, role) (ground-truth rule 6) — when a real
  // captured body_template exists for this order_no's own device-header row, use
  // it verbatim (placeholder-filled) instead of the generic hardcoded field list.
  out.push(headTpl && headTpl.body_template
    ? blocks.deviceHeaderBlockFromTemplate({ ioNo, addr, imOrder, imVersion: imVer, name, bodyTemplate: headTpl.body_template, posX: station.posX, posY: station.posY })
    : blocks.deviceHeaderBlock({ ioNo, addr, imOrder, imVersion: imVer, name, posX: station.posX, posY: station.posY, scfL, updTime }));
  const slot0Tpl = await findSlotZeroTemplate(db, imOrder);
  out.push(slot0Tpl && slot0Tpl.body_template
    ? blocks.slot0BlockFromTemplate({ ioNo, addr, imOrder, name, bodyTemplate: slot0Tpl.body_template, hexIp, hexRouter, diag: diag.ptr-- })
    : blocks.slot0Block({ ioNo, addr, imOrder, name, hexIp, hexRouter, diag: diag.ptr-- }));
  out.push(blocks.ifaceBlock({ ioNo, addr, ifaceOrder, diag: diag.ptr-- }));

  // Auto-create subslots (ports) from config. Subslot 1 (type 'subslot', the
  // PN-IO interface) is already emitted above via ifaceBlock — only emit
  // entries whose type is 'port' here, or the interface subslot renders twice.
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.subslots) {
      for (const subslot of slot0Config.subslots) {
        if (subslot.order_no && subslot.type === 'port') {
          out.push(blocks.portBlock({
            ioNo, addr, subslot: subslot.subslot,
            portLabel: subslot.port_label || subslot.label,
            portOrder: subslot.order_no,
            diag: diag.ptr--
          }));
        }
      }
    }
  }

  // I/O module slots (ascending), excluding the head. The ET200SP server module
  // (193-6PA00-0AA0) is special: it carries a diagnostic address, not a process
  // image address, so it is rendered via serverModuleBlock wherever it appears.
  const isServerOrder = o => (o || '').includes('193-6PA00-0AA0');
  const ioSlots = [...station.slots.keys()].filter(s => s !== 0).sort((a, b) => a - b);
  let maxSlot = 0;
  let hasServer = false;
  for (const slotNo of ioSlots) {
    const slot = station.slots.get(slotNo);
    maxSlot = Math.max(maxSlot, slotNo);
    if (isServerOrder(slot.orderNo)) {
      hasServer = true;
      out.push(blocks.serverModuleBlock({ ioNo, addr, slot: slotNo, diag: diag.ptr-- }));
      continue;
    }
    const tpl = findTemplate(templateMap, slot.orderNo);
    // Collect assigned channel numbers for dynamic parameter resolution
    const assignedChannels = new Set();
    if (slot.channels) {
      slot.channels.forEach(ch => {
        if (ch.tag) assignedChannels.add(Number(ch.channel));
      });
    }
    out.push(blocks.ioModuleBlock({
      ioNo, addr, slot: slotNo,
      order: slot.orderNo,
      version: tpl && tpl.version ? tpl.version : '',
      name: slot.name,
      redundant: !NON_REDUNDANT_ORDERS.has(slot.orderNo),
      addressLines: buildAddressLines(tpl, slot, warnings, { addr, slot: slotNo, order: slot.orderNo }),
      paramLines: await buildParamLines(tpl, slot.potentialGroup || null, db, assignedChannels),
      mlfb: tpl ? tpl.mlfb : null,
    }));
  }

  // Server module attachment is controlled by the station's auto-slot config.
  // PCS7 standard: always place server module as the last slot.
  // Auto-add only if: (1) not already in the user's slot list, AND (2) enabled in config.
  // If config is missing or flag is null/false, skip auto-addition (safe default).
  const serverModuleEnabled = autoSlotConfig?.rules?.server_module_enabled === true;
  if (!hasServer && serverModuleEnabled) {
    const serverModuleOrder = 'V1_1:6ES7 193-6PA00-0AA0';
    out.push(blocks.serverModuleBlock({ ioNo, addr, slot: maxSlot + 1, diag: diag.ptr-- }));
  }

  return out.join('\n\n');
}

/**
 * Render a CFU_PA station. Structure (from validated golden CFG):
 *   Device header
 *   Slot 0 (ethernet head, AUTOCREATED) + Slot 0/Subslot 1 (IFACE) + 2 RJ45 ports
 *   Slot 1 (DIQ8, digital DI+DQ) — user-facing, address allocated by allocateAddresses
 *   Slot 2 (PA Master, AUTOCREATED)
 *     Slot 2/Subslot 1 (param/diag, diagnostic address only)
 *     Slot 2/Subslot 2 (status/notifications, 4 bytes DI + 2 bytes DQ in ANALOG space)
 *   Slot 3+ — PA transmitter slots added by the user (one META\PA... block each)
 *
 * @param autoSlotConfig - Auto-slot configuration from database (optional)
 * @param db - Database instance (for loading module parameters)
 */
async function renderCfuPa(station, templateMap, ioNo, diag, warnings, autoSlotConfig, db) {
  const out = [];
  const addr      = station.address;
  const name      = deviceName(station);
  const hexIp     = ipToHex(station.ip);
  const hexRouter = station.routerAddress ? ipToHex(station.routerAddress) : null;

  // Head and slot 0 can be separate catalogue records with different order_no/
  // version (e.g. CFU_PA: head "V_2_0_PA:..." vs slot 0 "V_2_0_PA_ETER:...").
  // `templateMap` is keyed only by order_no and can collide across hw_category
  // values for the same order_no, so resolve identity via direct, category-
  // filtered DB queries instead: slot 0's own 'slot' row, then the family's
  // single 'station' row for the device header. Falls back to slot 0's own
  // identity when no distinct 'station' row exists (ET200SP, IO-Link).
  const headSlot = station.slots.get(0);
  let imOrder = headSlot ? headSlot.orderNo : 'V_2_0_PA:6ES7 655-5PX11-0XX0';
  let imVer = 'V2.0';
  let slot0Version = 'V2.0';

  if (headSlot && headSlot.orderNo && db) {
    const slot0Row = await db.prepare(
      `SELECT * FROM hw_module_templates WHERE order_no = ? AND hw_category = 'slot' LIMIT 1`
    ).get(headSlot.orderNo);
    if (slot0Row) {
      slot0Version = slot0Row.version || slot0Version;
      imVer = slot0Version;
      if (slot0Row.family) {
        const stationRow = await db.prepare(
          `SELECT * FROM hw_module_templates WHERE hw_category = 'station' AND family = ? LIMIT 1`
        ).get(slot0Row.family);
        if (stationRow) {
          imOrder = stationRow.order_no;
          imVer = stationRow.version || slot0Version;
        }
      }
    }
  }

  // Resolve slot 0 order from config (explicit order_no from DB), else keep
  // slot 0's own identity (may differ from the device header's).
  let slot0Order = headSlot ? headSlot.orderNo : imOrder;
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.order_no) {
      slot0Order = slot0Config.order_no;
    }
  }

  // Device header + Slot 0 + IFACE + auto-created subslots from config
  out.push(blocks.cfuPaDeviceHeaderBlock({ ioNo, addr, imOrder, imVersion: imVer, name, posX: station.posX, posY: station.posY }));
  out.push(blocks.cfuPaSlot0Block({ ioNo, addr, slot0Order, version: slot0Version, name, hexIp, hexRouter, diag: diag.ptr-- }));
  out.push(blocks.cfuPaIfaceBlock({ ioNo, addr, name, diag: diag.ptr-- }));

  // Auto-create subslots (ports) from config. Subslot 1 (type 'subslot', the
  // PN-IO interface) is already emitted above via cfuPaIfaceBlock — only emit
  // entries whose type is 'port' here, or the interface subslot renders twice.
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.subslots) {
      for (const subslot of slot0Config.subslots) {
        if (subslot.order_no && subslot.type === 'port') {
          out.push(blocks.portBlock({
            ioNo, addr, subslot: subslot.subslot,
            portLabel: subslot.port_label || subslot.label,
            portOrder: subslot.order_no,
            diag: diag.ptr--,
            includePrivate6: true,
          }));
        }
      }
    }
  }

  // Slot 1 — DIQ8 (digital, user-facing, address already allocated)
  const slot1 = station.slots.get(1);
  const slot1Tpl = slot1 ? findTemplate(templateMap, slot1.orderNo) : null;
  if (slot1) {
    // Collect assigned channel numbers for dynamic parameter resolution
    const slot1AssignedChannels = new Set();
    if (slot1.channels) {
      slot1.channels.forEach(ch => {
        if (ch.tag) slot1AssignedChannels.add(Number(ch.channel));
      });
    }
    out.push(blocks.ioModuleBlock({
      ioNo, addr, slot: 1,
      order: slot1 ? slot1.orderNo : '_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT',
      version: '',
      name: slot1 ? slot1.name : 'DIQ8 DC24V/0.5A',
      redundant: false,
      addressLines: buildAddressLines(slot1Tpl, slot1, warnings, { addr, slot: 1, order: slot1.orderNo }),
      paramLines: slot1Tpl ? await buildParamLines(slot1Tpl, null, db, slot1AssignedChannels) : null,
      mlfb: slot1Tpl ? slot1Tpl.mlfb : null,
    }));
  }

  // Slot 2 — PA Master composite (AUTOCREATED infrastructure).
  // allocateAddresses gives Slot 2 inputAddr=528 (4 bytes) and outputAddr=528 (2 bytes),
  // advancing the analog pointer to 532 so Slot 3+ PA transmitters start there.
  const slot2 = station.slots.get(2);
  const s2InAddr  = slot2 && slot2.inputAddr  != null ? slot2.inputAddr  : 528;
  const s2OutAddr = slot2 && slot2.outputAddr != null ? slot2.outputAddr : 528;
  out.push(blocks.cfuPaPaMasterBlock({ ioNo, addr }));
  out.push(blocks.cfuPaPaMasterParamBlock({ ioNo, addr, diag: diag.ptr-- }));
  out.push(blocks.cfuPaPaMasterStatusBlock({ ioNo, addr, inAddr: s2InAddr, outAddr: s2OutAddr }));

  // Slot 3+ — PA field device profiles (one per device on the PROFIBUS PA segment).
  //
  // Each PA slot emits three CFG blocks:
  //   1. Slot header   — device GSD order, carries a DIAGNOSTIC address (not process image)
  //   2. Slot N/SS 1   — signal data block with process image address and SYMBOL lines
  //   3. Slot N/SS 2   — AUTOCREATED service block (diagnostic address)
  //
  // The process image address (inputAddr) is allocated by allocateAddresses using the
  // GSD PA fallback (5 bytes) when no catalogue template is found, or the template's
  // input_bytes when one exists. Addresses are strictly sequential: no alignment gaps.
  //
  // Subslot 1 order string is a FIXED GSD telegram-format identifier, not user data:
  //   "Analog Input (AI)short"  (Kennung 148 / 0x94)
  //   "Analog Input (AI)long"   (Kennung 66  / 0x42)
  //   "SP (short)"              (Kennung 164 / 0xA4)

  const KNOWN_PA_SUBSLOT_ORDERS = new Set([
    'Analog Input (AI)short', 'Analog Input (AI)long', 'SP (short)',
  ]);

  const ioSlots = [...station.slots.keys()].filter(s => s > 2).sort((a, b) => a - b);
  for (const slotNo of ioSlots) {
    const slot = station.slots.get(slotNo);
    const tpl  = findTemplate(templateMap, slot.orderNo);

    // Build per-subslot profile map from slot.subslots (keyed by 1-based subslot_no)
    // Falls back to legacy slot.paProfile (slot-level) for subslot 1 if no per-subslot entry exists.
    const subslotProfileMap = new Map();
    if (Array.isArray(slot.subslots)) {
      for (const ss of slot.subslots) {
        if (ss.paProfile && KNOWN_PA_SUBSLOT_ORDERS.has(ss.paProfile)) {
          subslotProfileMap.set(ss.subslotNo, ss.paProfile);
        }
      }
    }
    // Resolve default (used when a subslot has no specific assignment)
    let defaultSubslotOrder;
    if (slot.paProfile && KNOWN_PA_SUBSLOT_ORDERS.has(slot.paProfile)) {
      defaultSubslotOrder = slot.paProfile;
    } else if (KNOWN_PA_SUBSLOT_ORDERS.has(slot.orderNo)) {
      defaultSubslotOrder = slot.orderNo;
    } else {
      const sigType = tpl ? (tpl.signal_type || 'PA').toUpperCase() : 'PA';
      defaultSubslotOrder = sigType === 'AO' ? 'SP (short)' : 'Analog Input (AI)short';
    }

    // Number of function subslots: channel_count from template (min 1).
    // For simple profiles (Transmitter, Actuator) this is 1.
    // For multi-function profiles (Analyzer etc.) this equals the number of PA functions.
    const funcCount = (tpl && (tpl.channel_count || 0) > 1) ? tpl.channel_count : 1;
    const perSubslotBytes = (tpl && tpl.input_bytes > 0) ? tpl.input_bytes : 5;
    const perSubslotOutBytes = (tpl && tpl.output_bytes > 0) ? tpl.output_bytes : 0;
    const pipNo = slot.pipNo != null ? slot.pipNo : 8;

    // Index channels 0..(funcCount-1) to subslots 1..funcCount.
    const channelsBySubslot = new Map();
    for (const ch of (slot.channels || [])) {
      // channel field = 0-based function index; subslot = channel + 1
      if (ch.channel != null) channelsBySubslot.set(ch.channel, ch);
    }

    out.push(blocks.cfuPaPaSlotBlock({
      ioNo, addr, slotNo,
      order: slot.orderNo,
      name: slot.name,
      diag: diag.ptr--,
    }));

    // Emit one signal subslot per function
    for (let fi = 0; fi < funcCount; fi++) {
      const ssNo = fi + 1;
      const ssInAddr  = slot.inputAddr  != null ? slot.inputAddr  + fi * perSubslotBytes    : null;
      const ssOutAddr = slot.outputAddr != null ? slot.outputAddr + fi * perSubslotOutBytes : null;

      // Build address lines for this individual subslot
      let ssAddressLines;
      if (tpl && tpl.in_addr_fmt && ssInAddr != null) {
        // Template with addr_fmt: build using single-subslot byte counts
        const ssTpl = { ...tpl, channel_count: 1 };
        const ch = channelsBySubslot.get(fi);
        ssAddressLines = buildAddressLines(ssTpl, {
          ...slot,
          inputAddr:  ssInAddr,
          outputAddr: ssOutAddr,
          channels:   ch ? [ch] : [],
        }, warnings, { addr, slot: slotNo, order: slot.orderNo });
      } else if (ssInAddr != null) {
        // GSD-path fallback: construct ADDRESS line directly.
        // SYMBOL identifiers are always "I" (input) or "O" (output).
        const ch = channelsBySubslot.get(fi);
        ssAddressLines = [
          'LOCAL_IN_ADDRESSES',
          `  ADDRESS  ${ssInAddr}, 0, ${perSubslotBytes}, 0, ${pipNo}, 0`,
        ];
        if (ch && ch.tag) {
          ssAddressLines.push(`SYMBOL  I , 0, "${ch.tag}", "${ch.desc || ''}"`);
        }
        if (perSubslotOutBytes > 0 && ssOutAddr != null) {
          ssAddressLines.push('LOCAL_OUT_ADDRESSES', `  ADDRESS  ${ssOutAddr}, 0, ${perSubslotOutBytes}, 0, ${pipNo}, 0`);
          if (ch && ch.tag) {
            ssAddressLines.push(`SYMBOL  O , 0, "${ch.tag}", "${ch.desc || ''}"`);
          }
        }
      } else {
        ssAddressLines = [];
      }

      const subslotOrder = subslotProfileMap.get(ssNo) || defaultSubslotOrder;
      out.push(blocks.cfuPaPaSubslot1Block({
        ioNo, addr, slotNo,
        subslotNo: ssNo,
        subslotOrder,
        addressLines: ssAddressLines,
      }));
    }

    // Service subslot always last: funcCount + 1
    out.push(blocks.cfuPaPaSubslot2Block({
      ioNo, addr, slotNo,
      subslotNo: funcCount + 1,
      diag: diag.ptr--,
    }));
  }

  return out.join('\n\n');
}

/**
 * Render a Scalance network switch station.
 * Structure: device header → SLOT 0 (DAP) → SUBSLOT 1 (PN-IO) → SUBSLOT N (ports).
 * Port definitions come from tpl.port_config JSON; device identity from tpl.gsdml_file + tpl.dap_id.
 */
function renderScalance(station, templateMap, ioNo, diag, db) {
  const addr   = station.address;
  const hexIp  = ipToHex(station.ip);
  const name   = deviceName(station);

  const headSlot = station.slots.get(0);
  const headTpl  = headSlot ? findTemplate(templateMap, headSlot.orderNo) : null;

  const gsdmlFile = headTpl && headTpl.gsdml_file ? headTpl.gsdml_file : '';
  const dapId     = headTpl && headTpl.dap_id     ? headTpl.dap_id     : '';
  const gsdmlPath = dapId ? `${gsdmlFile}<DAP ${dapId}>` : gsdmlFile;
  const version   = headTpl && headTpl.version    ? headTpl.version    : '';
  // Prefer MLFB from slot (extracted from baseline CFG) over template; fallback to template's mlfb
  const mlfb      = (headSlot && headSlot.mlfb) ? headSlot.mlfb : (headTpl && headTpl.mlfb ? headTpl.mlfb : '');

  let meta = {};
  if (headTpl && headTpl.param_template) {
    try { meta = JSON.parse(headTpl.param_template); } catch (_) {}
  }

  let ports = [];
  if (headTpl && headTpl.port_config) {
    try { ports = JSON.parse(headTpl.port_config); } catch (_) {}
  }

  const out = [];
  out.push(blocks.scalanceDeviceHeaderBlock({
    ioNo, addr, gsdmlPath, version, name, mlfb,
    posX: station.posX, posY: station.posY, meta,
  }));
  out.push(blocks.scalanceSlot0Block({
    ioNo, addr, gsdmlPath, name, hexIp, mlfb, diag: diag.ptr--, meta,
  }));
  out.push(blocks.scalancePnioBlock({ ioNo, addr, diag: diag.ptr-- }));
  for (const p of ports) {
    if (p.type !== 'port') continue;
    out.push(blocks.scalancePortBlock({
      ioNo, addr, gsdmlPath, subslot: p.subslot, portName: p.name, medium: p.medium || 'RJ45', diag: diag.ptr--,
    }));
  }
  return out.join('\n\n');
}

/**
 * Render a station. ET200SP gets full PCS7 fidelity; CFU_PA gets its own renderer;
 * Scalance gets its GSDML-based renderer; others fall back to a minimal block.
 *
 * @param db - Database instance (for loading auto-slot configs)
 */
async function renderStation(station, templateMap, ioNo, diag, warnings, db) {
  const headSlot = station.slots.get(0) ||
    station.slots.get([...station.slots.keys()].sort((a, b) => a - b)[0]);
  const headTpl  = headSlot ? await findStationTemplate(db, headSlot.orderNo, templateMap) : null;
  const family   = headTpl ? headTpl.family : 'ET200SP';

  // Load auto-slot config from database using station (slot 0) order_no
  // This is keyed by the interface module order number, not the family name
  const autoSlotConfig = headSlot && db ? await loadStationAutoSlotConfig(db, headSlot.orderNo) : null;

  if (family === 'CFU_PA') {
    return renderCfuPa(station, templateMap, ioNo, diag, warnings, autoSlotConfig, db);
  }

  if (family === 'Scalance') {
    return renderScalance(station, templateMap, ioNo, diag, db);
  }

  if (family === 'ET200SP') {
    return renderEt200sp(station, templateMap, ioNo, diag, warnings, autoSlotConfig, db);
  }

  // Generic fallback (Festo, GSDML, and other non-ET200SP families).
  // Still use auto-slot config for subslot generation (slots 1+, Slot 0 subslots, etc.)
  const addr      = station.address;
  const name      = deviceName(station);
  const hexIp     = ipToHex(station.ip);
  const hexRouter = station.routerAddress ? ipToHex(station.routerAddress) : null;
  const imOrder = headSlot ? headSlot.orderNo : 'UNKNOWN';
  const imVer = headTpl && headTpl.version ? headTpl.version : '';
  // Prefer MLFB from slot (extracted from baseline CFG) over template; fallback to template's mlfb
  const mlfb = (headSlot && headSlot.mlfb) ? headSlot.mlfb : (headTpl && headTpl.mlfb ? headTpl.mlfb : null);
  const stationHasCards = [...station.slots.keys()].some(s => s !== 0);
  const scfL = stationHasCards ? '32' : '0';
  const updTime = stationHasCards ? '2' : '0';
  const out = [];
  // Header body text is per (order_no, role) (ground-truth rule 6) — when a real
  // captured body_template exists for this order_no's own device-header row, use
  // it verbatim (placeholder-filled) instead of the generic hardcoded field list.
  out.push(headTpl && headTpl.body_template
    ? blocks.deviceHeaderBlockFromTemplate({ ioNo, addr, imOrder, imVersion: imVer, name, bodyTemplate: headTpl.body_template, posX: station.posX, posY: station.posY })
    : blocks.deviceHeaderBlock({ ioNo, addr, imOrder, imVersion: imVer, name, posX: station.posX, posY: station.posY, scfL, updTime }));
  const slot0Tpl = await findSlotZeroTemplate(db, imOrder);
  out.push(slot0Tpl && slot0Tpl.body_template
    ? blocks.slot0BlockFromTemplate({ ioNo, addr, imOrder, name, bodyTemplate: slot0Tpl.body_template, hexIp, hexRouter, diag: diag.ptr--, mlfb })
    : blocks.slot0Block({ ioNo, addr, imOrder, name, hexIp, hexRouter, diag: diag.ptr--, mlfb }));

  // SLOT 0 SUBSLOT 1 (PN-IO interface): on this fallback path PCS7 always uses
  // the one shared, family-agnostic order_no captured in GENERIC_IFACE_ORDER_NO
  // (ground-truth rule 6 covers identity here too, not just body text). Emit it
  // whenever a body_template has been captured for that catalogue row; auto-slot
  // 'subslot' entries below are then filtered to 'port' only, mirroring
  // renderEt200sp/renderCfuPa, so the interface subslot never renders twice.
  const genericIfaceTpl = await findGenericIfaceTemplate(db);
  if (genericIfaceTpl && genericIfaceTpl.body_template) {
    out.push(blocks.ifaceBlockFromTemplate({
      ioNo, addr, ifaceOrder: GENERIC_IFACE_ORDER_NO, bodyTemplate: genericIfaceTpl.body_template, diag: diag.ptr--,
    }));
  }

  // Auto-create remaining Slot 0 subslots (ports) from config. When the interface
  // subslot was just emitted above from its own template, skip any auto-slot
  // entry for subslot 1 so it isn't duplicated.
  const emittedSubslots = new Set([1]);
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.subslots) {
      for (const subslot of slot0Config.subslots) {
        if (genericIfaceTpl && genericIfaceTpl.body_template && subslot.subslot === 1) continue;
        if (subslot.order_no) {
          out.push(blocks.portBlock({
            ioNo, addr, subslot: subslot.subslot,
            portLabel: subslot.port_label || subslot.label,
            portOrder: subslot.order_no,
            diag: diag.ptr--
          }));
          emittedSubslots.add(subslot.subslot);
        }
      }
    }
  }

  // Ports not covered by autoSlotConfig (which is only manually populated for
  // ET200SP/CFU): fall back to the REAL, parsed subslot data on the head slot
  // (hw_slot_subslots, sourced purely from CFG parsing — no manual per-device
  // authoring). Ground-truth rule 6: each such port reuses the device's own
  // order_no as its header order_no, so its captured body_template is looked
  // up under that same order_no (hw_category='subslot').
  if (headSlot && headSlot.subslots) {
    for (const ss of headSlot.subslots) {
      if (emittedSubslots.has(ss.subslotNo)) continue;
      const portOrder = ss.paProfile;
      if (!portOrder) continue;
      const portTpl = await findSubslotTemplate(db, portOrder);
      if (!portTpl || !portTpl.body_template) continue;
      out.push(blocks.portBlockFromTemplate({
        ioNo, addr, subslot: ss.subslotNo,
        portLabel: ss.label || '',
        portOrder,
        bodyTemplate: portTpl.body_template,
        diag: diag.ptr--,
      }));
      emittedSubslots.add(ss.subslotNo);
    }
  }

  // Render slots 1+ (each may have its own subslots from config)
  const ioSlots = [...station.slots.keys()].filter(s => s !== 0).sort((a, b) => a - b);
  for (const slotNo of ioSlots) {
    const slot = station.slots.get(slotNo);
    const tpl  = findTemplate(templateMap, slot.orderNo);
    // Collect assigned channel numbers for dynamic parameter resolution
    const slotAssignedChannels = new Set();
    if (slot.channels) {
      slot.channels.forEach(ch => {
        if (ch.tag) slotAssignedChannels.add(Number(ch.channel));
      });
    }
    // Ground-truth rule 6: a slot's own header body is per (order_no, role) too —
    // when a real captured body_template exists for this order_no's own 'slot'
    // catalogue row, use it verbatim (its shape can differ entirely from the
    // generic ET200SP-style CPU_NO/ALARM_OB_NO body, e.g. GSDML PN_TI/PN_TO
    // fields), instead of the generic hardcoded field list.
    const slotModuleTpl = await findSlotModuleTemplate(db, slot.orderNo);
    if (slotModuleTpl && slotModuleTpl.body_template) {
      out.push(blocks.ioModuleBlockFromTemplate({
        ioNo, addr, slot: slotNo,
        order: slot.orderNo,
        version: tpl && tpl.version ? tpl.version : '',
        name: slot.name,
        bodyTemplate: slotModuleTpl.body_template,
        isAutocreated: /OBJECT_REMOVEABLE\s+"0"/.test(slotModuleTpl.body_template),
      }));
    } else {
      out.push(blocks.ioModuleBlock({
        ioNo, addr, slot: slotNo,
        order: slot.orderNo,
        version: tpl && tpl.version ? tpl.version : '',
        name: slot.name,
        redundant: false,
        addressLines: buildAddressLines(tpl, slot, warnings, { addr, slot: slotNo, order: slot.orderNo }),
        paramLines: await buildParamLines(tpl, null, db, slotAssignedChannels),
        mlfb: tpl ? tpl.mlfb : null,
      }));
    }

    // Subslots on this slot. Two sources describe the same set of positions:
    //   - the family's generic default list (autoSlotConfig) — what a freshly
    //     plugged module looks like, and
    //   - this station's own real rows (hw_slot_subslots) — what the user
    //     actually selected for each position in the project's Configure screen.
    // The real row is authoritative for WHICH profile occupies a position and
    // must win, *including* when the catalogue has no captured body_template for
    // the selected profile (most GSDML subslot profiles have none). Resolving
    // the two per position — rather than emitting each source's list in turn —
    // is what keeps a user's selection from being shadowed by the default.
    const defaultSubslots = new Map();
    if (autoSlotConfig && autoSlotConfig.slots) {
      const slotConfig = autoSlotConfig.slots.find(s => s.slot === slotNo);
      if (slotConfig && slotConfig.subslots) {
        for (const s of slotConfig.subslots) defaultSubslots.set(s.subslot, s);
      }
    }
    const realSubslots = new Map();
    for (const ss of (slot.subslots || [])) {
      if (ss.subslotNo != null) realSubslots.set(ss.subslotNo, ss);
    }
    const ssPositions = [...new Set([...defaultSubslots.keys(), ...realSubslots.keys()])]
      .sort((a, b) => a - b);

    for (const ssNo of ssPositions) {
      const real = realSubslots.get(ssNo) || null;
      const dflt = defaultSubslots.get(ssNo) || null;
      const subslotOrder = (real && real.paProfile) || (dflt && dflt.order_no) || null;
      if (!subslotOrder) continue;
      const ssTpl = await findSubslotTemplate(db, subslotOrder);
      const label = await resolveSubslotLabel(db, real, dflt, ssTpl, subslotOrder);

      if (ssTpl && ssTpl.body_template) {
        // A subslot's own real per-instance data (e.g. IO-Link ports sharing one
        // shared order_no but each with a different process-image address and
        // optional tagged SYMBOL line(s)) is filled into the captured body
        // template's placeholders here, same mechanism as every other
        // body_template fill — never hardcoded per order_no.
        //
        // SYMBOL identifiers are always "I" (input) or "O" (output) regardless
        // of catalogue signal-type metadata (see buildAddressLines' own note
        // above) — a subslot's tagged channels here are always input ("I") in
        // every fixture observed. Offsets are stored as the raw value parsed
        // from the fixture (no catalogue byte-width metadata exists for these
        // order_nos) — pass totalBytes===channelCount so buildSymbolLines'
        // byte-offset math (channel × bytesPerCh) is an identity pass-through.
        const symbolLines = buildSymbolLines('I', (real && real.symbols) || [], 1, 1);
        out.push(blocks.subslotBlockFromTemplate({
          ioNo, addr, slot: slotNo, subslot: ssNo,
          label,
          order: subslotOrder,
          bodyTemplate: ssTpl.body_template,
          symbolLines,
          localAddress: (real && real.localAddress != null) ? real.localAddress : null,
        }));
      } else {
        // No captured body for this profile — emit the generic submodule body,
        // still carrying the resolved (possibly user-selected) order_no and
        // label rather than the family default's. A subslot that carries real
        // process-image bytes gets its own LOCAL_IN/OUT_ADDRESSES block and the
        // SYMBOL lines for whatever channels the user tagged on it, built the
        // same way a slot-level module's are; only a position with no bytes at
        // all falls back to the placeholder diagnostic address.
        const ssAddressLines = real
          ? buildAddressLines(
              ssTpl,
              { channels: real.symbols || [], inputAddr: real.inputAddr, outputAddr: real.outputAddr, pipNo: real.pipNo },
              warnings,
              { addr, slot: slotNo, order: subslotOrder },
            )
          : [];
        out.push(blocks.portBlock({
          ioNo, addr, slot: slotNo, subslot: ssNo,
          portLabel: label,
          portOrder: subslotOrder,
          diag: ssAddressLines.length ? null : diag.ptr--,
          addressLines: ssAddressLines,
        }));
      }
    }
  }
  return out.join('\n\n');
}

/**
 * Assemble the full .cfg output.
 *
 * @param {object} parsedBaseline - From cfgParser.parseCfg()
 * @param {Map}    stations       - From hwAddressEngine.allocateAddresses()
 * @param {Map}    templateMap    - Map<orderNo, templateRow>
 * @param {object} db             - Database instance (for loading auto-slot configs)
 */
async function generateCfg(parsedBaseline, stations, templateMap, db) {
  const parts = [];
  const defaultIoNo = parsedBaseline.ioSubsystemNo;

  // Determine which subnet names the new devices need (via their PN system's
  // controller) and which are missing from the baseline, so we can synthesise
  // the SUBNET + IRT_DOMAIN blocks PCS7 would have added.
  const usedNos = new Set();
  for (const [, st] of stations) usedNos.add(st.subsystemNo != null ? st.subsystemNo : defaultIoNo);
  const haveSubnetNames = new Set(parsedBaseline.subnetNames || []);
  const missingSubnets = [];
  for (const no of usedNos) {
    const ctrl = (parsedBaseline.ioControllers || []).find(c => c.no === no);
    const sn = ctrl ? ctrl.subnetName : null;
    if (sn && !haveSubnetNames.has(sn) && !missingSubnets.includes(sn)) missingSubnets.push(sn);
  }
  // Deterministic distinct NET_IDs for synthesised subnets (avoid clashing with
  // existing ones). PCS7 re-validates subnet IDs on import.
  const synthNetId = idx => ('02' + (0xC0 + idx).toString(16).toUpperCase().padStart(2, '0') + '00000001');

  // Strip trailing NEWLINES only — never trailing spaces, which PCS7 keeps on some
  // block lines (e.g. "END "). Using trimEnd() here would corrupt that fidelity.
  const trimNl = s => String(s).replace(/[\r\n]+$/, '');

  // 1. File header
  if (parsedBaseline.header) { parts.push(trimNl(parsedBaseline.header)); parts.push(''); }
  // 2. Station block
  if (parsedBaseline.station) { parts.push(trimNl(parsedBaseline.station)); parts.push(''); }
  // 3. Subnets (baseline + synthesised)
  for (const s of parsedBaseline.subnets) { parts.push(trimNl(s)); parts.push(''); }
  missingSubnets.forEach((sn, i) => {
    parts.push(blocks.subnetBlock({ name: sn, netIdHex: synthNetId(i) })); parts.push('');
  });
  // 4. IRT domains (baseline + synthesised for the new subnets)
  for (const d of parsedBaseline.irtDomains) { parts.push(trimNl(d)); parts.push(''); }
  for (const sn of missingSubnets) { parts.push(blocks.irtDomainBlock({ name: sn })); parts.push(''); }
  // 5. Rack blocks
  for (const r of parsedBaseline.racks) { parts.push(trimNl(r)); parts.push(''); }

  // 6. IOSUBSYSTEM "PROFINET IO system" descriptor blocks.
  //    Emit baseline ones verbatim, then synthesise any missing subsystem that a
  //    device now uses (e.g. baseline only declared PlantBus, a device lands on
  //    Fieldbus → PCS7 adds the Fieldbus descriptor).
  const baselineHeaders = parsedBaseline.ioSubsystemHeaders && parsedBaseline.ioSubsystemHeaders.length
    ? parsedBaseline.ioSubsystemHeaders
    : (parsedBaseline.ioSubsystemHeader ? [{ no: defaultIoNo, text: parsedBaseline.ioSubsystemHeader }] : []);
  const haveHeaderNos = new Set(baselineHeaders.map(h => h.no));
  for (const h of baselineHeaders) { parts.push(trimNl(h.text)); parts.push(''); }

  // Subsystem numbers actually used by devices
  const usedSubsystems = new Set();
  for (const [, station] of stations) {
    usedSubsystems.add(station.subsystemNo != null ? station.subsystemNo : defaultIoNo);
  }
  for (const no of [...usedSubsystems].sort((a, b) => a - b)) {
    if (haveHeaderNos.has(no)) continue;
    const ctrl = (parsedBaseline.ioControllers || []).find(c => c.no === no);
    const subnetName = ctrl ? ctrl.subnetName : `PN System ${no}`;
    parts.push(blocks.subsystemHeaderBlock({ no, subnetName }));
    parts.push('');
  }

  // 7. Device stations, sorted by address. Diagnostic addresses count down from
  //    just below the lowest diagnostic address already used in the baseline.
  //    Canvas positions are calculated using a left-to-right, top-to-bottom grid
  //    (max 15 devices per row, 92px horizontal gap, 100px vertical gap).
  const POS_X_START = 350, POS_Y_START = 250;
  const COLS = 15, STEP_X = 90, STEP_Y = 150;

  const diag = { ptr: (parsedBaseline.minDiag || 16384) - 1 };
  const warnings = [];   // missing-identifier diagnostics collected during render
  const sortedAddrs = [...stations.keys()].sort((a, b) => a - b);
  sortedAddrs.forEach((addr, idx) => {
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    stations.get(addr).posX = POS_X_START + col * STEP_X;
    stations.get(addr).posY = POS_Y_START + row * STEP_Y;
  });
  for (const addr of sortedAddrs) {
    const station = stations.get(addr);
    const ioNo = station.subsystemNo != null ? station.subsystemNo : defaultIoNo;
    parts.push(await renderStation(station, templateMap, ioNo, diag, warnings, db));
    parts.push('');
  }

  // Assemble. PCS7 .cfg files use CRLF line endings and end with the final block's
  // "END " (trailing space preserved) followed by one blank line. Strip any trailing
  // blank lines we accumulated, re-add the single blank, then convert LF → CRLF.
  const body = parts.join('\n').replace(/[\r\n]+$/, '');
  const cfg = (body + '\n\n').replace(/\r?\n/g, '\r\n');
  return { cfg, warnings };
}

module.exports = { generateCfg, ipToHex, hexToIp };
