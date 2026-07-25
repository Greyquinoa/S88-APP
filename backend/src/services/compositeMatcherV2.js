// services/compositeMatcherV2.js — Match CM instances to Composite CM Types
'use strict';

/**
 * Load a composite's members in sort order. Returns [{ cmTypeName, namePrefix, idx }]
 * where idx is the sub-member index used by unit_type_member_roles.target_member_idx.
 * Cached per (db, compositeId) within a single matching call via the passed cache map.
 */
async function loadCompositeMembers(compositeId, db, cache) {
  if (cache && cache.has(compositeId)) return cache.get(compositeId);
  const rows = await db.prepare(`
    SELECT cm_type_name, name_prefix
    FROM composite_cm_members
    WHERE composite_id = ?
    ORDER BY sort_order, id
  `).all(compositeId);
  const members = rows.map((r, idx) => ({
    cmTypeName: r.cm_type_name,
    namePrefix: r.name_prefix || '',
    idx,
  }));
  if (cache) cache.set(compositeId, members);
  return members;
}

/**
 * Split an alias into [prefix, suffix] at each underscore boundary, longest-suffix first.
 * "NIF_XV10" → [["NIF_","XV10"], ["NIF_XV10", ""]]  (we only care about the meaningful splits)
 * The suffix is the trailing segment(s); the prefix keeps its trailing underscore.
 */
function suffixCandidates(alias) {
  const parts = alias.split('_');
  const out = [];
  // i = number of leading segments treated as prefix (0..parts.length-1)
  for (let i = 0; i < parts.length; i++) {
    const prefix = i === 0 ? '' : parts.slice(0, i).join('_') + '_';
    const suffix = parts.slice(i).join('_');
    out.push({ prefix, suffix });
  }
  return out; // ordered from bare alias (prefix='') to longest prefix / shortest suffix
}

/**
 * Group instances that share a suffix. For each instance we find the LONGEST suffix
 * (i.e. the most specific tag like "XV10") that is also the FULL alias of some other
 * instance in the set. That bare-alias instance is the group's "primary".
 *
 * Example set: NIF_XV10, XV10, NIF_XV11, XV11
 *   XV10 is a bare alias → primary of group "XV10"; NIF_XV10 shares suffix XV10 (prefix "NIF_")
 *   XV11 is a bare alias → primary of group "XV11"; NIF_XV11 shares suffix XV11 (prefix "NIF_")
 *
 * Returns Map<suffix, { primaryIdx, members: [{ idx, prefix }] }>
 * and a Set of instance indices that belong to some group.
 */
function groupBySharedSuffix(cmInstances) {
  const aliasOf = (cm) => cm.alias || cm.name;
  // Set of aliases that appear verbatim (candidate "primaries" / suffixes).
  const bareAliases = new Set(cmInstances.map(aliasOf));

  const groups = new Map();   // suffix -> { primaryIdx, members: [{idx, prefix}] }
  const grouped = new Set();  // indices that landed in a group

  cmInstances.forEach((cm, idx) => {
    const alias = aliasOf(cm);
    // Longest suffix (most specific) that is itself a bare alias of another instance.
    // suffixCandidates is prefix-ascending → suffix-descending, so first hit is longest.
    for (const { prefix, suffix } of suffixCandidates(alias)) {
      if (suffix === alias) continue;              // the whole alias is not a "shared suffix" for itself here
      if (!bareAliases.has(suffix)) continue;      // suffix must be some instance's full alias
      if (!groups.has(suffix)) {
        groups.set(suffix, { primaryIdx: null, members: [] });
      }
      groups.get(suffix).members.push({ idx, prefix });
      grouped.add(idx);
      break; // take the longest/most-specific suffix only
    }
  });

  // Attach the primary (the instance whose alias === suffix) to each group.
  cmInstances.forEach((cm, idx) => {
    const alias = aliasOf(cm);
    if (groups.has(alias)) {
      groups.get(alias).primaryIdx = idx;
      groups.get(alias).members.push({ idx, prefix: '' }); // primary itself, no prefix
      grouped.add(idx);
    }
  });

  return { groups, grouped };
}

