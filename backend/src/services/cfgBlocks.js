// services/cfgBlocks.js — Full PCS7/STEP7 property-block templates for generated devices.
//
// These reproduce the EXACT block structure PCS7 itself exports (validated against
// a golden as01_final.cfg). The generator fills only the genuinely per-instance
// values (subsystem no, IOADDRESS, device/module name, order no, IP, addresses,
// diagnostic addresses, ASSET_ID GUIDs); everything else is verbatim what PCS7
// produces so the file re-imports without warnings.
'use strict';

const crypto = require('crypto');

/** Fresh 32-char uppercase hex GUID (PCS7 ASSET_ID format). */
function newGuid() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

/**
 * Derive the interface (IFACE) submodule order string for an IM head.
 *   "6ES7 155-6AU00-0CN0" + "V4.2" -> "_S7H_HSP_155_6AU00_0CN0_V4_2_IFACE_CT"
 */
function ifaceOrderString(imOrder, imVersion) {
  const core = String(imOrder).replace(/^6ES7\s+/i, '').replace(/[^A-Za-z0-9]+/g, '_');
  const ver  = String(imVersion || '').replace(/[^A-Za-z0-9]+/g, '_'); // V4.2 -> V4_2
  return `_S7H_HSP_${core}_${ver}_IFACE_CT`;
}

// ── Device header block (the IM "station" object) ─────────────────────────────
function deviceHeaderBlock({ ioNo, addr, imOrder, imVersion, name, posX, posY }) {
  const ver = imVersion ? ` "${imVersion}"` : '';
  // NOTE: PCS7 writes THIS block's BEGIN/END WITHOUT a trailing space (unlike the
  // AUTOCREATED submodule blocks below, which do have one). Matches as01_final.cfg.
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, "${imOrder}"${ver}, "${name}"`,
    `BEGIN`,
    `  ASSET_ID "${newGuid()}"`,
    `  INSTALLATION_DATE ""`,
    `  PN_EQUIDISTANT_CYCLE "0"`,
    `  HAS_SHARED_SUBMODULES "0"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  PLANT_LOCATION ""`,
    `  PN_MSOT "30"`,
    `  PN_FIXED_UPDATE_TIME "0"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "1"`,
    `  IRT_DOMAIN_NAME "syncdomain-default"`,
    `  POS_X "${posX != null ? posX : 609}"`,
    `  POS_Y "${posY != null ? posY : 247}"`,
    `  SIZE_X "78"`,
    `  SIZE_Y "64"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  PN_DEVICE_SCF_L "32"`,
    `  CAX_APP_ID ""`,
    `  PN_GENERATED_SCF "0"`,
    `  SHARED_PROXY_DATA ""`,
    `  PN_WATCHDOGFACTOR "3"`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  LIST_SUBMODULES ""`,
    `  COMMENT ""`,
    `  PN_DEVICE_UPD_TIME "2"`,
    `  PLANT_DESIGNATION ""`,
    `  IRT_GROUP_NR "1"`,
    `END`,
  ].join('\n');
}

