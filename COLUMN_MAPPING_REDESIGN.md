# Column Mapping UI Redesign - Implementation Summary

## Overview
The Column Mapping tab in the IO Import workflow has been redesigned to improve usability and auto-matching capabilities.

## Key Changes

### 1. **New Layout: Internal Fields Fixed on Left**
**Before:** Customer columns on left → Internal Field dropdown on right (confusing direction)
**After:** Internal Field (fixed) on left → Customer Column dropdown on right

This creates a natural left-to-right flow: **Internal Field (what we need) → Customer Column (what you have)**

### 2. **Auto-Column Matching on New Config**
When creating a new column mapping configuration, the system now:
- Automatically suggests column mappings using fuzzy string matching
- Uses the same similarity algorithm from the backend (`columnMapper.js`)
- Pre-populates the mappings before user edits

**Algorithm:** Dice coefficient similarity scoring
- Normalizes strings (lowercase, removes special chars)
- Compares bigrams (2-char substrings)
- Requires 60% similarity threshold for a match

**Example Matches:**
- Column `Instrument` → Internal Field `instrument_tag`
- Column `Hierarchy_Path` → Internal Field `hierarchy`
- Column `AS_Assignment` → Internal Field `assignment`
- Column `Function` → Internal Field `function_val`

### 3. **Enhanced Internal Field Display**
Each internal field now shows:
- **Field name** (e.g., `instrument_tag`)
- **Description** (e.g., "CM identity — groups IO rows into one instance")
- **Dropdown** to select the matching customer column

```
┌─────────────────────────────────────────────────────────────┐
│ INTERNAL FIELD                 │ CUSTOMER COLUMN             │
├─────────────────────────────────────────────────────────────┤
│ instrument_tag                 │ [dropdown showing columns]  │
│ CM identity — groups IO rows   │                             │
│                                │                             │
├─────────────────────────────────────────────────────────────┤
│ function_val                   │ [dropdown showing columns]  │
│ Maps to CM type for instance   │                             │
│ creation                        │                             │
└─────────────────────────────────────────────────────────────┘
```

### 4. **Unmapped Columns Indicator**
A new info box shows which customer columns haven't been mapped to any internal field:
```
Unmapped columns: Order_ID, Revision, Status
```
or
```
Unmapped columns: (all mapped)
```

## Code Changes

### File: `frontend/src/StepIOImport.jsx`

#### Constants Restructured
```javascript
// Internal fields (no empty option — all 4 fields are required)
const INTERNAL_FIELDS = ['instrument_tag', 'function_val', 'hierarchy', 'assignment'];

// Added descriptions for each field
const INTERNAL_FIELD_DESCRIPTIONS = {
  instrument_tag:  'CM identity — groups IO rows into one instance',
  function_val:    'Maps to CM type for instance creation',
  hierarchy:       'Full path (e.g., Area/Cell/Unit) — determines folder structure',
  assignment:      'AS assignment (e.g., AS01) — maps to user_project',
};
```

#### Function: `newConfig()`
- Now auto-suggests mappings using `suggestColumnMapping()` helper
- Pre-fills `draft.mappings` with fuzzy-matched columns
- Users can override suggestions before saving

#### Function: `setMapping(field, header)`
- **Changed logic:** Maps from internal field → customer column (inverted)
- Ensures each internal field maps to at most one customer column
- Prevents duplicate mappings

#### New Helper Functions
```javascript
// Fuzzy-match algorithm (client-side)
function suggestColumnMapping(columnName)
function diceSimilarity(a, b)
```

These replicate the backend's fuzzy-matching logic to provide instant feedback in the UI.

## Layout Grid Structure

```
Left Panel (220px, fixed width):
├── CONFIGS header
├── Config list (scrollable)
└── "New Config" button

Right Panel (flex):
├── Config name input
├── Description input
├── "Map Internal Fields to Columns" header
├── Mapping grid (2-column)
│   ├── Header row: "INTERNAL FIELD" | "CUSTOMER COLUMN"
│   ├── Row 1: instrument_tag + description | dropdown
│   ├── Row 2: function_val + description | dropdown
│   ├── Row 3: hierarchy + description | dropdown
│   └── Row 4: assignment + description | dropdown
├── Unmapped columns info
└── Action buttons (Apply to import, Save config)
```

## User Experience Improvements

### Before
- ✗ Confusing column-first layout (right-to-left mapping)
- ✗ Need to manually select all 4 fields
- ✗ No auto-suggestion on config creation
- ✗ Unclear what each internal field represents
- ✗ No visibility into unmapped columns

### After
- ✓ Intuitive field-first layout (left-to-right flow)
- ✓ Auto-suggested mappings based on column names
- ✓ Clear descriptions for each mandatory field
- ✓ Visual feedback on unmapped columns
- ✓ Faster mapping: 0 clicks for perfect matches, minimal overrides for partial matches

## Testing Recommendations

1. **Test Auto-Matching**
   - Upload an IO List with common column names (Hierarchy, Function, Instrument, AS)
   - Verify suggestions appear pre-filled
   - Override one and save, then re-open to confirm manual mapping persists

2. **Test Layout**
   - Verify internal fields are always visible (no horizontal scroll)
   - Check that dropdowns show all available customer columns
   - Verify unmapped columns list updates when selections change

3. **Test Edge Cases**
   - No columns selected on Upload tab → "No columns selected" message
   - Partial mappings → save and re-apply
   - Duplicate mappings → only latest selection wins

## Backwards Compatibility

- **Mapping format unchanged:** Still stores as `{ customerColumn: internalField }`
- **Existing configs:** Work as-is with new UI (will show mappings correctly)
- **Database schema:** No changes required

## Files Modified
- `frontend/src/StepIOImport.jsx` (TabColumnMap component + helper functions)

## Files NOT Modified
- Backend column mapping logic (unchanged)
- Database schema (unchanged)
- API contracts (unchanged)
