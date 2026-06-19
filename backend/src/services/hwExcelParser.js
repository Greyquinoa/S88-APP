// services/hwExcelParser.js — Parse HW IO list Excel into structured station/slot data
'use strict';
const { listSheets, parseSheet } = require('./ioParser');

// Standard column names (case-insensitive match)
const FIELD_ALIASES = {
  station_address: ['station_address', 'stationaddress', 'station address', 'io address', 'ioaddress', 'address'],
  station_name:    ['station_name', 'stationname', 'station name', 'device name', 'devicename', 'device_name'],
  ip_address:      ['ip_address', 'ipaddress', 'ip address', 'ip'],
  slot:            ['slot', 'slot_no', 'slot number', 'slotnumber'],
  module_order_no: ['module_order_no', 'moduleorderno', 'module_orderno', 'module order no', 'order_no', 'order no', 'orderno', 'module', 'ordernum'],
  module_name:     ['module_name', 'modulename', 'module name', 'module label'],
  tag:             ['tag', 'tag_name', 'tagname', 'instrument_tag', 'instrument tag'],
  description:     ['description', 'desc', 'signal description', 'comment'],
  signal_type:     ['signal_type', 'signaltype', 'signal type', 'type', 'io_type'],
  channel:         ['channel', 'channel_no', 'channelno', 'channel number', 'ch'],
  subsystem_no:    ['subsystem_no', 'subsystemno', 'subsystem no', 'io_subsystem', 'iosubsystem', 'pn_system', 'pnsystem'],
  router_address:  ['router_address', 'routeraddress', 'router address', 'gateway', 'gateway_ip', 'gatewayip', 'default_gateway'],
};

function detectColumnMap(headers) {
  const map = {};
  const lower = headers.map(h => ({ orig: h, lc: String(h).toLowerCase().trim() }));
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const found = lower.find(h => aliases.includes(h.lc));
    if (found) map[field] = found.orig;
  }
  return map;
}

/**
 * Parse an HW IO list Excel buffer.
 * Returns { headers, colMap, rows, stations }
 *
 * stations: Map<stationAddress(number), {
 *   address: number,
 *   name: string,
 *   ip: string,
 *   slots: Map<slot(number), { slot, orderNo, name, channels: [{channel, tag, desc, signalType}] }>
 * }>
 */
async function parseHwExcel(buffer, sheetName) {
  const sheets = await listSheets(buffer);
  const target = sheetName || sheets[0];
  const { headers, rows } = await parseSheet(buffer, target);

  const colMap = detectColumnMap(headers);

  const stations = new Map();
  const rawRows = [];

  for (const { rowNum, data } of rows) {
    const get = field => {
      const col = colMap[field];
      if (!col) return null;
      const v = data[col];
      return v != null ? String(v).trim() : null;
    };

    const stationAddrRaw = get('station_address');
    const slotRaw        = get('slot');
    const orderNo        = get('module_order_no');

    if (!stationAddrRaw || !orderNo) continue; // skip incomplete rows

    const stationAddr = parseInt(stationAddrRaw, 10);
    const slot        = slotRaw != null ? parseInt(slotRaw, 10) : 0;

    if (isNaN(stationAddr)) continue;

    const stationName = get('station_name') || `Station_${stationAddr}`;
    const ip          = get('ip_address') || '';
    const moduleName    = get('module_name') || orderNo;
    const tag           = get('tag') || '';
    const desc          = get('description') || '';
    const signalType    = get('signal_type') || '';
    const channelRaw    = get('channel');
    const channel       = channelRaw != null ? parseInt(channelRaw, 10) : null;
    const subsystemRaw  = get('subsystem_no');
    const subsystemNo   = subsystemRaw != null ? parseInt(subsystemRaw, 10) : null;
    const routerAddress = get('router_address') || '';

    // Build station
    if (!stations.has(stationAddr)) {
      stations.set(stationAddr, { address: stationAddr, name: stationName, ip, routerAddress, slots: new Map(), subsystemNo });
    }
    const station = stations.get(stationAddr);
    // Update name/ip/subsystemNo/routerAddress from first row that specifies them
    if (!station.name && stationName) station.name = stationName;
    if (!station.ip && ip) station.ip = ip;
    if (!station.routerAddress && routerAddress) station.routerAddress = routerAddress;
    if (station.subsystemNo == null && subsystemNo != null) station.subsystemNo = subsystemNo;

    // Build slot
    if (!station.slots.has(slot)) {
      station.slots.set(slot, { slot, orderNo, name: moduleName, channels: [] });
    }
    const slotObj = station.slots.get(slot);

    // Each row with a tag/channel adds a channel entry
    if (tag || channel != null) {
      slotObj.channels.push({ channel: channel ?? slotObj.channels.length, tag, desc, signalType });
    }

    rawRows.push({ rowNum, stationAddr, slot, orderNo, moduleName, tag, desc, signalType, channel, ip, stationName, subsystemNo, routerAddress });
  }

  return { headers, colMap, rows: rawRows, stations };
}

module.exports = { parseHwExcel, detectColumnMap };
