// src/services/diffLibrary.js — Compute three-way diff between new and existing library types
'use strict';

async function computeLibraryDiff(newCmTypes, db, projectId) {
  const summary = { new: 0, updated: 0, unchanged: 0, removed: 0 };
  const items = [];

  // Create map of existing types for fast lookup
  const existingTypes = new Map();
  const existingTypeList = await db.prepare('SELECT id, name FROM lib_cm_types WHERE project_id = ?').all(projectId);
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
      `SELECT id, name, comment, optional, is_conditional FROM lib_blocks WHERE cm_type_id = ? ORDER BY sort_order`
    ).all(cmTypeId);

    const blockChanges = [];
    let hasChanges = false;

    // Compare the enabled-optional-blocks selection (the per-type green toggles).
    // `undefined`/`null` means the file predates this field — treat as "not specified"
    // and skip, so older exports don't all show up as changed.
    if (Array.isArray(newType.enabledBlocks)) {
      const prefRow = await db.prepare(
        `SELECT enabled_blocks FROM user_cm_block_prefs WHERE project_id = ? AND cm_type_name = ?`
      ).get(projectId, newType.name);
      let oldEnabled = [];
      if (prefRow) {
        try { oldEnabled = JSON.parse(prefRow.enabled_blocks || '[]'); } catch { oldEnabled = []; }
      }
      const oldSet = [...oldEnabled].sort();
      const newSet = [...newType.enabledBlocks].sort();
      if (JSON.stringify(oldSet) !== JSON.stringify(newSet)) {
        hasChanges = true;
        const added     = newSet.filter(b => !oldSet.includes(b));
        const removed   = oldSet.filter(b => !newSet.includes(b));
        const unchanged = newSet.filter(b => oldSet.includes(b));
        blockChanges.push({
          type: 'ENABLED_BLOCKS_CHANGED',
          added,
          removed,
          unchanged,     // blocks enabled both before and after import, for a complete picture
          finalEnabled: newSet,
          oldCount: oldSet.length,
          newCount: newSet.length,
        });
      }
    }

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

      // Compare block-level flags (optional / conditional) independent of variable changes
      if (!!oldBlock.optional !== !!newBlock.optional || !!oldBlock.is_conditional !== !!newBlock.isConditional) {
        hasChanges = true;
        blockChanges.push({
          type: 'BLOCK_FLAGS_CHANGED',
          blockName: newBlock.name,
          oldVal: { optional: !!oldBlock.optional, isConditional: !!oldBlock.is_conditional },
          newVal: { optional: !!newBlock.optional, isConditional: !!newBlock.isConditional },
        });
      }

      // Compare variables within the block
      const oldVars = await db.prepare(
        `SELECT id, name, dtype, val, dir, is_valid FROM lib_variables WHERE block_id = ? ORDER BY sort_order`
      ).all(oldBlock.id);

      const varDiffs = [];

      // Check for new or changed variables
      for (const newVar of newBlock.vars) {
        const oldVar = oldVars.find(v => v.name === newVar.name);
        if (!oldVar) {
          varDiffs.push({
            name: newVar.name,
            change: 'ADDED',
            newVal: { dtype: newVar.dtype, val: newVar.val, dir: newVar.dir, isValid: newVar.isValid },
          });
          hasChanges = true;
        } else if (oldVar.dtype !== newVar.dtype || oldVar.val !== newVar.val || !!oldVar.is_valid !== !!newVar.isValid) {
          varDiffs.push({
            name: newVar.name,
            change: 'CHANGED',
            oldVal: { dtype: oldVar.dtype, val: oldVar.val, dir: oldVar.dir, isValid: !!oldVar.is_valid },
            newVal: { dtype: newVar.dtype, val: newVar.val, dir: newVar.dir, isValid: !!newVar.isValid },
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

// ── Composite CM type diff — same NEW/UPDATED/UNCHANGED/REMOVED_FROM_FILE shape ──
// as computeLibraryDiff, but compares members/connections/matrix instead of blocks.
async function computeCompositeDiff(newComposites, db, projectId) {
  const summary = { new: 0, updated: 0, unchanged: 0, removed: 0 };
  const items = [];

  const existing = new Map();
  const existingList = await db.prepare('SELECT id, name FROM composite_cm_types WHERE project_id = ?').all(projectId);
  for (const row of existingList) existing.set(row.name, row.id);

  const { getCompositeDetail } = require('../routes/compositeCmTypes');

  for (const newComp of newComposites) {
    const compId = existing.get(newComp.name);

    if (!compId) {
      items.push({ name: newComp.name, status: 'NEW', newType: newComp, oldType: null, changes: [] });
      summary.new++;
      continue;
    }

    const oldComp = await getCompositeDetail(db, compId);
    const changes = _diffCompositeFields(oldComp, newComp);

    if (changes.length) {
      items.push({ name: newComp.name, status: 'UPDATED', newType: newComp, oldType: { id: compId, name: newComp.name }, changes });
      summary.updated++;
    } else {
      items.push({ name: newComp.name, status: 'UNCHANGED', newType: newComp, oldType: { id: compId, name: newComp.name }, changes: [] });
      summary.unchanged++;
    }
  }

  for (const [name, id] of existing) {
    if (!newComposites.find(c => c.name === name)) {
      items.push({ name, status: 'REMOVED_FROM_FILE', newType: null, oldType: { id, name }, changes: [] });
      summary.removed++;
    }
  }

  return { summary, items };
}

function _diffCompositeFields(oldComp, newComp) {
  const changes = [];

  if ((oldComp.description || '') !== (newComp.description || '')) {
    changes.push({ type: 'FIELD_CHANGED', field: 'description', oldVal: oldComp.description || '', newVal: newComp.description || '' });
  }
  if (!!oldComp.is_matrix !== !!newComp.is_matrix) {
    changes.push({ type: 'FIELD_CHANGED', field: 'is_matrix', oldVal: !!oldComp.is_matrix, newVal: !!newComp.is_matrix });
  }

  // Members: compare by position + cm_type_name (members have no stable name key)
  const oldMembers = oldComp.members || [];
  const newMembers = newComp.members || [];
  if (oldMembers.length !== newMembers.length) {
    changes.push({ type: 'MEMBERS_CHANGED', detail: `${oldMembers.length} → ${newMembers.length} members` });
  } else {
    for (let i = 0; i < newMembers.length; i++) {
      const om = oldMembers[i], nm = newMembers[i];
      if (om.cm_type_name !== nm.cm_type_name || om.hierarchy_folder !== nm.hierarchy_folder ||
          om.name_prefix !== nm.name_prefix || om.name_suffix !== nm.name_suffix ||
          !!om.is_primary !== !!nm.is_primary || (om.scope || 'unit') !== (nm.scope || 'unit') ||
          JSON.stringify(om.roles || {}) !== JSON.stringify(nm.roles || {})) {
        changes.push({ type: 'MEMBER_CHANGED', index: i, oldVal: om, newVal: nm });
      }
    }
  }

  // Connections: track added/removed with full source/destination details.
  // Connections reference members by index, so resolve each side to the member's
  // cm_type_name (from the matching member list) to make the diff human-readable.
  const oldConns = oldComp.connections || [];
  const newConns = newComp.connections || [];

  const describeSide = (members, idx, varName) => {
    if (idx == null || idx < 0) return varName || null;
    const m = members[idx];
    const label = m ? m.cm_type_name : `member #${idx}`;
    return varName ? `${label}.${varName}` : label;
  };

  // 'value' and 'io_connection' have no real "from" member — their source is a static
  // value or a hardware IO block (decoded from static_value JSON by getCompositeDetail
  // into block_name/prefix/suffix). Describe those instead of falling through to null.
  const describeFrom = (c, members) => {
    if (c.conn_type === 'value') {
      return c.value_mode === 'derived'
        ? `derived: ${c.column || ''}${c.prefix ? ` (${c.prefix}…${c.suffix || ''})` : ''}`
        : `static "${c.static_value ?? ''}"`;
    }
    if (c.conn_type === 'io_connection') {
      return `IO block ${c.block_name || '?'}${c.prefix || c.suffix ? ` (${c.prefix || ''}…${c.suffix || ''})` : ''}`;
    }
    return describeSide(members, c.from_member_idx, c.from_var_name) || '(static)';
  };

  const annotateConn = (c, members) => ({
    from_member_idx: c.from_member_idx ?? -1,
    from_var_name: c.from_var_name || '',
    to_member_idx: c.to_member_idx,
    to_var_name: c.to_var_name || '',
    conn_type: c.conn_type || 'interconnection',
    fromLabel: describeFrom(c, members),
    toLabel: describeSide(members, c.to_member_idx, c.to_var_name) || `member #${c.to_member_idx}`,
  });

  // For comparison, normalize to a stable key (order can change). Destination
  // (to_member_idx/to_var_name) always identifies the slot; include whatever
  // distinguishes the source per conn_type so an edited static value or IO
  // block on the same destination shows as a change instead of looking identical.
  const connKey = c => {
    const dest = `${c.to_member_idx}:${c.to_var_name || ''}:${c.conn_type || 'interconnection'}`;
    if (c.conn_type === 'value') {
      return `${dest}<=${c.value_mode === 'derived' ? `derived:${c.column}:${c.prefix}:${c.suffix}` : `static:${c.static_value ?? ''}`}`;
    }
    if (c.conn_type === 'io_connection') {
      return `${dest}<=io:${c.block_name || ''}:${c.prefix || ''}:${c.suffix || ''}`;
    }
    return `${c.from_member_idx ?? -1}:${c.from_var_name || ''}=>${dest}`;
  };

  const oldConnMap = new Map(oldConns.map(c => [connKey(c), c]));
  const newConnMap = new Map(newConns.map(c => [connKey(c), c]));

  const added = [], removed = [];

  for (const [key, conn] of oldConnMap) {
    if (!newConnMap.has(key)) removed.push(annotateConn(conn, oldMembers));
  }
  for (const [key, conn] of newConnMap) {
    if (!oldConnMap.has(key)) added.push(annotateConn(conn, newMembers));
  }

  if (added.length > 0 || removed.length > 0) {
    changes.push({
      type: 'CONNECTIONS_CHANGED',
      added,
      removed,
      oldCount: oldConns.length,
      newCount: newConns.length,
    });
  }

  // Matrix: columns + modes/cells
  const oldCols = oldComp.matrixColumns || [];
  const newCols = newComp.matrixColumns || [];
  if (JSON.stringify(oldCols) !== JSON.stringify(newCols)) {
    changes.push({ type: 'MATRIX_COLUMNS_CHANGED', oldVal: oldCols, newVal: newCols });
  }

  // Matrix modes: match by mode_nr (stable across edits, unlike array position),
  // then diff mode name and individual cell values so the UI can show exactly
  // which cells changed instead of a bare "X → Y modes" count.
  const normModes = modes => (modes || []).map(m => ({ mode_nr: m.mode_nr, mode_name: m.mode_name || '', cells: m.cells || {} }));
  const oldModes = normModes(oldComp.matrixModes);
  const newModes = normModes(newComp.matrixModes);

  const oldModeMap = new Map(oldModes.map(m => [m.mode_nr, m]));
  const newModeMap = new Map(newModes.map(m => [m.mode_nr, m]));
  const allCols = [...new Set([...oldCols, ...newCols])];

  const addedModes = [], removedModes = [], changedModes = [];

  for (const [nr, om] of oldModeMap) {
    if (!newModeMap.has(nr)) removedModes.push(om);
  }
  for (const [nr, nm] of newModeMap) {
    if (!oldModeMap.has(nr)) addedModes.push(nm);
  }
  for (const [nr, nm] of newModeMap) {
    const om = oldModeMap.get(nr);
    if (!om) continue;
    const cellDiffs = [];
    for (const col of allCols) {
      const ov = om.cells[col];
      const nv = nm.cells[col];
      if (String(ov ?? '') !== String(nv ?? '')) cellDiffs.push({ column: col, oldVal: ov ?? null, newVal: nv ?? null });
    }
    const nameChanged = om.mode_name !== nm.mode_name;
    if (nameChanged || cellDiffs.length > 0) {
      changedModes.push({ modeNr: nr, oldName: om.mode_name, newName: nm.mode_name, nameChanged, cellDiffs });
    }
  }

  if (addedModes.length > 0 || removedModes.length > 0 || changedModes.length > 0) {
    changes.push({
      type: 'MATRIX_MODES_CHANGED',
      columns: allCols,
      added: addedModes,
      removed: removedModes,
      changed: changedModes,
      oldCount: oldModes.length,
      newCount: newModes.length,
    });
  }

  return changes;
}

module.exports = { computeLibraryDiff, computeCompositeDiff };
