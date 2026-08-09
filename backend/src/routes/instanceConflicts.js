// routes/instanceConflicts.js — Instance conflict detection and resolution endpoints
'use strict';
const express = require('express');
const { detectInstanceConflicts, applyConflictResolutions } = require('../services/instanceConflictResolver');
const { planUnitInstanceExpansion, detectUnitInstanceConflicts } = require('../services/unitInstanceExpander');
const { getDb } = require('../db');

const router = express.Router();

/**
 * POST /api/instance-conflicts/detect
 * Detects conflicts and returns structured data for modal rendering.
 *
 * Body: {
 *   projectId: 5,
 *   instances: [
 *     { name: "U010_XV10", cmType: "CM_AO", ... },
 *     { name: "U020_XV20", cmType: "CM_DI", ... }
 *   ]
 * }
 *
 * Response: {
 *   conflicts: [{name, existingId, incoming: {...}, existing: {...}}, ...],
 *   clean: ["U020_XV20"],
 *   summary: {total, conflicts, clean}
 * }
 */
router.post('/detect', async (req, res) => {
  try {
    const { projectId, instances } = req.body;
    if (!projectId || !Array.isArray(instances)) {
      return res.status(400).json({ error: 'projectId and instances array required' });
    }

    const db = getDb();
    const result = await detectInstanceConflicts(db, projectId, instances);
    res.json(result);
  } catch (err) {
    console.error('Error detecting conflicts:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/instance-conflicts/resolve
 * Applies user resolutions: skip, update, or create_anyway.
 *
 * Body: {
 *   projectId: 5,
 *   instances: [...],  // original incoming instances
 *   resolutions: [
 *     { name: "U010_XV10", action: "update" },
 *     { name: "U020_XV20", action: "skip" },
 *     { name: "U030_XV30", action: "create_anyway" }
 *   ]
 * }
 *
 * Response: {
 *   created: 1,
 *   updated: 1,
 *   skipped: 1,
 *   summary: "1 created, 1 updated, 1 skipped"
 * }
 */
router.post('/resolve', async (req, res) => {
  try {
    const { projectId, instances, resolutions } = req.body;
    if (!projectId || !Array.isArray(instances) || !Array.isArray(resolutions)) {
      return res.status(400).json({ error: 'projectId, instances, and resolutions arrays required' });
    }

    const db = getDb();
    const result = await applyConflictResolutions(db, projectId, resolutions, instances);
    res.json(result);
  } catch (err) {
    console.error('Error resolving conflicts:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/instance-conflicts/unit-instances/detect
 * Detects conflicts for planned unit instance expansion.
 *
 * Applies "silent updates" (Scenario 1: is_imported=true, is_generated=false → set is_generated=true)
 * before returning so only real conflicts are shown in the modal.
 *
 * Body: { projectId: number }
 *
 * Response: {
 *   conflicts: [{name, existingId, incoming: {...}, existing: {...}}, ...],
 *   silentUpdates: [{name, existingId}, ...],
 *   clean: ["U020"],
 *   summary: {total, conflicts, clean, silentUpdates}
 * }
 */
router.post('/unit-instances/detect', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId required' });
    }

    const db = getDb();
    const plannedInstances = await planUnitInstanceExpansion(db, projectId);
    const result = await detectUnitInstanceConflicts(db, projectId, plannedInstances);

    // Detection is read-only. The is_generated=true write for these rows happens
    // in expandUnitInstances, which runs only once the user commits. Writing here
    // would promote rows on a detect that the user then cancels, and a promoted
    // row reads as Scenario 2 forever after — it could never be silently updated
    // again, so every later run would wrongly prompt for it.

    // Store planned instances in response so frontend can use them for resolution
    res.json({
      ...result,
      plannedInstances,
    });
  } catch (err) {
    console.error('Error detecting unit instance conflicts:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/instance-conflicts/unit-instances/expand
 * Applies conflict resolutions and expands unit instances.
 *
 * Body: {
 *   projectId: number,
 *   plannedInstances: [{name, cmType}, ...],
 *   resolutions: [{name, action: 'skip'|'update'|'create_anyway'}, ...]
 * }
 *
 * Response: {
 *   success: true,
 *   instanceCount: number,
 *   folderCount: number,
 *   summary: string
 * }
 */
router.post('/unit-instances/expand', async (req, res) => {
  try {
    const { projectId, plannedInstances, resolutions } = req.body;
    if (!projectId || !Array.isArray(plannedInstances) || !Array.isArray(resolutions)) {
      return res.status(400).json({ error: 'projectId, plannedInstances, and resolutions arrays required' });
    }

    const db = getDb();

    // Required lazily to avoid a require cycle with the unitTypes route module.
    const { expandUnitInstances } = require('./unitTypes');

    // Expansion regenerates every unit-sourced instance itself, so resolutions
    // here decide only what survives around it — we must not pre-insert the
    // incoming rows, or expand would add a second copy of each.
    //
    //   update        → drop the old row, keep one freshly expanded row
    //   skip          → keep the old row, drop what expansion just made
    //   create_anyway → keep everything, duplicates included
    //
    // A name can also repeat purely within the plan (two unit instances sharing
    // a unit_name). There is no "old row" to weigh against then, so update/skip
    // both mean "one row of this name" and we trim the surplus after expanding.
    const byAction = { update: [], create_anyway: [], skip: [] };
    for (const r of resolutions) {
      if (byAction[r.action]) byAction[r.action].push(r.name);
    }

    // Not wrapped in an outer db.transaction(): expandUnitInstances opens its
    // own, and this pool binds one client per transaction — nesting would
    // issue a second BEGIN on the same client.
    for (const name of byAction.update) {
      await db.prepare(
        'DELETE FROM project_instances WHERE project_id = ? AND instance_name = ?'
      ).run(projectId, name);
    }

    const result = await expandUnitInstances(db, projectId);

    // "Skip": the pre-existing row wins, so drop expansion's replacements. If
    // nothing pre-existed, keep a single expanded row rather than none.
    for (const name of byAction.skip) {
      const preExisting = await db.prepare(
        'SELECT COUNT(*) AS n FROM project_instances'
          + ' WHERE project_id = ? AND instance_name = ? AND source_unit_instance_id IS NULL'
      ).get(projectId, name);

      await db.prepare(
        `DELETE FROM project_instances
         WHERE project_id = ? AND instance_name = ? AND source_unit_instance_id IS NOT NULL
           ${Number(preExisting.n) > 0 ? '' : 'AND id > (SELECT MIN(id) FROM project_instances WHERE project_id = ? AND instance_name = ?)'}`
      ).run(...(Number(preExisting.n) > 0
        ? [projectId, name]
        : [projectId, name, projectId, name]));
    }

    // "Update": exactly one row should remain. Expansion emits one per source
    // unit instance, so collapse any surplus from plan-internal duplicates.
    for (const name of byAction.update) {
      await db.prepare(
        `DELETE FROM project_instances
         WHERE project_id = ? AND instance_name = ?
           AND id > (SELECT MIN(id) FROM project_instances WHERE project_id = ? AND instance_name = ?)`
      ).run(projectId, name, projectId, name);
    }

    const stats = {
      created: byAction.create_anyway.length,
      updated: byAction.update.length,
      skipped: byAction.skip.length,
    };

    res.json({
      success: true,
      ...result,
      resolutions: {
        ...stats,
        summary: `${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`,
      },
    });
  } catch (err) {
    console.error('Error expanding unit instances:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
