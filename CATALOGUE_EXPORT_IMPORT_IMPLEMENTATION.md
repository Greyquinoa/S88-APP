# Hardware Catalogue Export/Import Feature - Implementation Summary

## What Has Been Done (Frontend - Complete)

### 1. New Component: `CatalogueExportImport.jsx`
A complete React component that mirrors the Library export/import functionality:

**Features:**
- **Export Section**: Button to download all catalogue data as JSON file
- **Import Section**: Drag-and-drop or click-to-browse file upload
- **Preview UI**: Shows differences grouped by category:
  - Module Templates (station/slot/subslot with all parameters)
  - Slot Compatibility Rules
  - Signal Types
- **Status Indicators**: Color-coded badges (NEW/UPDATED/UNCHANGED/REMOVED_FROM_FILE)
- **Selective Import**: Checkboxes to choose exactly which items to import
- **Summary Cards**: Shows count of new, updated, unchanged, and removed items per category
- **Filter Controls**: Filter by status, select/deselect all in view
- **Commit Action**: "Import selected (N)" button applies changes

### 2. API Integration: `api.js`
Three new API endpoints added:

```javascript
// Triggers browser download of full catalogue export
downloadCatalogueExport()

// Parses upload file and returns preview with differences
previewCatalogueImport(file)

// Applies selective import based on user choices
commitCatalogueImport(token, selectedTemplateIds, selectedSlotCompatIds, selectedSignalTypes)
```

### 3. UI Integration: `CatalogueGrid.jsx`
- Added "Export/Import" button in the toolbar (next to "Import from .cfg")
- Toggleable panel that appears above grid/family view
- Close button to hide panel
- Auto-refresh on successful import

## What Needs to Be Done (Backend - Not Yet Implemented)

### Three Backend Endpoints Required

**1. `GET /hw-config/catalogue/export`**
- Aggregates all hardware catalogue data
- Returns JSON file with module templates, slot compatibility, signal types, and parameters
- Downloads as `catalogue-export-YYYY-MM-DD.json`

**2. `POST /hw-config/catalogue/import/preview`**
- Accepts JSON file upload
- Compares against current database state
- Returns preview showing what will be created (NEW), updated (UPDATED), unchanged (UNCHANGED), or removed (REMOVED_FROM_FILE)
- Generates temporary token for atomic commit

**3. `POST /hw-config/catalogue/import/commit`**
- Accepts token + list of selected item IDs
- Upserts selected templates, slot compatibility rules, signal types
- Updates/inserts all associated module parameters
- Returns statistics on what was imported

See `frontend/CATALOGUE_EXPORT_IMPORT_GUIDE.md` for complete API specification with request/response formats.

## User Experience Workflow

### Export
1. Open Hardware Catalogue tab
2. Click "Export/Import" button
3. Panel appears at top
4. Click "Export Catalogue"
5. File downloads as `catalogue-export-<timestamp>.json`

### Import
1. Click "Export/Import" button
2. Upload JSON file (drag-and-drop or click)
3. Preview loads showing all items with status indicators
4. Optionally filter by status (NEW, UPDATED, etc.)
5. Uncheck items you don't want to import
6. Click "Import selected (N)"
7. See success message with statistics
8. Page refreshes to show imported data

## Why This Feature Matters

**Scenario**: A team has spent weeks configuring the Hardware Catalogue at their central engineering site with:
- 50+ module templates (stations, slots, subslots)
- Detailed slot compatibility rules
- Custom signal types
- Extensive parameter configurations

**Before**: Starting a new project required manual re-entry of all this configuration.

**After**: Export in one click, import selectively in another project in seconds. Users see exactly what's NEW (will be added), UPDATED (differs from current), UNCHANGED (already same), so they can make informed choices about what to import.

## Data Exported

1. **Module Templates**
   - Order number, display name, family, category (station/slot/subslot)
   - Signal type, channel count, I/O bytes
   - SYMBOL-line identifiers (In/Out)
   - Default datatype
   - All associated module-level and channel-level parameters

2. **Slot Compatibility Rules**
   - Station → Slot assignments
   - Slot → Subslot assignments
   - Default flags

3. **Signal Types**
   - Standard types (DI, DO, AI, AO, PA, INFRA, MIXED)
   - Custom user-defined types

4. **Module Parameters**
   - Module-level parameters (same for all channels)
   - Channel-level parameters (configurable per channel)
   - Dynamic vs. static flags
   - Visibility settings

## Files Modified

```
frontend/src/
├── api.js                          (modified: added 3 endpoints)
├── CatalogueGrid.jsx               (modified: added Export/Import button and panel)
└── CatalogueExportImport.jsx       (new: main component)

frontend/
└── CATALOGUE_EXPORT_IMPORT_GUIDE.md (new: detailed backend spec)

root/
└── CATALOGUE_EXPORT_IMPORT_IMPLEMENTATION.md (this file)
```

## Architecture Notes

**Mirrors Library Feature**: The implementation follows the exact same pattern as the existing Library export/import:
- Token-based preview → commit workflow
- Status-based item filtering
- Selective import with checkboxes
- Same UI patterns (StatusBadge, SummaryCard, etc.)

**Backward Compatible**: No changes to existing catalogue functionality. Export/import is purely additive.

**Extensible**: Easy to add more item types to export/import (e.g., auto-slot configurations, custom parameters) in future.

## Next Steps for Backend Implementation

1. **Create endpoint schema**: Design database queries to aggregate templates, parameters, slot compat
2. **Implement export endpoint**: Fetch all data, serialize to JSON, return with proper headers
3. **Implement preview endpoint**: Parse JSON, compute diffs, store preview state (with TTL)
4. **Implement commit endpoint**: Validate token, upsert selected items with transaction
5. **Add error handling**: Validate inputs, handle conflicts gracefully
6. **Add audit logging**: Log all imports for compliance
7. **Test**: Export/import workflow, selective import, large files, concurrent imports

## Testing Checklist

- [ ] Export empty catalogue (no templates)
- [ ] Export full catalogue with templates, parameters, slot compat, signal types
- [ ] Import into empty project
- [ ] Import into project with overlapping items (updates)
- [ ] Selective import (choose subset)
- [ ] Parameter import (verify both module-level and channel-level)
- [ ] Slot compatibility validation (warn on missing templates)
- [ ] Large file import (1000+ templates)
- [ ] Invalid JSON error handling
- [ ] Token expiration (15+ min wait)
- [ ] Concurrent imports from multiple users
- [ ] UI: Filter by status, select all, deselect all
- [ ] UI: Progress indicator while parsing/importing
- [ ] UI: Success/error messages

## Success Criteria

✅ Users can export entire catalogue as JSON file  
✅ Users can upload exported file and see preview with status  
✅ Users can selectively choose which items to import  
✅ Users can see statistics on what was created/updated/skipped  
✅ Imported items are correctly stored with all parameters  
✅ Slot compatibility rules are validated and linked properly  
✅ Custom signal types are preserved  
✅ Feature works with large catalogues (1000+ items)  
✅ Feature is non-destructive (users control what imports)  
✅ UI is consistent with existing Library export/import  
