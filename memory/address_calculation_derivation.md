---
name: address-calculation-derivation
description: How channel_count, input_bytes, output_bytes, and I/O addresses are derived
metadata:
  type: reference
---

# Address and Byte Calculation Methodology

## Overview

The system derives three key metrics for hardware modules:
1. **channel_count** — number of function subslots (PA modules) or signal channels
2. **input_bytes** — process image bytes consumed from baseline CFG (DI/AI slots)
3. **output_bytes** — process image bytes consumed from baseline CFG (DO/AO slots)

These come from parsing the baseline CFG file during import, then used to allocate sequential process image addresses.

## 1. Parsing Baseline CFG (`cfgCatalogueParser.js`)

When uploading a baseline CFG file, the parser extracts module metadata from SYMBOL-line blocks.

### Input/Output Bytes Extraction

**Source:** CFG SYMBOL-line format
```
SYMBOL <SlotModule>=<ioAddress>:<slot>::(<inAddrFmt>, <outAddrFmt>, <lengthIn>, <lengthOut>)
```

**Parse Logic** (line 474-483 in `cfgCatalogueParser.js`):
```javascript
function lengthFrom(fields) {
  if (!fields) return 0;
  const parts = fields.split(',');
  return parts.length >= 3 ? (parseInt(parts[2].trim(), 10) || 0) : 0;
}

const input_bytes  = lengthFrom(inAddrFields);   // 3rd comma field from input section
const output_bytes = lengthFrom(outAddrFields);  // 3rd comma field from output section
```

**Examples:**
- `I, 0, 2` → extracts `2` bytes input
- `Q, 10, 4` → extracts `4` bytes output
- `I, 0, 0` → extracts `0` bytes (read-only module)

### Channel Count Derivation

**For Standard Modules (ET200, DIQ8, etc.):**
- `channel_count = 0` (single-channel only)

**For PA Modules (CFU_PA, META\ GSD paths):**
- `channel_count` = number of function subslots
- Parsed from CFG subslot hierarchy
- Service subslot (highest number) is excluded from count
- Example: META\ transmitter with SS 1 (function) + SS 2 (service) → `channel_count = 1`
- Example: META\ analyzer with SS 1..32 (function) + SS 33 (service) → `channel_count = 32`

Code (line 489-504):
```javascript
let channel_count = 0;
if (slotM && /^META[/\\]/i.test(order_no)) {
  const servicePos = maxSubslotByKey.get(compatKey) || 0;
  if (servicePos > 1) channel_count = servicePos - 1;
}
```

### Signal Type Derivation

From `input_bytes` and `output_bytes` alone:
- Both > 0 → `'MIXED'` (DIQ8 with DI + DO)
- Input only → `'DI'` or `'AI'` (analog if from ANALOG_BASE ≥ 512)
- Output only → `'DO'` or `'AO'`
- PA modules → refined to `'PA'` based on profile or GSD path

## 2. Address Allocation (`hwAddressEngine.js`)

Once templates are catalogued, the system allocates process image addresses sequentially when generating CFG.

### Allocation Strategy

**Four independent address spaces:**
- **digIn** — digital input (0–511, or higher if baseline used more)
- **digOut** — digital output (0–511, or higher)
- **anaIn** — analog input (512+, reserved for AI/PA)
- **anaOut** — analog output (512+, reserved for AO/PA)

**Cursor Initialization** (line 88-102):
```javascript
const ptr = {
  digIn:  baseInput  < ANALOG_BASE ? baseInput  + 1 : 0,
  digOut: baseOutput < ANALOG_BASE ? baseOutput + 1 : 0,
  anaIn:  baseInput  >= ANALOG_BASE ? baseInput  + 1 : ANALOG_BASE,
  anaOut: baseOutput >= ANALOG_BASE ? baseOutput + 1 : ANALOG_BASE,
};
```

**Sequential Allocation (no gaps):**
```
next_address = current_address + bytes_consumed
```

### Multi-Channel Expansion

**For multi-channel PA modules:**
```javascript
const funcCount = (isAnalog(tpl) && tpl.signal_type !== 'MIXED' && (tpl.channel_count || 0) > 1)
  ? tpl.channel_count : 1;
inBytes  = (tpl.input_bytes  || 0) * funcCount;
outBytes = (tpl.output_bytes || 0) * funcCount;
```

If template has `input_bytes=5` and `channel_count=32`:
- Total input allocation = 5 × 32 = 160 bytes

### Per-Subslot PA Addresses

**For GSD-referenced PA (META\ paths):**
- Each function subslot (SS 1..N) gets its own address block
- Example: 5-byte profile, 32 function subslots = 32 separate 5-byte allocations
- stored in `slot.subslotAddrs[{subslotNo, inputAddr, bytes}]`

Code (line 124-139):
```javascript
const funcCount = (tpl.channel_count || 0) > 0 ? tpl.channel_count : 1;
const ssMap = new Map((slot.subslots || []).map(ss => [ss.subslotNo, ss.paProfile]));
for (let ssNo = 1; ssNo <= funcCount; ssNo++) {
  const profile  = ssMap.get(ssNo) || slot.paProfile || null;
  const pTpl     = profile ? templateMap.get(profile) : null;
  const ssBytes  = pTpl ? (pTpl.input_bytes || PA_GSD_FALLBACK_BYTES) : PA_GSD_FALLBACK_BYTES;
  const ssAddr   = ptr.anaIn;
  ptr.anaIn += ssBytes;
}
```

## 3. Frontend Display

### Where Values Appear

**Slot Table** (`StepHWConfig.jsx:3764-3816`):
- Column "Addr IN" displays `slot.inputAddr` from allocated addresses
- Column "Addr OUT" displays `slot.outputAddr`
- Column "Signals" displays `slot.signalCount` (count of actual signal rows in hw_signals table)

**Signal Channels Grid** (separate modal):
- `GET /api/hw-config/imports/:id/stations/:addr/slots/:slot/channels`
- Returns one row per channel (0-indexed up to `channel_count`)
- For MIXED (DIQ8): first half are DI, second half are DO

### Signal Count vs Channel Count

- **channel_count** = template metadata (how many function subslots or PA channels exist)
- **signalCount** = actual signals assigned to this slot (from `hw_signals` table)
  - May be less than channel_count if not all channels are wired
  - Counted in `hwConfig.js:1290–1292`

## Summary Table

| Field | Source | Derivation |
|-------|--------|-----------|
| `input_bytes` | CFG SYMBOL-line | 3rd field of input address format |
| `output_bytes` | CFG SYMBOL-line | 3rd field of output address format |
| `channel_count` | CFG subslot tree (PA only) | Service subslot position − 1 |
| `inputAddr` | Runtime allocation | Sequential cursor + bytes consumed |
| `outputAddr` | Runtime allocation | Sequential cursor + bytes consumed |
| `signalCount` | hw_signals table | COUNT(*) WHERE slot matches |

## Related Memories
- [[io_address_calculation]] — Sequential packing strategy details
