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

// ── GET /api/connections/:projectId/:instanceName/exported-blocks ──────────────
// List blocks that are exported (emitted in XML) for an instance.
// Returns blocks that passed cascade + optional filters.
router.get('/:projectId/:instanceName/exported-blocks', async (req, res) => {
  try {
    const db = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    const instanceName = (req.params.instanceName || '').trim();

    if (!instanceName) return err(res, 400, 'instanceName required');

    // Fetch the instance and its CM type
    const inst = await db.prepare(
      `SELECT i.id, i.cm_type, c.id AS cm_type_id
       FROM project_instances i
       JOIN lib_cm_types c ON c.name = i.cm_type
       WHERE i.project_id = ? AND i.instance_name = ?`
    ).get(projectId, instanceName);
    if (!inst) return err(res, 404, 'Instance not found');

    // Fetch all blocks in the CM type
    const blocks = await db.prepare(
      `SELECT id, name, optional FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`
    ).all(inst.cm_type_id);

    // Reconciled IO state. cascade_status is written by reconcileConnections() —
    // read it rather than recomputing the cascade, so this preview can't drift
    // from what the exporter actually does.
    const ios = await db.prepare(
      `SELECT DISTINCT block_name, status, required, cascade_status FROM instance_ios
       WHERE project_id = ? AND instance_name = ?`
    ).all(projectId, instanceName);

    // Enabled-block set, resolved exactly as routes/generate.js does it: the
    // per-user library preference first, then the project profile, with any
    // non-empty list winning. project_cmt_profiles is briefly empty mid-save,
    // so neither source alone is reliable.
    let enabledBlocks = [];
    for (const row of [
      await db.prepare(
        `SELECT enabled_blocks FROM user_cm_block_prefs WHERE cm_type_name = ?`
      ).get(inst.cm_type),
      await db.prepare(
        `SELECT enabled_blocks FROM project_cmt_profiles WHERE project_id = ? AND cm_type = ?`
      ).get(projectId, inst.cm_type),
    ]) {
      let list = [];
      try { list = JSON.parse(row?.enabled_blocks || '[]'); } catch { list = []; }
      if (Array.isArray(list) && list.length) enabledBlocks = list;
    }

    // A block drops out for one of two reasons, mirroring xmlGenerator.js:
    //   - optional and not switched on for this CM type
    //   - omitted by reconciliation (required pins unmatched, or cascaded off a
    //     parent that was itself omitted)
    const omitted = new Set(
      ios.filter(io => io.cascade_status || (io.required && io.status === 'dummy'))
         .map(io => io.block_name)
    );

    const exported = blocks
      .filter(b => !b.optional || enabledBlocks.includes(b.name))
      .filter(b => !omitted.has(b.name))
      .map(b => {
        const ioEntry = ios.find(io => io.block_name === b.name);
        return {
          block_name: b.name,
          optional: !!b.optional,
          // No IO rule means no hardware binding — the block is emitted
          // unconditionally rather than being of unknown status.
          status: ioEntry?.status || 'unconditional',
          var_count: 0,
        };
      });

    res.json({
      instance_name: instanceName,
      exported_blocks: exported,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { err(res, 500, e.message); }
});

module.exports = router;
