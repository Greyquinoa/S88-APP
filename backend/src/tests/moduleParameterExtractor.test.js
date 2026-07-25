'use strict';

const ModuleParameterExtractor = require('../services/moduleParameterExtractor');
const fs = require('fs');
const path = require('path');

/**
 * Test the Module Parameter Extractor with the provided AS01.cfg file
 */

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║     Module Parameter Extractor - CFG Test                      ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

const cfgPath = path.join(__dirname, '../../..', 'as01_newdevice.cfg');

if (!fs.existsSync(cfgPath)) {
  console.error('❌ CFG file not found:', cfgPath);
  process.exit(1);
}

const cfgContent = fs.readFileSync(cfgPath, 'utf-8');
console.log(`✓ Loaded CFG file: ${cfgPath}`);
console.log(`  File size: ${(cfgContent.length / 1024).toFixed(2)} KB\n`);

const extractor = new ModuleParameterExtractor();

// Extract all parameters
const allParameters = extractor.extractAllParameters(cfgContent);
console.log(`✓ Extracted ${allParameters.length} total parameters\n`);

// Organize by module
const organized = extractor.organizeByModule(allParameters);
console.log(`✓ Found ${organized.size} modules with parameters:\n`);

let moduleIndex = 1;
organized.forEach((moduleData, key) => {
  const { orderNo, displayName, parameters } = moduleData;
  console.log(`${moduleIndex}. ${orderNo}`);
  console.log(`   Display: ${displayName}`);
  console.log(`   Parameters: ${parameters.length}`);

  // Show breakdown by type
  const moduleLevel = parameters.filter(p => p.parameter_type === 'module').length;
  const channelLevel = parameters.filter(p => p.parameter_type === 'channel').length;
  const metadata = parameters.filter(p => p.parameter_type === 'metadata').length;

  if (moduleLevel > 0) console.log(`     • Module-level: ${moduleLevel}`);
  if (channelLevel > 0) console.log(`     • Channel-level: ${channelLevel}`);
  if (metadata > 0) console.log(`     • Metadata: ${metadata}`);

  console.log();
  moduleIndex++;
});

// Get summary
const summary = extractor.summarize(allParameters);

console.log('═══════════════════════════════════════════════════════════════\n');
console.log('📊 EXTRACTION SUMMARY\n');
console.log(`Total Parameters Extracted:  ${summary.total_parameters}`);
console.log(`  • Module-level:            ${summary.module_params}`);
console.log(`  • Channel-level:           ${summary.channel_params}`);
console.log(`  • Metadata:                ${summary.metadata_params}`);
console.log();
console.log(`Unique Parameter Names:      ${summary.unique_param_names.length}`);
console.log(`Modules Affected:            ${summary.modules_affected.length}`);

console.log('\n═══════════════════════════════════════════════════════════════\n');
console.log('📋 UNIQUE PARAMETER NAMES\n');
summary.unique_param_names.forEach((name, idx) => {
  // Count occurrences
  const count = allParameters.filter(p => p.parameter_name === name).length;
  console.log(`${String(idx + 1).padStart(2)}. ${name.padEnd(40)} (${count} occurrence${count > 1 ? 's' : ''})`);
});

console.log('\n═══════════════════════════════════════════════════════════════\n');
console.log('🔍 DETAILED MODULE BREAKDOWN\n');

organized.forEach((moduleData, key) => {
  const { orderNo, displayName, parameters } = moduleData;
  console.log(`\n▸ ${orderNo}`);
  console.log(`  ${displayName}\n`);

  // Group parameters by type
  const moduleParams = parameters.filter(p => p.parameter_type === 'module');
  const channelParams = parameters.filter(p => p.parameter_type === 'channel');
  const metadataParams = parameters.filter(p => p.parameter_type === 'metadata');

  if (moduleParams.length > 0) {
    console.log('  MODULE-LEVEL PARAMETERS:');
    moduleParams.slice(0, 5).forEach((p) => {
      console.log(`    • ${p.parameter_name} = "${p.parameter_value}"`);
    });
    if (moduleParams.length > 5) {
      console.log(`    ... and ${moduleParams.length - 5} more`);
    }
  }

  if (channelParams.length > 0) {
    console.log('\n  CHANNEL-LEVEL PARAMETERS:');
    const byChannel = {};
    channelParams.forEach((p) => {
      if (!byChannel[p.channel_no]) byChannel[p.channel_no] = [];
      byChannel[p.channel_no].push(p);
    });

    Object.keys(byChannel)
      .slice(0, 3)
      .forEach((ch) => {
        console.log(`    Channel ${ch}:`);
        byChannel[ch].slice(0, 2).forEach((p) => {
          console.log(`      • ${p.parameter_name} = "${p.parameter_value}"`);
        });
        if (byChannel[ch].length > 2) {
          console.log(`      ... and ${byChannel[ch].length - 2} more`);
        }
      });

    if (Object.keys(byChannel).length > 3) {
      console.log(`    ... and ${Object.keys(byChannel).length - 3} more channels`);
    }
  }

  if (metadataParams.length > 0) {
    console.log('\n  METADATA PARAMETERS:');
    metadataParams.slice(0, 3).forEach((p) => {
      console.log(`    • ${p.parameter_name} = "${p.parameter_value}"`);
    });
    if (metadataParams.length > 3) {
      console.log(`    ... and ${metadataParams.length - 3} more`);
    }
  }
});

console.log('\n═══════════════════════════════════════════════════════════════\n');
console.log('✅ EXTRACTION COMPLETE\n');

// Example: Show what will go into the database
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('📦 DATABASE SCHEMA\n');

console.log(`Table: hw_module_parameters`);
console.log(`Columns:`);
console.log(`  • id                 (INTEGER PRIMARY KEY)`);
console.log(`  • hw_signal_id       (INTEGER FK → hw_signals.id)`);
console.log(`  • parameter_name     (TEXT) - e.g., CHANNEL_ACTIVATED, DIAGNOSTICS_WIRE_BREAK`);
console.log(`  • parameter_value    (TEXT) - e.g., "1", "0", "3.2_MS", "TURN_OFF"`);
console.log(`  • channel_no         (INTEGER) - NULL for module-level, channel index for channel-level`);
console.log(`  • parameter_type     (TEXT) - 'module' | 'channel' | 'metadata'`);
console.log(`  • sort_order         (INTEGER) - order in CFG file`);
console.log(`  • created_at         (TIMESTAMP)`);
console.log(`  • updated_at         (TIMESTAMP)`);

console.log('\nUnique Constraint: (hw_signal_id, parameter_name, channel_no)');
console.log('Indexes: signal_id, parameter_name, channel_no\n');

console.log('═══════════════════════════════════════════════════════════════\n');
