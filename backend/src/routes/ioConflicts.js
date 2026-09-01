'use strict';
const express = require('express');
const { detectIOConflicts, applyIOPromotion } = require('../services/ioConflictDetector');
const { getDb } = require('../db');

const router = express.Router();

router.post('/detect', async (req, res) => {
  const { importId, projectId } = req.body;
  if (!importId || !projectId) {
    return res.status(400).json({ error: 'importId and projectId are required' });
  }
  try {
    const db = getDb();
    const result = await detectIOConflicts(db, Number(importId), Number(projectId));
    res.json(result);
  } catch (e) {
    console.error('[ioConflicts/detect]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/apply', async (req, res) => {
  const { importId, projectId } = req.body;
  if (!importId || !projectId) {
    return res.status(400).json({ error: 'importId and projectId are required' });
  }
  try {
    const db = getDb();
    const result = await applyIOPromotion(db, Number(importId), Number(projectId));
    res.json(result);
  } catch (e) {
    console.error('[ioConflicts/apply]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
