// src/routes/signalMappings.js — Signal-to-Instance mapping CRUD + signal lookup
//
// Standalone module. Stores mappings in `signal_mappings` and serves the signal
// picker from the project's latest hw_import. The export engine reads these
// mappings via signalMappings.loadMappingsForProject() — see routes/generate.js.
'use strict';
const express = require('express');
const { getDb } = require('../db');
const {
  validateDatatype,
  latestHwImportId,
} = require('../signalMappings');

const router = express.Router();

// ── GET /api/signal-mappings/project/:projectId[?instance=NAME] ───────────────
// List stored mappings for a project, optionally filtered to one instance.
router.get('/project/:projectId', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    const instance  = req.query.instance;
    const rows = instance
      ? await db.prepare(
          `SELECT * FROM signal_mappings WHERE project_id = ? AND instance_name = ?
           ORDER BY block_name, var_name`
        ).all(projectId, instance)
      : await db.prepare(
          `SELECT * FROM signal_mappings WHERE project_id = ?
           ORDER BY instance_name, block_name, var_name`
        ).all(projectId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/signal-mappings/project/:projectId/signals?q=&type=&limit= ───────
// Candidate signals from the project's latest hw_import. Server-side LIKE filter
// + hard LIMIT so the picker never loads the full set (scales to 50k+ signals).
router.get('/project/:projectId/signals', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    const importId  = await latestHwImportId(db, projectId);
    if (!importId) return res.json({ importId: null, signals: [] });

    const q     = (req.query.q || '').trim();
    const type  = (req.query.type || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

    const where = ['hw_import_id = ?', "tag IS NOT NULL", "tag != ''"];
    const vals  = [importId];
    if (q)    { where.push('tag LIKE ?');      vals.push(`%${q}%`); }
    if (type) { where.push('signal_type = ?'); vals.push(type); }
    vals.push(limit);

    const signals = await db.prepare(
      `SELECT id, tag, signal_type, description, station_address, slot, channel
       FROM hw_signals
       WHERE ${where.join(' AND ')}
       ORDER BY tag
       LIMIT ?`
    ).all(...vals);

    res.json({ importId, signals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/signal-mappings/project/:projectId/instance/:instanceName ────────
// Replace all mappings for one instance. Body: { mappings: [{ blockName, varName,
// signalTag, hwSignalId?, varDtype?, signalType? }] }. Validates datatype per row
// (warn only) and returns { saved, warnings: [...] }.
router.put('/project/:projectId/instance/:instanceName', async (req, res) => {
  try {
    const db           = getDb();
    const projectId    = parseInt(req.params.projectId, 10);
    const instanceName = req.params.instanceName;
    const mappings     = Array.isArray(req.body?.mappings) ? req.body.mappings : [];

    const warnings = [];
    const seenSignals = new Map();   // signal_tag -> "block.var" (duplicate-signal warning)
    const clean = [];
    for (const m of mappings) {
      if (!m || !m.blockName || !m.varName || !m.signalTag) continue;
      const key = `${m.blockName}.${m.varName}`;
      // Datatype validation (warn but allow)
      const v = validateDatatype(m.signalType, m.varDtype);
      if (!v.ok) warnings.push(`${key}: ${v.reason}`);
      // Same signal reused on multiple variables (allowed, warned)
      if (seenSignals.has(m.signalTag)) {
        warnings.push(`Signal ${m.signalTag} is assigned to both ${seenSignals.get(m.signalTag)} and ${key}`);
      } else {
        seenSignals.set(m.signalTag, key);
      }
      clean.push(m);
    }

    const save = db.transaction(async () => {
      await db.prepare(
        `DELETE FROM signal_mappings WHERE project_id = ? AND instance_name = ?`
      ).run(projectId, instanceName);
      const ins = db.prepare(
        `INSERT INTO signal_mappings
           (project_id, instance_name, block_name, var_name, signal_tag, hw_signal_id, var_dtype, signal_type)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      for (const m of clean) {
        await ins.run(projectId, instanceName, m.blockName, m.varName, m.signalTag,
          m.hwSignalId ?? null, m.varDtype ?? null, m.signalType ?? null);
      }
      return clean.length;
    });
    const saved = await save();

    res.json({ saved, warnings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/signal-mappings/:id ───────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.prepare(`DELETE FROM signal_mappings WHERE id = ?`).run(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/signal-mappings/project/:projectId/auto-map ─────────────────────
// Stub for future bulk auto-mapping (and Excel import). Returns the same row
// shape the PUT endpoint accepts, so a future importer can post straight through.
router.post('/project/:projectId/auto-map', (_req, res) => {
  res.json({ proposed: [], note: 'auto-map deferred' });
});

module.exports = router;
