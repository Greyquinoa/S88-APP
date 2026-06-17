// services/assignmentEngine.js — Function mapping + type assignment
'use strict';

/**
 * Resolve a function value against a sorted list of mapping rules.
 * Returns { cm_type_name, match_mode } or null.
 */
function resolveMapping(functionValue, mappings) {
  const val = (functionValue || '').trim().toUpperCase();
  for (const m of mappings) {
    const pattern = (m.match_pattern || m.function_value || '').toUpperCase();
    let matched = false;
    switch ((m.match_mode || 'exact').toLowerCase()) {
      case 'exact':    matched = val === pattern;               break;
      case 'prefix':   matched = val.startsWith(pattern);      break;
      case 'contains': matched = val.includes(pattern);        break;
      case 'regex':    try { matched = new RegExp(pattern, 'i').test(val); } catch (_) {} break;
    }
    if (matched) return { cm_type_name: m.cm_type_name, match_mode: m.match_mode };
  }
  return null;
}

/**
 * Simple edit-distance based suggestion for unresolved functions.
 */
function suggestMatch(functionValue, mappings) {
  const val = (functionValue || '').toUpperCase();
  let best = null, bestDist = Infinity;
  for (const m of mappings) {
    const d = levenshtein(val, m.function_value.toUpperCase());
    if (d < bestDist) { bestDist = d; best = m; }
  }
  const threshold = Math.max(2, Math.floor(val.length * 0.5));
  return bestDist <= threshold ? { suggestion: best.function_value, assignedType: best.cm_type_name, distance: bestDist } : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i || j));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
               : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/**
 * Run the full assignment engine for an import.
 * Updates io_tags.assigned_cm_type and assignment_status.
 * Returns report { auto, unresolved, skipped }.
 */
function runAssignment(db, importId, functionMapConfigId) {
  const mappings = db.prepare(`
    SELECT * FROM io_function_mappings
    WHERE config_id = ?
    ORDER BY priority DESC, id ASC
  `).all(functionMapConfigId);

  const tags = db.prepare(`
    SELECT id, tag_name, function_val, assignment_status
    FROM io_tags
    WHERE import_id = ? AND validation_status != 'error'
  `).all(importId);

  const report = { auto: 0, unresolved: 0, skipped: 0 };

  const updateAuto = db.prepare(`
    UPDATE io_tags SET assigned_cm_type=?, assignment_status='auto',
      assigned_at=datetime('now'), assigned_by='engine', updated_at=datetime('now')
    WHERE id=?
  `);
  const updateUnresolved = db.prepare(`
    UPDATE io_tags SET assigned_cm_type=NULL, assignment_status='unresolved',
      validation_flags=json_set(COALESCE(validation_flags,'{}'),'$.suggestion',?),
      updated_at=datetime('now')
    WHERE id=?
  `);

  db.transaction(() => {
    for (const tag of tags) {
      // Skip manual overrides — respect human decisions
      if (tag.assignment_status === 'manual_override' || tag.assignment_status === 'approved') {
        report.skipped++;
        continue;
      }
      const result = resolveMapping(tag.function_val, mappings);
      if (result) {
        updateAuto.run(result.cm_type_name, tag.id);
        report.auto++;
      } else {
        const hint = suggestMatch(tag.function_val, mappings);
        updateUnresolved.run(hint ? JSON.stringify(hint) : null, tag.id);
        report.unresolved++;
      }
    }

    db.prepare(`UPDATE io_imports SET function_map_id=?, status='assigned' WHERE id=?`)
      .run(functionMapConfigId, importId);

    db.prepare(`
      INSERT INTO io_audit_trail (import_id, action, actor, after_val)
      VALUES (?, 'assign', 'engine', ?)
    `).run(importId, JSON.stringify(report));
  })();

  return report;
}

/**
 * Collect all distinct unresolved function values for an import.
 * Used to pre-populate the function mapping screen.
 */
function getUnresolvedFunctions(db, importId) {
  return db.prepare(`
    SELECT function_val, COUNT(*) AS tag_count
    FROM io_tags
    WHERE import_id = ? AND assignment_status = 'unresolved'
      AND function_val IS NOT NULL
    GROUP BY function_val
    ORDER BY tag_count DESC
  `).all(importId);
}

module.exports = { runAssignment, resolveMapping, suggestMatch, getUnresolvedFunctions };
