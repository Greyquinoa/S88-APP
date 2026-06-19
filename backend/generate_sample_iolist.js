/**
 * generate_sample_iolist.js
 * Run: node generate_sample_iolist.js
 * Produces: Sample_HW_IOList_P650_AS2.xlsx
 *
 * Matches the module order numbers seeded in db.js so the app can
 * look them up and generate a CFG file similar to FINAL_P650_AS2.cfg.
 *
 * Station layout (mirrors a realistic P650 AS2 cabinet):
 *   Addr 6   950KE1-P650-02    ET200SP IM  20.40.2.6
 *     slot 0  6ES7 155-6AU01-0CN0  (IM head)
 *     slot 1  6ES7 131-6BH01-0BA0  DI 16ch   1001KE1
 *     slot 2  6ES7 131-6BH01-0BA0  DI 16ch   1002KE1
 *     slot 3  6ES7 132-6BH01-0BA0  DO 16ch   1003KE1
 *     slot 4  6ES7 134-6HD01-0BA1  AI 4ch    1004KE1
 *     slot 5  6ES7 135-6HD00-0BA1  AO 4ch    1005KE1
 *
 *   Addr 10  950KE2-P650-02    ET200SP IM  20.40.2.10
 *     slot 0  6ES7 155-6AU01-0CN0  (IM head)
 *     slot 1  6ES7 131-6BH01-0BA0  DI 16ch   2001KE2
 *     slot 2  6ES7 134-6HD01-0BA1  AI 4ch    2002KE2
 *
 *   Addr 20  SW-P650-01        SCALANCE XC208  20.40.2.20
 *     slot 0  GSDML-V2.4-Siemens-002A-SCALANCE_XC200-20210310.xml  (head)
 */
'use strict';
const ExcelJS = require('exceljs');
const path    = require('path');

const OUT = path.join(__dirname, 'Sample_HW_IOList_P650_AS2.xlsx');

// ── Signal data ───────────────────────────────────────────────────────────────
// Each row: { station_address, station_name, ip_address, slot, module_order_no,
//             module_name, tag, description, signal_type, channel }
// Station-head rows (slot 0) have no tag/channel — they define the station.

const rows = [
  // ── Station 6 ─────────────────────────────────────────────────────────────
  // Slot 0 — IM head (station definition row)
  { station_address: 6,  station_name: '950KE1-P650-02', ip_address: '20.40.2.6',
    slot: 0, module_order_no: '6ES7 155-6AU01-0CN0', module_name: 'ET200SP IM',
    tag: '', description: '', signal_type: 'INFRA', channel: '' },

  // Slot 1 — DI 16ch (1001KE1)
  ...Array.from({ length: 16 }, (_, i) => ({
    station_address: 6, station_name: '950KE1-P650-02', ip_address: '20.40.2.6',
    slot: 1, module_order_no: '6ES7 131-6BH01-0BA0', module_name: '1001KE1',
    tag: `101-XS-${String(i + 1).padStart(3, '0')}`, description: `DI signal ${i + 1} slot1`,
    signal_type: 'DI', channel: i,
  })),

  // Slot 2 — DI 16ch (1002KE1)
  ...Array.from({ length: 16 }, (_, i) => ({
    station_address: 6, station_name: '950KE1-P650-02', ip_address: '20.40.2.6',
    slot: 2, module_order_no: '6ES7 131-6BH01-0BA0', module_name: '1002KE1',
    tag: `102-XS-${String(i + 1).padStart(3, '0')}`, description: `DI signal ${i + 1} slot2`,
    signal_type: 'DI', channel: i,
  })),

  // Slot 3 — DO 16ch (1003KE1)
  ...Array.from({ length: 16 }, (_, i) => ({
    station_address: 6, station_name: '950KE1-P650-02', ip_address: '20.40.2.6',
    slot: 3, module_order_no: '6ES7 132-6BH01-0BA0', module_name: '1003KE1',
    tag: `103-XY-${String(i + 1).padStart(3, '0')}`, description: `DO signal ${i + 1} slot3`,
    signal_type: 'DO', channel: i,
  })),

  // Slot 4 — AI 4ch (1004KE1)
  ...Array.from({ length: 4 }, (_, i) => ({
    station_address: 6, station_name: '950KE1-P650-02', ip_address: '20.40.2.6',
    slot: 4, module_order_no: '6ES7 134-6HD01-0BA1', module_name: '1004KE1',
    tag: `104-FT-${String(i + 1).padStart(3, '0')}`, description: `AI signal ${i + 1} slot4`,
    signal_type: 'AI', channel: i,
  })),

  // Slot 5 — AO 4ch (1005KE1)
  ...Array.from({ length: 4 }, (_, i) => ({
    station_address: 6, station_name: '950KE1-P650-02', ip_address: '20.40.2.6',
    slot: 5, module_order_no: '6ES7 135-6HD00-0BA1', module_name: '1005KE1',
    tag: `105-FC-${String(i + 1).padStart(3, '0')}`, description: `AO signal ${i + 1} slot5`,
    signal_type: 'AO', channel: i,
  })),

  // ── Station 10 ────────────────────────────────────────────────────────────
  // Slot 0 — IM head
  { station_address: 10, station_name: '950KE2-P650-02', ip_address: '20.40.2.10',
    slot: 0, module_order_no: '6ES7 155-6AU01-0CN0', module_name: 'ET200SP IM',
    tag: '', description: '', signal_type: 'INFRA', channel: '' },

  // Slot 1 — DI 16ch (2001KE2)
  ...Array.from({ length: 16 }, (_, i) => ({
    station_address: 10, station_name: '950KE2-P650-02', ip_address: '20.40.2.10',
    slot: 1, module_order_no: '6ES7 131-6BH01-0BA0', module_name: '2001KE2',
    tag: `201-XS-${String(i + 1).padStart(3, '0')}`, description: `DI signal ${i + 1} st10s1`,
    signal_type: 'DI', channel: i,
  })),

  // Slot 2 — AI 4ch (2002KE2)
  ...Array.from({ length: 4 }, (_, i) => ({
    station_address: 10, station_name: '950KE2-P650-02', ip_address: '20.40.2.10',
    slot: 2, module_order_no: '6ES7 134-6HD01-0BA1', module_name: '2002KE2',
    tag: `202-FT-${String(i + 1).padStart(3, '0')}`, description: `AI signal ${i + 1} st10s2`,
    signal_type: 'AI', channel: i,
  })),

  // ── Station 20 — SCALANCE XC208 ───────────────────────────────────────────
  { station_address: 20, station_name: 'SW-P650-01', ip_address: '20.40.2.20',
    slot: 0,
    module_order_no: 'GSDML-V2.4-Siemens-002A-SCALANCE_XC200-20210310.xml',
    module_name: 'SCALANCE XC208',
    tag: '', description: 'Network switch', signal_type: 'INFRA', channel: '' },
];

