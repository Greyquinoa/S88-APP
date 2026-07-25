# Fix: ET200SP Interface Module Category Correction

## Problem
The ET200SP Interface Module `6ES7 155-6AU00-0CN0` was incorrectly categorized as **"slot"** instead of **"station"** in the database, making it invisible in the station head selection dropdown.

### What Users Saw
In the Hardware Configuration catalogue, when trying to add a new station:
- ❌ `6ES7 155-6AU00-0CN0` appeared with category **"slot"** (wrong)
- ✅ `6ES7 155-6AU01-0CN0` appeared with category **"station"** (correct)

The module should appear in the station head dropdown but was hidden because it was marked as a "slot" instead of "station".

## Root Cause

The issue was a timing/ordering problem in the database initialization:

1. **Migration runs** (lines 817-845 in `db.js`):
   - Marks all existing modules with patterns like `6ES7 15%` as 'station'
   - But has a fallback rule that marks unmatched `6ES7 15%` entries as 'slot'
   - If a module was already in the DB from a prior import, it could match the fallback

2. **Seeding runs** (lines 942-943 in `db.js`):
   - Seeds `6ES7 155-6AU00-0CN0` with `hw_category = 'station'`
   - But uses `INSERT OR IGNORE` to avoid overwriting existing entries
   - If the module was already in the DB, the seeded 'station' category is NOT applied

3. **Result**:
   - Module ends up with `hw_category = 'slot'` (from import or migration)
   - Seeded 'station' category never overwrites it
   - Module is hidden from station head dropdown (which filters for `hw_category = 'station'`)

## Solution

Added a migration that fixes the hw_category retroactively:

```javascript
// Migration: 6ES7 155-6AU00-0CN0 hw_category must be 'station', not 'slot'
// (it was marked as 'slot' by the fallback migration if imported before seeding)
_db.run("UPDATE hw_module_templates SET hw_category='station' 
         WHERE order_no='6ES7 155-6AU00-0CN0' AND hw_category='slot'");
```

**File:** `backend/src/db.js` (lines 983-985)

This migration:
- ✅ Runs AFTER seeding, so it catches any 'slot' entries that weren't fixed
- ✅ Is idempotent (safe to run multiple times)
- ✅ Only updates entries where hw_category is 'slot' (doesn't touch correct ones)

## What This Fixes

After this migration runs on any database that has the issue:

1. **Catalogue View**
   - `6ES7 155-6AU00-0CN0` now shows with category **"station"** ✅

2. **Station Head Dropdown**
   - Module now appears in the dropdown when adding a new station ✅

3. **Auto-Slot Configuration**
   - Module is available for Slot 0 selection in auto-slot editor ✅

## Testing

To verify the fix:

1. **In Database**:
   ```sql
   SELECT order_no, hw_category FROM hw_module_templates 
   WHERE order_no = '6ES7 155-6AU00-0CN0';
   ```
   Should return `hw_category = 'station'`

2. **In UI - Catalogue Panel**:
   - View Hardware Config → Catalogue Tab
   - Filter by ET200SP
   - Verify `6ES7 155-6AU00-0CN0` shows with category **"station"**

3. **In UI - Add Station**:
   - Hardware Config → Stations Tab
   - Click "Add Station"
   - Click dropdown for "Interface Module"
   - Verify `6ES7 155-6AU00-0CN0` appears in list ✅

4. **In UI - Auto-Slot Editor**:
   - Auto-Slot Configuration → Select ET200SP station
   - Select Slot 0
   - Module Type dropdown
   - Verify `6ES7 155-6AU00-0CN0` appears ✅

## Affected Modules

This fix applies specifically to:
- `6ES7 155-6AU00-0CN0` — ET200SP IM 155-6 PN HF V4.2

Other station modules should not be affected since they don't have this import/seed conflict.

## Migration Safety

✅ **Safe to run**:
- Conditional: only updates if hw_category is currently 'slot'
- Idempotent: safe to run multiple times
- Non-destructive: only changes hw_category field, nothing else
- No user data affected: only module template metadata

## Commit Info

- **Commit ID:** `9d28764`
- **File Modified:** `backend/src/db.js`
- **Change:** 1 migration added (3 lines)
- **Lines:** 983-985

## Related Documentation

- `AUTO_SLOTS_FEATURE.md` — Auto-slot configuration system
- `db.js` Migration Pattern — Other similar migrations at lines 975-998
- Frontend filter logic — `StepHWConfig.jsx` lines 3319-3328
