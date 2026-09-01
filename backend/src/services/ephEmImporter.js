// services/ephEmImporter.js — EPH/EM import processing
'use strict';
const { parseSheet, listSheets } = require('./ioParser');
const { newBatchId } = require('./auditLog');
const { auditInstanceCreate } = require('./instanceAudit');

/**
 * Upload and parse EPH/EM Excel file.
 * Returns { headers, totalRows, sheet name, preview }
 */
async function uploadEphEmFile(buffer, sheetName) {
  const sheets = await listSheets(buffer);
  const targetSheet = sheetName || sheets[0];
  const { headers, rows } = await parseSheet(buffer, targetSheet);

  return {
    sheets,
    sheet: targetSheet,
    headers,
    totalRows: rows.length,
    preview: rows.slice(0, 5).map(r => r.data),
    rows: rows.map((r, i) => ({
      rowNum: r.rowNum,
      data: r.data,
    })),
  };
}

/**
 * Apply column mapping: extract unit_name, assignment (AS), and detect type columns.
 * Mappings format: { unit_column: "Unit_Name", assignment_column?: "AS" }
 * All other columns become type columns.
 */
async function applyColumnMap(db, importId, mappings, headers) {
  const unitColumn = mappings.unit_column;
  const assignmentColumn = mappings.assignment_column; // Optional, e.g., "AS"

  if (!unitColumn || !headers.includes(unitColumn)) {
    throw new Error('Invalid unit column specified');
  }

  const typeColumns = headers.filter(h => h !== unitColumn && h !== assignmentColumn);
  if (typeColumns.length === 0) {
    throw new Error('No type columns found after removing unit column');
  }

  const rows = await db.prepare(
    'SELECT id, raw_data FROM eph_em_import_rows WHERE import_id = ?'
  ).all(importId);

  const update = db.prepare(`
    UPDATE eph_em_import_rows SET
      unit_name = ?, eph_em_types = ?, assignment = ?,
      updated_at = NOW()
    WHERE id = ?
  `);

  await db.transaction(async () => {
    for (const row of rows) {
      const raw = JSON.parse(row.raw_data || '{}');
      const unitName = raw[unitColumn] ? String(raw[unitColumn]).trim() : null;

      // Extract AS assignment (e.g., "AS01")
      const assignment = assignmentColumn && raw[assignmentColumn]
        ? String(raw[assignmentColumn]).trim()
        : null;

      // Collect which type columns have 'X' or true-ish value
      const typesPresent = [];
      for (const typeCol of typeColumns) {
        const val = raw[typeCol];
        if (val && (val === 'X' || val === 'x' || val === true || val === 1 || String(val).toUpperCase() === 'TRUE')) {
          typesPresent.push(typeCol);
        }
      }

      // Store as JSON: { "EM_DNS": true, "EM_UPS": false }
      const ephEmTypes = {};
      typeColumns.forEach(tc => {
        ephEmTypes[tc] = typesPresent.includes(tc);
      });

      await update.run(unitName, JSON.stringify(ephEmTypes), assignment, row.id);
    }
    await db.prepare(
      'UPDATE eph_em_imports SET status = \'mapped\' WHERE id = ?'
    ).run(importId);
  })();
}

/**
 * Run function-map assignment: map type columns to composite CM types.
 * Mappings: { "EM_DNS": "COMPOSITE_EM_DNS", "EM_UPS": "COMPOSITE_EM_UPS" }
 * Matching is case-insensitive: "transin" matches "TransIN" in the Excel columns.
 */
async function runAssignment(db, importId, typeColumnMappings) {
  if (!typeColumnMappings || Object.keys(typeColumnMappings).length === 0) {
    throw new Error('Type column mappings required for assignment');
  }

  // Normalize mapping keys to uppercase for case-insensitive matching
  const normalizedMappings = {};
  for (const [key, value] of Object.entries(typeColumnMappings)) {
    normalizedMappings[String(key).toUpperCase()] = value;
  }

  // Get all rows (both pending and previously assigned, since users can re-assign)
  const rows = await db.prepare(`
    SELECT id, eph_em_types
    FROM eph_em_import_rows
    WHERE import_id = ? AND assignment_status IN ('pending', 'assigned')
  `).all(importId);

  const update = db.prepare(`
    UPDATE eph_em_import_rows
    SET assigned_cm_types = ?, assignment_status = 'assigned', updated_at = NOW()
    WHERE id = ?
  `);

  await db.transaction(async () => {
    for (const row of rows) {
      const ephEmTypes = JSON.parse(row.eph_em_types || '{}');

      // For each type column that is true, map it to a composite CM type
      const assignedTypes = {};
      for (const [typeCol, isPresent] of Object.entries(ephEmTypes)) {
        if (isPresent) {
          const cmType = normalizedMappings[String(typeCol).toUpperCase()];
          if (cmType) {
            assignedTypes[typeCol] = cmType;
          }
        }
      }

      await update.run(JSON.stringify(assignedTypes), row.id);
    }
  })();

  // Mark as assignment complete
  await db.prepare('UPDATE eph_em_imports SET status = \'assigned\' WHERE id = ?').run(importId);
}

