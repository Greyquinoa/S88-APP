# Module Parameters Extraction System

## Overview

A complete system for extracting, storing, and managing hardware module parameters from PCS7 CFG (configuration) files. Parameters from DI, DO, AI, AO modules and other hardware components are now stored in a dedicated database table with foreign key relationships to modules.

## What Was Extracted

### Database Schema

**Table: `hw_module_parameters`**

```sql
CREATE TABLE hw_module_parameters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  hw_signal_id    INTEGER NOT NULL REFERENCES hw_signals(id) ON DELETE CASCADE,
  parameter_name  TEXT NOT NULL,
  parameter_value TEXT,
  channel_no      INTEGER,
  parameter_type  TEXT DEFAULT 'module',  -- 'module' | 'channel' | 'metadata'
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(hw_signal_id, parameter_name, channel_no)
);

-- Indexes for performance
CREATE INDEX idx_hwmp_signal ON hw_module_parameters(hw_signal_id);
CREATE INDEX idx_hwmp_param_name ON hw_module_parameters(parameter_name);
CREATE INDEX idx_hwmp_channel ON hw_module_parameters(channel_no);
```

### Parameter Types

1. **Module-level Parameters** (parameter_type='module')
   - Generic module settings: DIAGNOSTICS_WIRE_BREAK, VERSION_HIGH, VERSION_LOW, etc.
   - Example: `DIAGNOSTICS_WIRE_BREAK, "0"`
   - Stored with `channel_no = NULL`

2. **Channel-level Parameters** (parameter_type='channel')
   - Channel-specific settings: CHANNEL_ACTIVATED, INPUT_DELAY, MEASURING_TYPE, etc.
   - Example: `CHANNEL_ACTIVATED, DI , 0, "1"`
   - Stored with `channel_no = 0` (the channel index)
   - Includes channel_type: DI, DO, AI, AO

3. **Metadata Parameters** (parameter_type='metadata')
   - Meta-information: VERSION, BLOCK_LENGTH, etc.
   - Similar structure to module-level

## Component Files

### 1. **moduleParameterExtractor.js** (`backend/src/services/moduleParameterExtractor.js`)

Core extraction engine that parses CFG files.

```javascript
const extractor = new ModuleParameterExtractor();

// Extract all parameters from a CFG file
const parameters = extractor.extractAllParameters(cfgContent);

// Organize by module
const organized = extractor.organizeByModule(parameters);

// Get summary stats
const summary = extractor.summarize(parameters);
```

**Key Methods:**
- `extractAllParameters(cfgText)` - Extract from entire CFG
- `findModuleBlocks(cfgText)` - Locate PARAMETER blocks
- `parseParameterBlock(paramText, context)` - Parse parameter lines
- `parseSingleParameter(line, context)` - Parse individual parameter
- `organizeByModule(parameters)` - Group by module
- `extractModuleParams(moduleOrderNo, paramText)` - Extract for one module
- `summarize(parameters)` - Generate stats

**Regex Patterns:**

- Simple module parameter: `PARAM_NAME, "value"`
- Channel parameter: `PARAM_NAME, CHANNEL_TYPE, CHANNEL_NO, "value"`
- Supported channel types: DI, DO, AI, AO

### 2. **moduleParameterDb.js** (`backend/src/services/moduleParameterDb.js`)

Database operations and queries.

```javascript
const ModuleParameterDb = require('./services/moduleParameterDb');

// Insert parameters for a module
ModuleParameterDb.insertModuleParameters(hwSignalId, parameters);

// Retrieve parameters
const params = ModuleParameterDb.getParametersBySignal(hwSignalId);
const grouped = ModuleParameterDb.getParametersGrouped(hwSignalId);
const stats = ModuleParameterDb.getParameterStats(hwSignalId);
```

**Key Methods:**
- `insertModuleParameters(hwSignalId, parameters)` - Insert batch
- `getParametersBySignal(hwSignalId)` - Get all for module
- `getParametersByName(paramName)` - Get across all modules
- `getChannelParameters(hwSignalId, channelNo)` - Get for specific channel
- `getModuleLevelParameters(hwSignalId)` - Get non-channel params
- `getParametersGrouped(hwSignalId)` - Organize by type
- `deleteParametersForSignal(hwSignalId)` - Remove all (for reimport)
- `getParameterStats(hwSignalId)` - Count and breakdown
- `getSummaryByImport(hwImportId)` - Statistics for entire import
- `exportAsParameterBlock(hwSignalId)` - Reconstruct CFG PARAMETER block

### 3. **moduleParameters.js** (`backend/src/routes/moduleParameters.js`)

REST API endpoints for parameter access.

