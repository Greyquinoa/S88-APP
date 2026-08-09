// Temp diagnostic — why is XV001_Out not reported as duplicate?
const { initDb, getDb } = require('./src/db');
(async () => {
  await initDb();
  const db = getDb();
  const imp = await db.prepare('SELECT id, file_name, total_rows FROM io_imports ORDER BY id DESC LIMIT 1').get();
  console.log('IMPORT:', imp);

  const rows = await db.prepare(
    'SELECT id, row_number, tag_name, instrument_tag, raw_data FROM io_tags WHERE import_id=? ORDER BY row_number'
  ).all(imp.id);

  console.log('\nALL ROWS (raw Tag vs stored tag_name):');
  for (const r of rows) {
    const d = JSON.parse(r.raw_data || '{}');
    console.log(
      `  row=${String(r.row_number).padStart(2)} rawTag=${JSON.stringify(d['Tag'])} ` +
      `stored=${JSON.stringify(r.tag_name)} instrument=${JSON.stringify(r.instrument_tag)}`
    );
  }

  console.log('\nCOUNTS by UPPER(raw Tag):');
  const counts = new Map();
  for (const r of rows) {
    const d = JSON.parse(r.raw_data || '{}');
    const t = d['Tag'] != null ? String(d['Tag']).trim() : '';
    if (!t) continue;
    const k = t.toUpperCase();
    if (!counts.has(k)) counts.set(k, []);
    counts.get(k).push(r.row_number);
  }
  for (const [k, v] of counts) {
    if (v.length > 1) console.log(`  DUP ${k} -> rows ${v.join(', ')}`);
  }

  const logs = await db.prepare(
    "SELECT rule_code, message FROM io_validation_log WHERE import_id=? AND rule_code='VAL-002' ORDER BY id"
  ).all(imp.id);
  console.log(`\nCURRENT VAL-002 IN LOG (${logs.length}):`);
  for (const l of logs) console.log('  ' + l.message);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
