#!/usr/bin/env node
// Quick test of the IO address fix: verify that allocated slot bases are
// correctly added to channel offsets, so a 4-channel AI card in analog space
// reports "IW 512/514/516/518" instead of "IW 0/2/4/6".

const { hwSignalToAddr } = require('./src/connections');

console.log('=== IO Address Fix Verification ===\n');

// Scenario: 4-channel AI card in slot 1 of station 1, allocated to base 512
const station = 1;
const slot = 1;
const signalType = 'AI';
const identifier = 'IW';

console.log(`4-channel AI card at station ${station}, slot ${slot}`);
console.log(`Baseline CFG max analog input: 511 (so next slot starts at 512)\n`);

const testCases = [
  { channel: 0, slotBase: 512, expected: 'IW 512', desc: 'TT01_PV (ch0)' },
  { channel: 1, slotBase: 512, expected: 'IW 514', desc: 'TT02_PV (ch1)' },
  { channel: 2, slotBase: 512, expected: 'IW 516', desc: 'TT03_PV (ch2)' },
  { channel: 3, slotBase: 512, expected: 'IW 518', desc: 'TT04_PV (ch3)' },
  // Legacy mode: no base (or base=0)
  { channel: 0, slotBase: 0, expected: 'IW 0', desc: 'Legacy: no allocation' },
  { channel: 1, slotBase: 0, expected: 'IW 2', desc: 'Legacy: no allocation' },
  // Digital DI card with base 4 (4 bytes used, so next slot at 5, rounded to 6 for even boundary)
  { channel: 0, slotBase: 6, signalType: 'DI', identifier: 'I', expected: 'I 6.0', desc: 'DI ch0 base 6' },
  { channel: 8, slotBase: 6, signalType: 'DI', identifier: 'I', expected: 'I 7.0', desc: 'DI ch8 base 6' },
  { channel: 9, slotBase: 6, signalType: 'DI', identifier: 'I', expected: 'I 7.1', desc: 'DI ch9 base 6' },
];

let passed = 0, failed = 0;
for (const tc of testCases) {
  const st = tc.signalType || signalType;
  const id = tc.identifier || identifier;
  const result = hwSignalToAddr(station, slot, tc.channel, st, id, tc.slotBase);
  const ok = result === tc.expected;
  const status = ok ? '✓' : '✗';
  console.log(`${status} ${tc.desc}`);
  if (!ok) {
    console.log(`  Expected: ${tc.expected}`);
    console.log(`  Got:      ${result}`);
    failed++;
  } else {
    passed++;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
