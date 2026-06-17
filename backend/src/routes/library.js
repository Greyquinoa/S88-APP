// src/routes/library.js — Library upload + query endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb }           = require('../db');
const { parseLibraryXML } = require('../xmlParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

// In-memory parse cache: token → { cmTypes, timerId }
const _parseCache = new Map();

function cacheSet(token, cmTypes) {
  // Only one pending parse at a time — clear any previous entry
  for (const [k, v] of _parseCache) clearTimeout(v.timerId);
  _parseCache.clear();
  const timerId = setTimeout(() => _parseCache.delete(token), 15 * 60 * 1000);
  _parseCache.set(token, { cmTypes, timerId });
}

function cacheGet(token) {
  return _parseCache.get(token)?.cmTypes || null;
}

// ── POST /api/library/upload — parse only, returns preview + token ────────────
router.post('/upload', upload.single('library'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    console.log(`[Library] Parsing ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB)…`);
    const cmTypes = await parseLibraryXML(req.file.buffer);
    console.log(`[Library] Parsed ${cmTypes.length} CM/EM/EPH types`);

    const token = Date.now().toString(36);
    cacheSet(token, cmTypes);

    const preview = cmTypes.map(cm => ({
      name:       cm.name,
      cm_type:    cm.type || '',
      comment:    cm.comment || '',
      blockCount: cm.subBlocks.length,
      varCount:   cm.subBlocks.reduce((s, b) => s + b.vars.length, 0),
    }));

    res.json({ token, preview });
  } catch (err) {
    console.error('[Library] Parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/library/import — commit selected types to DB ────────────────────
router.post('/import', async (req, res) => {
  const { token, selectedNames } = req.body || {};
  if (!token || !Array.isArray(selectedNames)) {
    return res.status(400).json({ error: 'token and selectedNames are required' });
  }

  const allCmTypes = cacheGet(token);
  if (!allCmTypes) {
    return res.status(404).json({ error: 'Upload token expired or not found — please re-upload the file' });
  }

  const selected = new Set(selectedNames);
  const cmTypes  = allCmTypes.filter(cm => selected.has(cm.name));

  if (!cmTypes.length) {
    return res.status(400).json({ error: 'No matching types selected' });
  }

  try {
    const db = getDb();

    const doImport = db.transaction(() => {
      // Wipe old data (manual cascade since sql.js FK enforcement is limited)
      const cmIds = db.prepare('SELECT id FROM lib_cm_types').all().map(r => r.id);
      for (const cid of cmIds) {
        const blkIds = db.prepare('SELECT id FROM lib_blocks WHERE cm_type_id = ?').all(cid).map(r => r.id);
        for (const bid of blkIds) {
          const varIds = db.prepare('SELECT id FROM lib_variables WHERE block_id = ?').all(bid).map(r => r.id);
          for (const vid of varIds) {
            db.prepare('DELETE FROM lib_var_links WHERE var_id = ?').run(vid);
          }
          db.prepare('DELETE FROM lib_variables WHERE block_id = ?').run(bid);
          db.prepare('DELETE FROM lib_messages WHERE block_id = ?').run(bid);
        }
        db.prepare('DELETE FROM lib_blocks WHERE cm_type_id = ?').run(cid);
        db.prepare('DELETE FROM lib_em_roles WHERE cm_type_id = ?').run(cid);
      }
      db.prepare('DELETE FROM lib_cm_types').run();

      let totalBlocks = 0;
      let totalVars   = 0;

      for (const cm of cmTypes) {
        const cmRow = db.prepare(
          `INSERT INTO lib_cm_types (name, cm_type, comment, sampling_time) VALUES (?,?,?,?)`
        ).run(cm.name, cm.type || '', cm.comment || '', cm.samplingTime || '1000');
        const cmId = cmRow.lastInsertRowid;

        for (const blk of cm.subBlocks) {
          const blkRow = db.prepare(
            `INSERT INTO lib_blocks (cm_type_id, name, comment, optional, sort_order) VALUES (?,?,?,?,?)`
          ).run(cmId, blk.name, blk.comment || '', blk.optional, blk.sortOrder);
          const blkId = blkRow.lastInsertRowid;
          totalBlocks++;

          for (const v of blk.vars) {
            const varRow = db.prepare(`
              INSERT INTO lib_variables
                (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, sort_order)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)
            `).run(blkId, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
                   v.comment||'', v.vtype||'', v.enumeration||'', v.negation, v.sortOrder);
            const varId = varRow.lastInsertRowid;
            totalVars++;
            for (const tgt of v.libLinks) {
              db.prepare(`INSERT INTO lib_var_links (var_id, target_lib_id) VALUES (?,?)`).run(varId, tgt);
            }
          }

          for (const m of blk.msgs) {
            db.prepare(`
              INSERT INTO lib_messages (block_id, name, batch, cls, event, origin, osarea, prio, ack, sort_order)
              VALUES (?,?,?,?,?,?,?,?,?,?)
            `).run(blkId, m.name, m.batch||'', m.cls||'', m.event||'',
                   m.origin||'', m.osarea||'', m.prio||'', m.ack, m.sortOrder);
          }
        }

        for (const r of cm.roles || []) {
          db.prepare(`INSERT INTO lib_em_roles (cm_type_id, role, role_kind, sort_order) VALUES (?,?,?,?)`)
            .run(cmId, r.role, r.roleKind || 'cm', r.sortOrder);
        }
      }

      return { cmTypes: cmTypes.length, blocks: totalBlocks, vars: totalVars };
    });

    const result = doImport();
    _parseCache.delete(token);
    console.log(`[Library] Imported: ${result.cmTypes} types, ${result.blocks} blocks, ${result.vars} vars`);
    res.json({ success: true, ...result });

  } catch (err) {
    console.error('[Library] Import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/library/status ───────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    const db  = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS cm_count, MAX(loaded_at) AS last_loaded FROM lib_cm_types
    `).get();
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cm-types ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare(`
      SELECT
        t.id, t.name, t.cm_type, t.comment, t.sampling_time,
        COUNT(DISTINCT b.id)                             AS total_blocks,
        SUM(CASE WHEN b.optional=0 THEN 1 END)          AS required_blocks,
        SUM(CASE WHEN b.optional=1 THEN 1 END)          AS optional_blocks,
        COUNT(DISTINCT r.id)                             AS role_count
      FROM lib_cm_types t
      LEFT JOIN lib_blocks   b ON b.cm_type_id = t.id
      LEFT JOIN lib_em_roles r ON r.cm_type_id = t.id
      GROUP BY t.id
      ORDER BY t.name
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/cm-types/:name ────────────────────────────────────────────────
router.delete('/:name', (req, res) => {
  try {
    const db = getDb();
    const cm = db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });

    db.transaction(() => {
      const blkIds = db.prepare('SELECT id FROM lib_blocks WHERE cm_type_id = ?').all(cm.id).map(r => r.id);
      for (const bid of blkIds) {
        const varIds = db.prepare('SELECT id FROM lib_variables WHERE block_id = ?').all(bid).map(r => r.id);
        for (const vid of varIds) db.prepare('DELETE FROM lib_var_links WHERE var_id = ?').run(vid);
        db.prepare('DELETE FROM lib_variables WHERE block_id = ?').run(bid);
        db.prepare('DELETE FROM lib_messages WHERE block_id = ?').run(bid);
      }
      db.prepare('DELETE FROM lib_blocks WHERE cm_type_id = ?').run(cm.id);
      db.prepare('DELETE FROM lib_em_roles WHERE cm_type_id = ?').run(cm.id);
      db.prepare('DELETE FROM lib_cm_types WHERE id = ?').run(cm.id);
    })();

    res.json({ success: true });
  } catch (err) {
    console.error('[Library] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/cm-types/:name/vars/:id — update default value and/or is_valid ─
router.patch('/:name/vars/:id', (req, res) => {
  try {
    const db  = getDb();
    const cm  = db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });
    const v = db.prepare(
      'SELECT v.id, v.val, v.is_valid FROM lib_variables v JOIN lib_blocks b ON v.block_id = b.id WHERE v.id = ? AND b.cm_type_id = ?'
    ).get(req.params.id, cm.id);
    if (!v) return res.status(404).json({ error: 'Variable not found' });
    const { val, is_valid } = req.body || {};
    if (val !== undefined) {
      db.prepare('UPDATE lib_variables SET val = ? WHERE id = ?').run(val ?? '', req.params.id);
    }
    if (is_valid !== undefined) {
      db.prepare('UPDATE lib_variables SET is_valid = ? WHERE id = ?').run(is_valid ? 1 : 0, req.params.id);
    }
    const updated = db.prepare('SELECT val, is_valid FROM lib_variables WHERE id = ?').get(req.params.id);
    res.json({ success: true, id: Number(req.params.id), val: updated.val ?? '', isValid: !!updated.is_valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cm-types/:name/blocks ───────────────────────────────────────────
router.get('/:name/blocks', (req, res) => {
  try {
    const db = getDb();

    const cm = db.prepare(`SELECT * FROM lib_cm_types WHERE name = ?`).get(req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });

    const roles  = db.prepare(`SELECT role, role_kind, sort_order FROM lib_em_roles WHERE cm_type_id = ? ORDER BY sort_order`).all(cm.id);
    const blocks = db.prepare(`SELECT * FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`).all(cm.id);

    // Variables: use GROUP_CONCAT for links to avoid N+1 queries
    const vars = db.prepare(`
      SELECT v.*, GROUP_CONCAT(lk.target_lib_id) AS link_ids
      FROM lib_variables v
      JOIN lib_blocks b ON v.block_id = b.id
      LEFT JOIN lib_var_links lk ON lk.var_id = v.id
      WHERE b.cm_type_id = ?
      GROUP BY v.id
      ORDER BY v.block_id, v.sort_order
    `).all(cm.id);

    const msgs = db.prepare(`
      SELECT m.* FROM lib_messages m
      JOIN lib_blocks b ON m.block_id = b.id
      WHERE b.cm_type_id = ?
      ORDER BY m.block_id, m.sort_order
    `).all(cm.id);

    // Group by block_id
    const varsByBlock = {};
    for (const v of vars) {
      if (!varsByBlock[v.block_id]) varsByBlock[v.block_id] = [];
      varsByBlock[v.block_id].push({
        id: v.id, libId: v.lib_id, name: v.name, dir: v.dir,
        dtype: v.dtype, val: v.val, comment: v.comment, vtype: v.vtype,
        enumeration: v.enumeration, negation: !!v.negation,
        isValid: !!v.is_valid,
        libLinks: v.link_ids ? v.link_ids.split(',') : [],
      });
    }

    const msgsByBlock = {};
    for (const m of msgs) {
      if (!msgsByBlock[m.block_id]) msgsByBlock[m.block_id] = [];
      msgsByBlock[m.block_id].push({
        name: m.name, batch: m.batch, cls: m.cls, event: m.event,
        origin: m.origin, osarea: m.osarea, prio: m.prio, ack: !!m.ack,
      });
    }

    // roles: plain string array (consumed by frontend UI)
    // roleKindMap: { roleName -> 'cm'|'em' } (consumed by generator for correct XML element)
    const roleKindMap = {};
    for (const r of roles) roleKindMap[r.role] = r.role_kind || 'cm';

    res.json({
      ...cm,
      roles: roles.map(r => r.role),
      roleKindMap,
      subBlocks: blocks.map(b => ({
        id: b.id, name: b.name, comment: b.comment, optional: !!b.optional,
        vars: varsByBlock[b.id] || [],
        msgs: msgsByBlock[b.id] || [],
      })),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
