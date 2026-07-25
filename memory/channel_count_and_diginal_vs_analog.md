---
name: channel-count-and-digital-vs-analog
description: What happens with channel_count=0, and how DigIn vs AnaIn differentiation works
metadata:
  type: reference
---

# Channel Count = 0 and Digital vs Analog Differentiation

## Question 1: What Happens When channel_count = 0 and input_bytes = 1?

### Answer: channel_count = 0 is IGNORED for standard modules

**Code (Line 142-145):**
```javascript
const funcCount = (isAnalog(tpl) && tpl.signal_type !== 'MIXED' && (tpl.channel_count || 0) > 1)
  ? tpl.channel_count : 1;
inBytes  = (tpl.input_bytes  || 0) * funcCount;
outBytes = (tpl.output_bytes || 0) * funcCount;
```

**Explanation:**
- `funcCount = 1` if `channel_count` is 0 or ≤ 1 (applies to most modules)
- `inBytes = 1 × 1 = 1` byte

### When Does channel_count Actually Matter?

`channel_count` **ONLY affects byte calculation** for:
- **Multi-channel PA modules** where `channel_count > 1`
- AND `signal_type` is `'PA'` (not MIXED)
- AND module is analog

**Examples:**

| Scenario | channel_count | signal_type | Result |
|----------|---------------|-------------|--------|
| DI module | 0 | DI | `funcCount = 1` → inBytes × 1 |
| DO module | 0 | DO | `funcCount = 1` → outBytes × 1 |
| Single-channel PA | 1 | PA | `funcCount = 1` → inBytes × 1 |
| **Multi-channel PA analyzer** | **32** | **PA** | **`funcCount = 32` → inBytes × 32** |
| DIQ8 (MIXED) | 1 | MIXED | `funcCount = 1` (MIXED ignores count) |

### Real Example: channel_count = 0, input_bytes = 1

Module: DI input card
```
template {
  order_no: "6ES7_321...",
  signal_type: "DI",
  input_bytes: 1,
  channel_count: 0
}

Calculation:
funcCount = (isAnalog('DI') && ...) ? ... : 1
         = (false && ...) ? ... : 1
         = 1

inBytes = 1 × 1 = 1
outBytes = 0

Addr IN = ptr.digIn (starts at 0 or baseline+1)
Addr OUT = null (read-only module)
```

---

## Question 2: How Do You Differentiate DigIn from AnaIn?

### Answer: By Signal Type

The system uses the `signal_type` field from the template to decide which cursor to use.

**Code (Line 19-22):**
```javascript
function isAnalog(tpl) {
  const st = (tpl && tpl.signal_type ? String(tpl.signal_type) : '').toUpperCase();
  return st === 'AI' || st === 'AO' || st === 'PA';
}
```

**Code (Line 166-169):**
```javascript
if (inBytes > 0) {
  const key = analog ? 'anaIn' : 'digIn';
  slot.inputAddr = ptr[key];
  ptr[key] += inBytes;
}
```

### Signal Type Classification

| Signal Type | Category | Address Space | Used For |
|-------------|----------|----------------|----------|
| **DI** | Digital | 0–511 | Digital inputs (discrete 24V) |
| **DO** | Digital | 0–511 | Digital outputs (discrete 24V) |
| **MIXED** | Digital | 0–511 (both I/O) | DIQ8 cards (8 DI + 8 DO) |
| **AI** | **Analog** | **512+** | Analog inputs (4–20mA, voltage) |
| **AO** | **Analog** | **512+** | Analog outputs (4–20mA, voltage) |
| **PA** | **Analog** | **512+** | PROFIBUS PA (smart transmitters) |

### Differentiation Logic

**For Input Addresses (Line 166-169):**
```
IF signal_type IN ['AI', 'AO', 'PA']:
  USE ptr.anaIn (starts at 512)
ELSE:
  USE ptr.digIn (starts at 0)
```

**For Output Addresses (Line 174-177):**
```
IF signal_type IN ['AI', 'AO', 'PA']:
  USE ptr.anaOut (starts at 512)
ELSE:
  USE ptr.digOut (starts at 0)
```

### Concrete Examples