/**
 * Given a suffix group, find the single Composite CM Type that best matches:
 *   1. Candidate composites = composites containing the PRIMARY instance's CM type.
 *   2. Disambiguate: the composite must also contain a member whose name_prefix
 *      matches one of the non-primary members' prefixes (e.g. "NIF_").
 *   3. If exactly one composite survives, that's the match. Otherwise no match
 *      (leave blank rather than guess).
 *
 * Returns { compositeId, compositeInfo } or { compositeId: null, ... }.
 */
async function resolveCompositeForGroup(group, cmInstances, db) {
  const primary = group.primaryIdx != null ? cmInstances[group.primaryIdx] : null;
  const primaryType = primary ? primary.type : (cmInstances[group.members[0].idx]?.type);
  if (!primaryType) return { compositeId: null, compositeInfo: null };

  // 1. Composites that contain the primary CM type.
  const candidates = await db.prepare(`
    SELECT DISTINCT cct.id, cct.name, cct.description
    FROM composite_cm_members ccm
    JOIN composite_cm_types cct ON ccm.composite_id = cct.id
    WHERE ccm.cm_type_name = ?
    ORDER BY cct.name
  `).all(primaryType);

  if (candidates.length === 0) return { compositeId: null, compositeInfo: null };
  if (candidates.length === 1) {
    return {
      compositeId: candidates[0].id,
      compositeInfo: { id: candidates[0].id, name: candidates[0].name, description: candidates[0].description },
    };
  }

  // 2. More than one candidate → disambiguate by the other members' prefixes.
  const otherPrefixes = group.members
    .filter(m => m.prefix && m.prefix.length > 0)
    .map(m => m.prefix);

  const matched = [];
  for (const comp of candidates) {
    for (const prefix of otherPrefixes) {
      const hit = await db.prepare(`
        SELECT 1 FROM composite_cm_members
        WHERE composite_id = ? AND name_prefix = ?
        LIMIT 1
      `).get(comp.id, prefix);
      if (hit) { matched.push(comp); break; }
    }
  }

  // 3. Exactly one composite has the disambiguating prefix → confident match.
  if (matched.length === 1) {
    return {
      compositeId: matched[0].id,
      compositeInfo: { id: matched[0].id, name: matched[0].name, description: matched[0].description },
    };
  }

  // Ambiguous (0 or >1) → don't guess.
  return { compositeId: null, compositeInfo: null, ambiguous: candidates.length };
}

/**
 * Resolve a composite for a SINGLE instance (no suffix partner).
 *   1. Candidate composites = composites containing this instance's CM type.
 *   2. If exactly one, use it.
 *   3. If several, disambiguate by matching the composite NAME to the instance alias
 *      (e.g. instance "EM_DNS" → composite "EM_DNS", not "EM_UPS").
 *      Try exact match, then case-insensitive, then alias-contains-name / name-contains-alias.
 *
 * Returns { compositeId, compositeInfo } or { compositeId: null }.
 */
async function resolveCompositeForSingle(cm, db) {
  const alias = cm.alias || cm.name;
  const cmType = cm.type;
  if (!cmType) return { compositeId: null, compositeInfo: null };

  const candidates = await db.prepare(`
    SELECT DISTINCT cct.id, cct.name, cct.description
    FROM composite_cm_members ccm
    JOIN composite_cm_types cct ON ccm.composite_id = cct.id
    WHERE ccm.cm_type_name = ?
    ORDER BY cct.name
  `).all(cmType);

  if (candidates.length === 0) return { compositeId: null, compositeInfo: null };

  const pick = (c) => ({
    compositeId: c.id,
    compositeInfo: { id: c.id, name: c.name, description: c.description },
  });

  if (candidates.length === 1) return pick(candidates[0]);

  // Disambiguate by composite name vs instance alias.
  const aliasLc = alias.toLowerCase();

  // exact (case-sensitive), then case-insensitive
  let hit = candidates.find(c => c.name === alias)
        || candidates.find(c => c.name.toLowerCase() === aliasLc);
  if (hit) return pick(hit);

  // alias contains composite name or vice versa (e.g. "IEMT_MTX_DNS" vs "IEMT_MTX_DNS")
  const contains = candidates.filter(c => {
    const nLc = c.name.toLowerCase();
    return aliasLc.includes(nLc) || nLc.includes(aliasLc);
  });
  if (contains.length === 1) return pick(contains[0]);

  // Still ambiguous → don't guess.
  return { compositeId: null, compositeInfo: null, ambiguous: candidates.length };
}

