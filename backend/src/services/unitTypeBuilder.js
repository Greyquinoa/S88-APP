// services/unitTypeBuilder.js — Create Unit Types and link to existing Composite CM Types
'use strict';

/**
 * Create a new Unit Type with members pointing to existing Composite CM Types.
 * Atomically inserts Unit Type + members + connections in a transaction.
 *
 * Input:
 *   - unitName: string
 *   - description: string (optional)
 *   - unitMembers: [{ alias, cmTypeName, compositeCmId, hierarchyFolder, isPrimary, sortOrder }]
 *       A member is either a DIRECT CM (cmTypeName set, compositeCmId null) or a
 *       COMPOSITE reference (compositeCmId set). The PCS7 import uses direct CMs.
 *   - connections: [{ fromAlias, fromSubIdx, fromVarName, toAlias, toSubIdx, toVarName, connType, staticValue }]
 *       Only connections with both fromAlias/toAlias resolvable to a member are inserted;
 *       unresolved references (e.g. raw XML targetId refs) are skipped.
 *   - db: database connection
 *
 * Output:
 *   - { id: unitTypeId, name: unitName, memberCount, connectionCount }
 */
async function createUnitTypeFromAssignment(unitName, description, unitMembers, connections, db) {
  // Validate inputs
  if (!unitName || !unitName.trim()) {
    throw new Error('unitName is required');
  }

  if (!Array.isArray(unitMembers) || unitMembers.length === 0) {
    throw new Error('unitMembers array is required and must not be empty');
  }

  // Each member must be either a direct CM (cmTypeName) or a composite reference.
  for (const member of unitMembers) {
    const compositeId = member.compositeCmId ?? null;
    if (compositeId != null) {
      const comp = await db.prepare('SELECT id FROM composite_cm_types WHERE id = ?').get(compositeId);
      if (!comp) {
        throw new Error(`Composite CM Type with id ${compositeId} not found`);
      }
    } else if (!member.cmTypeName || !String(member.cmTypeName).trim()) {
      throw new Error(`Member "${member.alias}" has neither a cmTypeName nor a compositeCmId`);
    }
  }

  // Use transaction for atomicity
  const txn = db.transaction(async () => {
    // 1. Insert unit type
    const utRow = await db.prepare(
      'INSERT INTO unit_types (name, description) VALUES (?, ?)'
    ).run(unitName.trim(), description?.trim() || '');

    const unitTypeId = utRow.lastInsertRowid;

    // 2. Insert unit type members. cm_type_name is NOT NULL; for composite members
    //    it stays empty and composite_cm_id carries the reference.
    const insertMember = db.prepare(`
      INSERT INTO unit_type_members
        (unit_type_id, alias, cm_type_name, composite_cm_id, hierarchy_folder, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertRole = db.prepare(`
      INSERT INTO unit_type_member_roles
        (member_id, role, assigned_alias, source_member_idx, target_member_idx)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const member of unitMembers) {
      const compositeId = member.compositeCmId ?? null;
      const mRow = await insertMember.run(
        unitTypeId,
        member.alias,
        compositeId != null ? '' : String(member.cmTypeName).trim(),
        compositeId,
        member.hierarchyFolder || 'CM',
        member.sortOrder || 0
      );

      // Role assignments (from PCS7 XML): map an EM sub-member's role to a target
      // unit member + its composite sub-member index.
      for (const r of (member.roleAssignments || [])) {
        const targetAlias = (r.targetAlias || r.assignedAlias || '').trim();
        if (!r.role || !targetAlias) continue;
        await insertRole.run(
          mRow.lastInsertRowid,
          String(r.role).trim(),
          targetAlias,
          r.sourceMemberIdx ?? 0,
          r.targetMemberIdx ?? 0
        );
      }
    }

    // 3. Insert unit type member connections. Skip any connection whose endpoints
    //    don't resolve to a member alias (import may pass raw XML refs we can't map yet).
    let insertedConnections = 0;
    if (Array.isArray(connections) && connections.length > 0) {
      const findMember = db.prepare(
        'SELECT id FROM unit_type_members WHERE unit_type_id = ? AND alias = ?'
      );
      const insertConn = db.prepare(`
        INSERT INTO unit_type_member_connections
          (unit_type_id, from_alias, from_sub_idx, from_var_name, to_alias, to_sub_idx, to_var_name, conn_type, static_value, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const conn of connections) {
        if (!conn) continue;
        // Accept both camelCase (manual editor) and snake_case (PCS7 import matcher).
        const fromAlias  = conn.fromAlias  ?? conn.from_alias;
        const toAlias    = conn.toAlias    ?? conn.to_alias;
        const fromSubIdx = conn.fromSubIdx ?? conn.from_sub_idx ?? 0;
        const toSubIdx   = conn.toSubIdx   ?? conn.to_sub_idx   ?? 0;
        const fromVar    = conn.fromVarName ?? conn.from_var_name ?? '';
        const toVar      = conn.toVarName   ?? conn.to_var_name   ?? '';
        const connType   = conn.connType    ?? conn.conn_type    ?? 'interconnection';
        const staticVal  = conn.staticValue ?? conn.static_value ?? null;
        const sortOrder  = conn.sortOrder   ?? conn.sort_order   ?? 0;

        if (!fromAlias || !toAlias) continue;  // unresolved ref → skip

        const fromMember = await findMember.get(unitTypeId, fromAlias);
        const toMember = await findMember.get(unitTypeId, toAlias);
        if (!fromMember || !toMember) continue;  // endpoint not among members → skip

        await insertConn.run(
          unitTypeId,
          fromAlias,
          fromSubIdx,
          fromVar,
          toAlias,
          toSubIdx,
          toVar,
          connType,
          staticVal,
          sortOrder
        );
        insertedConnections++;
      }
    }

    return { unitTypeId, insertedConnections };
  });

  const { unitTypeId, insertedConnections } = await txn();

  return {
    id: unitTypeId,
    name: unitName,
    memberCount: unitMembers.length,
    connectionCount: insertedConnections,
  };
}

/**
 * Load unit type details to verify structure (used for round-trip testing).
 *
 * Input:
 *   - unitTypeId: number
 *   - db: database connection
 *
 * Output:
 *   - { id, name, description, members: [...], connections: [...] }
 */
async function loadUnitTypeForVerification(unitTypeId, db) {
  const ut = await db.prepare('SELECT * FROM unit_types WHERE id = ?').get(unitTypeId);
  if (!ut) return null;

  const members = await db.prepare(
    'SELECT id, alias, composite_cm_id, hierarchy_folder, sort_order FROM unit_type_members WHERE unit_type_id = ? ORDER BY sort_order'
  ).all(unitTypeId);

  const connections = await db.prepare(
    'SELECT from_alias, from_sub_idx, from_var_name, to_alias, to_sub_idx, to_var_name, conn_type FROM unit_type_member_connections WHERE unit_type_id = ? ORDER BY sort_order'
  ).all(unitTypeId);

  return {
    id: ut.id,
    name: ut.name,
    description: ut.description,
    members: members.map(m => ({
      alias: m.alias,
      compositeId: m.composite_cm_id,
      hierarchyFolder: m.hierarchy_folder,
      sortOrder: m.sort_order,
    })),
    connections: connections.map(c => ({
      fromAlias: c.from_alias,
      fromSubIdx: c.from_sub_idx,
      fromVarName: c.from_var_name,
      toAlias: c.to_alias,
      toSubIdx: c.to_sub_idx,
      toVarName: c.to_var_name,
      connType: c.conn_type,
    })),
  };
}

module.exports = {
  createUnitTypeFromAssignment,
  loadUnitTypeForVerification,
};
