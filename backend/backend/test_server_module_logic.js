#!/usr/bin/env node
/**
 * Test script to verify server module attachment logic
 * Tests that the server module is only attached when explicitly enabled in auto-slot config
 */

// Simulate the new logic
function testServerModuleLogic(hasServer, autoSlotConfig) {
  const serverModuleEnabled = autoSlotConfig?.rules?.server_module_enabled === true;
  return !hasServer && serverModuleEnabled;
}

console.log('Testing server module attachment logic...\n');

// Test Case 1: ET200SP with server_module_enabled: true (should add)
const test1 = testServerModuleLogic(false, {
  rules: { server_module_enabled: true }
});
console.log('Test 1 - ET200SP enabled, not in list:');
console.log(`  hasServer=false, server_module_enabled=true`);
console.log(`  Result: ${test1} (expected: true)`);
console.log(`  ${test1 === true ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Case 2: CFU_PA with server_module_enabled: false (should NOT add)
const test2 = testServerModuleLogic(false, {
  rules: { server_module_enabled: false }
});
console.log('Test 2 - CFU_PA disabled:');
console.log(`  hasServer=false, server_module_enabled=false`);
console.log(`  Result: ${test2} (expected: false)`);
console.log(`  ${test2 === false ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Case 3: User manually added server module (should NOT auto-add again)
const test3 = testServerModuleLogic(true, {
  rules: { server_module_enabled: true }
});
console.log('Test 3 - ET200SP enabled, but already in list:');
console.log(`  hasServer=true, server_module_enabled=true`);
console.log(`  Result: ${test3} (expected: false)`);
console.log(`  ${test3 === false ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Case 4: Missing config (safe default - should NOT add)
const test4 = testServerModuleLogic(false, null);
console.log('Test 4 - Missing auto-slot config:');
console.log(`  hasServer=false, autoSlotConfig=null`);
console.log(`  Result: ${test4} (expected: false)`);
console.log(`  ${test4 === false ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Case 5: Config exists but no rules (safe default - should NOT add)
const test5 = testServerModuleLogic(false, {
  slots: []
});
console.log('Test 5 - Config exists but no rules section:');
console.log(`  hasServer=false, config has no rules`);
console.log(`  Result: ${test5} (expected: false)`);
console.log(`  ${test5 === false ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Case 6: Config has null flag (safe default - should NOT add)
const test6 = testServerModuleLogic(false, {
  rules: { server_module_enabled: null }
});
console.log('Test 6 - Config has null flag:');
console.log(`  hasServer=false, server_module_enabled=null`);
console.log(`  Result: ${test6} (expected: false)`);
console.log(`  ${test6 === false ? '✅ PASS' : '❌ FAIL'}\n`);

// Summary
const allTests = [test1, test2, test3, test4, test5, test6];
const expected = [true, false, false, false, false, false];
const passed = allTests.every((result, i) => result === expected[i]);

console.log('═'.repeat(50));
console.log(`Summary: ${passed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
console.log('═'.repeat(50));

process.exit(passed ? 0 : 1);
