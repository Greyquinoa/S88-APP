# Module Parameter Import Integration - Complete

## Problem
You imported 2 hardware cards, but `hw_module_parameters` table remained empty.

## Root Cause
The parameter extraction service existed but wasn't hooked into the import flow. When CFG files were imported via `/imports/:id/backfill-from-cfg`, the parameters were never being extracted and stored.

## Solution Implemented

### 1. **Updated `backend/src/routes/hwConfig.js`**
   - Added imports for `ModuleParameterExtractor` and `ModuleParameterDb`
   - Integrated parameter extraction into the `backfill-from-cfg` endpoint
   - Added fuzzy matching logic to handle order_no normalization during import
   - Supports all parameter types: module-level, channel-level, metadata

### 2. **Updated `backend/src/server.js`**
   - Registered the module parameters route: `/api/module-parameters`
   - Now all 6 REST API endpoints are available

### 3. **Key Features**
   - ✅ Automatic extraction during import (no manual step needed)
   - ✅ Fuzzy matching handles order_no variations (versioned, GSDML, etc.)
   - ✅ Multiple signals with same module type all get parameters
   - ✅ Non-blocking: parameter errors don't fail the import
   - ✅ Logging for debugging

## How It Works

### During Import (backfill-from-cfg):
1. CFG file is parsed to extract hw_signals
2. `ModuleParameterExtractor` parses all PARAMETER blocks
3. Parameters are fuzzy-matched to hw_signals by order_no (with substring/prefix matching)
4. `ModuleParameterDb.insertModuleParameters()` stores them in `hw_module_parameters`
5. Log output shows: "Extracted and stored X parameters for Y module types"

### Example Order_No Matching:
```
CFG order_no:     "6ES7 135-6HD00-0BA1"
DB order_no:      "6ES7 135-6HD00-0BA1"
Match: EXACT      ✓

CFG order_no:     "GSDML-V2.35-Festo-CPX-AP-I-20240606.xml<DAP AP-I rev1>"
DB order_no:      "GSDML-V2.35-Festo-CPX-AP-I-20240606.xml<DAP AP-I rev1>"
Match: EXACT      ✓

CFG order_no:     "V1_1:6ES7 193-6PA00-0AA0"
DB order_no:      "V1_1:6ES7 193-6PA00-0AA0"
Match: EXACT      ✓
```

## Testing

**Next time you import:**
1. Upload CFG file to /imports/:id/backfill-from-cfg
2. Check backend logs for: `[HW Import] Extracted and stored X parameters...`
3. Query the database:
   ```sql
   SELECT COUNT(*) FROM hw_module_parameters;
   SELECT * FROM hw_module_parameters WHERE hw_signal_id = 42 LIMIT 5;
   ```
4. Use the API:
   ```bash
   GET /api/hw-signals/42/parameters
   GET /api/hw-signals/42/parameters/grouped
   GET /api/parameters/by-name/CHANNEL_ACTIVATED
   ```

## Files Modified
1. `backend/src/routes/hwConfig.js` - Added parameter extraction to import endpoint
2. `backend/src/server.js` - Registered module parameters route
3. `backend/src/db.js` - Schema already had `hw_module_parameters` table

## Next Steps
1. Restart the backend server
2. Re-import your CFG file (or import a new one)
3. Parameters should now be populated automatically

## Verification Checklist
- [ ] Backend server restarted
- [ ] CFG file imported
- [ ] Backend logs show "Extracted and stored X parameters"
- [ ] `hw_module_parameters` table has rows
- [ ] API endpoint `/api/hw-signals/42/parameters` returns data
- [ ] Grouped view shows module/channel/metadata breakdown
