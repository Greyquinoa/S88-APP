// verify_as01.js — Generate a CFG from the AS01 sample Excel + baseline and diff
// it against the golden as01_final.cfg (the file PCS7 itself exported).
// Run from backend/:  node verify_as01.js
'use strict';
const fs = require('fs');
const path = require('path');
const { parseCfg } = require('./src/services/cfgParser');
const { parseHwExcel } = require('./src/services/hwExcelParser');
const { allocateAddresses } = require('./src/services/hwAddressEngine');
const { generateCfg } = require('./src/services/cfgGenerator');

const GOLD = path.join(__dirname, 'data', 'golden');

// Module templates straight from the corrected db.js seed (no DB needed here).
const diParam = null, doParam = null;
const TEMPLATES = [
  ['6ES7 131-6BH01-0BA0', 'ET200SP DI 16×24VDC', 'ET200SP', 'DI', 16, 2, 0, '{{addr}}, 0, 2, 0, 0, 16', null, null, null],
  ['6ES7 132-6BH01-0BA0', 'ET200SP DO 16×24VDC', 'ET200SP', 'DO', 16, 0, 2, null, '{{addr}}, 0, 2, 0, 0, 16', null, null],
  ['6ES7 134-6HD00-0BA1', 'ET200SP AI4×U/I ST', 'ET200SP', 'AI', 4, 8, 0, '{{addr}}, 0, 8, 0, 0, 32', null, null, null],
  ['6ES7 135-6TD00-0CA1', 'ET200SP AQ4×I HART', 'ET200SP', 'AO', 4, 0, 8, null, '{{addr}}, 0, 8, 0, 2, 0', '  POTENTIAL_GROUP, "NEW_GROUP"', null],
  ['6ES7 155-6AU00-0CN0', 'ET200SP IM 155-6 PN HF V4.2', 'ET200SP', 'INFRA', 0, 0, 0, null, null, null, 'V4.2'],
  ['V1_1:6ES7 193-6PA00-0AA0', 'ET200SP Server Module V1.1', 'ET200SP', 'INFRA', 0, 0, 0, null, null, null, 'V1.1'],
];
const templateMap = new Map();
for (const t of TEMPLATES) {
  templateMap.set(t[0], {
    order_no: t[0], display_name: t[1], family: t[2], signal_type: t[3], channel_count: t[4],
    input_bytes: t[5], output_bytes: t[6], in_addr_fmt: t[7], out_addr_fmt: t[8],
    param_template: t[9], version: t[10],
  });
}

(async () => {
  const baseline = fs.readFileSync(path.join(GOLD, 'as01_Out.cfg'), 'utf8');
  const parsed = parseCfg(baseline);

  const xls = fs.readFileSync(path.join(__dirname, '..', 'Sample_HW_IOList_AS01.xlsx'));
  const { stations } = await parseHwExcel(xls);

  allocateAddresses(stations, templateMap,
    parsed.existingAddresses.maxInput, parsed.existingAddresses.maxOutput);

  const out = generateCfg(parsed, stations, templateMap);
  fs.writeFileSync(path.join(GOLD, 'as01_generated.cfg'), out);

  // ── Diff vs golden, normalising volatile/irrelevant differences ──
  // Focus on the DEVICE section (from the first "IOSUBSYSTEM N, IOADDRESS" line),
  // which is what the generator produces and what PCS7 was rejecting. The baseline
  // prefix is emitted verbatim and validated separately.
  const golden = fs.readFileSync(path.join(GOLD, 'as01_final.cfg'), 'utf8');
  const deviceOnly = s => {
    const idx = s.search(/^IOSUBSYSTEM \d+, IOADDRESS \d+/m);
    return idx >= 0 ? s.slice(idx) : s;
  };
  const norm = s => deviceOnly(s).split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ''))                 // trailing whitespace
    .map(l => l.replace(/ASSET_ID "[0-9A-F]+"/, 'ASSET_ID "<guid>"')) // volatile GUIDs
    .map(l => l.replace(/^#CREATED.*/, '#CREATED <ts>'))
    .filter(l => l !== '');                          // blank-line layout

  const g = norm(golden), o = norm(out);
  let diffs = 0;
  const max = Math.max(g.length, o.length);
  for (let i = 0; i < max; i++) {
    if (g[i] !== o[i]) {
      diffs++;
      if (diffs <= 60) {
        console.log(`L${i + 1}`);
        console.log(`  GOLD: ${g[i] === undefined ? '<none>' : g[i]}`);
        console.log(`  GEN : ${o[i] === undefined ? '<none>' : o[i]}`);
      }
    }
  }
  console.log(`\nGolden lines: ${g.length}, Generated lines: ${o.length}, Diffs: ${diffs}`);
  console.log(diffs === 0 ? '✅ EXACT MATCH (modulo GUIDs/timestamp/whitespace)' : '❌ differences above');
})().catch(e => { console.error(e); process.exit(1); });
