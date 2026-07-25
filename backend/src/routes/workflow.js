// src/routes/workflow.js — Automated workflow orchestration endpoint
'use strict';
const express = require('express');
const { getDb } = require('../db');
const { executeWorkflow } = require('../services/workflowEngine');

const router = express.Router();

function err(res, code, msg) { return res.status(code).json({ error: msg }); }

// POST /api/workflow/execute
// Body: { importId, projectId, functionMapId }
// Returns: SSE stream with progress frames, final { success, xml, stats, auditId }
router.post('/execute', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const db = getDb();
    const { importId, projectId, functionMapId } = req.body || {};

    if (!importId || !projectId || !functionMapId) {
      send({ error: 'Missing required fields: importId, projectId, functionMapId' });
      res.end();
      return;
    }

    // Verify import and project exist
    const imp = await db.prepare('SELECT id FROM io_imports WHERE id = ?').get(importId);
    if (!imp) {
      send({ error: 'Import not found' });
      res.end();
      return;
    }

    const proj = await db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!proj) {
      send({ error: 'Project not found' });
      res.end();
      return;
    }

    const funcMap = await db.prepare('SELECT id FROM io_function_map_configs WHERE id = ?').get(functionMapId);
    if (!funcMap) {
      send({ error: 'Function map not found' });
      res.end();
      return;
    }

    const result = await executeWorkflow(db, { importId, projectId, functionMapId }, send);
    send({ done: true, ...result });
    res.end();
  } catch (err) {
    console.error('[Workflow] Error:', err.message || err);
    if (err.stack) console.error(err.stack);
    send({ error: err.message || String(err), conflictRows: err.conflictRows || undefined });
    res.end();
  }
});

module.exports = router;