// ── SLOT 0 (IM head, AUTOCREATED) with IP + diagnostic address ────────────────
function slot0Block({ ioNo, addr, imOrder, name, hexIp, hexRouter, diag, mlfb }) {
  const lines = [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, "${imOrder}", "${name}"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  MACADDRESS "080006010000"`,
    `  IPACTIVE "1"`,
    `  IPADDRESS "${hexIp}"`,
    `  SUBNETMASK "FFFFFF00"`,
    `  ROUTERADDRESS "${hexRouter || hexIp}"`,
    `  ROUTERACTIVE "0"`,
    `  ISOACTIVE "0"`,
    `  PN_IPADDR_MODE_DEV "0"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  IRT_GROUP_NR "1"`,
  ];
  if (mlfb) {
    lines.push(`  MLFB "${mlfb}"`);
  }
  lines.push(
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `PARAMETER `,
    `  Option_Handling, "0"`,
    `END `,
  );
  return lines.join('\n');
}

// ── SLOT 0 SUBSLOT 1 (PN-IO interface submodule, AUTOCREATED) ─────────────────
function ifaceBlock({ ioNo, addr, ifaceOrder, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, SUBSLOT 1, "${ifaceOrder}", "PN-IO"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  PN_TI "0"`,
    `  PN_TO "0"`,
    `  PN_EQUIDISTANT_CYCLE "0"`,
    `  NETWORK_COMPONENT_DIAG "0"`,
    `  IRT_DETERMINATION_LEVEL "1"`,
    `  NO_OF_EXT_CONTROLLER "0"`,
    `  IRT_CACF "1"`,
    `  NO_SET_TO_MAX "0"`,
    `  IRT_SYNC_FLAG "65280"`,
    `  IRT_DEVICE_CYCLE_GROUP ""`,
    `  EXT_SENDCLOCK "32"`,
    `  PN_DEVICE_FSU_PRIORITY "0"`,
    `  MRP_CONFIGURATION "mrpdomain-1\t0"`,
    `  IRT_APP_TASK_NO "0"`,
    `  IRT_PTCP_SUBDOMAIN_ID_DATA ""`,
    `  PN_MIN_VERSION ""`,
    `  IRT_TI_TO_MODE "0"`,
    `  IRT_PTCP_SUBDOMAIN_ID_HASH ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  PN_ALARM_FILTER "0"`,
    `  IRT_OPTIMIZATION_STRUCT ""`,
    `  IRT_DOMAIN_NAME "syncdomain-default"`,
    `  POS_X "0"`,
    `  IRT_T_DC "0"`,
    `  IRT_SENDCLOCK_FACTOR "32"`,
    `  POS_Y "0"`,
    `  MRP_MULTI_CONFIGURATION "6D 72 70 64 6F 6D 61 69 6E 2D 31 09 30 09 00"`,
    `  MRP_DIAGNOSIS "0"`,
    `  SIZE_X "0"`,
    `  MRP_MULTI_DIAGNOSIS "0"`,
    `  SIZE_Y "0"`,
    `  MRP_INSTANCES "0"`,
    `  PNDX_MODE "0"`,
    `  CAX_APP_ID ""`,
    `  IRT_T_DC_BASE "1"`,
    `  OBJECT_COPYABLE "0"`,
    `  IRT_T_DC_MIN "8"`,
    `  CREATOR ""`,
    `  IRT_T_DC_MAX "128"`,
    `  IRT_T_IO_INPUT_MAX "0"`,
    `  COMMENT ""`,
    `  IRT_T_IO_OUTPUT_MAX "0"`,
    `  IRT_T_IO_INPUT_MIN "0"`,
    `  IRT_T_IO_OUTPUT_MIN "0"`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `END `,
  ].join('\n');
}

// ── SLOT 0 SUBSLOT 2/3 (RJ45 port submodule, AUTOCREATED) ─────────────────────
function portBlock({ ioNo, addr, subslot, portLabel, portOrder, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, SUBSLOT ${subslot}, "${portOrder}", "${portLabel}"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  LINE_COMMENT ""`,
    `  INSTALLATION_DATE ""`,
    `  LINK_STATE_DIAG_NEW_VERSION "0"`,
    `  LINE_DELAY "600"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  PLANT_LOCATION ""`,
    `  LINK_STATE_DIAG_REQUIRE "0"`,
    `  ETH_MEDIUM_RUNTIME_CHECK "1"`,
    `  PORT_DEACTIVATED "0"`,
    `  MRP_DOMAIN ""`,
    `  PORT_DOMAIN_BOUNDARY "0"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  PORT_EXCHANGE_TYPE "0"`,
    `  PORT_DCP_BOUNDARY "0"`,
    `  POS_X "0"`,
    `  PORT_LLDP_BOUNDARY "0"`,
    `  POS_Y "0"`,
    `  PN_RINGSTATUS_STRUCT ""`,
    `  SIZE_X "0"`,
    `  IRT_LINE_RX_DELAY "0"`,
    `  SIZE_Y "0"`,
    `  PNDX_MODE "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  MULTICAST_BOUNDARY "0"`,
    `  ETHERNET_MED_DUP "8"`,
    `  PLANT_DESIGNATION ""`,
    `  LINE_DELAY_SELECTOR "0"`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `END `,
  ].join('\n');
}

/**
 * I/O module block body (the common property block PCS7 emits for an I/O module).
 * Variable parts: order/version/name header, REDUNDANCY presence, address line(s),
 * optional PARAMETER block.
 *
 * @param addressLines  array of strings already formed, e.g.
 *                       ['LOCAL_OUT_ADDRESSES', '  ADDRESS  512, 0, 8, 0, 2, 0']
 * @param paramLines    optional array, e.g. ['PARAMETER', '  POTENTIAL_GROUP, "NEW_GROUP"']
 */
