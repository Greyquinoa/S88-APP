// services/ioValidator.js — Validation rules for IO imports
'use strict';

async function validateTags(db, importId) {
  const tags = await db.prepare('SELECT * FROM io_tags WHERE import_id = ?').all(importId);

  const counts = { error: 0, warning: 0, info: 0, ok: 0 };
  // Dedup: (instrument_tag + hierarchy) must be unique per import
  const seenKeys = new Map();

  const insertLog = db.prepare(`
    INSERT INTO io_validation_log (import_id, tag_id, rule_code, severity, message)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateTag = db.prepare(`
    UPDATE io_tags SET validation_status=?, validation_flags=?, updated_at=NOW()
    WHERE id=?
  `);

  await db.transaction(async () => {
    await db.prepare('DELETE FROM io_validation_log WHERE import_id = ?').run(importId);

    for (const tag of tags) {
      const flags = [];
      const identity = (tag.instrument_tag || tag.tag_name || '').trim();
      const tagName = (tag.tag_name || '').trim();

      // VAL-001: no usable identity
      if (!identity) {
        const msg = `Row ${tag.row_number}: instrument_tag (and tag_name) are both empty`;
        flags.push({ code: 'VAL-001', severity: 'error', message: msg });
        await insertLog.run(importId, tag.id, 'VAL-001', 'error', msg);
        counts.error++;
      } else {
        // VAL-002: duplicate tag_name (full signal tag must be unique within import)
        // instrument_tag can repeat (e.g. XV001 has XV001_GSH, XV001_GSL, XV001_out)
        // but tag_name must be unique
        const dedupKey = tagName.toUpperCase();
        if (dedupKey && seenKeys.has(dedupKey)) {
          const msg = `Row ${tag.row_number}: duplicate tag "${tagName}" — signal tags must be unique`;
          flags.push({ code: 'VAL-002', severity: 'error', message: msg });
          await insertLog.run(importId, tag.id, 'VAL-002', 'error', msg);
          counts.error++;
        } else if (dedupKey) {
          seenKeys.set(dedupKey, tag.id);
        }
      }

      // VAL-003: no function value — will be unresolved, but not a blocking error
      if (!tag.function_val || !String(tag.function_val).trim()) {
        const msg = `Row ${tag.row_number} (${identity}): function_val is empty — will be unresolved`;
        flags.push({ code: 'VAL-003', severity: 'warning', message: msg });
        await insertLog.run(importId, tag.id, 'VAL-003', 'warning', msg);
        counts.warning++;
      }

      // VAL-004: no hierarchy path
      if (!tag.hierarchy || !String(tag.hierarchy).trim()) {
        const msg = `Row ${tag.row_number} (${identity}): hierarchy is empty — CM will land at root`;
        flags.push({ code: 'VAL-004', severity: 'warning', message: msg });
        await insertLog.run(importId, tag.id, 'VAL-004', 'warning', msg);
        counts.warning++;
      }

      const hasError   = flags.some(f => f.severity === 'error');
      const hasWarning = flags.some(f => f.severity === 'warning');
      const status     = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
      if (status === 'ok') counts.ok++;
      await updateTag.run(status, JSON.stringify(flags), tag.id);
    }

    await db.prepare('UPDATE io_imports SET valid_rows=?, invalid_rows=? WHERE id=?')
      .run(counts.ok, counts.error, importId);
  })();

  return counts;
}

module.exports = { validateTags };
