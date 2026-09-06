// One-time data seed: capture a device's real device-header BEGIN..END body
// from a known-correct CFG export (a golden fixture, itself a real PCS7 export)
// and store it verbatim in hw_module_templates.body_template for that device's
// own (order_no, hw_category='station') catalogue row.
//
// This is a generic capture utility (works for any order_no/fixture pair given
// as args), not per-device code — it stands in for the not-yet-built "capture
// from CFG" endpoint (see joyful-conjuring-brooks.md plan, Phase 2). Ground-truth
// rule 6: header body text is per (order_no, role); the renderer
// (cfgGenerator.js / cfgBlocks.js deviceHeaderBlockFromTemplate) already reads
// this column generically for any station whose head row has it populated.
'use strict';

const fs = require('fs');
const path = require('path');
const { initDb, getDb } = require('./src/db');

// Generic block extractor: finds a header line matching `headerLineRe`, skips
// an optional AUTOCREATED marker line, requires BEGIN, and collects raw lines
// up to (not including) the matching END.
function extractBlockBody(lines, headerLineRe) {
  const startIdx = lines.findIndex((l) => headerLineRe.test(l));
  if (startIdx === -1) {
    throw new Error(`Header line not found for pattern: ${headerLineRe}`);
  }
  let i = startIdx + 1;
  if (/^\s*AUTOCREATED\s*$/.test(lines[i])) i++;
  if (!/^\s*BEGIN\s*$/.test(lines[i])) {
    throw new Error(`Expected BEGIN on the line after the header, got: ${JSON.stringify(lines[i])}`);
  }
  i++;
  const body = [];
  while (i < lines.length && !/^\s*END\s*$/.test(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  if (i >= lines.length) {
    throw new Error('Never found matching END for the block');
  }
  return body;
}

function placeholderize(bodyLines, fieldNames) {
  return bodyLines
    .map((l) => {
      let out = l;
      for (const field of fieldNames) {
        out = out.replace(new RegExp(`^(\\s*${field}\\s+)"[^"]*"`), `$1"{{${field}}}"`);
      }
      return out;
    })
    .join('\n');
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function seedHeaderBodyTemplate(db, fixturePath, orderNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escaped = reEscape(orderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*"${escaped}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);
  const bodyTemplate = placeholderize(body, ['ASSET_ID', 'POS_X', 'POS_Y']);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'station'`)
    .run(bodyTemplate, orderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded station body_template for order_no=${JSON.stringify(orderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

async function seedSlotZeroBodyTemplate(db, fixturePath, orderNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escaped = reEscape(orderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*SLOT 0,\\s*"${escaped}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);
  // ADDRESS <diag>, 0, 0, 0, 0, 0 — the diagnostic address is per-instance too.
  const withDiagPlaceholder = body.map((l) =>
    l.replace(/^(\s*ADDRESS\s+)\d+/, '$1{{DIAG}}')
  );
  const bodyTemplate = placeholderize(withDiagPlaceholder, [
    'ASSET_ID', 'POS_X', 'POS_Y', 'IPADDRESS', 'ROUTERADDRESS', 'MLFB',
  ]);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'slot'`)
    .run(bodyTemplate, orderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded slot0 body_template for order_no=${JSON.stringify(orderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

// SLOT 0 SUBSLOT 1 (PN-IO interface): on the generic fallback path this uses one
// shared, family-agnostic order_no, so it's captured/seeded once by that literal
// order_no rather than per-device — see cfgGenerator.js GENERIC_IFACE_ORDER_NO.
async function seedGenericIfaceBodyTemplate(db, fixturePath, stationOrderNo, ifaceOrderNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escapedIface = reEscape(ifaceOrderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*SLOT 0,\\s*SUBSLOT 1,\\s*"${escapedIface}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);
  const withDiagPlaceholder = body.map((l) =>
    l.replace(/^(\s*ADDRESS\s+)\d+/, '$1{{DIAG}}')
  );
  const bodyTemplate = placeholderize(withDiagPlaceholder, ['ASSET_ID']);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'subslot'`)
    .run(bodyTemplate, ifaceOrderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded generic iface body_template for order_no=${JSON.stringify(ifaceOrderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

// SLOT 0 SUBSLOT 2/3 (physical ports): ground-truth rule 6's "both ports" case —
// both ports reuse the DEVICE'S OWN order_no as header order_no, with bodies
// identical except ASSET_ID and the diagnostic ADDRESS value, so one captured
// body_template (from either port) serves both. Keyed by the device's own
// (order_no, hw_category='subslot') catalogue row, not a shared literal like
// GENERIC_IFACE_ORDER_NO — this generalizes per-device via cfgGenerator.js
// reading each subslot's own paProfile/order_no, no per-device code involved.
async function seedPortBodyTemplate(db, fixturePath, orderNo, subslotNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escaped = reEscape(orderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*SLOT 0,\\s*SUBSLOT ${subslotNo},\\s*"${escaped}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);
  const withDiagPlaceholder = body.map((l) =>
    l.replace(/^(\s*ADDRESS\s+)\d+/, '$1{{DIAG}}')
  );
  const bodyTemplate = placeholderize(withDiagPlaceholder, ['ASSET_ID']);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'subslot'`)
    .run(bodyTemplate, orderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded port body_template for order_no=${JSON.stringify(orderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

// A slot ≥1 module's own header (e.g. a GSDML DAP submodule plugged into a
// user slot) has a body shaped by its own device family (PN_TI/PN_TO/... for
// GSDML devices), not the generic ET200SP-style CPU_NO/ALARM_OB_NO body
// `ioModuleBlock` hardcodes — so it's captured the same way as station/slot0,
// keyed by (order_no, hw_category='slot').
async function seedIoModuleBodyTemplate(db, fixturePath, orderNo, slotNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escaped = reEscape(orderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*SLOT ${slotNo},\\s*"${escaped}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);
  const bodyTemplate = placeholderize(body, ['ASSET_ID']);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'slot'`)
    .run(bodyTemplate, orderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded io-module body_template for order_no=${JSON.stringify(orderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

// A slot ≥1's OWN subslot (e.g. an IO-Link master's "Status/Control Module"
// plugged into SLOT 1, SUBSLOT 1) — same rule-6 shape as seedPortBodyTemplate,
// generalized to any slot number, not just SLOT 0's RJ45 ports. The captured
// body includes this subslot's real ADDRESS/SYMBOL lines verbatim (this is a
// round-trip fixture, so the "instance" data IS the "default" data for this
// order_no); only ASSET_ID is placeholderized since it legitimately varies
// per render. Keyed by (order_no, hw_category='subslot'), read generically by
// cfgGenerator.js's findSubslotTemplate for any slot ≥1.
async function seedSlotSubslotBodyTemplate(db, fixturePath, orderNo, slotNo, subslotNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escaped = reEscape(orderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*SLOT ${slotNo},\\s*SUBSLOT ${subslotNo},\\s*"${escaped}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);
  const bodyTemplate = placeholderize(body, ['ASSET_ID']);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'subslot'`)
    .run(bodyTemplate, orderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded slot-subslot body_template for order_no=${JSON.stringify(orderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

// A slot ≥1's own subslot whose ADDRESS/SYMBOL lines are genuinely per-instance
// data even though many subslots share one order_no (e.g. an IO-Link master's
// 8 "Inactive (A/B)" ports on SLOT 1 SUBSLOTS 2..9: same catalogue order_no,
// but the LOCAL_IN_ADDRESSES ADDRESS line's first field is that specific
// subslot's own number, and any SYMBOL line(s) after it are that subslot's own
// tagged channels — present for some, absent for others). Same capture shape
// as seedSlotSubslotBodyTemplate, but additionally placeholderizes the
// ADDRESS line's varying first field as {{SUBSLOT}} and replaces any literal
// SYMBOL line(s) captured from the chosen fixture instance with a single
// {{SYMBOLS}} token (filled at render time from that specific subslot's own
// hw_signals rows, or left empty when it has none) — read generically by
// cfgGenerator.js/cfgBlocks.js's subslotBlockFromTemplate for any slot ≥1.
async function seedSlotSubslotAddressBodyTemplate(db, fixturePath, orderNo, slotNo, subslotNo) {
  const cfgText = fs.readFileSync(fixturePath, 'utf8');
  const lines = cfgText.split(/\r?\n/);
  const escaped = reEscape(orderNo);
  const headerLineRe = new RegExp(`^IOSUBSYSTEM\\s+\\d+,\\s*IOADDRESS\\s+\\d+,\\s*SLOT ${slotNo},\\s*SUBSLOT ${subslotNo},\\s*"${escaped}",\\s*"[^"]*"\\s*$`);
  const body = extractBlockBody(lines, headerLineRe);

  const addrIdx = body.findIndex((l) => /^\s*ADDRESS\s+\d+\s*,/.test(l));
  if (addrIdx === -1) {
    throw new Error(`No ADDRESS line found in captured body for order_no=${JSON.stringify(orderNo)}`);
  }
  const withSubslotPlaceholder = body.slice();
  // The {{SYMBOLS}} token is appended directly onto the end of the ADDRESS
  // line's own text (rather than living on its own array line) so that
  // filling it with '' for a subslot with no tagged channels reproduces the
  // fixture exactly — an empty standalone line would otherwise leave a stray
  // blank line before PARAMETER.
  withSubslotPlaceholder[addrIdx] = withSubslotPlaceholder[addrIdx].replace(
    /^(\s*ADDRESS\s+)\d+(\s*,.*)$/, `$1{{SUBSLOT}}$2{{SYMBOLS}}`
  );
  // Strip any literal SYMBOL line(s) immediately after the ADDRESS line (this
  // fixture instance's own tags — not representative of every subslot sharing
  // this order_no); they're replaced by the {{SYMBOLS}} token filled per-instance.
  let after = addrIdx + 1;
  while (after < withSubslotPlaceholder.length && /^\s*SYMBOL\s+/.test(withSubslotPlaceholder[after])) after++;
  const finalBody = [
    ...withSubslotPlaceholder.slice(0, addrIdx + 1),
    ...withSubslotPlaceholder.slice(after),
  ];
  const bodyTemplate = placeholderize(finalBody, ['ASSET_ID']);

  const result = await db
    .prepare(`UPDATE hw_module_templates SET body_template = ? WHERE order_no = ? AND hw_category = 'subslot'`)
    .run(bodyTemplate, orderNo);
  const affected = result && (result.rowCount ?? result.changes ?? null);
  console.log(`Seeded slot-subslot address body_template for order_no=${JSON.stringify(orderNo)} (rows affected: ${affected})`);
  return bodyTemplate;
}

async function main() {
  await initDb();
  const db = getDb();

  const seeds = [
    {
      orderNo: 'GSDML-V2.35-Pepperl+Fuchs-ICE1-S2-20191112.xml<IDD_W60_M12PWR_8xM12IOL_MP1_S2_Device>',
      fixture: path.join(__dirname, 'data/golden/generic/as01-iolink.cfg'),
    },
  ];

  for (const seed of seeds) {
    await seedHeaderBodyTemplate(db, seed.fixture, seed.orderNo);
    await seedSlotZeroBodyTemplate(db, seed.fixture, seed.orderNo);
    await seedGenericIfaceBodyTemplate(db, seed.fixture, seed.orderNo, '_S7H_IO_NORM_INTERFACE_CT');
    await seedPortBodyTemplate(db, seed.fixture, seed.orderNo, 2);
  }

  await seedIoModuleBodyTemplate(
    db,
    path.join(__dirname, 'data/golden/generic/as01-iolink.cfg'),
    'GSDML-V2.35-Pepperl+Fuchs-ICE1-S2-20191112.xml<IDM_8IOL_STATUS_CONTROL_W60>',
    1,
  );

  await seedSlotSubslotBodyTemplate(
    db,
    path.join(__dirname, 'data/golden/generic/as01-iolink.cfg'),
    'GSDML-V2.35-Pepperl+Fuchs-ICE1-S2-20191112.xml<IDS_8IOL_STATUS_CONTROL_W60>',
    1,
    1,
  );

  // SLOT 1 SUBSLOTS 2..9: all 8 share this order_no but each has its own
  // ADDRESS value (equal to its own subslot number) and optional SYMBOL
  // line(s) — captured from SUBSLOT 2 (no symbols), the cleanest base case.
  await seedSlotSubslotAddressBodyTemplate(
    db,
    path.join(__dirname, 'data/golden/generic/as01-iolink.cfg'),
    'GSDML-V2.35-Pepperl+Fuchs-ICE1-S2-20191112.xml<IDS_8IOL_INACTIVE>',
    1,
    2,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
