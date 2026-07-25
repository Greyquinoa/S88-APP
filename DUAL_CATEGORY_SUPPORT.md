# Dual Category Support for Module Catalogue

## Overview
Implemented support for the same module (order_no) to exist in the catalogue with **multiple different categories**. This is necessary for modules like `6ES7 155-6AU00-0CN0` that serve dual roles:

1. As a **station head** (IOSUBSYSTEM head) → category **"station"**
2. As **Slot 0** within ET200SP stations → category **"slot"**

## Problem
Previously, the `hw_module_templates` table had a UNIQUE constraint on just `order_no`, preventing the same module from appearing with different categories.

### What Users Saw
- Only one entry for `6ES7 155-6AU00-0CN0` in the catalogue
- Users couldn't select it for both station head AND slot 0 roles

## Solution

### 1. Schema Change - Composite Unique Constraint
**File:** `backend/src/db.js` (line 664)

Changed from:
```sql
order_no TEXT NOT NULL UNIQUE
```

To:
```sql
order_no TEXT NOT NULL,
...
UNIQUE (order_no, hw_category)
```

This allows:
- ✅ `6ES7 155-6AU00-0CN0` with category **"station"**
- ✅ `6ES7 155-6AU00-0CN0` with category **"slot"**
- ❌ Duplicate entries with the **same** order_no and **same** category

### 2. Migration for Existing Databases
**File:** `backend/src/db.js` (lines 847-883)

Added a migration that:
- Detects if the old UNIQUE(order_no) constraint exists
- Recreates the table with the new composite UNIQUE(order_no, hw_category) constraint
- Preserves all existing data during the migration
- Runs automatically on startup for any database with the old schema

### 3. Catalogue Entries
**File:** `backend/src/db.js` (lines 982-986)

Added two entries for `6ES7 155-6AU00-0CN0`:

```javascript
// Station head (IOSUBSYSTEM)
['6ES7 155-6AU00-0CN0', 'ET200SP IM 155-6 PN HF V4.2', 'ET200SP', 'INFRA', 0, 0, 0,
  null, null, null, 'V4.2', null, null, 'station'],

// Slot 0 within ET200SP stations
['6ES7 155-6AU00-0CN0', 'ET200SP IM 155-6 PN HF V4.2 (Slot 0)', 'ET200SP', 'INFRA', 0, 0, 0,
  null, null, null, 'V4.2', null, null, 'slot'],
```

## Database Behaviour

### Before
```
order_no (UNIQUE)    | display_name          | hw_category
─────────────────────┼───────────────────────┼──────────
6ES7 155-6AU00-0CN0  | ET200SP IM 155-6...   | station
(duplicate blocked)  | (cannot add slot)     | slot
```

### After
```
order_no | display_name                      | hw_category
─────────┼──────────────────────────────────┼──────────
6ES7 ... | ET200SP IM 155-6 PN HF V4.2      | station ✅
6ES7 ... | ET200SP IM 155-6 PN HF V4.2 (...| slot    ✅
```

## Frontend Impact

### Catalogue Panel
Users now see **two entries** for `6ES7 155-6AU00-0CN0`:
- One with category "station" (for adding new stations)
- One with category "slot" (for slot 0 configuration)

### Station Configuration
- When selecting a station head → sees version with category "station"
- When configuring Slot 0 → sees version with category "slot"

## Migration Safety

✅ **Automatic Migration**:
- Runs on first startup with old database
- Detects old UNIQUE constraint
- Recreates table with new constraint
- Preserves all data
- Idempotent (safe to run multiple times)

✅ **No Data Loss**:
- All existing module entries are preserved
- No columns are dropped
- Only the constraint definition changes

## Other Modules

This pattern can now be used for any module that needs multiple categories:
- ET200 interface modules
- CFU_PA components
- Custom variants

Example adding future modules:
```javascript
['<order-no>', '<station display name>', '<family>', 'INFRA', 0, 0, 0,
  null, null, null, '<version>', null, null, 'station'],
['<order-no>', '<slot display name>', '<family>', 'INFRA', 0, 0, 0,
  null, null, null, '<version>', null, null, 'slot'],
```

## Testing

### Database
```sql
-- Verify composite unique constraint
SELECT order_no, hw_category, COUNT(*) 
FROM hw_module_templates 
GROUP BY order_no, hw_category 
HAVING COUNT(*) > 1;

-- Should return empty (no duplicates with same order_no AND hw_category)
```

### Catalogue View
- Verify two entries appear for `6ES7 155-6AU00-0CN0`
- One with category "station"
- One with category "slot"

### Station Operations
- Add new ET200SP station
- Configure Slot 0 (should see both variants available)
- Generate CFG (should work correctly)

## Commit Info

- **Commit ID:** `8878628`
- **File Modified:** `backend/src/db.js`
- **Changes:** 
  - Schema modification (1 line)
  - Migration logic (37 lines)
  - Dual catalogue entries (4 lines)

## Related Features

- [[AUTO_SLOTS_FEATURE.md]] - Auto-slot configuration system
- [[SERVER_MODULE_TOGGLE_IMPLEMENTATION.md]] - Server module UI toggle
- Frontend catalogue filtering - `StepHWConfig.jsx` lines 3319-3328