function ioModuleBlock({ ioNo, addr, slot, order, version, name, redundant, addressLines, paramLines, mlfb }) {
  const ver = version ? ` "${version}"` : '';
  const out = [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT ${slot}, "${order}"${ver}, "${name}"`,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  INSTALLATION_DATE ""`,
    `  CPU_NO "1"`,
    `  ALARM_OB_NO "40"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  PLANT_LOCATION ""`,
    `  OBJECT_REMOVEABLE "1"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
  ];
  if (redundant) out.push(`  REDUNDANCY`, `  BEGIN`, `  END`);
  out.push(
    `  SIZE_X "0"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  PLANT_DESIGNATION ""`,
  );
  // Include MLFB (module type ID) if present
  if (mlfb) {
    out.push(`  MLFB "${mlfb}"`);
  }
  if (addressLines && addressLines.length) {
    // Keyword lines (LOCAL_IN_ADDRESSES, LOCAL_OUT_ADDRESSES, PARAMETER) get trailing space
    out.push(...addressLines.map(l =>
      /^(LOCAL_IN_ADDRESSES|LOCAL_OUT_ADDRESSES|PARAMETER)$/.test(l) ? l + ' ' : l
    ));
  }
  if (paramLines && paramLines.length) {
    out.push(...paramLines.map(l => /^PARAMETER$/.test(l) ? l + ' ' : l));
  }
  out.push(`END `);
  return out.join('\n');
}

// ── ET200SP auto-added Server module (last slot) ──────────────────────────────
function serverModuleBlock({ ioNo, addr, slot, diag }) {
  return ioModuleBlock({
    ioNo, addr, slot,
    order: 'V1_1:6ES7 193-6PA00-0AA0',
    version: 'V1.1',
    name: 'Server module V1.1',
    redundant: true,
    addressLines: [`LOCAL_IN_ADDRESSES`, `  ADDRESS  ${diag}, 0, 0, 0, 1, 0`],
    // trailing space added by ioModuleBlock's keyword mapper
    paramLines: null,
  });
}

// ── CFU_PA block builders ─────────────────────────────────────────────────────
// Reproduced from a validated CFG file. Only per-instance values differ from the
// golden (ASSET_ID, IOADDRESS, IP, diagnostic addresses, canvas position).

function cfuPaDeviceHeaderBlock({ ioNo, addr, imOrder, imVersion, name, posX, posY }) {
  const ver = imVersion ? ` "${imVersion}"` : '';
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, "${imOrder}"${ver}, "${name}"`,
    `BEGIN`,
    `  ASSET_ID "${newGuid()}"`,
    `  INSTALLATION_DATE ""`,
    `  HAS_SHARED_SUBMODULES "0"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  PDM_PARAM "1"`,
    `  PLANT_LOCATION ""`,
    `  PN_FIXED_UPDATE_TIME "0"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "1"`,
    `  IRT_DOMAIN_NAME "syncdomain-default"`,
    `  POS_X "${posX != null ? posX : 562}"`,
    `  POS_Y "${posY != null ? posY : 247}"`,
    `  IRT_FIBEROPTIC_CABLETYPE_P1 "0"`,
    `  SIZE_X "78"`,
    `  IRT_FIBEROPTIC_CABLETYPE_P2 "0"`,
    `  SIZE_Y "64"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  IRT_LINK_DELAY_P1 "600"`,
    `  IRT_LINK_DELAY_P2 "600"`,
    `  PN_DEVICE_SCF_L "32"`,
    `  CAX_APP_ID ""`,
    `  PN_GENERATED_SCF "0"`,
    `  SHARED_PROXY_DATA ""`,
    `  PN_WATCHDOGFACTOR "3"`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  LIST_SUBMODULES ""`,
    `  COMMENT ""`,
    `  PN_DEVICE_UPD_TIME "2"`,
    `  PLANT_DESIGNATION ""`,
    `  IRT_GROUP_NR "1"`,
    `END`,
  ].join('\n');
}

// CFU_PA SLOT 0 (ethernet head, AUTOCREATED)
function cfuPaSlot0Block({ ioNo, addr, slot0Order, name, hexIp, hexRouter, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, "${slot0Order}", "${name}"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  MACADDRESS "080006010000"`,
    `  IPACTIVE "1"`,
    `  IPADDRESS "${hexIp}"`,
    `  SUBNETMASK "FFFFFF00"`,
    `  ROUTERADDRESS "${hexRouter || hexIp}"`,
    `  ROUTERACTIVE "0"`,
    `  ISOACTIVE "0"`,
    `  EDGE_EVALUATION "0"`,
    `  PN_IPADDR_MODE_DEV "0"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  TIMESTAMP_ACTIVATED "0"`,
    `  HIGH_PRECISION_TIMESTAMP_ACTIVATED "0"`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `PARAMETER `,
    `  RESET_SWITCH_ENABLE, "1"`,
    `END `,
  ].join('\n');
}

