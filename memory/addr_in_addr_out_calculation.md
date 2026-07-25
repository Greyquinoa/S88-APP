---
name: addr-in-addr-out-calculation
description: Step-by-step calculation of Addr IN and Addr OUT in configuration
metadata:
  type: reference
---

# How Addr IN and Addr OUT Are Calculated

## Quick Answer

**Addr IN** and **Addr OUT** are process image byte addresses assigned sequentially to each slot.

- **Addr IN** = starting byte address for input data (consumed by the slot)
- **Addr OUT** = starting byte address for output data (produced to the slot)

They are allocated **sequentially with NO gaps** — the next slot starts immediately after the previous one ends.

## Step-by-Step Calculation

### 1. Initialize Four Address Cursors (Line 93-102)

The system maintains **four independent address spaces**:

```javascript
const ptr = {
  digIn:  baseInput  >= 0 && baseInput  < 512 ? baseInput  + 1 : 0,      // Digital input start
  digOut: baseOutput >= 0 && baseOutput < 512 ? baseOutput + 1 : 0,      // Digital output start
  anaIn:  baseInput  >= 512 ? baseInput  + 1 : 512,                      // Analog input start (512+)
  anaOut: baseOutput >= 512 ? baseOutput + 1 : 512,                      // Analog output start (512+)
};

// Align digital cursors to even boundary (PCS7 requirement)
if (ptr.digIn  % 2 !== 0) ptr.digIn++;
if (ptr.digOut % 2 !== 0) ptr.digOut++;
```

**Explanation:**
- `baseInput` / `baseOutput` = highest byte address already used in baseline CFG
- **Digital space** (0–511): for DI/DO modules
- **Analog space** (512+): for AI/AO/PA modules
- If baseline used addresses, start after them; otherwise start at 0 (digital) or 512 (analog)
- Digital must start on even boundary (PCS7 constraint)

### 2. Determine Module Byte Consumption (Line 115-158)

For each slot, calculate how many bytes it consumes:

```javascript
const tpl = findTemplate(templateMap, slot.orderNo);
let inBytes  = 0;
let outBytes = 0;
let analog   = false;
```

**Case 1: Standard Module (ET200, DIQ8, AI, AO)**
```javascript
inBytes  = (tpl.input_bytes  || 0) * funcCount;
outBytes = (tpl.output_bytes || 0) * funcCount;
analog   = isAnalog(tpl);  // true for AI/AO/PA
```

**Example:** DI module with `input_bytes=2`, single channel
- `inBytes = 2`
- `outBytes = 0`
- `analog = false`

**Case 2: Multi-Channel PA Module**
```javascript
const funcCount = tpl.channel_count || 1;  // e.g., 32 for analyzer
inBytes = tpl.input_bytes * funcCount;    // e.g., 5 × 32 = 160
```

**Case 3: GSD-Referenced PA (META\ path) — Per-Subslot Allocation**
```javascript
const funcCount = tpl.channel_count;
slot.subslotAddrs = [];
for (let ssNo = 1; ssNo <= funcCount; ssNo++) {
  const profile  = ssMap.get(ssNo) || slot.paProfile;
  const pTpl     = templateMap.get(profile);
  const ssBytes  = pTpl ? pTpl.input_bytes : PA_GSD_FALLBACK_BYTES;  // 5 bytes typically
  const ssAddr   = ptr.anaIn;              // Current position
  ptr.anaIn     += ssBytes;                // Advance for next subslot
  slot.subslotAddrs.push({ subslotNo: ssNo, inputAddr: ssAddr });
}
```

### 3. Assign Addresses from Cursors (Line 160-181)

**For Standard Slots (not per-subslot PA):**

```javascript
if (inBytes > 0) {
  const key = analog ? 'anaIn' : 'digIn';
  slot.inputAddr = ptr[key];      // ASSIGN current cursor value
  ptr[key] += inBytes;             // ADVANCE cursor for next slot
}

if (outBytes > 0) {
  const key = analog ? 'anaOut' : 'digOut';
  slot.outputAddr = ptr[key];     // ASSIGN current cursor value
  ptr[key] += outBytes;            // ADVANCE cursor for next slot
}
```

**For Per-Subslot PA:**
```javascript
slot.inputAddr  = slot.subslotAddrs[0].inputAddr;  // First subslot's address
slot.outputAddr = null;                             // PA has no output
```

## Concrete Example

