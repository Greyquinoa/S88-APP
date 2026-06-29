// src/routes/connections.js — Connection generation (dummy ↔ hardware) endpoints
//
// Standalone module. POST .../generate runs the re-runnable reconciliation that
// matches each CM instance dummy IO against the project's hardware symbols and
// materializes the result into instance_ios. GET returns the current state for
// display. The export engine reads instance_ios via connections.loadConnectionIOsForProject()
// — see routes/generate.js.
'use strict';
const express = require('express');
const { getDb } = require('../db');
const { reconcileConnections } = require('../connections');

const router = express.Router();
function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// ── POST /api/connections/project/:projectId/generate ─────────────────────────
// Reconcile dummy IOs against hardware symbols for the whole project. Idempotent —
// safe to re-run after IO re-imports, hardware edits, or tag renames.
router.post('/project/:projectId/generate', (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
      return err(res, 404, 'Project not found');

    const result = reconcileConnections(db, projectId);
    res.json(result);
  } catch (e) { err(res, 500, e.message); }
});

// ── GET /api/connections/project/:projectId[?status=real|dummy] ───────────────
// Current reconciled IOs for the project (joined to hardware address for REAL rows).
router.get('/project/:projectId', (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    const status    = (req.query.status || '').trim();

    const where = ['io.project_id = ?'];
    const vals  = [projectId];
    if (status === 'real' || status === 'dummy') { where.push('io.status = ?'); vals.push(status); }

    const rows = db.prepare(
      `SELECT io.id, io.instance_name, io.block_name, io.var_name, io.signal_name,
              io.signal_type, io.required, io.status, io.hw_signal_id,
              hw.station_address, hw.slot, hw.channel
       FROM instance_ios io
       LEFT JOIN hw_signals hw ON hw.id = io.hw_signal_id
       WHERE ${where.join(' AND ')}
       ORDER BY io.instance_name, io.block_name, io.var_name`
    ).all(...vals);

    const real  = rows.filter(r => r.status === 'real').length;
    res.json({ total: rows.length, real, dummy: rows.length - real, ios: rows });
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
