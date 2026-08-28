// src/routes/library.js — Library upload + query endpoints
'use strict';
const express = require('express');
const multer  = require('multer');
const { getDb }           = require('../db');
const { parseLibraryXML } = require('../xmlParser');
const { computeLibraryDiff, computeCompositeDiff } = require('../services/diffLibrary');
const { recordAudit, diffRow, newBatchId } = require('../services/auditLog');
const { describeChanges, enrichChanges } = require('../services/libraryFieldMeta');
const {
  getCompositeDetail,
  _insertMembers: insertCompositeMembers,
  _insertConnections: insertCompositeConnections,
  _insertMatrixColumns: insertMatrixColumns,
  _insertMatrixModes: insertMatrixModes,
  _deleteMatrixData: deleteMatrixData,
} = require('./compositeCmTypes');

const router = express.Router({ mergeParams: true });
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
    const projectId = req.params.projectId;
    const diffResult = await computeLibraryDiff(cmTypes, db, projectId);

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
    const projectId = req.params.projectId;
    const batchId = newBatchId();

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
          const result = await _insertNewCmType(item.newType, db, batchId, projectId);
          stats.new++;
          totalBlocks += result.blocks;
          totalVars += result.vars;
          continue;
        }

        // Merge updated types (preserve block preferences)
        if (item.status === 'UPDATED') {
          const result = await _mergeUpdatedCmType(item.oldType.id, item.newType, db, batchId, projectId);
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
async function _insertNewCmType(cm, db, batchId = null, projectId) {
  let totalBlocks = 0;
  let totalVars = 0;

  const cmRow = await db.prepare(
    `INSERT INTO lib_cm_types (project_id, name, cm_type, comment, sampling_time) VALUES (?,?,?,?,?)`
  ).run(projectId, cm.name, cm.type || '', cm.comment || '', cm.samplingTime || '1000');
  const cmId = cmRow.lastInsertRowid;

  await recordAudit(db, {
    projectId,
    batchId,
    entityType: 'LibraryCmType',
    entityId: cmId,
    action: 'CREATE',
    description: `CM type '${cm.name}' created`,
    source: 'import',
    location: 'Library > Upload Library',
    objectLabel: `CM Type - ${cm.name}`,
    contextCmType: cm.name,
  });

  for (const blk of cm.subBlocks) {
    const blkRow = await db.prepare(
      `INSERT INTO lib_blocks (cm_type_id, name, comment, optional, is_conditional, sort_order) VALUES (?,?,?,?,?,?)`
      // is_conditional is an INTEGER column (0/1), unlike the boolean `optional`
    ).run(cmId, blk.name, blk.comment || '', !!blk.optional, blk.isConditional ? 1 : 0, blk.sortOrder);
    const blkId = blkRow.lastInsertRowid;
    totalBlocks++;

    for (const v of blk.vars) {
      const varRow = await db.prepare(`
        INSERT INTO lib_variables
          (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, is_valid, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(blkId, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
             v.comment||'', v.vtype||'', v.enumeration||'', !!v.negation, !!v.isValid, v.sortOrder);
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

  // A library export carries the enabled-optional-blocks selection; apply it so the
  // imported type arrives configured. XML uploads have none — nothing to write.
  if (Array.isArray(cm.enabledBlocks)) {
    const blockNames = new Set(cm.subBlocks.map(b => b.name));
    const filtered = cm.enabledBlocks.filter(bn => blockNames.has(bn));
    await db.prepare(`
      INSERT INTO user_cm_block_prefs (project_id, cm_type_name, enabled_blocks) VALUES (?, ?, ?)
      ON CONFLICT (project_id, cm_type_name) DO UPDATE SET enabled_blocks = EXCLUDED.enabled_blocks
    `).run(projectId, cm.name, JSON.stringify(filtered));
  }

  return { blocks: totalBlocks, vars: totalVars };
}

// ── Helper: Merge updated CM type with block preference preservation ────
async function _mergeUpdatedCmType(cmTypeId, newType, db, batchId = null, projectId) {
  let totalBlocks = 0;
  let totalVars = 0;

  // Step 1: Decide the enabled-blocks selection to end up with.
  // A library export carries its own selection (newType.enabledBlocks) — that wins,
  // so an imported library arrives configured as it was on the source side. An XML
  // upload (or a pre-`enabledBlocks` export) has none, so the local selection is kept.
  const prefs = await db.prepare(
    `SELECT enabled_blocks FROM user_cm_block_prefs WHERE project_id = ? AND cm_type_name = ?`
  ).get(projectId, newType.name);
  const localBlockNames = prefs ? JSON.parse(prefs.enabled_blocks || '[]') : [];
  const savedBlockNames = Array.isArray(newType.enabledBlocks) ? newType.enabledBlocks : localBlockNames;

  // Step 2: Update type metadata
  const oldCmRow = await db.prepare(
    `SELECT comment, sampling_time FROM lib_cm_types WHERE id = ?`
  ).get(cmTypeId);
  await db.prepare(
    `UPDATE lib_cm_types SET cm_type = ?, comment = ?, sampling_time = ? WHERE id = ?`
  ).run(newType.type || '', newType.comment || '', newType.samplingTime || '1000', cmTypeId);

  const cmChanges = diffRow(
    { 'lib_cm_types.comment': oldCmRow?.comment, 'lib_cm_types.sampling_time': oldCmRow?.sampling_time },
    { 'lib_cm_types.comment': newType.comment || '', 'lib_cm_types.sampling_time': newType.samplingTime || '1000' },
    { 'lib_cm_types.comment': true, 'lib_cm_types.sampling_time': true },
  );
  if (cmChanges.length) {
    await recordAudit(db, {
      projectId,
      batchId,
      entityType: 'LibraryCmType',
      entityId: cmTypeId,
      action: 'UPDATE',
      fieldChanges: enrichChanges(cmChanges),
      description: describeChanges(`CM type '${newType.name}'`, cmChanges),
      source: 'import',
      location: 'Library > Upload Library',
      objectLabel: `CM Type - ${newType.name}`,
      contextCmType: newType.name,
    });
  }

  // Step 3: Fetch existing blocks and delete removed ones
  const oldBlocks = await db.prepare(
    `SELECT id, name, comment, optional, is_conditional FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`
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
        `UPDATE lib_blocks SET comment = ?, optional = ?, is_conditional = ? WHERE id = ?`
        // is_conditional is an INTEGER column (0/1), unlike the boolean `optional`
      ).run(newBlock.comment || '', !!newBlock.optional, newBlock.isConditional ? 1 : 0, oldBlock.id);

      const blockChanges = diffRow(
        { 'lib_blocks.optional': oldBlock.optional, 'lib_blocks.is_conditional': oldBlock.is_conditional },
        { 'lib_blocks.optional': !!newBlock.optional, 'lib_blocks.is_conditional': !!newBlock.isConditional },
        { 'lib_blocks.optional': true, 'lib_blocks.is_conditional': true },
      );
      if (blockChanges.length) {
        await recordAudit(db, {
          projectId,
          batchId,
          entityType: 'LibraryBlock',
          entityId: oldBlock.id,
          action: 'UPDATE',
          fieldChanges: enrichChanges(blockChanges),
          description: describeChanges(`Block '${newBlock.name}' (${newType.name})`, blockChanges),
          source: 'import',
          location: 'Library > Upload Library',
          objectLabel: `Block - ${newBlock.name}`,
          contextCmType: newType.name,
        });
      }

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
            (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, is_valid, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(oldBlock.id, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
               v.comment||'', v.vtype||'', v.enumeration||'', !!v.negation, !!v.isValid, v.sortOrder);
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
        `INSERT INTO lib_blocks (cm_type_id, name, comment, optional, is_conditional, sort_order) VALUES (?,?,?,?,?,?)`
        // is_conditional is an INTEGER column (0/1), unlike the boolean `optional`
      ).run(cmTypeId, newBlock.name, newBlock.comment || '', !!newBlock.optional, newBlock.isConditional ? 1 : 0, newBlock.sortOrder);
      const blkId = blkRow.lastInsertRowid;
      totalBlocks++;

      for (const v of newBlock.vars) {
        const varRow = await db.prepare(`
          INSERT INTO lib_variables
            (block_id, lib_id, name, dir, dtype, val, comment, vtype, enumeration, negation, is_valid, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(blkId, v.libId, v.name, v.dir||'', v.dtype||'', v.val||'',
               v.comment||'', v.vtype||'', v.enumeration||'', !!v.negation, !!v.isValid, v.sortOrder);
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
    INSERT INTO user_cm_block_prefs (project_id, cm_type_name, enabled_blocks) VALUES (?, ?, ?)
    ON CONFLICT (project_id, cm_type_name) DO UPDATE SET enabled_blocks = EXCLUDED.enabled_blocks
  `).run(projectId, newType.name, JSON.stringify(filteredPrefs));

  return { blocks: totalBlocks, vars: totalVars };
}

// ── GET /api/library/status ───────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const db  = getDb();
    const rows = await db.prepare(`
      SELECT cm_type, COUNT(*) AS count, MAX(loaded_at) AS last_loaded FROM lib_cm_types WHERE project_id = ? GROUP BY cm_type
    `).all(req.params.projectId);

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
      WHERE t.project_id = ?
      GROUP BY t.id
      ORDER BY t.name
    `).all(req.params.projectId);
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
    const cm = await db.prepare('SELECT id FROM lib_cm_types WHERE project_id = ? AND name = ?').get(req.params.projectId, req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });

    await db.transaction(async () => {
      await recordAudit(db, {
        projectId: req.params.projectId,
        entityType: 'LibraryCmType',
        entityId: cm.id,
        action: 'DELETE',
        description: `CM type '${req.params.name}' deleted`,
        source: 'ui',
        location: 'Library > Type Configuration',
        objectLabel: `CM Type - ${req.params.name}`,
        contextCmType: req.params.name,
      });

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
    const cm  = await db.prepare('SELECT id FROM lib_cm_types WHERE project_id = ? AND name = ?').get(req.params.projectId, req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });
    const v = await db.prepare(
      'SELECT v.id, v.name, v.val, v.is_valid FROM lib_variables v JOIN lib_blocks b ON v.block_id = b.id WHERE v.id = ? AND b.cm_type_id = ?'
    ).get(req.params.id, cm.id);
    if (!v) return res.status(404).json({ error: 'Variable not found' });
    const { val, is_valid } = req.body || {};

    const doUpdate = db.transaction(async () => {
      if (val !== undefined) {
        await db.prepare('UPDATE lib_variables SET val = ? WHERE id = ?').run(val ?? '', req.params.id);
      }
      if (is_valid !== undefined) {
        await db.prepare('UPDATE lib_variables SET is_valid = ? WHERE id = ?').run(!!is_valid, req.params.id);
      }
      const updated = await db.prepare('SELECT val, is_valid FROM lib_variables WHERE id = ?').get(req.params.id);

      const changes = diffRow(
        { 'lib_variables.val': v.val, 'lib_variables.is_valid': v.is_valid },
        { 'lib_variables.val': updated.val, 'lib_variables.is_valid': updated.is_valid },
        {
          ...(val !== undefined ? { 'lib_variables.val': true } : {}),
          ...(is_valid !== undefined ? { 'lib_variables.is_valid': true } : {}),
        },
      );
      if (changes.length) {
        const block = await db.prepare('SELECT name FROM lib_blocks WHERE id = ?').get(v.block_id || 0);
        await recordAudit(db, {
          projectId: req.params.projectId,
          entityType: 'LibraryVariable',
          entityId: v.id,
          action: 'UPDATE',
          fieldChanges: enrichChanges(changes),
          description: describeChanges(`Variable '${v.name}' (${req.params.name})`, changes),
          source: 'ui',
          location: 'Library > Type Configuration',
          objectLabel: `Variable - ${v.name}`,
          contextCmType: req.params.name,
        });
      }

      return updated;
    });

    const updated = await doUpdate();
    res.json({ success: true, id: Number(req.params.id), val: updated.val ?? '', isValid: !!updated.is_valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: load full CM type detail (roles, blocks, vars, msgs) by row ───────
// Shared by GET /:name/blocks and the library export endpoint.
async function loadCmTypeDetail(db, cm) {
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

  return {
    ...cm,
    roles: roles.map(r => r.role),
    roleKindMap,
    subBlocks: blocks.map(b => ({
      id: b.id, name: b.name, comment: b.comment, optional: !!b.optional, isConditional: !!b.is_conditional,
      vars: varsByBlock[b.id] || [],
      msgs: msgsByBlock[b.id] || [],
    })),
  };
}

// ── GET /api/cm-types/:name/blocks ───────────────────────────────────────────
router.get('/:name/blocks', async (req, res) => {
  try {
    const db = getDb();
    const cm = await db.prepare(`SELECT * FROM lib_cm_types WHERE project_id = ? AND name = ?`).get(req.params.projectId, req.params.name);
    if (!cm) return res.status(404).json({ error: 'CM type not found' });
    res.json(await loadCmTypeDetail(db, cm));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cm-types/:name/block-prefs — Get user's saved optional block selections ──
router.get('/:name/block-prefs', async (req, res) => {
  try {
    const db = getDb();
    const prefs = await db.prepare(`
      SELECT enabled_blocks FROM user_cm_block_prefs WHERE project_id = ? AND cm_type_name = ?
    `).get(req.params.projectId, req.params.name);
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
      INSERT INTO user_cm_block_prefs (project_id, cm_type_name, enabled_blocks)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, cm_type_name) DO UPDATE SET
        enabled_blocks = excluded.enabled_blocks,
        updated_at = NOW()
    `).run(req.params.projectId, req.params.name, JSON.stringify(enabledBlocks));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/lib-blocks/:blockId/conditional — Toggle conditional flag on a block ──
router.patch('/block/:blockId/conditional', async (req, res) => {
  try {
    const db = getDb();
    const { isConditional } = req.body || {};

    const block = await db.prepare(`
      SELECT b.id, b.name, b.is_conditional FROM lib_blocks b
      JOIN lib_cm_types t ON t.id = b.cm_type_id
      WHERE b.id = ? AND t.project_id = ?
    `).get(req.params.blockId, req.params.projectId);
    if (!block) return res.status(404).json({ error: 'Block not found' });

    const doUpdate = db.transaction(async () => {
      await db.prepare('UPDATE lib_blocks SET is_conditional = ? WHERE id = ?').run(
        isConditional ? 1 : 0,
        req.params.blockId
      );

      const changes = diffRow(
        { 'lib_blocks.is_conditional': !!block.is_conditional },
        { 'lib_blocks.is_conditional': !!isConditional },
        { 'lib_blocks.is_conditional': true },
      );
      if (changes.length) {
        const cm = await db.prepare('SELECT t.name FROM lib_cm_types t JOIN lib_blocks b ON b.cm_type_id = t.id WHERE b.id = ?').get(block.id);
        await recordAudit(db, {
          projectId: req.params.projectId,
          entityType: 'LibraryBlock',
          entityId: block.id,
          action: 'UPDATE',
          fieldChanges: enrichChanges(changes),
          description: describeChanges(`Block '${block.name}' (${cm?.name || 'N/A'})`, changes),
          source: 'ui',
          location: 'Library > Type Configuration',
          objectLabel: `Block - ${block.name}`,
          contextCmType: cm?.name || null,
        });
      }
    });

    await doUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LIBRARY_ENTITY_TYPES = ['LibraryCmType', 'LibraryBlock', 'LibraryVariable'];

// ── GET /api/library/audit-log — module-level feed, paginated + filterable ────
router.get('/audit-log', async (req, res) => {
  try {
    const db = getDb();
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { user, action, from, to } = req.query;

    const entityPlaceholders = LIBRARY_ENTITY_TYPES.map(() => '?').join(',');
    const clauses = [`entity_type IN (${entityPlaceholders})`, `project_id = ?`];
    const params  = [...LIBRARY_ENTITY_TYPES, req.params.projectId];

    if (user)   { clauses.push(`changed_by ILIKE ?`); params.push(`%${user}%`); }
    if (action) { clauses.push(`action = ?`); params.push(action); }
    if (from)   { clauses.push(`changed_at >= ?`); params.push(from); }
    if (to)     { clauses.push(`changed_at <= ?`); params.push(to); }

    const where = `WHERE ${clauses.join(' AND ')}`;

    const rows = await db.prepare(`
      SELECT id, project_id, batch_id, entity_type, entity_id, action,
             field_changes, description, changed_by, reason, source, changed_at,
             location, object_label, context_cm_type
      FROM audit_log
      ${where}
      ORDER BY changed_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const totalRow = await db.prepare(`SELECT COUNT(*) AS count FROM audit_log ${where}`).get(...params);

    res.json({
      entries: rows,
      total: Number(totalRow?.count || 0),
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/library/audit-log/:entityType/:entityId — history for one entity ─
router.get('/audit-log/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    if (!LIBRARY_ENTITY_TYPES.includes(entityType)) {
      return res.status(400).json({ error: `entityType must be one of: ${LIBRARY_ENTITY_TYPES.join(', ')}` });
    }
    const db = getDb();
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const rows = await db.prepare(`
      SELECT id, project_id, batch_id, entity_type, entity_id, action,
             field_changes, description, changed_by, reason, source, changed_at,
             location, object_label, context_cm_type
      FROM audit_log
      WHERE entity_type = ? AND entity_id = ? AND project_id = ?
      ORDER BY changed_at DESC
      LIMIT ? OFFSET ?
    `).all(entityType, entityId, req.params.projectId, limit, offset);

    res.json({ entries: rows, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Full-library export / import (CM types + Composite CM types + Matrix modes)
// ═══════════════════════════════════════════════════════════════════════════

// In-memory cache for uploaded export files: token → { cmTypes, composites, diff, timerId }
const _libExportCache = new Map();

function libExportCacheSet(token, data) {
  for (const [k, v] of _libExportCache) clearTimeout(v.timerId);
  _libExportCache.clear();
  const timerId = setTimeout(() => _libExportCache.delete(token), 15 * 60 * 1000);
  _libExportCache.set(token, { ...data, timerId });
}

// ── Helper: load one CM type in the same shape parseLibraryXML() produces ────
// (subBlocks/vars/msgs/roles all carry sortOrder) so the existing
// _insertNewCmType / _mergeUpdatedCmType helpers can consume exported JSON
// exactly like a freshly-parsed XML upload, without a shape-translation layer.
async function loadCmTypeForExport(db, cm) {
  const roles  = await db.prepare(`SELECT role, role_kind, sort_order FROM lib_em_roles WHERE cm_type_id = ? ORDER BY sort_order`).all(cm.id);
  const blocks = await db.prepare(`SELECT * FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`).all(cm.id);

  // Which optional blocks are switched on for this type (the green toggles in the
  // Type Configuration UI). Stored per cm_type_name in user_cm_block_prefs and
  // carried in the export so a library moves between projects fully configured.
  const prefRow = await db.prepare(
    `SELECT enabled_blocks FROM user_cm_block_prefs WHERE project_id = ? AND cm_type_name = ?`
  ).get(cm.project_id, cm.name);
  let enabledBlocks = null;
  if (prefRow) {
    try { enabledBlocks = JSON.parse(prefRow.enabled_blocks || '[]'); } catch { enabledBlocks = []; }
  }

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

  const varsByBlock = {};
  for (const v of vars) {
    (varsByBlock[v.block_id] ||= []).push({
      libId: v.lib_id, name: v.name, dir: v.dir, dtype: v.dtype, val: v.val,
      comment: v.comment, vtype: v.vtype, enumeration: v.enumeration,
      negation: !!v.negation, isValid: !!v.is_valid, libLinks: v.link_ids ? v.link_ids.split(',') : [],
      sortOrder: v.sort_order,
    });
  }

  const msgsByBlock = {};
  for (const m of msgs) {
    (msgsByBlock[m.block_id] ||= []).push({
      name: m.name, batch: m.batch, cls: m.cls, event: m.event,
      origin: m.origin, osarea: m.osarea, prio: m.prio, ack: !!m.ack,
      sortOrder: m.sort_order,
    });
  }

  return {
    name: cm.name,
    type: cm.cm_type,
    comment: cm.comment,
    samplingTime: cm.sampling_time,
    roles: roles.map(r => ({ role: r.role, roleKind: r.role_kind || 'cm', sortOrder: r.sort_order })),
    enabledBlocks,
    subBlocks: blocks.map(b => ({
      name: b.name, comment: b.comment, optional: !!b.optional, isConditional: !!b.is_conditional,
      sortOrder: b.sort_order,
      vars: varsByBlock[b.id] || [],
      msgs: msgsByBlock[b.id] || [],
    })),
  };
}

// ── GET /api/library/export — full library dump (CM types + composites) ──────
router.get('/export', async (req, res) => {
  try {
    const db = getDb();
    const projectId = req.params.projectId;

    const cmRows = await db.prepare('SELECT * FROM lib_cm_types WHERE project_id = ? ORDER BY name').all(projectId);
    const cmTypes = [];
    for (const cm of cmRows) cmTypes.push(await loadCmTypeForExport(db, cm));

    const compRows = await db.prepare('SELECT id, name FROM composite_cm_types WHERE project_id = ? ORDER BY name').all(projectId);
    const composites = [];
    for (const c of compRows) composites.push(await getCompositeDetail(db, c.id));

    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stats: { cmCount: cmTypes.length, compositeCount: composites.length },
      cmTypes,
      composites,
    };

    res.setHeader('Content-Disposition', `attachment; filename="library-export-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    console.error('[Library] Export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/library/import2/preview — upload exported file, compute diff ───
router.post('/import2/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const parsed = JSON.parse(req.file.buffer.toString('utf-8'));
    const cmTypes    = Array.isArray(parsed.cmTypes) ? parsed.cmTypes : [];
    const composites = Array.isArray(parsed.composites) ? parsed.composites : [];

    if (!cmTypes.length && !composites.length) {
      return res.status(400).json({ error: 'File contains no CM types or composites' });
    }

    const db = getDb();
    const projectId = req.params.projectId;
    const cmDiff   = await computeLibraryDiff(cmTypes, db, projectId);
    const compDiff = await computeCompositeDiff(composites, db, projectId);

    const token = Date.now().toString(36);
    libExportCacheSet(token, { cmTypes, composites, cmDiff, compDiff, projectId });

    console.log(`[Library] Import preview: CM ${cmDiff.summary.new} new/${cmDiff.summary.updated} updated, Composite ${compDiff.summary.new} new/${compDiff.summary.updated} updated`);

    res.json({
      token,
      cmTypes: cmDiff,
      composites: compDiff,
      meta: parsed.stats ? { exportedAt: parsed.exportedAt, sourceStats: parsed.stats } : null,
    });
  } catch (err) {
    console.error('[Library] Import preview error:', err.message);
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid library export file (not valid JSON)' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/library/import2/commit — selectively import CM types + composites ─
// Body: { token, selectedCmNames: string[], selectedCompositeNames: string[] }
router.post('/import2/commit', async (req, res) => {
  const { token, selectedCmNames = [], selectedCompositeNames = [] } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token is required' });

  const cached = _libExportCache.get(token);
  if (!cached) return res.status(404).json({ error: 'Upload token expired or not found — please re-upload the file' });

  const selectedCm   = new Set(selectedCmNames);
  const selectedComp = new Set(selectedCompositeNames);

  try {
    const db = getDb();
    const projectId = cached.projectId || req.params.projectId;
    const batchId = newBatchId();

    const result = await db.transaction(async () => {
      const stats = { cmNew: 0, cmUpdated: 0, cmSkipped: 0, compNew: 0, compUpdated: 0, compSkipped: 0 };

      // CM types (reuses the same merge helpers as the single-file library import)
      for (const item of cached.cmDiff.items) {
        if (item.status === 'REMOVED_FROM_FILE') continue;
        if (!selectedCm.has(item.name)) { stats.cmSkipped++; continue; }
        if (item.status === 'UNCHANGED') continue;
        if (item.status === 'NEW') {
          await _insertNewCmType(item.newType, db, batchId, projectId);
          stats.cmNew++;
        } else if (item.status === 'UPDATED') {
          await _mergeUpdatedCmType(item.oldType.id, item.newType, db, batchId, projectId);
          stats.cmUpdated++;
        }
      }

      // Composites
      for (const item of cached.compDiff.items) {
        if (item.status === 'REMOVED_FROM_FILE') continue;
        if (!selectedComp.has(item.name)) { stats.compSkipped++; continue; }
        if (item.status === 'UNCHANGED') continue;

        const nc = item.newType;
        if (item.status === 'NEW') {
          const row = await db.prepare(
            'INSERT INTO composite_cm_types (project_id, name, description, is_matrix) VALUES (?, ?, ?, ?)'
          ).run(projectId, nc.name, nc.description || '', !!nc.is_matrix);
          const compId = row.lastInsertRowid;
          await insertCompositeMembers(db, compId, nc.members || []);
          await insertCompositeConnections(db, compId, nc.connections || []);
          if (nc.is_matrix) {
            await insertMatrixColumns(db, compId, nc.matrixColumns || []);
            await insertMatrixModes(db, compId, nc.matrixModes || []);
          }
          await recordAudit(db, {
            projectId, batchId, entityType: 'CompositeCmType', entityId: compId, action: 'CREATE',
            description: `Composite CM type '${nc.name}' created via library import`,
            source: 'import', location: 'Library > Import Library', objectLabel: `Composite - ${nc.name}`,
          });
          stats.compNew++;
        } else if (item.status === 'UPDATED') {
          const compId = item.oldType.id;
          await db.prepare('UPDATE composite_cm_types SET description=?, is_matrix=? WHERE id=?')
            .run(nc.description || '', !!nc.is_matrix, compId);
          await db.prepare('DELETE FROM composite_cm_members WHERE composite_id = ?').run(compId);
          await db.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(compId);
          await deleteMatrixData(db, compId);
          await insertCompositeMembers(db, compId, nc.members || []);
          await insertCompositeConnections(db, compId, nc.connections || []);
          if (nc.is_matrix) {
            await insertMatrixColumns(db, compId, nc.matrixColumns || []);
            await insertMatrixModes(db, compId, nc.matrixModes || []);
          }
          await recordAudit(db, {
            projectId, batchId, entityType: 'CompositeCmType', entityId: compId, action: 'UPDATE',
            description: `Composite CM type '${nc.name}' updated via library import`,
            source: 'import', location: 'Library > Import Library', objectLabel: `Composite - ${nc.name}`,
          });
          stats.compUpdated++;
        }
      }

      return stats;
    })();

    _libExportCache.delete(token);
    console.log(`[Library] Import committed:`, result);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Library] Import commit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
