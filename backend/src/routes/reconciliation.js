// src/routes/reconciliation.js — Instance reconciliation endpoints
'use strict';
const express = require('express');
const { getDb } = require('../db');
const {
  runReconciliation,
  acceptDummy,
  revertDummy,
  bulkAcceptDummies,
  bulkRevertDummies,
  getReconciliationSummary,
  getInstancesWithReconciliation,
} = require('../services/reconciliationEngine');

const router = express.Router();

function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// ── POST /api/reconciliation/project/:projectId/run ───────────────────────────
router.post('/project/:projectId/run', async (req, res) => {
  try {
    const db = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return err(res, 400, 'projectId required');

    const project = await db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return err(res, 404, 'Project not found');

    const result = await runReconciliation(db, projectId);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[Reconciliation] Run error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconciliation/project/:projectId/summary ────────────────────────
router.get('/project/:projectId/summary', async (req, res) => {
  try {
    const db = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return err(res, 400, 'projectId required');

    const summary = await getReconciliationSummary(db, projectId);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconciliation/project/:projectId/instances ──────────────────────
router.get('/project/:projectId/instances', async (req, res) => {
  try {
    const db = getDb();
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return err(res, 400, 'projectId required');

    const filters = {
      status: req.query.status || null,
      search: req.query.search || null,
    };

    const instances = await getInstancesWithReconciliation(db, projectId, filters);
    res.json({ instances, count: instances.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/reconciliation/instances/:id/accept ────────────────────────────
router.patch('/instances/:id/accept', async (req, res) => {
  try {
    const db = getDb();
    const instanceId = parseInt(req.params.id, 10);
    if (!instanceId) return err(res, 400, 'instance id required');

    const acceptedBy = req.body?.acceptedBy || req.query.acceptedBy || 'user';
    await acceptDummy(db, instanceId, acceptedBy);
    res.json({ success: true, id: instanceId, status: 'DUMMY_ACCEPTED' });
  } catch (e) {
    if (e.message.includes('not found') || e.message.includes('not in DUMMY')) {
      return err(res, 404, e.message);
    }
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/reconciliation/instances/:id/revert ────────────────────────────
router.patch('/instances/:id/revert', async (req, res) => {
  try {
    const db = getDb();
    const instanceId = parseInt(req.params.id, 10);
    if (!instanceId) return err(res, 400, 'instance id required');

    await revertDummy(db, instanceId);
    res.json({ success: true, id: instanceId, status: 'DUMMY' });
  } catch (e) {
    if (e.message.includes('not found') || e.message.includes('not in DUMMY_ACCEPTED')) {
      return err(res, 404, e.message);
    }
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/reconciliation/instances/bulk-accept ───────────────────────────
router.patch('/instances/bulk-accept', async (req, res) => {
  try {
    const db = getDb();
    const { instanceIds, acceptedBy } = req.body || {};

    if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
      return err(res, 400, 'instanceIds array required');
    }

    const count = await bulkAcceptDummies(db, instanceIds, acceptedBy || 'user');
    res.json({ success: true, accepted: count });
  } catch (e) {
    if (e.message.includes('No instances')) return err(res, 404, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/reconciliation/instances/bulk-revert ───────────────────────────
router.patch('/instances/bulk-revert', async (req, res) => {
  try {
    const db = getDb();
    const { instanceIds } = req.body || {};

    if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
      return err(res, 400, 'instanceIds array required');
    }

    const count = await bulkRevertDummies(db, instanceIds);
    res.json({ success: true, reverted: count });
  } catch (e) {
    if (e.message.includes('No instances')) return err(res, 404, e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
