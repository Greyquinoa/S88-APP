// services/ioValidator.js — Validation rules for IO imports
'use strict';

const BATCH_SIZE = 500;

/**
 * Per-row rule evaluation stays in JS (VAL-002's duplicate check is
 * stateful across rows via seenKeys, so it can't be pushed into a single
 * SQL statement the way applyMapping's stateless field extraction was).
 * What changes here is the writes: instead of one INSERT/UPDATE per row
 * (2000+ round-trips for 500 rows with flags), results are batched into
 * multi-row INSERT/UPDATE statements — same row-by-row logic, far fewer
 * round-trips to Postgres.
 */
async function validateTags(db, importId) {
  const tags = await db.prepare('SELECT * FROM io_tags WHERE import_id = ?').all(importId);

  const counts = { error: 0, warning: 0, info: 0, ok: 0 };
  // Dedup: (instrument_tag + hierarchy) must be unique per import
  const seenKeys = new Map();

  const logRows = [];   // { tagId, code, severity, message }
  const tagUpdates = []; // { tagId, status, flagsJson }

  for (const tag of tags) {
    const flags = [];
    const identity = (tag.instrument_tag || tag.tag_name || '').trim();
    const tagName = (tag.tag_name || '').trim();

    // VAL-001: no usable identity
    if (!identity) {
      const msg = `Row ${tag.row_number}: instrument_tag (and tag_name) are both empty`;
      flags.push({ code: 'VAL-001', severity: 'error', message: msg });
      logRows.push({ tagId: tag.id, code: 'VAL-001', severity: 'error', message: msg });
      counts.error++;
    } else {
      // VAL-002: duplicate tag_name (full signal tag must be unique within import)
      // instrument_tag can repeat (e.g. XV001 has XV001_GSH, XV001_GSL, XV001_out)
      // but tag_name must be unique
      const dedupKey = tagName.toUpperCase();
      if (dedupKey && seenKeys.has(dedupKey)) {
        const msg = `Row ${tag.row_number}: duplicate tag "${tagName}" — signal tags must be unique`;
        flags.push({ code: 'VAL-002', severity: 'error', message: msg });
        logRows.push({ tagId: tag.id, code: 'VAL-002', severity: 'error', message: msg });
        counts.error++;
      } else if (dedupKey) {
        seenKeys.set(dedupKey, tag.id);
      }
    }

    // VAL-003: no function value — will be unresolved, but not a blocking error
    if (!tag.function_val || !String(tag.function_val).trim()) {
      const msg = `Row ${tag.row_number} (${identity}): function_val is empty — will be unresolved`;
      flags.push({ code: 'VAL-003', severity: 'warning', message: msg });
      logRows.push({ tagId: tag.id, code: 'VAL-003', severity: 'warning', message: msg });
      counts.warning++;
    }

    // VAL-004: no hierarchy path
    if (!tag.hierarchy || !String(tag.hierarchy).trim()) {
      const msg = `Row ${tag.row_number} (${identity}): hierarchy is empty — CM will land at root`;
      flags.push({ code: 'VAL-004', severity: 'warning', message: msg });
      logRows.push({ tagId: tag.id, code: 'VAL-004', severity: 'warning', message: msg });
      counts.warning++;
    }

    const hasError   = flags.some(f => f.severity === 'error');
    const hasWarning = flags.some(f => f.severity === 'warning');
    const status     = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
    if (status === 'ok') counts.ok++;
    tagUpdates.push({ tagId: tag.id, status, flagsJson: JSON.stringify(flags) });
  }

  await db.transaction(async () => {
    await db.prepare('DELETE FROM io_validation_log WHERE import_id = ?').run(importId);

    for (let i = 0; i < logRows.length; i += BATCH_SIZE) {
      await insertLogBatch(db, importId, logRows.slice(i, i + BATCH_SIZE));
    }
    for (let i = 0; i < tagUpdates.length; i += BATCH_SIZE) {
      await updateTagBatch(db, tagUpdates.slice(i, i + BATCH_SIZE));
    }

    await db.prepare('UPDATE io_imports SET valid_rows=?, invalid_rows=? WHERE id=?')
      .run(counts.ok, counts.error, importId);
  })();

  return counts;
}

// One multi-row INSERT for up to BATCH_SIZE validation-log entries.
async function insertLogBatch(db, importId, rows) {
  if (!rows.length) return;
  const values = rows.map(() => '(?,?,?,?,?)').join(',');
  const params = rows.flatMap(r => [importId, r.tagId, r.code, r.severity, r.message]);
  await db.prepare(`
    INSERT INTO io_validation_log (import_id, tag_id, rule_code, severity, message)
    VALUES ${values}
  `).run(...params);
}

// One UPDATE ... FROM (VALUES ...) for up to BATCH_SIZE tag status updates,
// instead of one UPDATE per row.
async function updateTagBatch(db, rows) {
  if (!rows.length) return;
  const values = rows.map(() => '(?::int,?::text,?::text)').join(',');
  const params = rows.flatMap(r => [r.tagId, r.status, r.flagsJson]);
  await db.prepare(`
    UPDATE io_tags AS t SET
      validation_status = v.status,
      validation_flags  = v.flags,
      updated_at        = NOW()
    FROM (VALUES ${values}) AS v(tag_id, status, flags)
    WHERE t.id = v.tag_id
  `).run(...params);
}

module.exports = { validateTags };