#### Example 1: DI Module (Digital Input)

```
Template: {
  order_no: "6ES7_321-1BL00-0AA0",
  signal_type: "DI",
  input_bytes: 2,
  channel_count: 0
}

Decision:
isAnalog('DI') = false
→ Use ptr.digIn (starts at 0)

Result:
inputAddr = 0
outputAddr = null
```

#### Example 2: AI Module (Analog Input)

```
Template: {
  order_no: "6ES7_331-7KB02-0AB0",
  signal_type: "AI",
  input_bytes: 4,
  channel_count: 0
}

Decision:
isAnalog('AI') = true
→ Use ptr.anaIn (starts at 512)

Result:
inputAddr = 512
outputAddr = null
```

#### Example 3: DIQ8 (Mixed Digital I/O)

```
Template: {
  order_no: "6ES7_321-1FF00-0AA0",
  signal_type: "MIXED",
  input_bytes: 1,
  output_bytes: 1,
  channel_count: 1
}

Decision:
isAnalog('MIXED') = false
→ Use ptr.digIn and ptr.digOut (both start at 0)

funcCount = 1 (MIXED ignores channel_count > 1 rule)
inBytes = 1, outBytes = 1

Result:
inputAddr = ptr.digIn (say 0)  → ptr.digIn becomes 1
outputAddr = ptr.digOut (say 0) → ptr.digOut becomes 1
```

#### Example 4: PA Module (PROFIBUS PA)

```
Template: {
  order_no: "META\...",
  signal_type: "PA",
  input_bytes: 5,
  channel_count: 32,  // 32 function subslots
}

Decision:
isAnalog('PA') = true
→ Use ptr.anaIn (starts at 512)

funcCount = 32 (PA with count > 1)
inBytes = 5 × 32 = 160 bytes total

Result:
inputAddr = 512 (first subslot)
per-subslot allocation:
  SS 1: 512–516
  SS 2: 517–521
  SS 3: 522–526
  ...
  SS 32: 667–671
ptr.anaIn becomes 672 (next available)
```

---

## Process Image Layout

```
DIGITAL SPACE (0–511)
┌─────────────────────────────┐
│ DI Module 1: 2 bytes        │ Addr 0–1
│ DI Module 2: 3 bytes        │ Addr 2–4
│ DO Module 1: 1 byte         │ Addr 5
│ (sequential, no gaps)       │
└─────────────────────────────┘

ANALOG SPACE (512+)
┌─────────────────────────────┐
│ AI Module 1: 4 bytes        │ Addr 512–515
│ PA Analyzer: 160 bytes      │ Addr 516–675
│ AO Module 1: 2 bytes        │ Addr 676–677
│ (sequential, no gaps)       │
└─────────────────────────────┘

DIAGNOSTIC (16000+)
┌─────────────────────────────┐
│ Error codes, status         │ Counts DOWN from 16000
└─────────────────────────────┘
```

---

## Summary Table

| Question | Answer |
|----------|--------|
| **channel_count = 0, input_bytes = 1** | `funcCount = 1` → total bytes = 1. Channel count is **ignored for standard modules**; only matters for multi-channel PA (count > 1) |
| **How to differentiate DigIn from AnaIn** | Check `signal_type` from template: if AI/AO/PA → use anaIn (512+); if DI/DO/MIXED → use digIn (0–511) |
| **What does channel_count do?** | For PA modules only: multiplies bytes × channel_count. For standard modules: ignored (treated as 1) |
| **Why separate spaces?** | PCS7 architecture: analog signals need different address range due to 16-bit representation. Keeps bit-level and word-level separate |

---

## Source Code References

- **isAnalog() decision:** [hwAddressEngine.js:19–22](file://backend/src/services/hwAddressEngine.js#L19)
- **funcCount calculation:** [hwAddressEngine.js:142–145](file://backend/src/services/hwAddressEngine.js#L142)
- **Cursor selection (DigIn vs AnaIn):** [hwAddressEngine.js:166–169](file://backend/src/services/hwAddressEngine.js#L166)
- **Signal type defaults:** [hwAddressEngine.js:36–47](file://backend/src/services/hwAddressEngine.js#L36)