/**
 * Match CM instances to Composite CM Types using the suffix/prefix strategy.
 *
 * Output preserves the INPUT ORDER of cmInstances so the UI table stays aligned:
 *   assignments[i] corresponds to cmInstances[i].
 *
 * Input:
 *   - cmInstances: [{ name, alias, type, kind, stripped }]
 *   - db: database connection
 * Output:
 *   - { assignments: [{ alias, cmTypeName, compositeCmId, compositeInfo, suffix, prefix, hierarchyFolder, roleAssignments }], metadata, interconnections }
 */
async function matchInstancesToComposites(cmInstances, db, roleAssignments = [], interconnections = []) {
  const metadata = {
    totalInstances: cmInstances ? cmInstances.length : 0,
    matchedToComposite: 0,
    matchedDirect: 0,
    groups: [],
    errors: [],
    interconnectionsProcessed: 0,
    interconnectionsImported: 0,
    interconnectionsSkipped: 0,
  };

  if (!cmInstances || cmInstances.length === 0) {
    return { assignments: [], metadata, interconnections: [] };
  }

  const compMemberCache = new Map();  // compositeId → ordered member list

  // Group role assignments by owner instance NAME (from XML extraction).
  // Each: { ownerInstance, ownerAlias, role, targetInstance, targetAlias }
  const rolesByOwnerName = new Map();
  for (const ra of (roleAssignments || [])) {
    if (!ra.ownerInstance) continue;
    if (!rolesByOwnerName.has(ra.ownerInstance)) rolesByOwnerName.set(ra.ownerInstance, []);
    rolesByOwnerName.get(ra.ownerInstance).push(ra);
  }

  const { groups } = groupBySharedSuffix(cmInstances);

  // Resolve a composite per group, then map each instance index → its group resolution.
  const perIndex = new Array(cmInstances.length).fill(null);
  for (const [suffix, group] of groups) {
    const resolved = await resolveCompositeForGroup(group, cmInstances, db);
    metadata.groups.push({
      suffix,
      memberCount: group.members.length,
      compositeId: resolved.compositeId,
      compositeName: resolved.compositeInfo?.name || null,
    });
    for (const m of group.members) {
      // A member could theoretically appear in multiple groups; keep the first
      // (longest-suffix) resolution, which is the most specific.
      if (perIndex[m.idx] == null) {
        perIndex[m.idx] = { ...resolved, suffix, prefix: m.prefix };
      }
    }
  }

  // Build assignments in ORIGINAL order, COLLAPSING each suffix group that
  // resolved to a composite into ONE member (keyed by suffix). Instances in a
  // group that did NOT resolve to a composite fall through to direct members.
  const assignments = [];
  const emittedGroup = new Set();  // suffixes already emitted as one composite member

  for (let idx = 0; idx < cmInstances.length; idx++) {
    const cm = cmInstances[idx];
    const alias = cm.alias || cm.name;
    const hierarchyFolder = cm.kind === 'EM' ? 'EM' : (cm.kind === 'EPH' ? 'EPH' : 'CM');
    const r = perIndex[idx];

    if (r && r.compositeId) {
      // Part of a resolved composite group → emit once per group (by suffix).
      if (emittedGroup.has(r.suffix)) continue;  // already collapsed this group
      emittedGroup.add(r.suffix);
      metadata.matchedToComposite++;
      const groupInstances = cmInstances
        .filter((_, i) => perIndex[i] && perIndex[i].suffix === r.suffix && perIndex[i].compositeId);
      assignments.push({
        alias: r.suffix,             // the shared suffix (e.g. "XV10") is the member alias
        cmTypeName: '',              // composite carries the CM types; direct name unused
        compositeCmId: r.compositeId,
        compositeInfo: r.compositeInfo,
        suffix: r.suffix,
        prefix: r.prefix,
        hierarchyFolder,
        _ownerInstances: groupInstances.map(c => ({ name: c.name, type: c.type })),
        collapsedFrom: groupInstances.map(c => c.alias || c.name),
      });
      continue;
    }

    // Not part of a resolved suffix group → try singleton composite resolution
    // (match by CM type, disambiguate by composite name vs instance alias).
    const single = await resolveCompositeForSingle(cm, db);
    if (single.compositeId) {
      metadata.matchedToComposite++;
      assignments.push({
        alias,
        cmTypeName: '',
        compositeCmId: single.compositeId,
        compositeInfo: single.compositeInfo,
        suffix: null,
        prefix: null,
        hierarchyFolder,
        _ownerInstances: [{ name: cm.name, type: cm.type }],
        collapsedFrom: [alias],
      });
      continue;
    }

    // No composite match at all → direct member.
    metadata.matchedDirect++;
    assignments.push({
      alias,
      cmTypeName: cm.type,
      compositeCmId: null,
      compositeInfo: null,
      suffix: r?.suffix || null,
      prefix: r?.prefix || null,
      hierarchyFolder,
      _ownerInstances: [{ name: cm.name, type: cm.type }],
    });
  }

  // ── Attach role assignments with composite sub-member indices ────────────────
  // Build a map: original XML instance NAME → { memberAlias, subIdx } where subIdx
  // is the position of that instance's CM type within its collapsed composite.
  const instanceToTarget = new Map();
  for (const a of assignments) {
    const compMembers = a.compositeCmId
      ? await loadCompositeMembers(a.compositeCmId, db, compMemberCache)
      : [];
    for (const inst of (a._ownerInstances || [])) {
      let subIdx = 0;
      let subCmType = inst.type;
      if (compMembers.length) {
        // Match this instance's CM type to a sub-member of the composite.
        const found = compMembers.find(m => m.cmTypeName === inst.type);
        if (found) { subIdx = found.idx; subCmType = found.cmTypeName; }
      }
      instanceToTarget.set(inst.name, {
        memberAlias: a.alias,
        subIdx,
        subCmType,
        compositeCmId: a.compositeCmId || null,
        compositeName: a.compositeInfo?.name || null,
      });
    }
  }

  // For each assignment that OWNS roles (its instances appear as role owners),
  // attach resolved roles. sourceMemberIdx = the owning EM sub-member's index
  // (the EM instance's CM type position within its own composite).
  for (const a of assignments) {
    const compMembers = a.compositeCmId
      ? await loadCompositeMembers(a.compositeCmId, db, compMemberCache)
      : [];
    const roles = [];
    for (const inst of (a._ownerInstances || [])) {
      const ownerRoles = rolesByOwnerName.get(inst.name) || [];
      if (!ownerRoles.length) continue;

      // sourceMemberIdx: where the owning instance's CM type sits in its composite.
      let sourceMemberIdx = 0;
      const srcFound = compMembers.find(m => m.cmTypeName === inst.type);
      if (srcFound) sourceMemberIdx = srcFound.idx;

      for (const ra of ownerRoles) {
        // Resolve the role's target instance → final member alias + sub-member idx.
        const tgt = ra.targetInstance ? instanceToTarget.get(ra.targetInstance) : null;
        if (!tgt) continue;  // target not among imported members → leave unassigned
        roles.push({
          role: ra.role,
          targetAlias: tgt.memberAlias,
          targetMemberIdx: tgt.subIdx,
          sourceMemberIdx,
          assignedAlias: tgt.memberAlias,  // back-compat
        });
      }
    }
    if (roles.length) {
      a.roleAssignments = roles;
      metadata.rolesAttached = (metadata.rolesAttached || 0) + roles.length;
    }
  }

  // ── Resolve & classify interconnections ──────────────────────────────────
  // Each XML interconnection resolves both endpoints to their final composite
  // member + sub-member index (via instanceToTarget, keyed by raw instance name).
  //
  //  • INTRA-composite (both endpoints in the SAME collapsed member): this is a
  //    connection WITHIN a composite (e.g. NIF_C → CM_VALVE inside CCM_VALVE).
  //    We do NOT import it — we CHECK whether the composite already declares it,
  //    and report the result for the preview.
  //  • CROSS-composite (endpoints in DIFFERENT members): a unit-level wire — import.

  const compConnCache = new Map();  // compositeId → [{from_member_idx, from_var_name, to_member_idx, to_var_name}]
  const loadCompConns = async (compositeId) => {
    if (compConnCache.has(compositeId)) return compConnCache.get(compositeId);
    const rows = await db.prepare(`
      SELECT from_member_idx, from_var_name, to_member_idx, to_var_name
      FROM composite_cm_connections
      WHERE composite_id = ?
    `).all(compositeId);
    compConnCache.set(compositeId, rows);
    return rows;
  };

  const filteredInterconnections = [];  // cross-composite → imported to unit level
  const intraCompositeChecks = [];      // intra-composite → checked, reported (NOT imported)
  const seenIntraSignatures = new Set(); // dedup: same connection repeated across XV10/XV11/... shows once

  for (const ic of (interconnections || [])) {
    metadata.interconnectionsProcessed++;
    const from = instanceToTarget.get(ic.fromInstance);
    const to = instanceToTarget.get(ic.toInstance);
    if (!from || !to) {
      metadata.interconnectionsSkipped++;
      continue;  // endpoint not among imported instances
    }

    if (from.memberAlias === to.memberAlias) {
      // Both endpoints in the same collapsed member. Only report connections that
      // cross BETWEEN two different sub-members (e.g. NIF_C ↔ CM_VALVE). A
      // connection where both ends resolve to the SAME sub-member is that CM's own
      // internal block wiring (e.g. CM_VALVE.AIF → CM_VALVE.IF_BACK) — not a
      // composite-level interconnect, so it's excluded from the summary entirely.
      if (from.subIdx === to.subIdx) {
        metadata.interconnectionsSkipped++;
        metadata.intraSameSubMember = (metadata.intraSameSubMember || 0) + 1;
        continue;
      }

      // Cross-sub-type within the composite: check existence (no import).
      const compositeId = from.compositeCmId;
      metadata.interconnectionsSkipped++;

      // Dedup by connection TYPE signature (composite + sub-indices + var names).
      // The same connection recurs once per collapsed member (XV10, XV11, XV12);
      // it only needs to be reported once since it's a composite-type property.
      const sig = `${compositeId}|${from.subIdx}|${ic.fromVarName}|${to.subIdx}|${ic.toVarName}`;
      if (seenIntraSignatures.has(sig)) continue;
      seenIntraSignatures.add(sig);

      let existsInComposite = false;
      if (compositeId) {
        const conns = await loadCompConns(compositeId);
        existsInComposite = conns.some(c =>
          c.from_member_idx === from.subIdx &&
          c.to_member_idx === to.subIdx &&
          c.from_var_name === ic.fromVarName &&
          c.to_var_name === ic.toVarName
        );
      }
      intraCompositeChecks.push({
        compositeName: from.compositeName,
        compositeCmId: compositeId,
        fromSubCmType: from.subCmType,
        fromVarName: ic.fromVarName,
        toSubCmType: to.subCmType,
        toVarName: ic.toVarName,
        existsInComposite,
      });
      if (existsInComposite) metadata.intraExisting = (metadata.intraExisting || 0) + 1;
      else metadata.intraMissing = (metadata.intraMissing || 0) + 1;
      continue;
    }

    // Cross-composite: unit-level wire → import.
    filteredInterconnections.push({
      from_alias: from.memberAlias,
      from_var_name: ic.fromVarName,
      to_alias: to.memberAlias,
      to_var_name: ic.toVarName,
      conn_type: 'interconnection',
      sort_order: filteredInterconnections.length,
    });
    metadata.interconnectionsImported++;
  }

  metadata.intraCompositeCount = intraCompositeChecks.length;

  // Strip internal bookkeeping before returning.
  for (const a of assignments) delete a._ownerInstances;

  return { assignments, metadata, interconnections: filteredInterconnections, intraCompositeChecks };
}

module.exports = {
  suffixCandidates,
  groupBySharedSuffix,
  resolveCompositeForGroup,
  matchInstancesToComposites,
};