// CFU_PA SLOT 0 SUBSLOT 1 (IFACE, AUTOCREATED) — fixed order string for V2.0
function cfuPaIfaceBlock({ ioNo, addr, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, SUBSLOT 1, "_S7H_HSP_CFU_PA_V2_0_IFACE_CT", "${addr}"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  NETWORK_COMPONENT_DIAG "1"`,
    `  IRT_DETERMINATION_LEVEL "1"`,
    `  NO_OF_EXT_CONTROLLER "0"`,
    `  NO_SET_TO_MAX "0"`,
    `  IRT_SYNC_FLAG "65280"`,
    `  IRT_DEVICE_CYCLE_GROUP ""`,
    `  EXT_SENDCLOCK "32"`,
    `  PN_DEVICE_FSU_PRIORITY "0"`,
    `  MRP_CONFIGURATION "mrpdomain-1\t0"`,
    `  IRT_PTCP_SUBDOMAIN_ID_DATA ""`,
    `  PN_MIN_VERSION ""`,
    `  IRT_PTCP_SUBDOMAIN_ID_HASH ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  PN_ALARM_FILTER "0"`,
    `  IRT_OPTIMIZATION_STRUCT ""`,
    `  IRT_DOMAIN_NAME "syncdomain-default"`,
    `  POS_X "0"`,
    `  IRT_SENDCLOCK_FACTOR "32"`,
    `  POS_Y "0"`,
    `  MRP_MULTI_CONFIGURATION "6D 72 70 64 6F 6D 61 69 6E 2D 31 09 30 09 00"`,
    `  MRP_DIAGNOSIS "0"`,
    `  SIZE_X "0"`,
    `  MRP_MULTI_DIAGNOSIS "0"`,
    `  SIZE_Y "0"`,
    `  MRP_INSTANCES "0"`,
    `  PNDX_MODE "0"`,
    `  CAX_APP_ID ""`,
    `  PTCP_TIME_SYNC_ENABLED "0"`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `END `,
  ].join('\n');
}

// CFU_PA SLOT 2 (PA Master, AUTOCREATED — no process image on the master block itself)
function cfuPaPaMasterBlock({ ioNo, addr }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 2, "_S7H_HSP_CFU_PA_V2_0_PA_MASTER_CT", "PROFIBUS PA Master"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  SIZE_Y "0"`,
    `  PNDX_MODE "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  IRT_GROUP_NR "1"`,
    `END `,
  ].join('\n');
}

// CFU_PA SLOT 2 SUBSLOT 1 (param/diag block, AUTOCREATED, diagnostic address only)
function cfuPaPaMasterParamBlock({ ioNo, addr, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 2, SUBSLOT 1, "_S7H_HSP_CFU_PA_V2_0_SUB_PARAM_DIAG_CT", "PROFIBUS PA Master"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  CPU_NO "0"`,
    `  ALARM_OB_NO "40"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `PARAMETER `,
    `  Show_Alarms_DPV0, "1"`,
    `  Compare_Tags, "0"`,
    `END `,
  ].join('\n');
}

// CFU_PA SLOT 2 SUBSLOT 2 (status/notifications, AUTOCREATED)
// Fixed PCS7-internal addresses: 528 DI (4 bytes), 512 DQ (2 bytes) — not user-allocated.
function cfuPaPaMasterStatusBlock({ ioNo, addr, inAddr, outAddr }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 2, SUBSLOT 2, "_S7H_HSP_CFU_PA_V2_0_SUB_STATUS_NOTIF_CT", "Status + Notifications"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  CPU_NO "1"`,
    `  ALARM_OB_NO "40"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${inAddr}, 0, 4, 0, 0, 0`,
    `LOCAL_OUT_ADDRESSES `,
    `  ADDRESS  ${outAddr}, 0, 2, 0, 0, 0`,
    `END `,
  ].join('\n');
}

// ── CFU_PA Slot 3+ (PA field device slot header — one per PA device on bus) ────
// The slot header carries a diagnostic address (not a process image address).
// name is the PCS7 device name (truncated to 24 chars as PCS7 does).
function cfuPaPaSlotBlock({ ioNo, addr, slotNo, order, name, diag }) {
  const displayName = String(name || '').slice(0, 24);
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT ${slotNo}, "${order}", "${displayName}"`,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  PNO_IDENT_NO "0"`,
    `  WD_ON "1"`,
    `  PDM_PARAM "1"`,
    `  CBA_USAGE "0"`,
    `  GROUP_IDENT "0"`,
    `  NORMSLAVE_DP_MODE "0"`,
    `  OBJECT_REMOVEABLE "1"`,
    `  NORMSLAVE_PARAM_DATA "03 00 00 00 00"`,
    `  POS_X "0"`,
    `  GATEWAY_COMMENT ""`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  SIZE_Y "0"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  PHYSICAL_INTERFACE "0"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 2, 0`,
    `END `,
  ].join('\n');
}

