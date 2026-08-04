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
const { resolveDerivedValues } = require('../derivedValues');
const { autoAssignRoles } = require('../services/autoRoleAssignment');

const router = express.Router();
function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// ── POST /api/connections/project/:projectId/generate ─────────────────────────
// Reconcile dummy IOs against hardware symbols for the whole project. Idempotent —
// safe to re-run after IO re-imports, hardware edits, or tag renames.
router.post('/project/:projectId/generate', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    if (!(await db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)))
      return err(res, 404, 'Project not found');

    const result = await reconcileConnections(db, projectId);
    const derived = await resolveDerivedValues(db, projectId);
    // Auto-assign roles for composite instances after connection generation succeeds
    await autoAssignRoles(db, projectId);
    res.json({ ...result, derivedValues: derived });
  } catch (e) { err(res, 500, e.message); }
});

// ── GET /api/connections/project/:projectId[?status=real|dummy] ───────────────
// Current reconciled IOs for the project (joined to hardware address for REAL rows).
router.get('/project/:projectId', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    const status    = (req.query.status || '').trim();

    const where = ['io.project_id = ?'];
    const vals  = [projectId];
    if (status === 'real' || status === 'dummy') { where.push('io.status = ?'); vals.push(status); }

    const rows = await db.prepare(
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

// ── PUT /api/connections/derived-values/:projectId/instance/:instanceName/override ──
// Set or clear a manual override for one derived Value pin. Body: { varName, value }.
// value === null (or omitted) clears the override so the auto-resolved value applies
// again. The row must already exist (created by resolveDerivedValues / "Generate
// Connections") — overrides can't be set on a pin that isn't a known derived connection.
// IMPORTANT: This route must come BEFORE the GET route below, since Express matches
// routes in order and "/derived-values/123/instance/..." would match the GET pattern.
router.put('/derived-values/:projectId/instance/:instanceName/override', async (req, res) => {
  try {
    const db           = getDb();
    const projectId    = parseInt(req.params.projectId, 10);
    const instanceName = decodeURIComponent(req.params.instanceName);
    const { varName, value } = req.body || {};
    if (!varName) return err(res, 400, 'varName is required');

    const result = await db.prepare(
      `UPDATE instance_derived_values SET override_value = ?
       WHERE project_id = ? AND instance_name = ? AND to_var_name = ?`
    ).run(value ?? null, projectId, instanceName, varName);

    if (!result.rowCount) {
      return err(res, 404, 'No derived-value connection found for this pin — run Generate Connections first');
    }
    res.json({ success: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── GET /api/connections/derived-values/:projectId ─────────────────────────────
// Current resolved derived values for the project (mirrors GET /project/:projectId).
router.get('/derived-values/:projectId', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);

    const rows = await db.prepare(
      `SELECT instance_name, to_var_name, symbol_name, column_name, value, status, io_tag_id, override_value
       FROM instance_derived_values
       WHERE project_id = ?
       ORDER BY instance_name, to_var_name`
    ).all(projectId);

    res.json({ values: rows });
  } catch (e) { err(res, 500, e.message); }
});

// ── PUT /api/connections/matrix-override/:projectId/instance/:instanceName ──────
// Upsert the per-instance matrix override. Body: { enabled, cells }.
//   enabled — single flag gating the whole matrix override for this instance.
//   cells   — JSON object keyed by mode_nr → { colName: intValue } (only overridden cells).
// IMPORTANT: declared BEFORE the GET route below so Express doesn't match
// "/matrix-override/123/instance/..." against the GET pattern.
router.put('/matrix-override/:projectId/instance/:instanceName', async (req, res) => {
  try {
    const db           = getDb();
    const projectId    = parseInt(req.params.projectId, 10);
    const instanceName = decodeURIComponent(req.params.instanceName);
    const { enabled = false, cells = {} } = req.body || {};

    await db.prepare(
      `INSERT INTO instance_matrix_overrides (project_id, instance_name, enabled, cells)
       VALUES (?,?,?,?)
       ON CONFLICT (project_id, instance_name)
       DO UPDATE SET enabled = EXCLUDED.enabled, cells = EXCLUDED.cells`
    ).run(projectId, instanceName, !!enabled, JSON.stringify(cells || {}));

    res.json({ success: true });
  } catch (e) { err(res, 500, e.message); }
});

// ── GET /api/connections/matrix-override/:projectId ────────────────────────────
// All per-instance matrix overrides for the project. `cells` parsed back to an object.
router.get('/matrix-override/:projectId', async (req, res) => {
  try {
    const db        = getDb();
    const projectId = parseInt(req.params.projectId, 10);

    const rows = await db.prepare(
      `SELECT instance_name, enabled, cells
       FROM instance_matrix_overrides
       WHERE project_id = ?`
    ).all(projectId);

    res.json({
      overrides: rows.map(r => ({
        instance_name: r.instance_name,
        enabled:       !!r.enabled,
        cells:         r.cells ? JSON.parse(r.cells) : {},
      })),
    });
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