```
GET  /api/hw-signals/:id/parameters
     → All parameters for a module

GET  /api/hw-signals/:id/parameters/grouped
     → Organized by type (module/channel/metadata)

GET  /api/hw-signals/:id/parameters/export-cfg
     → Export as CFG PARAMETER block

GET  /api/hw-signals/:id/parameters/channels/:channelNo
     → Parameters for specific channel

GET  /api/parameters/by-name/:paramName
     → Find parameter across all modules

GET  /api/hw-imports/:id/parameters/summary
     → Statistics for entire import
```

### 4. **Test Suite** (`backend/src/tests/moduleParameterExtractor.test.js`)

Comprehensive test demonstrating extraction from a real CFG file.

```bash
node backend/src/tests/moduleParameterExtractor.test.js
```

Output:
- Total parameters extracted
- Module breakdown
- Unique parameter names
- Sample parameters per module
- Parameter statistics

## Integration Points

### During HW Import (cfgParser.js)

When importing a CFG file:

```javascript
const ModuleParameterExtractor = require('../services/moduleParameterExtractor');
const ModuleParameterDb = require('../services/moduleParameterDb');

// After parsing modules into hw_signals...
const extractor = new ModuleParameterExtractor();
const allParams = extractor.extractAllParameters(cfgContent);

// Link to each signal by order_no matching
for (const signal of signals) {
  const moduleParams = allParams.filter(p => p.orderNo === signal.module_order_no);
  if (moduleParams.length > 0) {
    ModuleParameterDb.insertModuleParameters(signal.id, moduleParams);
  }
}
```

### During XML Export (generate.js)

When exporting to XML for re-import into PCS7:

```javascript
const params = ModuleParameterDb.getParametersGrouped(signalId);

// Use params.moduleLevel and params.channelLevel to reconstruct
// the module's parameter configuration in the generated XML/CFG
```

## Example: Extracting from Sample CFG

Input CFG block:
```
IOSUBSYSTEM 101, IOADDRESS 2, SLOT 1, "6ES7 131-6BH00-0BA0", "DI16 x 24VDC ST V1.0"
BEGIN 
  ASSET_ID "..."
  ...
  LOCAL_IN_ADDRESSES 
    ADDRESS 1, 0, 2, 0, 0, 16
  PARAMETER
    DIAGNOSTICS_WIRE_BREAK, "0"
    CHANNEL_ACTIVATED, DI , 0, "1"
    CHANNEL_ACTIVATED, DI , 1, "1"
    CHANNEL_ACTIVATED, DI , 2, "1"
    ...
    INPUT_DELAY, DI , 0, "3.2_MS"
    INPUT_DELAY, DI , 1, "3.2_MS"
  END 
END 
```

Extracted Records:
```
hw_signal_id: 123
parameter_name        | channel_no | parameter_type | parameter_value
─────────────────────────────────────────────────────────────────────
DIAGNOSTICS_WIRE_BREAK| NULL       | module         | "0"
CHANNEL_ACTIVATED     | 0          | channel        | "1"
CHANNEL_ACTIVATED     | 1          | channel        | "1"
CHANNEL_ACTIVATED     | 2          | channel        | "1"
INPUT_DELAY           | 0          | channel        | "3.2_MS"
INPUT_DELAY           | 1          | channel        | "3.2_MS"
```

## Benefits

1. **Structured Storage**: Parameters no longer embedded in text; queryable and updatable
2. **Integrity**: Foreign key relationship ensures parameters stay linked to modules
3. **Reusability**: Parameters can be viewed, exported, or applied to other modules
4. **Auditability**: Full parameter history with timestamps
5. **Flexibility**: Easy to filter, compare, or bulk-update parameters
6. **Completeness**: All module types (DI/DO/AI/AO/INFRA) supported

## Query Examples

### Get all DI channel parameters for a module
```javascript
const allParams = ModuleParameterDb.getChannelParameters(signalId, channelNo);
const diParams = allParams.filter(p => p.parameter_name === 'CHANNEL_ACTIVATED');
```

### Find all modules with a specific diagnostic setting
```javascript
const wireBreakParams = ModuleParameterDb.getParametersByName('DIAGNOSTICS_WIRE_BREAK');
wireBreakParams.forEach(p => {
  console.log(`Module ${p.module_name} at slot ${p.slot}: ${p.parameter_value}`);
});
```

### Compare parameters between modules
```javascript
const params1 = ModuleParameterDb.getParametersGrouped(signalId1);
const params2 = ModuleParameterDb.getParametersGrouped(signalId2);

// Diff them...
```

## Future Enhancements

- [ ] Parameter validation rules (e.g., INPUT_DELAY valid values)
- [ ] Parameter templates per module type
- [ ] Bulk parameter editor UI
- [ ] Parameter comparison tool
- [ ] Parameter history / audit trail
- [ ] Parameter import from Excel templates
- [ ] Parameter sync between projects