### Scenario: Station 1 with 4 Slots

**Baseline CFG used:** digIn up to byte 5, digOut up to byte 3

```
Initial cursors:
  ptr.digIn  = 6 (next even = 6)
  ptr.digOut = 4 (next even = 4)
  ptr.anaIn  = 512
  ptr.anaOut = 512
```

**Slot 1: DI module (2 bytes input)**
```
inBytes = 2, outBytes = 0, analog = false
→ slot.inputAddr  = ptr.digIn = 6
→ ptr.digIn        = 6 + 2 = 8
→ slot.outputAddr  = null
```

**Slot 2: DO module (3 bytes output)**
```
inBytes = 0, outBytes = 3, analog = false
→ slot.inputAddr  = null
→ slot.outputAddr = ptr.digOut = 4
→ ptr.digOut       = 4 + 3 = 7
```

**Slot 3: AI module (2 bytes input)**
```
inBytes = 2, outBytes = 0, analog = true
→ slot.inputAddr  = ptr.anaIn = 512
→ ptr.anaIn        = 512 + 2 = 514
→ slot.outputAddr  = null
```

**Slot 4: AO module (4 bytes output)**
```
inBytes = 0, outBytes = 4, analog = true
→ slot.inputAddr  = null
→ slot.outputAddr = ptr.anaOut = 512
→ ptr.anaOut       = 512 + 4 = 516
```

### Result in UI Table

| Slot | Module   | Addr IN | Addr OUT |
|------|----------|---------|----------|
| 1    | DI (2B)  | 6       | —        |
| 2    | DO (3B)  | —       | 4        |
| 3    | AI (2B)  | 512     | —        |
| 4    | AO (4B)  | —       | 512      |

**Key Observations:**
- No gaps between slots (6→8, 4→7, 512→514, 512→516)
- Digital and analog spaces are independent
- Next station would start at digIn=8, digOut=7, anaIn=514, anaOut=516

## Address Spaces in PCS7

| Space | Range | Usage | Notes |
|-------|-------|-------|-------|
| Digital Input | 0–511 | DI modules | Even byte boundary start |
| Digital Output | 0–511 | DO modules | Even byte boundary start |
| Analog Input | 512–1023 | AI, PA modules | Starts at 512 by default |
| Analog Output | 512–1023 | AO modules | Starts at 512 by default |
| Diagnostic | ≥16000 | Error codes | Reserved, not process image |

## Key Formula

```
Next Slot's Addr = Previous Slot's Addr + Previous Slot's Bytes
```

Example chain:
```
Slot 1: inputAddr = 0, bytes = 4  → ptr = 0 + 4 = 4
Slot 2: inputAddr = 4, bytes = 2  → ptr = 4 + 2 = 6
Slot 3: inputAddr = 6, bytes = 8  → ptr = 6 + 8 = 14
```

## Special Cases

### 1. Slot 0 (Station Head/Interface Module)
- **ALWAYS skipped** — no address allocation (line 112)
- IM/ethernet heads consume no process image bytes

### 2. Read-Only Modules (Addr IN only)
- Example: Encoder input, DI module
- `outputAddr = null`

### 3. Write-Only Modules (Addr OUT only)
- Example: DO module, AO module
- `inputAddr = null`

### 4. Bidirectional Modules (Both)
- Example: MIXED (DIQ8), bidirectional PA
- Both `inputAddr` and `outputAddr` assigned

### 5. Multi-Channel PA (GSD paths)
- Each subslot gets separate address block
- Total bytes = `input_bytes_per_channel × channel_count`
- Stored in `slot.subslotAddrs[]` array
- Display shows first subslot only

## Source Code Location

**Main calculation:** [hwAddressEngine.js:88–186](file://backend/src/services/hwAddressEngine.js#L88)
- Lines 93–102: Cursor initialization
- Lines 106–183: Per-slot address assignment
- Lines 160–181: Address allocation logic

**Frontend display:** [StepHWConfig.jsx:3803–3815](file://frontend/src/StepHWConfig.jsx#L3803)
- Shows `inputAddr` and `outputAddr` in table columns

## Related Concepts

- **Sequential Packing** — No alignment padding between modules
- **Baseline Tracking** — Respects high-water marks from imported CFG
- **Signal Type** — DI/DO/AI/AO/MIXED/PA determines which cursor to use
- **Channel Count** — PA modules multiply bytes by count for multi-channel
