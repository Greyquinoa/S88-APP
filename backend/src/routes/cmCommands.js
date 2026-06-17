// routes/cmCommands.js — User-editable valve/mode command lookup table
'use strict';
const express  = require('express');
const { getDb } = require('../db');
const router   = express.Router();

// GET /api/cm-commands — returns all commands sorted by sort_order
router.get('/', (_req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare('SELECT id, name, value, sort_order FROM lib_cm_commands ORDER BY sort_order, id').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/cm-commands — replace all commands
// Body: [ { name, value }, ... ]  (sort_order derived from array position)
router.put('/', (req, res) => {
  try {
    const db      = getDb();
    const entries = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'body must be an array' });
    for (const e of entries) {
      if (!e.name?.trim()) return res.status(400).json({ error: 'each entry must have a non-empty name' });
      if (typeof e.value !== 'number' || !Number.isInteger(e.value))
        return res.status(400).json({ error: `value for "${e.name}" must be an integer` });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM lib_cm_commands').run();
      const ins = db.prepare('INSERT INTO lib_cm_commands (name, value, sort_order) VALUES (?, ?, ?)');
      entries.forEach((e, i) => ins.run(e.name.trim().toUpperCase(), e.value, i));
    })();

    res.json({ success: true, count: entries.length });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Duplicate command name' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
