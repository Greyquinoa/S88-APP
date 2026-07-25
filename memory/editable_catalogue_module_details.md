---
name: editable-catalogue-module-details
description: Inline editable module details in catalogue configure panel with automatic database persistence
metadata:
  type: reference
---

# Editable Catalogue Module Details

## Overview

Module details in the Catalogue Configure panel are now **inline editable** with automatic database persistence and address recalculation on next CFG generation.

## Editable Fields

The following fields in the Module Details section are now editable:

| Field | Type | Validation | Notes |
|-------|------|-----------|-------|
| **Channels** | Number | ≥ 0 | For multi-channel PA modules |
| **Input Bytes** | Number | ≥ 0 | Process image byte count |
| **Output Bytes** | Number | ≥ 0 | Process image byte count |
| **Input Identifier** | Text | Max 4 chars, uppercase | SYMBOL-line address identifier (I, IW, etc.) |
| **Output Identifier** | Text | Max 4 chars, uppercase | SYMBOL-line address identifier (Q, QW, etc.) |

Read-only fields (unchanged):
- Order Number
- Display Name
- Family
- Signal Type
- Version

## User Interaction

### Edit Mode

Fields are always in edit mode. Changes are saved when user:
- **Presses Enter** — saves and moves focus
- **Clicks away (blur)** — saves automatically
- **Presses Escape** — cancels and reverts to last saved value

### Visual Feedback

- All fields are styled as text inputs with `#d1d5db` borders
- Numeric fields validate ≥ 0 (invalid values are not sent to database)
- Identifiers auto-uppercase and max 4 characters
- Placeholder text shows "auto" for identifier fields (inherit signal-type default)

### Database Updates

Changes are immediately persisted:
1. User edits field (onChange updates local state)
2. User blurs or presses Enter
3. `handleFieldChange()` called with field name and value
4. `onPatchTemplate(data, patch)` sends update to backend
5. Backend upserts the template in database
6. Next CFG generation uses updated values

## Implementation Details

### Frontend (CatalogueGrid.jsx)

**State management (lines 666-671):**
```javascript
const [channelCount, setChannelCount] = React.useState(data.channel_count || 0);
const [inputBytes, setInputBytes] = React.useState(data.input_bytes || 0);
const [outputBytes, setOutputBytes] = React.useState(data.output_bytes || 0);
const [inIdentifier, setInIdentifier] = React.useState(data.in_identifier || '');
const [outIdentifier, setOutIdentifier] = React.useState(data.out_identifier || '');
```

**Field change handler (lines 677-692):**
```javascript
const handleFieldChange = (field, value) => {
  const patch = {};

  // Validate numeric fields
  if (field === 'channel_count' || field === 'input_bytes' || field === 'output_bytes') {
    const numValue = parseInt(value, 10);
    if (isNaN(numValue) || numValue < 0) return;  // Ignore invalid values
    patch[field] = numValue;
  } else {
    patch[field] = value.trim().toUpperCase() || null;  // Uppercase identifiers, blank = null
  }

  // Save to database
  onPatchTemplate(data, patch);  // Spreads data + patch and calls upsertHwModuleTemplate
};
```

**Input field example (Channels, lines 793-811):**
```javascript
<input
  type="number"
  min="0"
  value={channelCount}
  onChange={e => setChannelCount(e.target.value)}
  onBlur={e => handleFieldChange('channel_count', e.target.value)}
  onKeyDown={e => {
    if (e.key === 'Enter') handleFieldChange('channel_count', e.target.value);
    if (e.key === 'Escape') setChannelCount(data.channel_count || 0);
  }}
  style={{ width: '100%', padding: '8px 8px', fontSize: '14px', ... }}
/>
```

### Backend (hwConfig.js:63-120)

The existing `/module-templates` POST endpoint handles updates:
- **If `id` provided**: Updates matching row by primary key (safe for duplicate order_no)
- **If no `id`**: Matches by (order_no, hw_category) and updates first match
- **All fields updated atomically** including identifiers with signal-type default fallback

```javascript
const inIdent  = in_identifier  !== undefined ? (in_identifier  || null) : def.in;
const outIdent = out_identifier !== undefined ? (out_identifier || null) : def.out;
```

## Affected Stations

When module details change:

| Change | Effect | Timing |
|--------|--------|--------|
| `channel_count` | PA multi-channel byte count changes | Next CFG generation |
| `input_bytes` | `Addr IN` recalculated sequentially | Next CFG generation |
| `output_bytes` | `Addr OUT` recalculated sequentially | Next CFG generation |
| `in_identifier` / `out_identifier` | SYMBOL-line identifier in CFG | Next CFG generation |

**No automatic station update** — addresses are calculated at generation time by `hwAddressEngine.js`, not when template changes. This is correct because:
- Address allocation is global and sequential (affects all stations)
- User explicitly triggers CFG generation (when they're ready)
- Generated CFG captures snapshot of all current template values

## Validation Rules

| Field | Rule | Example |
|-------|------|---------|
| Channels | Must be integer ≥ 0 | `0` (single), `32` (analyzer) |
| Input Bytes | Must be integer ≥ 0 | `0` (output-only), `2` (DI), `4` (AI) |
| Output Bytes | Must be integer ≥ 0 | `0` (input-only), `3` (DO) |
| Input Identifier | Max 4 uppercase letters | `I`, `IW`, blank (auto) |
| Output Identifier | Max 4 uppercase letters | `Q`, `QW`, blank (auto) |

## Error Handling

- **Invalid numeric value** (non-integer, negative): Silently ignored, no update sent
- **Escape pressed**: Reverts to last known value from `data`
- **Backend error**: Handled by existing error UI (toast/alert)

## Testing Checklist

- [ ] Edit channel_count, verify saved in database
- [ ] Edit input_bytes, verify saved in database
- [ ] Edit output_bytes, verify saved in database
- [ ] Edit input identifier to custom value (e.g., "IW"), verify saved
- [ ] Edit output identifier to blank, verify saves as null
- [ ] Press Escape to cancel edit, verify reverts to original
- [ ] Enter invalid number (negative), verify ignored
- [ ] Generate CFG after changes, verify new addresses reflect updated bytes
- [ ] Verify only affected station slots recalculated (global sequential packing)
- [ ] Verify identifier appears in generated CFG SYMBOL-line

## Related Code

- **Backend update endpoint:** [hwConfig.js:63–120](file://backend/src/routes/hwConfig.js#L63)
- **Frontend state & handler:** [CatalogueGrid.jsx:666–692](file://frontend/src/CatalogueGrid.jsx#L666)
- **Address generation:** [hwAddressEngine.js:88–186](file://backend/src/services/hwAddressEngine.js#L88)
- **API wrapper:** [api.js:254–256](file://frontend/src/api.js#L254)