// ── Build workbook ─────────────────────────────────────────────────────────────
async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PCS7 CM Generator';
  wb.created = new Date();

  const ws = wb.addWorksheet('HW_IO_List');

  // Column definitions — names match FIELD_ALIASES in hwExcelParser.js
  ws.columns = [
    { header: 'Station_Address', key: 'station_address', width: 18 },
    { header: 'Station_Name',    key: 'station_name',    width: 22 },
    { header: 'IP_Address',      key: 'ip_address',      width: 16 },
    { header: 'Slot',            key: 'slot',            width:  8 },
    { header: 'Module_OrderNo',  key: 'module_order_no', width: 46 },
    { header: 'Module_Name',     key: 'module_name',     width: 18 },
    { header: 'Tag',             key: 'tag',             width: 20 },
    { header: 'Description',     key: 'description',     width: 36 },
    { header: 'Signal_Type',     key: 'signal_type',     width: 14 },
    { header: 'Channel',         key: 'channel',         width: 10 },
  ];

  // Header row style
  ws.getRow(1).eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border    = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };
  });
  ws.getRow(1).height = 28;

  // Colour bands per station
  const stationColours = {
    6:  'FFDCE6F1',  // light blue
    10: 'FFE2EFDA',  // light green
    20: 'FFFFF2CC',  // light yellow
  };

  // Fill data rows
  for (const r of rows) {
    const row = ws.addRow(r);
    const fill = stationColours[r.station_address] || 'FFFAFAFA';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      };
      cell.alignment = { vertical: 'middle' };
    });
  }

  // Freeze header row
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Auto-filter on header
  ws.autoFilter = { from: 'A1', to: 'J1' };

  // ── Info sheet ──────────────────────────────────────────────────────────────
  const info = wb.addWorksheet('Info');
  info.columns = [{ header: 'Field', key: 'f', width: 22 }, { header: 'Notes', key: 'n', width: 60 }];
  const infoRows = [
    ['Station_Address', 'Integer IOADDRESS number (must match baseline CFG IOSUBSYSTEM number)'],
    ['Station_Name',    'PROFINET device name used in .cfg output'],
    ['IP_Address',      'Dotted-decimal IP of the station (auto-converted to hex in .cfg)'],
    ['Slot',            '0 = station head/IM — no process image bytes; 1+ = I/O modules'],
    ['Module_OrderNo',  'Siemens order number or GSDML file ref — must match a template in the DB'],
    ['Module_Name',     'Human-readable label for this slot (used as name in .cfg)'],
    ['Tag',             'Instrument tag (informational; kept in DB for traceability)'],
    ['Description',     'Signal description (informational)'],
    ['Signal_Type',     'DI / DO / AI / AO / PA / HART / IS / INFRA'],
    ['Channel',         '0-based channel index within the module'],
  ];
  info.getRow(1).font = { bold: true };
  infoRows.forEach(([f, n]) => info.addRow({ f, n }));

  await wb.xlsx.writeFile(OUT);
  console.log(`Written: ${OUT}`);
  console.log(`Rows: ${rows.length} data rows across 3 stations`);
}

main().catch(e => { console.error(e); process.exit(1); });
