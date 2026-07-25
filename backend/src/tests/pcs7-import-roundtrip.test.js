// tests/pcs7-import-roundtrip.test.js — Round-trip import/export verification
'use strict';

const assert = require('assert');
const { initDb, getDb } = require('../db');

/**
 * Integration test: Create → Export → Extract → Re-import → Verify
 * Ensures bidirectional sync works correctly.
 */

async function runRoundTripTest() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('PCS7 Unit Type Round-Trip Import/Export Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Initialize database
    await initDb();
    const db = getDb();

    console.log('✓ Database initialized');

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Set up test data (CM types + Composite CM Type)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[Phase 1] Setting up test data...');

    // Insert test CM types into library (if they don't exist)
    const cmTypes = ['TEST_CM_AO', 'TEST_CM_NIF', 'TEST_CM_POWER'];
    for (const cmName of cmTypes) {
      const existing = await db.prepare('SELECT id FROM lib_cm_types WHERE name = ?').get(cmName);
      if (!existing) {
        await db.prepare('INSERT INTO lib_cm_types (name, cm_type) VALUES (?, ?)')
          .run(cmName, 'CM');
        console.log(`  ✓ Created test CM type: ${cmName}`);
      }
    }

    // Create a test Composite CM Type
    const compRow = await db.prepare('SELECT id FROM composite_cm_types WHERE name = ?')
      .get('TEST_COMPOSITE_AO');
    let compositeId;
    if (!compRow) {
      const result = await db.prepare(
        'INSERT INTO composite_cm_types (name, description) VALUES (?, ?)'
      ).run('TEST_COMPOSITE_AO', 'Test Composite with AO + NIF + POWER');
      compositeId = result.lastInsertRowid;
      console.log(`  ✓ Created test Composite CM Type (id=${compositeId})`);

      // Add members to composite
      const members = [
        { cmName: 'TEST_CM_AO', folder: 'CM', isPrimary: 1, sortOrder: 0 },
        { cmName: 'TEST_CM_NIF', folder: 'INT', isPrimary: 0, sortOrder: 1 },
        { cmName: 'TEST_CM_POWER', folder: 'PWR', isPrimary: 0, sortOrder: 2 },
      ];
      for (const m of members) {
        await db.prepare(`
          INSERT INTO composite_cm_members (composite_id, cm_type_name, hierarchy_folder, is_primary, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `).run(compositeId, m.cmName, m.folder, m.isPrimary, m.sortOrder);
      }
      console.log(`  ✓ Added ${members.length} members to composite`);

      // Add internal connections (TEST_CM_AO.output → TEST_CM_NIF.input)
      await db.prepare(`
        INSERT INTO composite_cm_connections (composite_id, from_member_idx, from_var_name, to_member_idx, to_var_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(compositeId, 0, 'OUTPUT', 1, 'INPUT');
      console.log('  ✓ Added internal connection in composite');
    } else {
      compositeId = compRow.id;
      console.log(`  ✓ Using existing Composite CM Type (id=${compositeId})`);
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Create a Unit Type manually
    // ─────────────────────────────────────────────────────────────
    console.log('\n[Phase 2] Creating Unit Type manually...');

    const origName = `TEST_UNIT_TYPE_ORIGINAL_${Date.now()}`;
    const utRow = await db.prepare(
      'INSERT INTO unit_types (name, description) VALUES (?, ?)'
    ).run(origName, 'Original unit type for round-trip test');
    const originalUnitTypeId = utRow.lastInsertRowid;
    console.log(`  ✓ Created Unit Type (id=${originalUnitTypeId})`);

    // Add member (composite)
    const utmRow = await db.prepare(`
      INSERT INTO unit_type_members (unit_type_id, alias, cm_type_name, composite_cm_id, hierarchy_folder, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(originalUnitTypeId, 'TEST_MEMBER_01', '', compositeId, 'CM', 0);
    console.log(`  ✓ Added composite member to unit type`);

    // Add unit-level connection (if multiple members existed)
    // For now, just verify the structure is correct
    const verifyOriginal = await db.prepare(`
      SELECT ut.name, COUNT(utm.id) AS member_count
      FROM unit_types ut
      LEFT JOIN unit_type_members utm ON utm.unit_type_id = ut.id
      WHERE ut.id = ?
      GROUP BY ut.id
    `).get(originalUnitTypeId);
    console.log(`  ✓ Original unit type has ${Number(verifyOriginal.member_count)} member(s)`);

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Simulate CFG extraction (simplistic for test)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[Phase 3] Simulating CFG extraction...');

    // In real scenario, this would come from POST /api/generate and parsed
    const simulatedCfgText = `
STATION S7400 , "TEST_STATION"
  SUBNET INDUSTRIAL_ETHERNET , "PlantBus"
  RACK 1 , "TEST_STATION"
    MODULE SLOT 1 "6ES7 321-1BH02-0AA0"
      MODULE_INFO "TEST_CM_AO" 1 0
    MODULE SLOT 2 "6ES7 153-1AA00-0XB0"
      MODULE_INFO "TEST_CM_NIF" 2 0
    MODULE SLOT 3 "6ES7 307-1BA00-0AA0"
      MODULE_INFO "TEST_CM_POWER" 3 0
`;

    const { extractCmTypesFromCfg } = require('../services/pcs7UnitImporter');
    const extracted = extractCmTypesFromCfg(simulatedCfgText);
    console.log(`  ✓ Extracted CM types: ${extracted.cmTypes.join(', ')}`);

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Re-import using the import endpoint logic
    // ─────────────────────────────────────────────────────────────
    console.log('\n[Phase 4] Re-importing via import logic...');

    const pcs7Importer = require('../services/pcs7UnitImporter');
    const compositeAssigner = require('../services/compositeAssigner');
    const unitTypeBuilder = require('../services/unitTypeBuilder');

    // Validate CMs exist
    await compositeAssigner.validateCmTypesExist(extracted.cmTypes, db);
    console.log('  ✓ All extracted CM types exist in library');

    // Load composites and match
    const existingComposites = await pcs7Importer.loadExistingComposites(db);
    const matchResult = compositeAssigner.findCompositeMatches(extracted.cmTypes, existingComposites, 0.7);
    console.log(`  ✓ Matched to composite: ${matchResult.assignment.compositeName} (confidence=${matchResult.confidence})`);

    // Build unit structure
    const unitStructure = compositeAssigner.buildUnitMemberStructure(matchResult.assignment, []);
    console.log(`  ✓ Built unit structure with ${unitStructure.unitMembers.length} member(s)`);

    // Create the re-imported unit type
    const reimportName = `TEST_UNIT_TYPE_REIMPORTED_${Date.now()}`;
    const reimportResult = await unitTypeBuilder.createUnitTypeFromAssignment(
      reimportName,
      'Re-imported unit type from round-trip test',
      unitStructure.unitMembers,
      unitStructure.connections,
      db
    );
    const reimportedUnitTypeId = reimportResult.id;
    console.log(`  ✓ Created re-imported Unit Type (id=${reimportedUnitTypeId})`);

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Verify round-trip consistency
    // ─────────────────────────────────────────────────────────────
    console.log('\n[Phase 5] Verifying round-trip consistency...');

    const originalDetail = await unitTypeBuilder.loadUnitTypeForVerification(originalUnitTypeId, db);
    const reimportDetail = await unitTypeBuilder.loadUnitTypeForVerification(reimportedUnitTypeId, db);

    console.log(`  Original:   ${originalDetail.name} | Members: ${originalDetail.members.length}`);
    console.log(`  Re-imported: ${reimportDetail.name} | Members: ${reimportDetail.members.length}`);

    // Assertions
    assert.strictEqual(
      originalDetail.members.length,
      reimportDetail.members.length,
      'Member count should match'
    );

    assert.strictEqual(
      originalDetail.members[0].compositeId,
      reimportDetail.members[0].compositeId,
      'Composite ID should match'
    );

    console.log('  ✓ Round-trip verification passed!');

    // ─────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✓ All tests passed!');
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ Test failed:');
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  runRoundTripTest().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runRoundTripTest };
