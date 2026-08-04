// services/autoRoleAssignment.js — Auto-assign roles to composite instances after connection generation
// Triggered after reconcileConnections() succeeds in the generate endpoint.
//
// Scope: composite CM type role assignments ONLY. Unit-type role logic is untouched.
'use strict';

/**
 * Auto-assign roles for EM/EPH composite instances after connection generation.
 *
 * Role definitions live on composite_cm_members.roles as:
 *   { "<RoleName>": { alias: "<RoleAlias>", member: "<compositeId>::<cmTypeName>" } }
 *
 * The referenced member ("member") identifies a member of ANOTHER composite; that
 * member's name_prefix supplies the <Member> token of the target instance name.
 *
 * Target name pattern:  <MemberPrefix><UnitName>_<RoleAlias>
 *
 * Example:
 *   EM_DNS member EMT_MTX_C05S05 has role CCM01 = { alias: "XV10", member: "3::NIF_C" }
 *   Composite 3 ("CCM_VALVE") member NIF_C has name_prefix "NIF_"
 *   Instance "U010_EM_DNS" sits under Unit folder "U010"
 *   → looks for "NIF_U010_XV10"; if present, role_assignments.CCM01 = "NIF_U010_XV10"
 *
 * A role whose target instance does not exist is skipped silently — never an error.
 */
