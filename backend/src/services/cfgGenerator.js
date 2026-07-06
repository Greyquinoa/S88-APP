// services/cfgGenerator.js — Generate a PCS7 STEP7 .cfg file from baseline + station data
'use strict';
const { findTemplate, isGsdPaPath, defaultIdentifiers } = require('./hwAddressEngine');
const { loadFamilyAutoSlotConfig, buildSlotMap, buildSubslotMap, isSlotAutocreated, isSubslotAutocreated, resolveSlotOrderNo, resolveSubslotOrderNo } = require('./autoSlotResolver');
const blocks = require('./cfgBlocks');

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
 *   SYMBOL  Q , <byteOfs>, "<tag>", "<desc>"
 *
 * The output identifier ("Q", "QW", …) comes from the card catalogue, not a
 * hardcoded value — ET200SP DO cards need "Q" where this used to emit "O".
 */
function buildAddressLines(tpl, slot, warnings, ctx) {
  const channels = slot.channels ? [...slot.channels.values()] : [];
  const pipNo = slot.pipNo != null ? slot.pipNo : null;
  const isMixed = tpl && tpl.signal_type === 'MIXED';

  const addrLines = [];
  const symbolLines = [];

  if (tpl && tpl.input_bytes > 0 && slot.inputAddr != null && tpl.in_addr_fmt) {
    const fields = patchPip(fillAddrFmt(tpl.in_addr_fmt, slot.inputAddr), pipNo);
    addrLines.push('LOCAL_IN_ADDRESSES', `  ADDRESS  ${fields}`);
    // MIXED (DIQ8): only DI channels → input identifier; pass totalBytes=0 so byteOfs=0 for all (bit-packed)
    const inChannels = isMixed ? channels.filter(c => c.signalType === 'DI') : channels;
    const inIdent = resolveIdentifier(tpl, 'in', inChannels.some(c => c.tag), warnings, ctx);
    symbolLines.push(...buildSymbolLines(inIdent, inChannels, isMixed ? 0 : tpl.input_bytes, isMixed ? 1 : (tpl.channel_count || 0)));
  }
  if (tpl && tpl.output_bytes > 0 && slot.outputAddr != null && tpl.out_addr_fmt) {
    const fields = patchPip(fillAddrFmt(tpl.out_addr_fmt, slot.outputAddr), pipNo);
    addrLines.push('LOCAL_OUT_ADDRESSES', `  ADDRESS  ${fields}`);
    // MIXED (DIQ8): only DO channels → output identifier (catalogue-driven, e.g. "Q")
    const outChannels = isMixed ? channels.filter(c => c.signalType === 'DO') : channels;
    const outIdent = resolveIdentifier(tpl, 'out', outChannels.some(c => c.tag), warnings, ctx);
    symbolLines.push(...buildSymbolLines(outIdent, outChannels, isMixed ? 0 : tpl.output_bytes, isMixed ? 1 : (tpl.channel_count || 0)));
  }

  // All address blocks first, then all SYMBOL lines — PCS7 requires this order
  return [...addrLines, ...symbolLines];
}

/**
 * Build PARAMETER block lines from a template (param_template already indented).
 * If potentialGroup is provided ("NEW_GROUP" | "LEFT_MODULE"), the POTENTIAL_GROUP
 * line is injected/replaced inside the block (ET200SP-only).
 */
function buildParamLines(tpl, potentialGroup) {
  const hasTpl = tpl && tpl.param_template;
  if (!potentialGroup && !hasTpl) return null;

  let lines = hasTpl ? tpl.param_template.split('\n') : [];

  if (potentialGroup) {
    const pgLine = `  POTENTIAL_GROUP, "${potentialGroup}"`;
    const idx = lines.findIndex(l => l.trimStart().startsWith('POTENTIAL_GROUP'));
    if (idx >= 0) {
      lines[idx] = pgLine;
    } else {
      lines.push(pgLine);
    }
  }

  return ['PARAMETER', ...lines];
}

/**
 * Render one full device section (the IM + all submodules + I/O modules) for an
 * ET200SP-family station, reproducing the structure PCS7 exports.
 *
 * @param diag - { ptr } mutable diagnostic-address counter (counts down)
 * @param warnings - mutable array collecting missing-identifier diagnostics
 * @param autoSlotConfig - Auto-slot configuration from database (optional)
 */
