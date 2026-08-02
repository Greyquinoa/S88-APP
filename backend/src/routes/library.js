// src/routes/library.js — Library upload + query endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb }           = require('../db');
const { parseLibraryXML } = require('../xmlParser');
const { computeLibraryDiff } = require('../services/diffLibrary');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

// In-memory parse cache: token → { cmTypes, diffResult?, timerId }
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

// ── POST /api/library/compute-diff — compute diff without committing to DB ────
router.post('/compute-diff', async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  const cmTypes = cacheGet(token);
  if (!cmTypes) {
    return res.status(404).json({ error: 'Upload token expired or not found — please re-upload the file' });
  }

  try {
    const db = getDb();
    const diffResult = await computeLibraryDiff(cmTypes, db);

    // Store diff result in cache for /import to use
    const cached = _parseCache.get(token);
    _parseCache.set(token, {
      cmTypes,
      diffResult,
      timerId: cached.timerId,
    });

    console.log(`[Library] Computed diff: ${diffResult.summary.new} new, ${diffResult.summary.updated} updated, ${diffResult.summary.unchanged} unchanged, ${diffResult.summary.removed} removed`);
    res.json(diffResult);
  } catch (err) {
    console.error('[Library] Diff computation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/library/import — selectively merge types (not destructive wipe) ────
router.post('/import', async (req, res) => {
  const { token, selectedNames } = req.body || {};
  if (!token || !Array.isArray(selectedNames)) {
    return res.status(400).json({ error: 'token and selectedNames are required' });
  }

  const cached = _parseCache.get(token);
  if (!cached || !cached.cmTypes || !cached.diffResult) {
    return res.status(404).json({ error: 'Upload token expired or not found — please re-upload and compute diff' });
  }

  const selected = new Set(selectedNames);

  try {
    const db = getDb();

    const doImport = db.transaction(async () => {
      let stats = { new: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 };
      let totalBlocks = 0;
      let totalVars = 0;

      for (const item of cached.diffResult.items) {
        // Skip if user deselected this type
        if (!selected.has(item.name)) {
          stats.skipped++;
          continue;
        }

        // Skip unchanged types (no action needed)
        if (item.status === 'UNCHANGED') {
          stats.unchanged++;
          continue;
        }

        // Skip removed-from-file types (leave untouched in DB)
        if (item.status === 'REMOVED_FROM_FILE') {
          stats.removed++;
          continue;
        }

        // Insert new types
        if (item.status === 'NEW') {
          const result = await _insertNewCmType(item.newType, db);
          stats.new++;
          totalBlocks += result.blocks;
          totalVars += result.vars;
          continue;
        }

        // Merge updated types (preserve block preferences)
        if (item.status === 'UPDATED') {
          const result = await _mergeUpdatedCmType(item.oldType.id, item.newType, db);
          stats.updated++;
          totalBlocks += result.blocks;
          totalVars += result.vars;
        }
      }

      return { ...stats, blocks: totalBlocks, vars: totalVars };
    });

    const result = await doImport();
    _parseCache.delete(token);
    console.log(`[Library] Imported: ${result.new} new, ${result.updated} updated, ${result.blocks} blocks, ${result.vars} vars`);
    res.json({ success: true, ...result });

  } catch (err) {
    console.error('[Library] Import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: Insert new CM type (used by import) ────
async function _insertNewCmType(cm, db) {
  let totalBlocks = 0;
  let totalVars = 0;

  const cmRow = await db.prepare(
    `INSERT INTO lib_cm_types (name, cm_type, comment, sampling_time) VALUES (?,?,?,?)`
  ).run(cm.name, cm.type || '', cm.comment || '', cm.samplingTime || '1000');
  const cmId = cmRow.lastInsertRowid;

  for (const blk of cm.subBlocks) {
    const blkRow = await db.prepare(
      `INSERT INTO lib_blocks (cm_type_id, name, comment, optional, sort_order) VALUES (?,?,?,?,?)`
    ).run(cmId, blk.name, blk.comment || '', !!blk.optional, blk.sortOrder);
    const blkId = blkRow.lastInsertRowid;
    totalBlocks++;

    for (const v of blk.vars) {
      const varRow = await db.prepare(`
        INSERT INTO lib_variables
          (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(blkId, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
             v.comment||'', v.vtype||'', v.enumeration||'', !!v.negation, v.sortOrder);
      const varId = varRow.lastInsertRowid;
      totalVars++;
      for (const tgt of v.libLinks) {
        await db.prepare(`INSERT INTO lib_var_links (var_id, target_lib_id) VALUES (?,?)`).run(varId, tgt);
      }
    }

    for (const m of blk.msgs) {
      await db.prepare(`
        INSERT INTO lib_messages (block_id, name, batch, cls, event, origin, osarea, prio, ack, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(blkId, m.name, m.batch||'', m.cls||'', m.event||'',
             m.origin||'', m.osarea||'', m.prio||'', !!m.ack, m.sortOrder);
    }
  }

  for (const r of cm.roles || []) {
    await db.prepare(`INSERT INTO lib_em_roles (cm_type_id, role, role_kind, sort_order) VALUES (?,?,?,?)`)
      .run(cmId, r.role, r.roleKind || 'cm', r.sortOrder);
  }

  return { blocks: totalBlocks, vars: totalVars };
}

// ── Helper: Merge updated CM type with block preference preservation ────
async function _mergeUpdatedCmType(cmTypeId, newType, db) {
  let totalBlocks = 0;
  let totalVars = 0;

  // Step 1: Save existing block preferences
  const prefs = await db.prepare(
    `SELECT enabled_blocks FROM user_cm_block_prefs WHERE cm_type_name = ?`
  ).get(newType.name);
  const savedBlockNames = prefs ? JSON.parse(prefs.enabled_blocks || '[]') : [];

  // Step 2: Update type metadata
  await db.prepare(
    `UPDATE lib_cm_types SET cm_type = ?, comment = ?, sampling_time = ? WHERE id = ?`
  ).run(newType.type || '', newType.comment || '', newType.samplingTime || '1000', cmTypeId);

  // Step 3: Fetch existing blocks and delete removed ones
  const oldBlocks = await db.prepare(
    `SELECT id, name FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`
  ).all(cmTypeId);

  for (const oldBlock of oldBlocks) {
    const newBlock = newType.subBlocks.find(b => b.name === oldBlock.name);
    if (!newBlock) {
      // Block removed in new file — delete it and its variables
      const varIds = (await db.prepare(`SELECT id FROM lib_variables WHERE block_id = ?`).all(oldBlock.id)).map(r => r.id);
      for (const vid of varIds) {
        await db.prepare('DELETE FROM lib_var_links WHERE var_id = ?').run(vid);
      }
      await db.prepare('DELETE FROM lib_variables WHERE block_id = ?').run(oldBlock.id);
      await db.prepare('DELETE FROM lib_messages WHERE block_id = ?').run(oldBlock.id);
      await db.prepare('DELETE FROM lib_blocks WHERE id = ?').run(oldBlock.id);
    }
  }

  // Step 4: For each new block, insert or merge
  for (const newBlock of newType.subBlocks) {
    const oldBlock = oldBlocks.find(b => b.name === newBlock.name);

    if (oldBlock) {
      // Merge existing block: update metadata and variables
      await db.prepare(
        `UPDATE lib_blocks SET comment = ?, optional = ? WHERE id = ?`
      ).run(newBlock.comment || '', !!newBlock.optional, oldBlock.id);

      // Delete old variables and insert new ones
      const oldVarIds = (await db.prepare(`SELECT id FROM lib_variables WHERE block_id = ?`).all(oldBlock.id)).map(r => r.id);
      for (const vid of oldVarIds) {
        await db.prepare('DELETE FROM lib_var_links WHERE var_id = ?').run(vid);
      }
      await db.prepare('DELETE FROM lib_variables WHERE block_id = ?').run(oldBlock.id);
      await db.prepare('DELETE FROM lib_messages WHERE block_id = ?').run(oldBlock.id);

      // Insert new variables
      for (const v of newBlock.vars) {
        const varRow = await db.prepare(`
          INSERT INTO lib_variables
            (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(oldBlock.id, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
               v.comment||'', v.vtype||'', v.enumeration||'', !!v.negation, v.sortOrder);
        const varId = varRow.lastInsertRowid;
        totalVars++;
        for (const tgt of v.libLinks) {
          await db.prepare(`INSERT INTO lib_var_links (var_id, target_lib_id) VALUES (?,?)`).run(varId, tgt);
        }
      }

      // Insert new messages
      for (const m of newBlock.msgs) {
        await db.prepare(`
          INSERT INTO lib_messages (block_id, name, batch, cls, event, origin, osarea, prio, ack, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(oldBlock.id, m.name, m.batch||'', m.cls||'', m.event||'',
               m.origin||'', m.osarea||'', m.prio||'', !!m.ack, m.sortOrder);
      }
    } else {
      // Insert new block
      const blkRow = await db.prepare(
        `INSERT INTO lib_blocks (cm_type_id, name, comment, optional, sort_order) VALUES (?,?,?,?,?)`
      ).run(cmTypeId, newBlock.name, newBlock.comment || '', !!newBlock.optional, newBlock.sortOrder);
      const blkId = blkRow.lastInsertRowid;
      totalBlocks++;

      for (const v of newBlock.vars) {
        const varRow = await db.prepare(`
          INSERT INTO lib_variables
            (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(blkId, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
               v.comment||'', v.vtype||'', v.enumeration||'', !!v.negation, v.sortOrder);
        const varId = varRow.lastInsertRowid;
        totalVars++;
        for (const tgt of v.libLinks) {
          await db.prepare(`INSERT INTO lib_var_links (var_id, target_lib_id) VALUES (?,?)`).run(varId, tgt);
        }
      }

      for (const m of newBlock.msgs) {
        await db.prepare(`
          INSERT INTO lib_messages (block_id, name, batch, cls, event, origin, osarea, prio, ack, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(blkId, m.name, m.batch||'', m.cls||'', m.event||'',
               m.origin||'', m.osarea||'', m.prio||'', !!m.ack, m.sortOrder);
      }
    }
  }

  // Step 5: Re-apply saved block preferences (filter non-existent blocks)
  const existingBlockNames = (await db.prepare(
    `SELECT DISTINCT name FROM lib_blocks WHERE cm_type_id = ?`
  ).all(cmTypeId)).map(r => r.name);

  const filteredPrefs = savedBlockNames.filter(bn => existingBlockNames.includes(bn));
  await db.prepare(`
    INSERT INTO user_cm_block_prefs (cm_type_name, enabled_blocks) VALUES (?, ?)
    ON CONFLICT (cm_type_name) DO UPDATE SET enabled_blocks = EXCLUDED.enabled_blocks
  `).run(newType.name, JSON.stringify(filteredPrefs));

  return { blocks: totalBlocks, vars: totalVars };
}

// ── GET /api/library/status ───────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const db  = getDb();
    const rows = await db.prepare(`
      SELECT cm_type, COUNT(*) AS count, MAX(loaded_at) AS last_loaded FROM lib_cm_types GROUP BY cm_type
    `).all();

    const result = { cm_count: 0, em_count: 0, eph_count: 0, last_loaded: null };
    for (const row of rows) {
      // lib_cm_types.cm_type stores the long form ('ControlModule', …); older
      // rows may use the short codes. Accept both so the status never reads 0
      // against a populated library.
      if (row.cm_type === 'ControlModule'   || row.cm_type === 'CM')  result.cm_count  = Number(row.count);
      else if (row.cm_type === 'EquipmentModule' || row.cm_type === 'EM')  result.em_count  = Number(row.count);
      else if (row.cm_type === 'EquipmentPhase'  || row.cm_type === 'EPH') result.eph_count = Number(row.count);
      if (row.last_loaded) result.last_loaded = row.last_loaded;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cm-types ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db   = getDb();
    const rows = await db.prepare(`
      SELECT
        t.id, t.name, t.cm_type, t.comment, t.sampling_time,
        COUNT(DISTINCT b.id)                                   AS total_blocks,
        SUM(CASE WHEN b.optional=false THEN 1 END)            AS required_blocks,
        SUM(CASE WHEN b.optional=true THEN 1 END)             AS optional_blocks,
        COUNT(DISTINCT r.id)                                   AS role_count
      FROM lib_cm_types t
      LEFT JOIN lib_blocks   b ON b.cm_type_id = t.id
      LEFT JOIN lib_em_roles r ON r.cm_type_id = t.id
      GROUP BY t.id
      ORDER BY t.name
    `).all();
    res.json(rows.map(r => ({
      ...r,
      total_blocks: Number(r.total_blocks),
      required_blocks: Number(r.required_blocks) || 0,
      optional_blocks: Number(r.optional_blocks) || 0,
      role_count: Number(r.role_count),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/cm-types/:name ────────────────────────────────────────────────
router.delete('/:name', async (req, res) => {
  try {
    const db = getDb();
    const cm = await db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });

    await db.transaction(async () => {
      const blkIds = (await db.prepare('SELECT id FROM lib_blocks WHERE cm_type_id = ?').all(cm.id)).map(r => r.id);
      for (const bid of blkIds) {
        const varIds = (await db.prepare('SELECT id FROM lib_variables WHERE block_id = ?').all(bid)).map(r => r.id);
        for (const vid of varIds) await db.prepare('DELETE FROM lib_var_links WHERE var_id = ?').run(vid);
        await db.prepare('DELETE FROM lib_variables WHERE block_id = ?').run(bid);
        await db.prepare('DELETE FROM lib_messages WHERE block_id = ?').run(bid);
      }
      await db.prepare('DELETE FROM lib_blocks WHERE cm_type_id = ?').run(cm.id);
      await db.prepare('DELETE FROM lib_em_roles WHERE cm_type_id = ?').run(cm.id);
      await db.prepare('DELETE FROM lib_cm_types WHERE id = ?').run(cm.id);
    })();

    res.json({ success: true });
  } catch (err) {
    console.error('[Library] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/cm-types/:name/vars/:id — update default value and/or is_valid ─
router.patch('/:name/vars/:id', async (req, res) => {
  try {
    const db  = getDb();
    const cm  = await db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });
    const v = await db.prepare(
      'SELECT v.id, v.val, v.is_valid FROM lib_variables v JOIN lib_blocks b ON v.block_id = b.id WHERE v.id = ? AND b.cm_type_id = ?'
    ).get(req.params.id, cm.id);
    if (!v) return res.status(404).json({ error: 'Variable not found' });
    const { val, is_valid } = req.body || {};
    if (val !== undefined) {
      await db.prepare('UPDATE lib_variables SET val = ? WHERE id = ?').run(val ?? '', req.params.id);
    }
    if (is_valid !== undefined) {
      await db.prepare('UPDATE lib_variables SET is_valid = ? WHERE id = ?').run(!!is_valid, req.params.id);
    }
    const updated = await db.prepare('SELECT val, is_valid FROM lib_variables WHERE id = ?').get(req.params.id);
    res.json({ success: true, id: Number(req.params.id), val: updated.val ?? '', isValid: !!updated.is_valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cm-types/:name/blocks ───────────────────────────────────────────
router.get('/:name/blocks', async (req, res) => {
  try {
    const db = getDb();

    const cm = await db.prepare(`SELECT * FROM lib_cm_types WHERE name = ?`).get(req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });

    const roles  = await db.prepare(`SELECT role, role_kind, sort_order FROM lib_em_roles WHERE cm_type_id = ? ORDER BY sort_order`).all(cm.id);
    const blocks = await db.prepare(`SELECT * FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`).all(cm.id);

    // Variables: use STRING_AGG for links to avoid N+1 queries
    const vars = await db.prepare(`
      SELECT v.*, STRING_AGG(lk.target_lib_id, ',') AS link_ids
      FROM lib_variables v
      JOIN lib_blocks b ON v.block_id = b.id
      LEFT JOIN lib_var_links lk ON lk.var_id = v.id
      WHERE b.cm_type_id = ?
      GROUP BY v.id
      ORDER BY v.block_id, v.sort_order
    `).all(cm.id);

    const msgs = await db.prepare(`
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

// ── GET /api/cm-types/:name/block-prefs — Get user's saved optional block selections ──
router.get('/:name/block-prefs', async (req, res) => {
  try {
    const db = getDb();
    const prefs = await db.prepare(`
      SELECT enabled_blocks FROM user_cm_block_prefs WHERE cm_type_name = ?
    `).get(req.params.name);
    const enabledBlocks = prefs ? JSON.parse(prefs.enabled_blocks || '[]') : [];
    res.json({ enabledBlocks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/cm-types/:name/block-prefs — Save user's optional block selections ──
router.put('/:name/block-prefs', async (req, res) => {
  try {
    const db = getDb();
    const { enabledBlocks = [] } = req.body || {};
    await db.prepare(`
      INSERT INTO user_cm_block_prefs (cm_type_name, enabled_blocks)
      VALUES (?, ?)
      ON CONFLICT(cm_type_name) DO UPDATE SET
        enabled_blocks = excluded.enabled_blocks,
        updated_at = NOW()
    `).run(req.params.name, JSON.stringify(enabledBlocks));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
