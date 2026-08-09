// Temp diagnostic — run the REAL applyMapping + validateTags path with Tag -> tag_name,
// exactly as POST /imports/:id/apply-column-map would after the alias fix.
const { initDb, getDb } = require('./src/db');
const { applyMapping, suggestMappings } = require('./src/services/columnMapper');
const { validateTags } = require('./src/services/ioValidator');

(async () => {
  await initDb();
  const db = getDb();
  const imp = await db.prepare('SELECT id, column_map_id FROM io_imports ORDER BY id DESC LIMIT 1').get();

  const raw = await db.prepare('SELECT raw_data FROM io_tags WHERE import_id=? LIMIT 1').get(imp.id);
  const headers = Object.keys(JSON.parse(raw?.raw_data || '{}'));
  const suggested = suggestMappings(headers);
  console.log('SUGGESTED (fresh, post-fix):');
  for (const [col, field] of Object.entries(suggested)) console.log(`  ${col} -> ${field}`);

  await applyMapping(db, imp.id, suggested);
  const counts = await validateTags(db, imp.id);
  console.log('\nValidation counts:', counts);

  const dups = await db.prepare(
    "SELECT message FROM io_validation_log WHERE import_id=? AND rule_code='VAL-002' ORDER BY id"
  ).all(imp.id);
  console.log(`\nVAL-002 (${dups.length}):`);
  for (const d of dups) console.log('  ' + d.message);

  const sample = await db.prepare(
    'SELECT row_number, tag_name, instrument_tag FROM io_tags WHERE import_id=? AND tag_name IS NOT NULL ORDER BY row_number LIMIT 6'
  ).all(imp.id);
  console.log('\nSample stored rows:');
  for (const s of sample) console.log(`  row=${s.row_number} tag_name=${s.tag_name} instrument=${s.instrument_tag}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