function renderEt200sp(station, templateMap, ioNo, diag, warnings, autoSlotConfig) {
  const out = [];
  const addr      = station.address;
  const name      = deviceName(station);
  const hexIp     = ipToHex(station.ip);
  const hexRouter = station.routerAddress ? ipToHex(station.routerAddress) : null;

  const headSlot = station.slots.get(0);
  const headTpl  = headSlot ? findTemplate(templateMap, headSlot.orderNo) : null;
  const imOrder  = headSlot ? headSlot.orderNo : '6ES7 155-6AU00-0CN0';
  const imVer    = headTpl && headTpl.version ? headTpl.version : 'V4.2';
  const ifaceOrder = blocks.ifaceOrderString(imOrder, imVer);

  // Device header + SLOT 0 + interface + auto-created subslots from config
  out.push(blocks.deviceHeaderBlock({ ioNo, addr, imOrder, imVersion: imVer, name, posX: station.posX, posY: station.posY }));
  out.push(blocks.slot0Block({ ioNo, addr, imOrder, name, hexIp, hexRouter, diag: diag.ptr-- }));
  out.push(blocks.ifaceBlock({ ioNo, addr, ifaceOrder, diag: diag.ptr-- }));

  // Auto-create subslots (ports) from config
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.subslots) {
      for (const subslot of slot0Config.subslots) {
        if (subslot.type === 'port' && subslot.order_no) {
          out.push(blocks.portBlock({
            ioNo, addr, subslot: subslot.subslot,
            portLabel: subslot.port_label,
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
    out.push(blocks.ioModuleBlock({
      ioNo, addr, slot: slotNo,
      order: slot.orderNo,
      version: tpl && tpl.version ? tpl.version : '',
      name: slot.name,
      redundant: !NON_REDUNDANT_ORDERS.has(slot.orderNo),
      addressLines: buildAddressLines(tpl, slot, warnings, { addr, slot: slotNo, order: slot.orderNo }),
      paramLines: buildParamLines(tpl, slot.potentialGroup || null),
    }));
  }

  // PCS7 always inserts the server module as the last slot — add it if the IO
  // list did not already include one. Server module order is hardcoded (not DB-configurable).
  if (!hasServer) {
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
 */
function renderCfuPa(station, templateMap, ioNo, diag, warnings, autoSlotConfig) {
  const out = [];
  const addr      = station.address;
  const name      = deviceName(station);
  const hexIp     = ipToHex(station.ip);
  const hexRouter = station.routerAddress ? ipToHex(station.routerAddress) : null;

  const headSlot = station.slots.get(0);
  const headTpl  = headSlot ? findTemplate(templateMap, headSlot.orderNo) : null;
  const imOrder  = headSlot ? headSlot.orderNo : 'V_2_0_PA:6ES7 655-5PX11-0XX0';
  const imVer    = headTpl && headTpl.version ? headTpl.version : 'V2.0';

  // Resolve slot 0 order from config (explicit order_no from DB)
  let slot0Order = imOrder;
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.order_no) {
      slot0Order = slot0Config.order_no;
    }
  }

  // Device header + Slot 0 + IFACE + auto-created subslots from config
  out.push(blocks.cfuPaDeviceHeaderBlock({ ioNo, addr, imOrder, imVersion: imVer, name, posX: station.posX, posY: station.posY }));
  out.push(blocks.cfuPaSlot0Block({ ioNo, addr, slot0Order, name, hexIp, hexRouter, diag: diag.ptr-- }));
  out.push(blocks.cfuPaIfaceBlock({ ioNo, addr, diag: diag.ptr-- }));

  // Auto-create subslots (ports) from config
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0Config = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0Config && slot0Config.subslots) {
      for (const subslot of slot0Config.subslots) {
        if (subslot.type === 'port' && subslot.order_no) {
          out.push(blocks.portBlock({
            ioNo, addr, subslot: subslot.subslot,
            portLabel: subslot.port_label,
            portOrder: subslot.order_no,
            diag: diag.ptr--
          }));
        }
      }
    }
  }

  // Slot 1 — DIQ8 (digital, user-facing, address already allocated)
  const slot1 = station.slots.get(1);
  const slot1Tpl = slot1 ? findTemplate(templateMap, slot1.orderNo) : null;
  if (slot1) {
    out.push(blocks.ioModuleBlock({
      ioNo, addr, slot: 1,
      order: slot1 ? slot1.orderNo : '_S7H_HSP_CFU_PA_V2_0_DI8_DQ8_CT',
      version: '',
      name: slot1 ? slot1.name : 'DIQ8 DC24V/0.5A',
      redundant: false,
      addressLines: buildAddressLines(slot1Tpl, slot1, warnings, { addr, slot: 1, order: slot1.orderNo }),
      paramLines: slot1Tpl ? buildParamLines(slot1Tpl, null) : null,
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
        // GSD-path fallback: construct ADDRESS line directly. Identifiers come from
        // the card catalogue when a template exists, else the PA defaults (I / Q).
        const ch = channelsBySubslot.get(fi);
        const inIdent = resolveIdentifier(tpl, 'in', !!(ch && ch.tag), warnings, { addr, slot: slotNo, order: slot.orderNo });
        ssAddressLines = [
          'LOCAL_IN_ADDRESSES',
          `  ADDRESS  ${ssInAddr}, 0, ${perSubslotBytes}, 0, ${pipNo}, 0`,
        ];
        if (ch && ch.tag) {
          ssAddressLines.push(`SYMBOL  ${inIdent} , 0, "${ch.tag}", "${ch.desc || ''}"`);
        }
        if (perSubslotOutBytes > 0 && ssOutAddr != null) {
          const outIdent = resolveIdentifier(tpl, 'out', !!(ch && ch.tag), warnings, { addr, slot: slotNo, order: slot.orderNo });
          ssAddressLines.push('LOCAL_OUT_ADDRESSES', `  ADDRESS  ${ssOutAddr}, 0, ${perSubslotOutBytes}, 0, ${pipNo}, 0`);
          if (ch && ch.tag) {
            ssAddressLines.push(`SYMBOL  ${outIdent} , 0, "${ch.tag}", "${ch.desc || ''}"`);
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
function renderScalance(station, templateMap, ioNo, diag) {
  const addr   = station.address;
  const hexIp  = ipToHex(station.ip);
  const name   = deviceName(station);

  const headSlot = station.slots.get(0);
  const headTpl  = headSlot ? findTemplate(templateMap, headSlot.orderNo) : null;

  const gsdmlFile = headTpl && headTpl.gsdml_file ? headTpl.gsdml_file : '';
  const dapId     = headTpl && headTpl.dap_id     ? headTpl.dap_id     : '';
  const gsdmlPath = dapId ? `${gsdmlFile}<DAP ${dapId}>` : gsdmlFile;
  const version   = headTpl && headTpl.version    ? headTpl.version    : '';
  const mlfb      = headSlot ? headSlot.orderNo : (headTpl ? headTpl.order_no : '');

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
function renderStation(station, templateMap, ioNo, diag, warnings, db) {
  const headSlot = station.slots.get(0) ||
    station.slots.get([...station.slots.keys()].sort((a, b) => a - b)[0]);
  const headTpl  = headSlot ? findTemplate(templateMap, headSlot.orderNo) : null;
  const family   = headTpl ? headTpl.family : 'ET200SP';

  // Load auto-slot config from database
  const autoSlotConfig = db ? loadFamilyAutoSlotConfig(db, family) : null;

  if (family === 'CFU_PA') {
    return renderCfuPa(station, templateMap, ioNo, diag, warnings, autoSlotConfig);
  }

  if (family === 'Scalance') {
    return renderScalance(station, templateMap, ioNo, diag);
  }

  if (family === 'ET200SP') {
    return renderEt200sp(station, templateMap, ioNo, diag, warnings, autoSlotConfig);
  }

  // Generic fallback (non-ET200SP). Minimal but structurally valid.
  const addr      = station.address;
  const name      = deviceName(station);
  const hexIp     = ipToHex(station.ip);
  const hexRouter = station.routerAddress ? ipToHex(station.routerAddress) : null;
  const imOrder = headSlot ? headSlot.orderNo : 'UNKNOWN';
  const imVer = headTpl && headTpl.version ? headTpl.version : '';
  const out = [];
  out.push(blocks.deviceHeaderBlock({ ioNo, addr, imOrder, imVersion: imVer, name, posX: station.posX, posY: station.posY }));
  out.push(blocks.slot0Block({ ioNo, addr, imOrder, name, hexIp, hexRouter, diag: diag.ptr-- }));
  const ioSlots = [...station.slots.keys()].filter(s => s !== 0).sort((a, b) => a - b);
  for (const slotNo of ioSlots) {
    const slot = station.slots.get(slotNo);
    const tpl  = findTemplate(templateMap, slot.orderNo);
    out.push(blocks.ioModuleBlock({
      ioNo, addr, slot: slotNo,
      order: slot.orderNo,
      version: tpl && tpl.version ? tpl.version : '',
      name: slot.name,
      redundant: false,
      addressLines: buildAddressLines(tpl, slot, warnings, { addr, slot: slotNo, order: slot.orderNo }),
      paramLines: buildParamLines(tpl),
    }));
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
function generateCfg(parsedBaseline, stations, templateMap, db) {
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
    parts.push(renderStation(station, templateMap, ioNo, diag, warnings, db));
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
