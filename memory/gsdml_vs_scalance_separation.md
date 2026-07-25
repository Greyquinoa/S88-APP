---
name: gsdml-vs-scalance-separation
description: Complete separation of GSDML devices from Scalance network switches
metadata:
  type: reference
---

# GSDML vs Scalance Separation

## Overview

Previously, all GSDML-path devices were treated as Scalance network switches. Now they are completely separated:

- **Scalance** = network switches only (family: 'Scalance' or 'SCALANCE')
- **GSDML** = I/O devices (transmitters, valves, analyzers, etc.) with configurable slots

## Key Differences

| Feature | Scalance | GSDML |
|---------|----------|-------|
| **Family** | `'Scalance'` or `'SCALANCE'` | `stationFamily` contains `/^GSDML/i` pattern |
| **Table Type** | Scalance-only (5 columns: Module, Order Number, I Address, Q Address, Diagnostic) | Standard I/O table (like CFU_PA) |
| **PIP Column** | ❌ NOT shown | ✅ Shown for all slots |
| **Pot. Group** | ❌ NOT shown | ❌ NOT shown (only for ET200) |
| **Addr IN/OUT** | ❌ All "—" (networked) | ✅ Calculated like CFU_PA |
| **Slot 0 Subslots** | ✅ Shown as port rows | ✅ Shown if in auto-slot config |
| **I/O Module Subslots** | N/A (ports only) | ❌ NOT shown (unlike CFU_PA) |
| **Signals Column** | ❌ NOT shown | ✅ Shown |

## Implementation Details

### Station Type Detection

**Before (conflated):**
```javascript
const isGsdmlOrderNo = /^GSDML-.*\.xml<DAP/.test(orderNo);
const isScalanceStation = isGsdmlOrderNo || family === 'Scalance';
```

**After (separated):**
```javascript
const stationFamily = imTpl ? imTpl.family : null;

// GSDML devices: family contains "GSDML" pattern
const isGsdmlStation = stationFamily && /^GSDML/i.test(stationFamily);

// Scalance ONLY: family is explicitly 'Scalance' or 'SCALANCE'
const isScalanceStation = stationFamily === 'Scalance' || stationFamily === 'SCALANCE';
```

### Rendering Logic

**Scalance (line 3627):**
```javascript
{isScalanceStation && (
  <div>... Scalance table with ports only ...</div>
)}
```

**GSDML + ET200 + CFU_PA (line 3732):**
```javascript
{!isScalanceStation && (
  <div>... Standard I/O table with slots and modules ...</div>
)}
```

### Subslot Rendering

**Slot 0 (IM) Subslots - Shown for all non-Scalance devices:**
```javascript
if (slot && slot.slot === 0 && imPorts.length > 0) {
  // Show PN-IO interface subslots
}
```

**I/O Module PA Subslots - ONLY for CFU_PA:**
```javascript
// CFU_PA PA device slots (≥3): append function subslot rows
// GSDML devices do NOT have PA function subslots on I/O modules (unlike CFU_PA)
if (!isPaDevSlot || slot === null || isGsdmlStation) return [mainRow];
```

## Template Family Patterns

When importing GSDML devices, ensure `family` field is set to match the device type:

| Device Type | Family Value | Example |
|-------------|--------------|---------|
| Festo CPX (transmitter) | `'GSDML'` or `'Festo'` | `GSDML` |
| Festo valve | `'GSDML'` | `GSDML` |
| Festo analyzer | `'GSDML'` | `GSDML` |
| Siemens analyzer | `'GSDML'` | `GSDML` |
| Scalance network switch | `'Scalance'` | `Scalance` |

**Rule:** Only use `'Scalance'` or `'SCALANCE'` for actual network switches. All other GSDML devices should have `family` set to the actual device identifier (e.g., `'GSDML'`, `'Festo'`, etc.).

## Address Calculation

### GSDML Devices

Like **CFU_PA** and **ET200**:
- Process image addresses allocated sequentially
- Digital space (0–511) for DI/DO modules
- Analog space (512+) for AI/AO modules
- `Addr IN` / `Addr OUT` calculated via hwAddressEngine

### Scalance Devices

All addresses display as "—":
- Scalance runs on separate PROFIBUS PA network
- No process image byte allocation
- Addresses managed by PROFIBUS network, not PCS7 process image

## Configuration Requirements

When adding a new GSDML device (transmitter, valve, analyzer):

1. **Import baseline CFG** containing the device
2. **Ensure template `family`** is NOT `'Scalance'`
3. **Allocate slots** with I/O modules (DI/DO/AI/AO)
4. **PIP selector** appears automatically for all slots
5. **Addr IN/OUT** calculated from module byte counts
6. **Pot. Group** will NOT appear (only for ET200)

## Backward Compatibility

Existing Festo/transmitter/analyzer stations will display correctly:
- If `family` is `'Scalance'`: shown in Scalance table (old behavior)
- If `family` is anything else (including GSDML paths): shown in standard I/O table (new behavior)
- Can re-import affected stations to correct family field if needed

## Related Memories
- [[addr_in_addr_out_calculation]] — Address allocation for I/O devices
- [[channel_count_and_diginal_vs_analog]] — Digital vs Analog space
