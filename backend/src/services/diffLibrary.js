// src/services/diffLibrary.js — Compute three-way diff between new and existing library types
'use strict';

async function computeLibraryDiff(newCmTypes, db) {
  const summary = { new: 0, updated: 0, unchanged: 0, removed: 0 };
  const items = [];

  // Create map of existing types for fast lookup
  const existingTypes = new Map();
  const existingTypeList = await db.prepare('SELECT id, name FROM lib_cm_types').all();
  for (const row of existingTypeList) {
    existingTypes.set(row.name, row.id);
  }

  // Process each new type
  for (const newType of newCmTypes) {
    const cmTypeId = existingTypes.get(newType.name);

    if (!cmTypeId) {
      // NEW type
      items.push({
        name: newType.name,
        status: 'NEW',
        newType,
        oldType: null,
        blockChanges: [],
      });
      summary.new++;
      continue;
    }

    // Type exists — check if it changed
    const oldBlocks = await db.prepare(
      `SELECT id, name, comment, optional FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`
    ).all(cmTypeId);

    const blockChanges = [];
    let hasChanges = false;

    // Check for new or changed blocks
    for (const newBlock of newType.subBlocks) {
      const oldBlock = oldBlocks.find(b => b.name === newBlock.name);

      if (!oldBlock) {
        hasChanges = true;
        blockChanges.push({
          type: 'BLOCK_ADDED',
          blockName: newBlock.name,
          varCount: newBlock.vars.length,
        });
        continue;
      }

      // Compare variables within the block
      const oldVars = await db.prepare(
        `SELECT id, name, dtype, val, dir FROM lib_variables WHERE block_id = ? ORDER BY sort_order`
      ).all(oldBlock.id);

      const varDiffs = [];

      // Check for new or changed variables
      for (const newVar of newBlock.vars) {
        const oldVar = oldVars.find(v => v.name === newVar.name);
        if (!oldVar) {
          varDiffs.push({
            name: newVar.name,
            change: 'ADDED',
            newVal: { dtype: newVar.dtype, val: newVar.val, dir: newVar.dir },
          });
          hasChanges = true;
        } else if (oldVar.dtype !== newVar.dtype || oldVar.val !== newVar.val) {
          varDiffs.push({
            name: newVar.name,
            change: 'CHANGED',
            oldVal: { dtype: oldVar.dtype, val: oldVar.val, dir: oldVar.dir },
            newVal: { dtype: newVar.dtype, val: newVar.val, dir: newVar.dir },
          });
          hasChanges = true;
        }
      }

      // Check for removed variables
      for (const oldVar of oldVars) {
        if (!newBlock.vars.find(v => v.name === oldVar.name)) {
          varDiffs.push({
            name: oldVar.name,
            change: 'REMOVED',
            oldVal: { dtype: oldVar.dtype, val: oldVar.val, dir: oldVar.dir },
          });
          hasChanges = true;
        }
      }

      if (varDiffs.length > 0) {
        blockChanges.push({
          type: 'VARS_CHANGED',
          blockName: newBlock.name,
          details: varDiffs,
        });
      }
    }

    // Check for removed blocks
    for (const oldBlock of oldBlocks) {
      if (!newType.subBlocks.find(b => b.name === oldBlock.name)) {
        hasChanges = true;
        blockChanges.push({
          type: 'BLOCK_REMOVED',
          blockName: oldBlock.name,
        });
      }
    }

    if (hasChanges) {
      items.push({
        name: newType.name,
        status: 'UPDATED',
        newType,
        oldType: { id: cmTypeId, name: newType.name },
        blockChanges,
      });
      summary.updated++;
    } else {
      items.push({
        name: newType.name,
        status: 'UNCHANGED',
        newType,
        oldType: { id: cmTypeId, name: newType.name },
        blockChanges: [],
      });
      summary.unchanged++;
    }
  }

  // Check for types in DB but not in new file (REMOVED_FROM_FILE)
  for (const [typeName, cmTypeId] of existingTypes) {
    if (!newCmTypes.find(t => t.name === typeName)) {
      items.push({
        name: typeName,
        status: 'REMOVED_FROM_FILE',
        newType: null,
        oldType: { id: cmTypeId, name: typeName },
        blockChanges: [],
      });
      summary.removed++;
    }
  }

  return { summary, items };
}

module.exports = { computeLibraryDiff };
