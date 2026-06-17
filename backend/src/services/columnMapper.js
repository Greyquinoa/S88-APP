// services/columnMapper.js — Apply column mapping config to io_tags
'use strict';

// Minimum internal fields needed to build instances and hierarchy.
const INTERNAL_FIELDS = [
  'instrument_tag', // CM identity — groups IO rows into one instance
  'function_val',   // drives library-type assignment
  'hierarchy',      // full path e.g. "Area/Cell/Unit/EM" — parsed positionally
  'assignment',     // AS assignment e.g. "AS01" — maps to user_project on promote
];

/**
 * Given an io_import's raw rows (already in io_tags) and a mapping config
 * { "CUST_COL": "internal_field", ... }, update the resolved columns on each tag.
 * Mapping values not in INTERNAL_FIELDS are ignored (raw_data always preserved).
 */
function applyMapping(db, importId, mappings) {
  // mappings: { customerCol → internalField }
  const tags = db.prepare(
    'SELECT id, raw_data FROM io_tags WHERE import_id = ?'
  ).all(importId);

  // Invert: internalField → customerCol  (for quick lookup)
  const fieldToCol = {};
  for (const [col, field] of Object.entries(mappings)) {
    if (INTERNAL_FIELDS.includes(field)) fieldToCol[field] = col;
  }

  const update = db.prepare(`
    UPDATE io_tags SET
      instrument_tag=?, function_val=?, hierarchy=?, assignment=?,
      updated_at=datetime('now')
    WHERE id=?
  `);

  db.transaction(() => {
    for (const tag of tags) {
      const raw = JSON.parse(tag.raw_data || '{}');
      const get = field => {
        const col = fieldToCol[field];
        if (!col) return null;
        const v = raw[col];
        return v != null ? String(v).trim() || null : null;
      };
      update.run(
        get('instrument_tag'), get('function_val'), get('hierarchy'), get('assignment'),
        tag.id
      );
    }
    db.prepare(
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
    instrument_tag: ['instrument', 'instrumenttag', 'instrument_tag', 'cm_tag', 'cmtag', 'device', 'device_tag', 'tag_id', 'kks', 'tag', 'tagname'],
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