async function autoAssignRoles(db, projectId) {
  try {
    const instances = await db.prepare(`
      SELECT id, instance_name, cm_type, composite_id, member_idx, folder_id
      FROM project_instances
      WHERE project_id = ? AND composite_id IS NOT NULL AND source = 'eph_em_import'
      ORDER BY composite_id, member_idx
    `).all(projectId);

    console.log(`[autoRoleAssignment] projectId=${projectId}, found ${instances.length} composite instances`);
    if (instances.length === 0) return { processed: 0, assigned: 0 };

    // Name → true for every instance in the project (targets may be any source).
    const allInstances = await db.prepare(
      'SELECT instance_name FROM project_instances WHERE project_id = ?'
    ).all(projectId);
    const existingNames = new Set(allInstances.map(r => r.instance_name));

    // Folder tree, for resolving each instance's owning Unit.
    const folders = await db.prepare(
      'SELECT id, parent_id, name, s88_type FROM project_hierarchy_folders WHERE project_id = ?'
    ).all(projectId);
    const folderById = new Map(folders.map(f => [f.id, f]));

    function unitNameFor(folderId) {
      let f = folderId != null ? folderById.get(folderId) : null;
      const guard = new Set();
      while (f && !guard.has(f.id)) {
        guard.add(f.id);
        if (f.s88_type === 'Unit') return f.name;
        f = f.parent_id != null ? folderById.get(f.parent_id) : null;
      }
      return null;
    }

    // Cache: composite_id → members (ordered, so index === member_idx).
    const membersCache = new Map();
    async function membersOf(compositeId) {
      if (!membersCache.has(compositeId)) {
        membersCache.set(compositeId, await db.prepare(`
          SELECT cm_type_name, name_prefix, name_suffix, roles
          FROM composite_cm_members
          WHERE composite_id = ?
          ORDER BY sort_order, id
        `).all(compositeId));
      }
      return membersCache.get(compositeId);
    }

    // Resolve "<compositeId>::<cmTypeName>" → that member's name_prefix.
    async function prefixForRef(ref) {
      if (typeof ref !== 'string' || !ref.includes('::')) return null;
      const sep = ref.indexOf('::');
      const refCompositeId = Number(ref.slice(0, sep));
      const refCmType = ref.slice(sep + 2);
      if (!Number.isFinite(refCompositeId)) return null;
      const refMembers = await membersOf(refCompositeId);
      const hit = refMembers.find(m => m.cm_type_name === refCmType);
      return hit ? (hit.name_prefix || '') : null;
    }

    let totalAssigned = 0;

    for (const inst of instances) {
      const members = await membersOf(inst.composite_id);
      const member = members[inst.member_idx];
      if (!member) {
        console.log(`[autoRoleAssignment] ${inst.instance_name}: no member at idx ${inst.member_idx}`);
        continue;
      }
      if (!member.roles) {
        console.log(`[autoRoleAssignment] ${inst.instance_name}: member has no roles field`);
        continue;
      }

      let rolesMap;
      try {
        rolesMap = typeof member.roles === 'string' ? JSON.parse(member.roles) : member.roles;
      } catch (e) {
        console.log(`[autoRoleAssignment] ${inst.instance_name}: malformed roles JSON`, e.message);
        continue; // malformed roles JSON — skip this member
      }
      if (!rolesMap || Object.keys(rolesMap).length === 0) {
        console.log(`[autoRoleAssignment] ${inst.instance_name}: roles empty`);
        continue;
      }

      console.log(`[autoRoleAssignment] ${inst.instance_name}: processing roles:`, Object.keys(rolesMap));

      // Walk up the hierarchy to find the Unit folder name
      let unitName = unitNameFor(inst.folder_id);
      if (!unitName) {
        // Fallback: extract from instance name by removing member prefix/suffix
        const own = member.name_prefix || '';
        const suf = member.name_suffix || '';
        let base = inst.instance_name;
        if (own && base.startsWith(own)) base = base.slice(own.length);
        if (suf && base.endsWith(suf)) base = base.slice(0, -suf.length);
        // base is now "<unitName>_<typeCol>" — drop everything after the first underscore
        const cut = base.indexOf('_');
        unitName = cut > 0 ? base.slice(0, cut) : base;
      }
      if (!unitName) continue;

      console.log(`[autoRoleAssignment] ${inst.instance_name}: unitName="${unitName}"`);

      const roleAssignments = {};
      for (const [roleName, def] of Object.entries(rolesMap)) {
        if (!def || typeof def !== 'object') {
          console.log(`[autoRoleAssignment] ${inst.instance_name}/${roleName}: invalid def`, def);
          continue;
        }
        const alias = (def.alias || '').trim();
        if (!alias) {
          console.log(`[autoRoleAssignment] ${inst.instance_name}/${roleName}: no alias`);
          continue;
        }

        const memberPrefix = await prefixForRef(def.member);
        if (memberPrefix == null) {
          console.log(`[autoRoleAssignment] ${inst.instance_name}/${roleName}: unresolvable member ref ${def.member}`);
          continue;
        }

        const target = `${memberPrefix}${unitName}_${alias}`;
        console.log(`[autoRoleAssignment] ${inst.instance_name}/${roleName}: target=${target}`);
        if (existingNames.has(target)) {
          console.log(`[autoRoleAssignment] ${inst.instance_name}/${roleName}: ✓ FOUND`);
          roleAssignments[roleName] = target;
        } else {
          console.log(`[autoRoleAssignment] ${inst.instance_name}/${roleName}: ✗ NOT FOUND`);
        }
      }

      if (Object.keys(roleAssignments).length === 0) continue;

      console.log(`[autoRoleAssignment] assigning roles to ${inst.instance_name}:`, roleAssignments);

      // Merge over any existing assignments rather than clobbering them.
      const current = await db.prepare(
        'SELECT role_assignments FROM project_instances WHERE id = ?'
      ).get(inst.id);
      let existing = {};
      if (current?.role_assignments) {
        try {
          existing = typeof current.role_assignments === 'string'
            ? JSON.parse(current.role_assignments)
            : current.role_assignments;
        } catch (e) { existing = {}; }
      }

      await db.prepare('UPDATE project_instances SET role_assignments = ? WHERE id = ?')
        .run(JSON.stringify({ ...existing, ...roleAssignments }), inst.id);
      totalAssigned++;
    }

    console.log(`[autoRoleAssignment] complete: assigned ${totalAssigned} out of ${instances.length} processed`);
    return { processed: instances.length, assigned: totalAssigned };
  } catch (e) {
    console.error('[autoRoleAssignment]', e.message);
    // Never block generation on a role-assignment failure.
    return { processed: 0, assigned: 0, error: e.message };
  }
}

module.exports = { autoAssignRoles };