/**
 * Resolve a unit's full Plant Hierarchy path, e.g. "Plant/Area1/U010".
 * Returns null when the unit isn't in the hierarchy — the caller surfaces that
 * as a warning rather than an error, since such instances are still created
 * (just without a folder).
 */
async function resolveUnitPath(db, projectId, unitName) {
  const unit = await db.prepare(
    'SELECT id, name, parent_id FROM project_hierarchy_folders WHERE project_id = ? AND s88_type = ? AND name = ?'
  ).get(projectId, 'Unit', unitName);
  if (!unit) return null;

  const parts = [unit.name];
  let parentId = unit.parent_id;
  // Bounded walk — a cycle in the folder tree would otherwise hang the request.
  for (let depth = 0; parentId != null && depth < 32; depth++) {
    const parent = await db.prepare(
      'SELECT name, parent_id FROM project_hierarchy_folders WHERE id = ?'
    ).get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parent_id;
  }
  return parts.join('/');
}

/**
 * Find (or create) a named subfolder under a parent hierarchy folder.
 */
async function ensureSubfolder(db, projectId, parentId, name) {
  const existing = await db.prepare(
    'SELECT id FROM project_hierarchy_folders WHERE project_id = ? AND parent_id = ? AND name = ?'
  ).get(projectId, parentId, name);
  if (existing) return existing.id;

  const maxSort = await db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM project_hierarchy_folders WHERE project_id = ? AND parent_id = ?'
  ).get(projectId, parentId);

  const res = await db.prepare(`
    INSERT INTO project_hierarchy_folders (project_id, parent_id, name, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(projectId, parentId, name, Number(maxSort?.max_sort || 0) + 1);
  return res.lastInsertRowid;
}

/**
 * Promote EPH/EM import to project.
 *
 * Each assigned composite is expanded into its members: every member becomes a
 * real library-type instance placed in the member's own hierarchy_folder (e.g.
 * "EM") beneath the unit's folder in the Plant Hierarchy. The AS assignment field
 * is used as the user_project (e.g., "AS01").
 *
 * Units are looked up in the Plant Hierarchy. A missing unit is a warning, not an
 * error — its instances are created with no folder so the user can place them.
 */
async function promoteToProject(db, importId, projectId) {
  // One batch id for the whole promote, so the log shows it as one operation.
  const auditBatchId = newBatchId();

  const rows = await db.prepare(`
    SELECT id, unit_name, assigned_cm_types, assignment
    FROM eph_em_import_rows
    WHERE import_id = ? AND assignment_status = 'assigned'
  `).all(importId);

  if (rows.length === 0) {
    throw new Error('No assigned EPH/EM rows to promote');
  }

  // Fallback user project if not specified in AS assignment
  const defaultUserProject = (await db.prepare(
    'SELECT name FROM project_user_projects WHERE project_id = ? ORDER BY sort_order, id LIMIT 1'
  ).get(projectId))?.name || '';

  // The AS column names a *controller* (e.g. "AS01"), matching
  // hw_controllers.T16_Controller_TagName — not a user project. The user project
  // is read from the matched controller rather than invented from the AS string.
  // Unmatched names resolve to null: the grid shows those instances unassigned
  // and blocks generation until the user picks one, rather than guessing.
  const ctrlRows = await db.prepare(
    `SELECT id, T16_Controller_TagName AS tag_name, user_project
       FROM hw_controllers WHERE project_id = ?`
  ).all(projectId);
  const ctrlByName = new Map(
    ctrlRows
      .filter(c => c.tag_name)
      .map(c => [String(c.tag_name).trim().toUpperCase(), c])
  );
  const controllerFor = name => {
    const key = (name || '').trim().toUpperCase();
    return key ? (ctrlByName.get(key) ?? null) : null;
  };
  const controllerIdFor = name => controllerFor(name)?.id ?? null;

  const created = [];
  const warnings = [];
  const unmatchedAs = new Set();  // AS values with no controller — warned once each

  await db.transaction(async () => {
    for (const row of rows) {
      if (!row.unit_name) continue;

      const assignedTypes = JSON.parse(row.assigned_cm_types || '{}');
      // The AS value identifies a controller; the user project comes from that
      // controller. With no AS (or no matching controller) fall back to the
      // project's first user project so the instance is still placed sensibly —
      // its controller stays null and the grid flags it.
      const ctrl = controllerFor(row.assignment);
      const userProject = ctrl?.user_project || defaultUserProject;
      if (row.assignment && !ctrl && !unmatchedAs.has(row.assignment.trim())) {
        unmatchedAs.add(row.assignment.trim());
        warnings.push(
          `No controller matches AS "${row.assignment.trim()}" — instances for it have no ` +
          `controller assigned. Set one in the Instances grid before generating.`
        );
      }

      const unitFolder = await db.prepare(
        'SELECT id FROM project_hierarchy_folders WHERE project_id = ? AND s88_type = ? AND name = ?'
      ).get(projectId, 'Unit', row.unit_name);

      if (!unitFolder) {
        warnings.push(`Unit "${row.unit_name}" not found in Plant Hierarchy — instances for it were created without a folder`);
      }

      for (const [typeCol, compositeName] of Object.entries(assignedTypes)) {
        const composite = await db.prepare(
          'SELECT id FROM composite_cm_types WHERE name = ? AND project_id = ?'
        ).get(compositeName, projectId);

        if (!composite) {
          warnings.push(`Composite "${compositeName}" no longer exists — skipped for unit "${row.unit_name}"`);
          continue;
        }

        const members = await db.prepare(`
          SELECT cm_type_name, hierarchy_folder, name_prefix, name_suffix, sort_order
          FROM composite_cm_members
          WHERE composite_id = ?
          ORDER BY sort_order, id
        `).all(composite.id);

        if (members.length === 0) {
          warnings.push(`Composite "${compositeName}" has no members — nothing created for unit "${row.unit_name}"`);
          continue;
        }

        // Base tag all members derive their name from, e.g. U010_EM_DNS
        const baseName = `${row.unit_name}_${typeCol}`;

        for (let idx = 0; idx < members.length; idx++) {
          const m = members[idx];
          const instanceName = `${m.name_prefix || ''}${baseName}${m.name_suffix || ''}`;

          // Place the member in its configured subfolder under the unit.
          let folderId = unitFolder?.id ?? null;
          if (unitFolder && m.hierarchy_folder) {
            folderId = await ensureSubfolder(db, projectId, unitFolder.id, m.hierarchy_folder);
          }

          const maxSort = await db.prepare(
            'SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM project_instances WHERE project_id = ?'
          ).get(projectId);

          const inst = await db.prepare(`
            INSERT INTO project_instances
              (project_id, cm_type, instance_name, user_project, hw_controller_id, sort_order, folder_id,
               composite_id, member_idx, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(projectId, m.cm_type_name, instanceName, userProject,
                 controllerIdFor(userProject),
                 Number(maxSort?.max_sort || 0) + 1, folderId,
                 composite.id, idx, 'eph_em_import');

          await auditInstanceCreate(db, {
            projectId,
            instance: {
              id: inst.lastInsertRowid,
              instance_name: instanceName,
              cm_type: m.cm_type_name,
            },
            batchId: auditBatchId,
            source: 'import',
            location: 'EPH/EM Import',
          });

          created.push({
            id: inst.lastInsertRowid,
            instanceName,
            cmType: m.cm_type_name,
            composite: compositeName,
            unitName: row.unit_name,
            folder: m.hierarchy_folder || null,
            userProject: userProject,
          });
        }
      }
    }
  })();

  await db.prepare('UPDATE eph_em_imports SET status = \'promoted\' WHERE id = ?').run(importId);

  return {
    created: created.length,
    instances: created,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

module.exports = {
  uploadEphEmFile,
  applyColumnMap,
  runAssignment,
  promoteToProject,
  resolveUnitPath,
};