// CFU_PA Slot 3+ Subslot 1 — signal/process data submodule.
//
// The submodule identifier, SLAVE_CFG_DATA, and NORMMODULE_REFERENCE are FIXED GSD
// constants per module class — they are not project-specific values:
//
//   "Analog Input (AI)short"  → id "148" (0x94), SLAVE_CFG_DATA "01 00 94", NORMMODULE_REFERENCE "1"
//   "Analog Input (AI)long"   → id "66"  (0x42), SLAVE_CFG_DATA "04 00 42 84 08 05", NORMMODULE_REFERENCE "2"
//   "SP (short)"              → id "164" (0xA4), SLAVE_CFG_DATA "01 00 A4", NORMMODULE_REFERENCE "1"
//
// These values are sourced from the Siemens GSD file for the PROFIBUS PA profile —
// they identify the DP telegram format, not anything project- or channel-specific.
const PA_SUBSLOT1_META = {
  'Analog Input (AI)short': { id: '148', slaveCfg: '01 00 94',          normRef: '1' },
  'Analog Input (AI)long':  { id: '66',  slaveCfg: '04 00 42 84 08 05', normRef: '2' },
  'SP (short)':             { id: '164', slaveCfg: '01 00 A4',          normRef: '1' },
};

function cfuPaPaSubslot1Block({ ioNo, addr, slotNo, subslotNo = 1, subslotOrder, addressLines }) {
  const meta = PA_SUBSLOT1_META[subslotOrder] || PA_SUBSLOT1_META['Analog Input (AI)short'];
  const out = [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT ${slotNo}, SUBSLOT ${subslotNo}, "${subslotOrder}", "${meta.id}"`,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  SLAVE_CFG_DATA "${meta.slaveCfg}"`,
    `  OBJECT_REMOVEABLE "1"`,
    `  RETAIN_LAST_VALUE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  NORMMODULE_PARAM_DATA "00 00"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "1"`,
    `  NORMMODULE_REFERENCE "${meta.normRef}"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
  ];
  if (addressLines && addressLines.length) {
    out.push(...addressLines.map(l =>
      /^(LOCAL_IN_ADDRESSES|LOCAL_OUT_ADDRESSES)$/.test(l) ? l + ' ' : l
    ));
  }
  out.push(`END `);
  return out.join('\n');
}

// CFU_PA Slot 3+ Service subslot (AUTOCREATED, diagnostic address only).
// subslotNo = channel_count + 1 (last subslot in the slot range).
function cfuPaPaSubslot2Block({ ioNo, addr, slotNo, subslotNo = 2, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT ${slotNo}, SUBSLOT ${subslotNo}, "_S7H_NORM_PDM_BUB_MODULE_CT", "Service"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  SIZE_Y "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `END `,
  ].join('\n');
}

// ── SUBNET block (synthesised when a device's subnet is missing from baseline) ─
function subnetBlock({ name, netIdHex }) {
  // netIdHex: 12 hex chars (6 bytes). Spaced form for NET_ID_2.
  const spaced = netIdHex.match(/.{2}/g).join(' ');
  return [
    `SUBNET INDUSTRIAL_ETHERNET , "${name}"`,
    `BEGIN `,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  NET_ID_2 "${spaced}"`,
    `  NET_ID "${netIdHex}"`,
    `END `,
  ].join('\n');
}

// ── IRT_DOMAIN block (synthesised alongside a synthesised subnet) ──────────────
function irtDomainBlock({ name }) {
  return [
    `IRT_DOMAIN  "${name}" "syncdomain-default"`,
    `BEGIN `,
    `  SENDCLOCKFACTOR "32"`,
    `  BANDWIDTHLEVEL "3"`,
    `  GROUP "1, IRT Cycle 1, 1, 0, 0, 0"`,
    `END `,
  ].join('\n');
}

// ── IOSUBSYSTEM "PROFINET IO system" descriptor (synthesised when missing) ────
function subsystemHeaderBlock({ no, subnetName, posX, posY, sizeX }) {
  return [
    `IOSUBSYSTEM ${no}, "${subnetName}: PROFINET IO system (${no})"`,
    `BEGIN `,
    `  OLD_DEBUG_FILENAME ""`,
    `  PN_PHASE_RELATION "65536"`,
    `  PN_MIN_VERSION ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "1"`,
    `  POS_X "${posX != null ? posX : 345}"`,
    `  POS_Y "${posY != null ? posY : 212}"`,
    `  SIZE_X "${sizeX != null ? sizeX : 403}"`,
    `  SIZE_Y "16"`,
    `  PN_USE_DEVICE_SPEC_UPD_TIME "1"`,
    `  SUBNET_NAME "${subnetName}"`,
    `  CAX_APP_ID ""`,
    `  DNS_CHECK "0"`,
    `  OBJECT_COPYABLE "1"`,
    `  PN_USER_DEF_UPD_TIME "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  IRT_GROUP_NR "1"`,
    `END `,
  ].join('\n');
}

// ── SCALANCE device blocks ────────────────────────────────────────────────────
// gsdmlPath = "GSDML-V2.42-...-SCALANCE_XC200-20230619.xml<DAP 87>"
// For the device header line PCS7 appends "EXTENDED" after the DAP suffix.

