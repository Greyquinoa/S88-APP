// services/columnMapper.js — Apply column mapping config to io_tags
'use strict';

// Minimum internal fields needed to build instances and hierarchy.
const INTERNAL_FIELDS = [
  'tag_name',       // full signal tag — must be unique (used for duplicate detection)
  'instrument_tag', // CM identity — groups IO rows into one instance
  'function_val',   // drives library-type assignment
  'hierarchy',      // full path e.g. "Area/Cell/Unit/EM" — parsed positionally
  'assignment',     // AS assignment e.g. "AS01" — maps to user_project on promote
];

/**
 * Given an io_import's raw rows (already in io_tags) and a mapping config
 * { "CUST_COL": "internal_field", ... }, update the resolved columns on each tag.
 * Mapping values not in INTERNAL_FIELDS are ignored (raw_data always preserved).
 *
 * Does the extraction in a single UPDATE via jsonb ->> instead of looping
 * row-by-row in JS — one round-trip instead of one per row, which is what
 * made this the slowest step of import on large IO lists (~2ms/row before,
 * i.e. minutes at 50k+ rows). raw_data is stored as `text`, not native
 * jsonb, so it's cast inline per row. Column names come from user-uploaded
 * spreadsheet headers, so they're bound as query parameters (not
 * interpolated into the SQL) the same as any other user-supplied value.
 */
async function applyMapping(db, importId, mappings) {
  // Invert: internalField → customerCol  (for quick lookup)
  const fieldToCol = {};
  for (const [col, field] of Object.entries(mappings)) {
    if (INTERNAL_FIELDS.includes(field)) fieldToCol[field] = col;
  }

  // NULLIF(...,'') collapses '' to NULL, matching the old
  // `String(v).trim() || null` behavior for values present in raw_data.
  const expr = field => fieldToCol[field]
    ? `NULLIF(TRIM(BOTH FROM (raw_data::jsonb ->> ?)), '')`
    : 'NULL';

  await db.transaction(async () => {
    const params = [];
    const setClauses = INTERNAL_FIELDS.map(field => {
      const col = fieldToCol[field];
      if (col) params.push(col);
      return `${field}=${expr(field)}`;
    });
    params.push(importId);

    await db.prepare(`
      UPDATE io_tags SET
        ${setClauses.join(', ')},
        updated_at=NOW()
      WHERE import_id=?
    `).run(...params);

    await db.prepare(
      `UPDATE io_imports SET status='mapped' WHERE id=?`
    ).run(importId);
  })();
}

/**
 * Suggest column mappings by fuzzy-matching detected customer headers
 * against internal field names.
 */
function suggestMappings(customerHeaders) {
  const ALIASES = {
    // 'tag'/'tagname' belong to tag_name (the full signal tag, e.g. XV001_GSH).
    // The CM identity column is usually named "Tag CM" / "Instrument", which
    // scores higher against instrument_tag's own aliases.
    // No bare 'signal' alias — it fuzzy-matches "Signal_Type" and would hijack the column.
    tag_name:       ['tag', 'tagname', 'tag_name', 'signaltag', 'signal_tag', 'iotag', 'io_tag'],
    instrument_tag: ['instrument', 'instrumenttag', 'instrument_tag', 'tagcm', 'tag_cm', 'cm_tag', 'cmtag', 'device', 'device_tag', 'tag_id', 'kks'],
    function_val:   ['function', 'func', 'type', 'instrument_type', 'iotype', 'category'],
    hierarchy:      ['hierarchy', 'path', 'location', 'hierarchy_path', 'plant_path', 'structure', 'plant_structure', 'plant_hierarchy'],
    assignment:     ['assignment', 'as', 'as_assignment', 'controller', 'plc', 'cpu', 'station', 'as01', 'as_station'],
  };

  const suggestions = {};
  for (const header of customerHeaders) {
    const norm = header.toLowerCase().replace(/[^a-z0-9]/g, '');
    let bestField = null, bestScore = 0;
    for (const [field, aliases] of Object.entries(ALIASES)) {
      for (const alias of aliases) {
        const aliasNorm = alias.replace(/[^a-z0-9]/g, '');
        const score = similarity(norm, aliasNorm);
        if (score > bestScore && score >= 0.6) {
          bestScore = score;
          bestField = field;
        }
      }
    }
    if (bestField) suggestions[header] = bestField;
  }
  return suggestions;
}

// Dice coefficient string similarity
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aGrams) {
    if (bGrams.has(bg)) intersection += Math.min(count, bGrams.get(bg));
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

module.exports = { applyMapping, suggestMappings, INTERNAL_FIELDS };
