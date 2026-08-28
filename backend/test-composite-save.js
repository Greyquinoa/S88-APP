#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { initDb, getDb } = require('./src/db');

async function testCompositeInsert() {
  try {
    console.log('[TEST] Initializing database...');
    await initDb();

    const db = getDb();

    console.log('[TEST] Testing composite CM creation...');

    const result = await db.transaction(async () => {
      // Test: Create a composite with members, connections, and matrix data
      const compositeResult = await db.prepare(
        'INSERT INTO composite_cm_types (name, description, is_matrix) VALUES (?, ?, ?)'
      ).run('TEST_COMPOSITE', 'Test description', true);

      const compId = compositeResult.lastInsertRowid;
      console.log('[TEST] Created composite with id:', compId);

      // Add a member
      const memberResult = await db.prepare(`
        INSERT INTO composite_cm_members
          (composite_id, cm_type_name, hierarchy_folder, name_prefix, name_suffix, is_primary, scope, roles, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(compId, 'TEST_CM', '', '', '', false, 'unit', null, 0);
      console.log('[TEST] Created member');

      // Add matrix columns
      const colResult = await db.prepare(
        'INSERT INTO composite_matrix_columns (composite_id, column_name, sort_order) VALUES (?, ?, ?)'
      ).run(compId, 'VALVE_1', 0);
      console.log('[TEST] Created matrix column');

      // Add matrix mode
      const modeResult = await db.prepare(
        'INSERT INTO composite_matrix_modes (composite_id, mode_nr, mode_name, sort_order) VALUES (?, ?, ?, ?)'
      ).run(compId, 1, 'Mode 1', 0);
      const modeId = modeResult.lastInsertRowid;
      console.log('[TEST] Created matrix mode with id:', modeId);

      // Add matrix cell - THIS IS WHERE IT FAILS
      console.log('[TEST] About to insert into composite_matrix_cells...');
      const cellResult = await db.prepare(
        'INSERT INTO composite_matrix_cells (mode_id, column_name, value) VALUES (?, ?, ?)'
      ).run(modeId, 'VALVE_1', 100);
      console.log('[TEST] Created matrix cell');

      return compId;
    })();

    console.log('[TEST] SUCCESS - composite created:', result);

    // Clean up
    console.log('[TEST] Cleaning up test data...');
    const db2 = getDb();
    await db2.transaction(async () => {
      const rows = await db2.prepare('SELECT id FROM composite_cm_types WHERE name = ?').all('TEST_COMPOSITE');
      if (rows.length > 0) {
        const id = rows[0].id;
        await db2.prepare('DELETE FROM composite_matrix_cells WHERE mode_id IN (SELECT id FROM composite_matrix_modes WHERE composite_id = ?)').run(id);
        await db2.prepare('DELETE FROM composite_matrix_modes WHERE composite_id = ?').run(id);
        await db2.prepare('DELETE FROM composite_matrix_columns WHERE composite_id = ?').run(id);
        await db2.prepare('DELETE FROM composite_cm_connections WHERE composite_id = ?').run(id);
        await db2.prepare('DELETE FROM composite_cm_members WHERE composite_id = ?').run(id);
        await db2.prepare('DELETE FROM composite_cm_types WHERE id = ?').run(id);
      }
    })();
    console.log('[TEST] Cleanup complete');

  } catch (err) {
    console.error('[TEST] Error:', err.message);
    console.error('[TEST] Stack:', err.stack);
  }
}

testCompositeInsert();
