// services/hierarchyBuilder.js — Build ISA-88 hierarchy from io_tags
'use strict';

const S88_TYPE = {
  ProcessCell:     'ProcessCell',
  Unit:            'Unit',
  Standard:        null,        // plain folder, no ISA-88 type
  EquipmentModule: 'EMOD',
  ControlModule:   null,
};

// Valid levels a hierarchy path segment can be assigned to
const VALID_LEVELS = ['ProcessCell', 'Unit', 'Standard', 'EquipmentModule'];

/**
 * Build io_hierarchy_nodes from mapped io_tags.
 *
 * levelMap: array mapping each slash-segment position to an ISA-88 level name.
 *   e.g. ['Area','ProcessCell','Unit'] or ['ProcessCell','Unit'] or ['Unit','EquipmentModule']
 *   Defaults to ['Area','ProcessCell','Unit','EquipmentModule'].
 *   Segments beyond the levelMap length are ignored.
 *
 * Returns { nodeCount, levels: { ... } }
 */
function buildHierarchy(db, importId, levelMap) {
  const tags = db.prepare(`
    SELECT *
    FROM io_tags
    WHERE import_id = ?
    ORDER BY hierarchy, instrument_tag, tag_name
  `).all(importId);

  // Detect actual max segment depth from the data
  let maxDepth = 0;
  for (const tag of tags) {
    const parts = (tag.hierarchy || '').split('/').filter(s => s.trim());
    if (parts.length > maxDepth) maxDepth = parts.length;
  }
  if (maxDepth === 0) maxDepth = 2; // fallback

  // Build effective level map:
  //  - Use caller-supplied levelMap for the positions it covers
  //  - Fill any remaining positions (beyond levelMap) with 'Standard'
  const suppliedMap = (Array.isArray(levelMap) && levelMap.length > 0)
    ? levelMap.filter(l => VALID_LEVELS.includes(l))
    : [];

  const map = [];
  for (let i = 0; i < maxDepth; i++) {
    map.push(suppliedMap[i] ?? 'Standard');
  }

  // Clear any previous hierarchy for this import
  db.prepare('DELETE FROM io_hierarchy_nodes WHERE import_id = ?').run(importId);
  db.prepare('UPDATE io_tags SET hierarchy_node_id = NULL WHERE import_id = ?').run(importId);

  // node registry: key → { key, level, name, parentKey, sortOrder, sourceTagIds[] }
  const registry = new Map();

  function getOrCreate(level, rawName, parentKey) {
    const name = (rawName || '').trim() || `(unnamed ${level})`;
    const key  = `${level}::${name}::${parentKey ?? '__root__'}`;
    if (registry.has(key)) return registry.get(key);
    const node = { key, level, name, parentKey: parentKey ?? null, sortOrder: registry.size, sourceTagIds: [] };
    registry.set(key, node);
    return node;
  }

  // ── Build tree ─────────────────────────────────────────────────────
  // hierarchy field: "Segment0/Segment1/..." — each segment mapped to levelMap[i].
  // instrument_tag (or tag_name fallback) collapses multiple IO rows into one CM node.
  for (const tag of tags) {
    const cmKey = (tag.instrument_tag || tag.tag_name || '').trim();
    if (!cmKey) continue;  // skip rows with no identity

    const parts = (tag.hierarchy || '').split('/').map(s => s.trim()).filter(Boolean);

    // Build the ancestor chain from levelMap
    let parentKey = null;
    for (let i = 0; i < map.length; i++) {
      const segment = parts[i];
      if (!segment) continue;  // optional level — skip if not present in this row
      parentKey = getOrCreate(map[i], segment, parentKey).key;
    }

    const cmNode = getOrCreate('ControlModule', cmKey, parentKey);
    cmNode.sourceTagIds.push(tag.id);
  }

  // ── Topological insert (parents before children) ───────────────────
  const sorted = topoSort([...registry.values()]);
  const dbIds  = {};  // key → DB id

  const insertNode = db.prepare(`
    INSERT INTO io_hierarchy_nodes
      (import_id, parent_id, level, name, s88_type, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const linkTag = db.prepare(
    'UPDATE io_tags SET hierarchy_node_id=?, updated_at=datetime("now") WHERE id=?'
  );

  db.transaction(() => {
    for (const node of sorted) {
      const parentDbId = node.parentKey ? (dbIds[node.parentKey] ?? null) : null;
      const row = insertNode.run(
        importId, parentDbId, node.level, node.name,
        S88_TYPE[node.level] ?? null, node.sortOrder
      );
      dbIds[node.key] = row.lastInsertRowid;

      // Link source tags to their CM node
      if (node.level === 'ControlModule') {
        for (const tid of node.sourceTagIds) {
          linkTag.run(row.lastInsertRowid, tid);
        }
      }
    }
  })();

  // Count by level
  const levels = {};
  for (const node of registry.values()) levels[node.level] = (levels[node.level] || 0) + 1;

  return { nodeCount: registry.size, levels, effectiveLevelMap: map };
}

function topoSort(nodes) {
  const byKey  = Object.fromEntries(nodes.map(n => [n.key, n]));
  const order  = [];
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    const n = byKey[key];
    if (!n) return;
    if (n.parentKey) visit(n.parentKey);
    visited.add(key);
    order.push(n);
  }
  nodes.forEach(n => visit(n.key));
  return order;
}

/**
 * Load the full hierarchy tree for an import as a nested structure.
 */
function loadHierarchyTree(db, importId) {
  const nodes = db.prepare(`
    SELECT n.*, COUNT(t.id) AS tag_count
    FROM io_hierarchy_nodes n
    LEFT JOIN io_tags t ON t.hierarchy_node_id = n.id
    WHERE n.import_id = ?
    GROUP BY n.id
    ORDER BY n.sort_order, n.id
  `).all(importId);

  const byId  = {};
  const roots = [];
  for (const n of nodes) { n.children = []; byId[n.id] = n; }
  for (const n of nodes) {
    if (n.parent_id && byId[n.parent_id]) byId[n.parent_id].children.push(n);
    else if (!n.parent_id) roots.push(n);
  }
  return roots;
}

/**
 * Promote approved hierarchy to project_hierarchy_folders and
 * approved tags to project_instances.
 * Returns { folders: N, instances: N }
 */
function promoteToProject(db, importId, projectId) {
  const nodes = db.prepare(`
    SELECT * FROM io_hierarchy_nodes WHERE import_id = ? ORDER BY sort_order, id
  `).all(importId);

  // One instance per CM node — pick the best assigned_cm_type across all IO rows in that node.
  // Priority: manual_override > approved > auto. Dedup in JS (no window functions needed).
  const STATUS_RANK = { manual_override: 1, approved: 2, auto: 3 };
  const allCmRows = db.prepare(`
    SELECT n.id AS node_id, n.name AS node_name, n.parent_id AS node_parent_id,
           t.assigned_cm_type, t.assignment_status, t.assignment, t.id AS tag_id
    FROM io_hierarchy_nodes n
    JOIN io_tags t ON t.hierarchy_node_id = n.id
    WHERE n.import_id = ? AND n.level = 'ControlModule'
      AND t.assignment_status IN ('auto','manual_override','approved')
      AND t.assigned_cm_type IS NOT NULL AND t.validation_status != 'error'
    ORDER BY t.id
  `).all(importId);

  // Keep best row per node_id
  const bestByNode = new Map();
  for (const row of allCmRows) {
    const existing = bestByNode.get(row.node_id);
    const rank = STATUS_RANK[row.assignment_status] ?? 99;
    const existingRank = existing ? (STATUS_RANK[existing.assignment_status] ?? 99) : 100;
    if (!existing || rank < existingRank) bestByNode.set(row.node_id, row);
  }
  const approvedTags = [...bestByNode.values()];

  // Map: io_hierarchy_node id → project_hierarchy_folder id
  const nodeToFolderId = {};

  const maxSO = db.prepare(
    'SELECT MAX(sort_order) AS m FROM project_hierarchy_folders WHERE project_id=?'
  ).get(projectId)?.m || 0;
  let folSO = maxSO + 1;

  const maxInstSO = db.prepare(
    'SELECT MAX(sort_order) AS m FROM project_instances WHERE project_id=?'
  ).get(projectId)?.m || 0;
  let instSO = maxInstSO + 1;

  let foldersCreated = 0, instancesCreated = 0, userProjectsCreated = 0;

  db.transaction(() => {
    // Only promote non-CM nodes to hierarchy folders
    const folderNodes = nodes.filter(n => n.level !== 'ControlModule');

    // Topological order (parent_id is already in DB order since nodes ordered by sort_order)
    for (const node of folderNodes) {
      const parentFolderId = node.parent_id ? (nodeToFolderId[node.parent_id] ?? null) : null;

      // Reuse existing folder with same name + parent
      const existing = db.prepare(`
        SELECT id FROM project_hierarchy_folders
        WHERE project_id=? AND name=? AND (parent_id IS ? OR parent_id = ?)
      `).get(projectId, node.name, parentFolderId, parentFolderId);

      if (existing) {
        nodeToFolderId[node.id] = existing.id;
      } else {
        const row = db.prepare(`
          INSERT INTO project_hierarchy_folders
            (project_id, parent_id, name, s88_type, sort_order)
          VALUES (?,?,?,?,?)
        `).run(projectId, parentFolderId, node.name, node.s88_type || null, folSO++);
        nodeToFolderId[node.id] = row.lastInsertRowid;
        foldersCreated++;
      }

      // Mark node as promoted
      db.prepare(
        'UPDATE io_hierarchy_nodes SET promoted=1, promoted_folder_id=? WHERE id=?'
      ).run(nodeToFolderId[node.id], node.id);
    }

    // Collect distinct AS assignments to register in project_user_projects
    const distinctAssignments = [...new Set(
      approvedTags.map(t => (t.assignment || '').trim()).filter(Boolean)
    )];

    // Upsert each AS assignment into project_user_projects so it appears in the dropdown
    const maxUpSO = db.prepare(
      'SELECT MAX(sort_order) AS m FROM project_user_projects WHERE project_id=?'
    ).get(projectId)?.m || 0;
    let upSO = maxUpSO + 1;

    const upsertUp = db.prepare(`
      INSERT OR IGNORE INTO project_user_projects (project_id, name, sort_order)
      VALUES (?,?,?)
    `);
    for (const asgn of distinctAssignments) {
      const r = upsertUp.run(projectId, asgn, upSO++);
      if (r.changes > 0) userProjectsCreated++;
    }

    // Cache composite CM type lookups by name (assigned_cm_type is now a composite name)
    const compositeCache = new Map();
    function resolveComposite(name) {
      if (compositeCache.has(name)) return compositeCache.get(name);
      const comp = db.prepare('SELECT * FROM composite_cm_types WHERE name=?').get(name);
      if (!comp) { compositeCache.set(name, null); return null; }
      const members = db.prepare(
        'SELECT * FROM composite_cm_members WHERE composite_id=? ORDER BY sort_order, id'
      ).all(comp.id);
      const result = { comp, members };
      compositeCache.set(name, result);
      return result;
    }

    // Create one or more project_instances per CM node.
    // If assigned_cm_type matches a composite, expand its members; otherwise insert raw.
    let groupCounter = instSO * 1000; // unique composite group id base

    for (const tag of approvedTags) {
      const folderId = tag.node_parent_id ? (nodeToFolderId[tag.node_parent_id] ?? null) : null;

      // Avoid duplicate base instance names
      const existing = db.prepare(
        'SELECT id FROM project_instances WHERE project_id=? AND instance_name=?'
      ).get(projectId, tag.node_name);
      if (existing) continue;

      const composite = resolveComposite(tag.assigned_cm_type);

      if (composite) {
        const { comp, members } = composite;
        const groupId = ++groupCounter;
        members.forEach((m, mi) => {
          const isProject = m.scope === 'project';
          const instName = isProject
            ? (`${m.name_prefix || ''}${m.name_suffix || ''}`.trim() || m.cm_type_name || tag.node_name)
            : `${m.name_prefix || ''}${tag.node_name}${m.name_suffix || ''}`;
          // Skip project-scope members that already exist
          if (isProject) {
            const ex = db.prepare(
              'SELECT id FROM project_instances WHERE project_id=? AND instance_name=?'
            ).get(projectId, instName);
            if (ex) return;
          }
          db.prepare(`
            INSERT INTO project_instances
              (project_id, cm_type, instance_name, sampling_time, user_project, folder_id, sort_order,
               composite_group_id, composite_id, member_idx)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(
            projectId,
            m.cm_type_name,
            instName,
            '1000',
            tag.assignment || '',
            folderId,
            instSO++,
            groupId,
            comp.id,
            mi
          );
          instancesCreated++;
        });
      } else {
        // Raw CM type (legacy / non-composite)
        db.prepare(`
          INSERT INTO project_instances
            (project_id, cm_type, instance_name, sampling_time, user_project, folder_id, sort_order)
          VALUES (?,?,?,?,?,?,?)
        `).run(
          projectId,
          tag.assigned_cm_type,
          tag.node_name,
          '1000',
          tag.assignment || '',
          folderId,
          instSO++
        );
        instancesCreated++;
      }
    }

    // Mark import as promoted
    db.prepare(`UPDATE io_imports SET status='promoted' WHERE id=?`).run(importId);
  })();

  return { folders: foldersCreated, instances: instancesCreated, userProjects: userProjectsCreated };
}

module.exports = { buildHierarchy, loadHierarchyTree, promoteToProject, VALID_LEVELS };