function scalanceDeviceHeaderBlock({ ioNo, addr, gsdmlPath, version, name, mlfb, posX, posY, meta }) {
  const ver      = version ? ` "${version}"` : '';
  const vendorId = meta && meta.PN_VENDOR_ID ? meta.PN_VENDOR_ID : '42';
  const deviceId = meta && meta.PN_DEVICE_ID ? meta.PN_DEVICE_ID : '';
  const minVer   = meta && meta.PN_MIN_VERSION ? meta.PN_MIN_VERSION : '';
  const hwRel    = meta && meta.PN_HW_RELEASE  ? meta.PN_HW_RELEASE  : '1';
  const swRel    = meta && meta.PN_SW_RELEASE  ? meta.PN_SW_RELEASE  : (version || '');
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, "${gsdmlPath}EXTENDED"${ver}, "${name}"`,
    `BEGIN`,
    `  ASSET_ID "${newGuid()}"`,
    `  INSTALLATION_DATE ""`,
    `  HAS_SHARED_SUBMODULES "0"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  PDM_PARAM "0"`,
    `  PLANT_LOCATION ""`,
    `  PN_HW_RELEASE "${hwRel}"`,
    `  PN_SW_RELEASE "${swRel}"`,
    `  PN_VENDOR_ID "${vendorId}"`,
    `  PN_FIXED_UPDATE_TIME "0"`,
    `  PN_MIN_VERSION "${minVer}"`,
    `  PN_DEVICE_ID "${deviceId}"`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "1"`,
    `  POS_X "${posX != null ? posX : 355}"`,
    `  POS_Y "${posY != null ? posY : 245}"`,
    `  SIZE_X "78"`,
    `  SIZE_Y "64"`,
    `  MODULE_ADD_FLAGS "0"`,
    `  PN_DEVICE_SCF_L "32"`,
    `  CAX_APP_ID ""`,
    `  PN_GENERATED_SCF "0"`,
    `  SHARED_PROXY_DATA ""`,
    `  PN_WATCHDOGFACTOR "3"`,
    `  OBJECT_COPYABLE "1"`,
    `  CREATOR ""`,
    `  LIST_SUBMODULES ""`,
    `  COMMENT ""`,
    `  PN_DEVICE_UPD_TIME "128"`,
    `  CONFIG_FILE_NAME ""`,
    `  CONFIG_FILE_DATA ""`,
    `  PLANT_DESIGNATION ""`,
    `  IRT_GROUP_NR "1"`,
    `END`,
  ].join('\n');
}

