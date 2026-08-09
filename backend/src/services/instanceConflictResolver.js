// services/instanceConflictResolver.js — Instance name conflict detection and resolution
'use strict';

/**
 * Detects instance name conflicts between incoming and existing instances.
 *
 * @param {Database} db
 * @param {number} projectId
 * @param {Array<{name: string, cmType: string, ...}>} incomingInstances
 * @returns {Promise<{
 *   conflicts: Array<{
 *     name: string,
 *     existingId: number,
 *     incoming: {cmType, ...},
 *     existing: {cmType, createdAt, id}
 *   }>,
 *   clean: Array<string>,
 *   summary: {total: number, conflicts: number, clean: number}
 * }>}
 */
async function detectInstanceConflicts(db, projectId, incomingInstances) {
  // Load all existing instances for the project.
  // project_instances has no created_at column — don't select one.
  const existing = await db.prepare(`
    SELECT id, instance_name, cm_type
    FROM project_instances
    WHERE project_id = ?
  `).all(projectId);

  const existingMap = new Map(existing.map(r => [r.instance_name, r]));
  const conflicts = [];
  const clean = [];

  for (const incoming of incomingInstances) {
    if (existingMap.has(incoming.name)) {
      const existingRow = existingMap.get(incoming.name);
      conflicts.push({
        name: incoming.name,
        existingId: existingRow.id,
        incoming: {
          cmType: incoming.cmType,
        },
        existing: {
          cmType: existingRow.cm_type,
          id: existingRow.id,
        },
      });
    } else {
      clean.push(incoming.name);
    }
  }

  return {
    conflicts,
    clean,
    summary: {
      total: incomingInstances.length,
      conflicts: conflicts.length,
      clean: clean.length,
    },
  };
}

/**
 * Applies user-selected resolutions to conflicts and creates/updates instances.
 *
 * @param {Database} db
 * @param {number} projectId
 * @param {Array<{name: string, action: 'skip'|'update'|'create_anyway'}>} resolutions
 * @param {Array<{name: string, cmType: string, ...}>} incomingInstances
 * @returns {Promise<{
 *   created: number,
 *   updated: number,
 *   skipped: number,
 *   summary: string
 * }>}
 */
async function applyConflictResolutions(db, projectId, resolutions, incomingInstances) {
  const resolutionMap = new Map(resolutions.map(r => [r.name, r.action]));
  const stats = { created: 0, updated: 0, skipped: 0 };

  return await db.transaction(async () => {
    for (const incoming of incomingInstances) {
      const action = resolutionMap.get(incoming.name);

      if (action === 'skip') {
        stats.skipped++;
        continue;
      }

      if (action === 'update') {
        // UPDATE: Delete old instance and all related data, then insert new
        await db.prepare('DELETE FROM project_instances WHERE project_id = ? AND instance_name = ?')
          .run(projectId, incoming.name);
        // Insert new instance (cascading deletes handle roles, connections, etc.)
        await insertInstanceRecord(db, projectId, incoming);
        stats.updated++;
      } else if (action === 'create_anyway') {
        // CREATE_ANYWAY: Insert even if name exists (caller should have resolved duplicates in incoming)
        await insertInstanceRecord(db, projectId, incoming);
        stats.created++;
      }
    }

    return {
      ...stats,
      summary: `${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`,
    };
  })();   // db.transaction() returns a runner — it must be invoked.
}

/**
 * Inserts a single instance record into project_instances table.
 */
async function insertInstanceRecord(db, projectId, instanceData) {
  const result = await db.prepare(`
    INSERT INTO project_instances
    (project_id, instance_name, cm_type, sampling_time, folder_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    instanceData.name,
    instanceData.cmType,
    instanceData.samplingTime || '1000',
    instanceData.folderId || null,
    0  // sort_order updated later
  );

  return result.lastInsertRowid;
}

module.exports = {
  detectInstanceConflicts,
  applyConflictResolutions,
  insertInstanceRecord,
};
