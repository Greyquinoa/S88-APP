// One-off cleanup: remove the '__test_cfg_generic_model__' project created by
// the regression harness (backend/src/tests/cfg-generic-model.test.js) and all
// rows it populated. The frontend's project-delete route doesn't cascade
// hw_controllers/hw_imports (those are cleaned up by the separate
// DELETE /api/hw-controllers/:id route, keyed by controller not project), so a
// project with hw data can't be deleted from the UI — hence this script.
'use strict';

const { initDb, getDb } = require('./src/db');

async function main() {
  await initDb();
  const db = getDb();

  const proj = await db.prepare('SELECT id FROM projects WHERE name = ?').get('__test_cfg_generic_model__');
  if (!proj) {
    console.log('No __test_cfg_generic_model__ project found — nothing to do.');
    return;
  }
  const projectId = proj.id;
  console.log(`Found test project id=${projectId}`);

  await db.transaction(async () => {
    // ── hw_controllers cascade (mirrors DELETE /api/hw-controllers/:id) ──────
    const controllers = await db.prepare('SELECT id FROM hw_controllers WHERE project_id = ?').all(projectId);
    for (const { id: controllerId } of controllers) {
      const imports = await db.prepare('SELECT id FROM hw_imports WHERE hw_controller_id = ?').all(controllerId);
      for (const { id: importId } of imports) {
        const signals = await db.prepare('SELECT id FROM hw_signals WHERE hw_import_id = ?').all(importId);
        for (const { id: sigId } of signals) {
          await db.prepare('DELETE FROM instance_ios WHERE hw_signal_id = ?').run(sigId);
        }
        await db.prepare('DELETE FROM hw_signals WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM mrp_configs WHERE hw_import_id = ?').run(importId);
        await db.prepare('DELETE FROM hw_imports WHERE id = ?').run(importId);
      }
      await db.prepare('DELETE FROM hw_fieldbuses WHERE hw_controller_id = ?').run(controllerId);
      await db.prepare('DELETE FROM hw_controllers WHERE id = ?').run(controllerId);
    }

    // Any hw_imports left on this project without a controller (imports can be
    // created standalone before a controller is assigned).
    const strayImports = await db.prepare('SELECT id FROM hw_imports WHERE project_id = ?').all(projectId);
    for (const { id: importId } of strayImports) {
      const signals = await db.prepare('SELECT id FROM hw_signals WHERE hw_import_id = ?').all(importId);
      for (const { id: sigId } of signals) {
        await db.prepare('DELETE FROM instance_ios WHERE hw_signal_id = ?').run(sigId);
      }
      await db.prepare('DELETE FROM hw_signals WHERE hw_import_id = ?').run(importId);
      await db.prepare('DELETE FROM hw_excel_raw WHERE hw_import_id = ?').run(importId);
      await db.prepare('DELETE FROM hw_slot_subslots WHERE hw_import_id = ?').run(importId);
      await db.prepare('DELETE FROM hw_generated_cfgs WHERE hw_import_id = ?').run(importId);
      await db.prepare('DELETE FROM mrp_configs WHERE hw_import_id = ?').run(importId);
      await db.prepare('DELETE FROM hw_imports WHERE id = ?').run(importId);
    }

    // ── Same tear-down as the project-delete route (projects.js) ────────────
    await db.prepare('DELETE FROM project_instances         WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM project_cmt_profiles      WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM project_user_projects     WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM project_hierarchy_folders WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM project_config_devices    WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM project_config            WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM user_cm_block_prefs WHERE project_id = ?').run(projectId);

    const cmIds = (await db.prepare('SELECT id FROM lib_cm_types WHERE project_id = ?').all(projectId)).map(r => r.id);
    for (const cmId of cmIds) {
      const blockIds = (await db.prepare('SELECT id FROM lib_blocks WHERE cm_type_id = ?').all(cmId)).map(r => r.id);
      for (const blockId of blockIds) {
        const varIds = (await db.prepare('SELECT id FROM lib_variables WHERE block_id = ?').all(blockId)).map(r => r.id);
        for (const varId of varIds) await db.prepare('DELETE FROM lib_var_links WHERE var_id = ?').run(varId);
        await db.prepare('DELETE FROM lib_variables WHERE block_id = ?').run(blockId);
        await db.prepare('DELETE FROM lib_messages  WHERE block_id = ?').run(blockId);
      }
      await db.prepare('DELETE FROM lib_blocks   WHERE cm_type_id = ?').run(cmId);
      await db.prepare('DELETE FROM lib_em_roles WHERE cm_type_id = ?').run(cmId);
    }
    await db.prepare('DELETE FROM lib_cm_types WHERE project_id = ?').run(projectId);

    const compIds = (await db.prepare('SELECT id FROM composite_cm_types WHERE project_id = ?').all(projectId)).map(r => r.id);
    for (const compId of compIds) {
      const modeIds = (await db.prepare('SELECT id FROM composite_matrix_modes WHERE composite_id = ?').all(compId)).map(r => r.id);
      for (const modeId of modeIds) await db.prepare('DELETE FROM composite_matrix_cells WHERE mode_id = ?').run(modeId);
      await db.prepare('DELETE FROM composite_matrix_modes   WHERE composite_id = ?').run(compId);
      await db.prepare('DELETE FROM composite_matrix_columns WHERE composite_id = ?').run(compId);
      await db.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(compId);
      await db.prepare('DELETE FROM composite_cm_members     WHERE composite_id = ?').run(compId);
    }
    await db.prepare('DELETE FROM composite_cm_types WHERE project_id = ?').run(projectId);

    const unitTypeIds = (await db.prepare('SELECT id FROM unit_types WHERE project_id = ?').all(projectId)).map(r => r.id);
    for (const utId of unitTypeIds) {
      const memberIds = (await db.prepare('SELECT id FROM unit_type_members WHERE unit_type_id = ?').all(utId)).map(r => r.id);
      for (const memberId of memberIds) await db.prepare('DELETE FROM unit_type_member_roles WHERE member_id = ?').run(memberId);
      await db.prepare('DELETE FROM unit_type_members            WHERE unit_type_id = ?').run(utId);
      await db.prepare('DELETE FROM unit_type_member_connections WHERE unit_type_id = ?').run(utId);
    }
    await db.prepare('DELETE FROM unit_instances WHERE project_id = ?').run(projectId);
    await db.prepare('DELETE FROM unit_types     WHERE project_id = ?').run(projectId);

    await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  })();

  console.log(`Deleted test project id=${projectId} and all related rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