function scalanceSlot0Block({ ioNo, addr, gsdmlPath, name, hexIp, mlfb, diag, meta }) {
  const minVer = meta && meta.PN_MIN_VERSION ? meta.PN_MIN_VERSION : '';
  const hwRel  = meta && meta.PN_HW_RELEASE  ? meta.PN_HW_RELEASE  : '1';
  const swRel  = meta && meta.PN_SW_RELEASE  ? meta.PN_SW_RELEASE  : '';
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, "${gsdmlPath}", "${name}"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  MACADDRESS "080006010000"`,
    `  IPACTIVE "1"`,
    `  IPADDRESS "${hexIp}"`,
    `  SUBNETMASK "FFFFFF00"`,
    `  ROUTERADDRESS "${hexIp}"`,
    `  ROUTERACTIVE "0"`,
    `  ISOACTIVE "0"`,
    `  PN_TI "0"`,
    `  PN_TO "0"`,
    `  PN_EQUIDISTANT_CYCLE "0"`,
    `  COUPLING_UID ""`,
    `  PN_MODULE_IDENTNUMBER "135"`,
    `  PN_HW_RELEASE "${hwRel}"`,
    `  PN_SUBMODULE_IDENTNUMBER "65537"`,
    `  PN_SW_RELEASE "${swRel}"`,
    `  PN_IPADDR_MODE_DEV "0"`,
    `  PN_MIN_VERSION "${minVer}"`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  POS_X "0"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  SIZE_Y "0"`,
    `  MLFB "${mlfb}"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `PARAMETER `,
    `  "TOK_ParaRecDataItem_REF_DS4_Text_Var1 PRDIndex 33 DataID 48", "TOK_REF_DS33_LocalConfig"`,
    `  "TOK_ParaRecDataItem_REF_DS4_Text_Var2 PRDIndex 33 DataID 56", "TOK_REF_DS33_NotMotitored"`,
    `  "TOK_ParaRecDataItem_REF_DS4_Text_Var3 PRDIndex 33 DataID 64", "0"`,
    `END `,
  ].join('\n');
}

function scalancePnioBlock({ ioNo, addr, diag }) {
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, SUBSLOT 1, "_S7H_SCALANCE_INTERFACE_EXTDS2_CT", "PN-IO"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  PN_TI "0"`,
    `  INSTALLATION_DATE ""`,
    `  PN_TO "0"`,
    `  NETWORK_COMPONENT_DIAG "0"`,
    `  IRT_DETERMINATION_LEVEL "1"`,
    `  PN_EQUIDISTANT_CYCLE "0"`,
    `  NO_OF_EXT_CONTROLLER "0"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  NO_SET_TO_MAX "0"`,
    `  IRT_SYNC_FLAG "65280"`,
    `  IRT_CACF "1"`,
    `  IRT_DEVICE_CYCLE_GROUP ""`,
    `  EXT_SENDCLOCK "32"`,
    `  PN_DEVICE_FSU_PRIORITY "0"`,
    `  PLANT_LOCATION ""`,
    `  IRT_ADJUST_TITO "1"`,
    `  IRT_PN_USER_RATIO "30"`,
    `  MRP_CONFIGURATION "mrpdomain-1\t0"`,
    `  PN_SUBMODULE_IDENTNUMBER "257"`,
    `  IRT_PTCP_SUBDOMAIN_ID_DATA ""`,
    `  PN_MIN_VERSION "V2.0"`,
    `  IRT_PTCP_SUBDOMAIN_ID_HASH ""`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  IRT_BANDWIDTH_OVERRIDE_ALLOWED "0"`,
    `  IRT_OPTIMIZATION_STRUCT ""`,
    `  IRT_DOMAIN_NAME "syncdomain-default"`,
    `  POS_X "0"`,
    `  IRT_SENDCLOCK_FACTOR "32"`,
    `  POS_Y "0"`,
    `  SIZE_X "0"`,
    `  ALTERNATIVE_REDUNDANCY_ENABLE "0"`,
    `  MRP_MULTI_CONFIGURATION "6D 72 70 64 6F 6D 61 69 6E 2D 31 09 30 09 6D 72 70 64 6F 6D 61 69 6E 2D 32 09 30 09 6D 72 70 64 6F 6D 61 69 6E 2D 33 09 30 09 6D 72 70 64 6F 6D 61 69 6E 2D 34 09 30 09 00"`,
    `  MRP_DIAGNOSIS "0"`,
    `  SIZE_Y "0"`,
    `  MRP_MULTI_DIAGNOSIS "0"`,
    `  MRP_INSTANCES "0"`,
    `  PNDX_MODE "0"`,
    `  CAX_APP_ID ""`,
    `  PTCP_TIME_SYNC_ENABLED "0"`,
    `  IRT_PN_RATIO "-1"`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  PLANT_DESIGNATION ""`,
    `  IRT_SYNC_WHOLE_DEVICE "1"`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `PARAMETER `,
    `  "TOK_ParaRecDataItem_REF_DS3_Text_Var1 PRDIndex 3 DataID 72", "TOK_REF_DS3_Var1_0"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Interface_Text_Var1 PRDIndex 12309 DataID 48", "TOK_REF_DS_LD_Interface_Var1_255"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Interface_Text_Var2 PRDIndex 12309 DataID 56", "TOK_REF_DS_LD_Interface_Var2_1"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Interface_Text_Var3 PRDIndex 12309 DataID 64", "TOK_REF_DS_LD_Interface_Var3_1"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Interface_Text_Var4 PRDIndex 12309 DataID 72", "0"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Interface_Text_Var5 PRDIndex 12309 DataID 80", "2"`,
    `  "TOK_ParaRecDataItem_REF_DS_PM_Interface_Text_Var1 PRDIndex 12312 DataID 48", "TOK_REF_DS_PM_Interface_Var1_255"`,
    `  "TOK_ParaRecDataItem_REF_DS_PM_Interface_Text_Var2 PRDIndex 12312 DataID 56", "TOK_REF_DS_PM_Interface_Var2_0"`,
    `  "TOK_ParaRecDataItem_REF_DS_PM_Interface_Text_Var3 PRDIndex 12312 DataID 64", "1"`,
    `  "TOK_ParaRecDataItem_REF_DS_PM_Interface_Text_Var4 PRDIndex 12312 DataID 80", "0"`,
    `END `,
  ].join('\n');
}

function scalancePortBlock({ ioNo, addr, gsdmlPath, subslot, portName, medium, diag }) {
  const isFO        = medium && medium.toUpperCase() === 'FO';
  const lineDelay   = isFO ? '18000' : '600';
  const rtCheck     = isFO ? '0' : '1';
  const fiberType   = isFO ? '2' : '0';
  return [
    `IOSUBSYSTEM ${ioNo}, IOADDRESS ${addr}, SLOT 0, SUBSLOT ${subslot}, "${gsdmlPath}", "${portName}"`,
    `AUTOCREATED `,
    `BEGIN `,
    `  ASSET_ID "${newGuid()}"`,
    `  IRT_FIBEROPTIC_CABLETYPE "${isFO ? '1' : '0'}"`,
    `  LINE_COMMENT ""`,
    `  INSTALLATION_DATE ""`,
    `  LINK_STATE_DIAG_NEW_VERSION "0"`,
    `  LINE_DELAY "${lineDelay}"`,
    `  S7H_IRT_PORT_THRESHOLD_SFP_L "0"`,
    `  ADDITIONAL_INFORMATION ""`,
    `  S7H_IRT_PORT_TXF_SFP_L "0"`,
    `  S7H_IRT_PORT_RXL_SFP_L "0"`,
    `  PLANT_LOCATION ""`,
    `  LINK_STATE_DIAG_REQUIRE "0"`,
    `  ETH_MEDIUM_RUNTIME_CHECK "${rtCheck}"`,
    `  PN_MRPI_DOMAIN_ID "0"`,
    `  PN_MRPI_DOMAIN_NAME ""`,
    `  PORT_DEACTIVATED "0"`,
    `  PN_MRPI_ROLE "0"`,
    `  PN_MRPI_DIAGNOSIS "0"`,
    `  PN_MRPI_STARTUP "2"`,
    `  MRP_DOMAIN ""`,
    `  PORT_DOMAIN_BOUNDARY "0"`,
    `  PN_MIN_VERSION "V1.0"`,
    `  GUI_HIDE "0"`,
    `  OBJECT_REMOVEABLE "0"`,
    `  PORT_DCP_BOUNDARY "0"`,
    `  POS_X "0"`,
    `  PORT_LLDP_BOUNDARY "0"`,
    `  POS_Y "0"`,
    `  PN_RINGSTATUS_STRUCT ""`,
    `  SIZE_X "0"`,
    `  IRT_LINE_RX_DELAY "0"`,
    `  SIZE_Y "0"`,
    `  MRP_INSTANCE_NUMBER "0"`,
    `  PNDX_MODE "0"`,
    `  CAX_APP_ID ""`,
    `  OBJECT_COPYABLE "0"`,
    `  CREATOR ""`,
    `  COMMENT ""`,
    `  MULTICAST_BOUNDARY "0"`,
    `  ETHERNET_MED_DUP "8"`,
    `  PLANT_DESIGNATION ""`,
    `  IRT_FIBEROPTIC_TYPE "${fiberType}"`,
    `  LINE_DELAY_SELECTOR "0"`,
    `  IRT_GROUP_NR "1"`,
    `LOCAL_IN_ADDRESSES `,
    `  ADDRESS  ${diag}, 0, 0, 0, 0, 0`,
    `PARAMETER `,
    `  "TOK_ParaRecDataItem_REF_DS_NNM2_Port_Text_Var1 PRDIndex 32 DataID 48", "TOK_REF_DS_NNM2_Var1_255"`,
    `  "TOK_ParaRecDataItem_REF_DS_NNM2_Port_Text_Var2 PRDIndex 32 DataID 64", "0"`,
    `  "TOK_ParaRecDataItem_REF_DS_NNM3_Port_Text_Var3 PRDIndex 32 DataID 80", "TOK_REF_DS_NNM3_Var3_0"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Port_Text_Var1 PRDIndex 12310 DataID 48", "TOK_REF_DS_LD_Port_Var1_2"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Port_Text_Var2 PRDIndex 12310 DataID 56", "TOK_REF_DS_LD_Port_Var2_2"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Port_Text_Var3 PRDIndex 12310 DataID 64", "TOK_REF_DS_LD_Port_Var3_2"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Port_Text_Var4 PRDIndex 12310 DataID 72", "0"`,
    `  "TOK_ParaRecDataItem_REF_DS_LD_Port_Text_Var5 PRDIndex 12310 DataID 80", "2"`,
    `  "TOK_ParaRecDataItem_REF_DS_PM_Port_Text_Var1 PRDIndex 12313 DataID 48", "TOK_REF_DS_PM_Port_Var1_0"`,
    `END `,
  ].join('\n');
}

module.exports = {
  newGuid,
  ifaceOrderString,
  deviceHeaderBlock,
  slot0Block,
  ifaceBlock,
  portBlock,
  ioModuleBlock,
  serverModuleBlock,
  subnetBlock,
  irtDomainBlock,
  subsystemHeaderBlock,
  cfuPaDeviceHeaderBlock,
  cfuPaSlot0Block,
  cfuPaIfaceBlock,
  cfuPaPaMasterBlock,
  cfuPaPaMasterParamBlock,
  cfuPaPaMasterStatusBlock,
  cfuPaPaSlotBlock,
  cfuPaPaSubslot1Block,
  cfuPaPaSubslot2Block,
  scalanceDeviceHeaderBlock,
  scalanceSlot0Block,
  scalancePnioBlock,
  scalancePortBlock,
};
