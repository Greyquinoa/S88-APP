# Hardware Catalogue Export/Import Feature

## Overview

The Hardware Catalogue Export/Import feature allows users to export all hardware configurations (module templates, slot compatibility rules, signal types, and module parameters) from one project and selectively import them into another project.

This feature mirrors the existing Library Export/Import functionality but focuses on hardware configuration rather than CM types and composites.

## Frontend Implementation (Complete)

### Files Created/Modified

1. **New: `frontend/src/CatalogueExportImport.jsx`**
   - React component for export/import UI
   - Export button downloads JSON file with all catalogue data
   - Import section accepts JSON file, shows preview with status (NEW/UPDATED/UNCHANGED/REMOVED_FROM_FILE)
   - Allows selective import via checkboxes
   - Commit button applies selected items

2. **Modified: `frontend/src/api.js`**
   - Added `downloadCatalogueExport()` - triggers download
   - Added `previewCatalogueImport(file)` - returns preview with differences
   - Added `commitCatalogueImport(token, selectedIds)` - applies selective import

3. **Modified: `frontend/src/CatalogueGrid.jsx`**
   - Added "Export/Import" button in toolbar
   - Added togglable panel showing `CatalogueExportImportPanel`
   - Panel appears above grid/family view when button is clicked

### User Experience

**Export Flow:**
1. User clicks "Export/Import" button in Catalogue tab
2. Panel appears
3. User clicks "Export Catalogue" button
4. Browser downloads `catalogue-export-YYYY-MM-DD.json` file

**Import Flow:**
1. User uploads previously exported catalogue JSON file
2. Preview shows changes grouped by category:
   - Module Templates (with # new/updated/unchanged/removed)
   - Slot Compatibility Rules
   - Signal Types
3. User can filter by status and select/deselect items
4. User clicks "Import selected (N)" to apply changes
5. Success message shows statistics
6. Page refreshes to reflect new data

## Backend Implementation Required

### Endpoint 1: Export Catalogue

```http
GET /hw-config/catalogue/export
```

**Purpose:** Aggregates all catalogue data and returns as downloadable JSON file.

**Response Headers:**
```
Content-Type: application/json
Content-Disposition: attachment; filename="catalogue-export-2026-09-02.json"
```

**Response Body:**
```json
{
  "meta": {
    "exportedAt": "2026-09-02T10:30:00Z",
    "exportedBy": "user@example.com",
    "sourceStats": {
      "templateCount": 42,
      "slotCompatCount": 15,
      "signalTypeCount": 8
    }
  },
  "templates": [
    {
      "id": 1,
      "order_no": "6ES7511-1AK02-0AB0",
      "display_name": "S7-1200 PLC",
      "family": "Siemens",
      "hw_category": "station",
      "signal_type": "MIXED",
      "channel_count": 16,
      "input_bytes": 2,
      "output_bytes": 2,
      "in_identifier": "I",
      "out_identifier": "Q",
      "default_datatype": "Bool",
      "version": null,
      "parameters": [
        {
          "parameter_name": "CYCLE_TIME",
          "parameter_value": "10",
          "channel_type": null,
          "is_module_level": true,
          "is_dynamic": false,
          "is_visible": 1
        },
        {
          "parameter_name": "TIMEOUT",
          "parameter_value": "5000",
          "spare_value": "10000",
          "channel_type": "AI",
          "is_module_level": false,
          "is_dynamic": true,
          "is_visible": 1
        }
      ]
    }
    // ... more templates
  ],
  "slotCompat": [
    {
      "slot_order_no": "6ES7511-1AK02-0AB0",
      "subslot_order_no": "6ES7135-4JF00-0AB0",
      "is_default": true
    }
    // ... more compatibility rules
  ],
  "signalTypes": [
    { "name": "DI" },
    { "name": "DO" },
    { "name": "AI" },
    { "name": "AO" },
    { "name": "PA" },
    { "name": "INFRA" },
    { "name": "MIXED" },
    { "name": "CUSTOM_TYPE" }
  ]
}
```

### Endpoint 2: Preview Catalogue Import

```http
POST /hw-config/catalogue/import/preview
Content-Type: multipart/form-data
```

**Request:**
- Form data key: `file`
- File: JSON export file from Endpoint 1

**Response:**
```json
{
  "token": "preview_token_abc123xyz",
  "meta": {
    "exportedAt": "2026-09-02T10:30:00Z",
    "sourceStats": {
      "templateCount": 42,
      "slotCompatCount": 15,
      "signalTypeCount": 8
    }
  },
  "templates": {
    "summary": {
      "new": 5,
      "updated": 3,
      "unchanged": 34,
      "removed": 0
    },
    "items": [
      {
        "id": 1,
        "order_no": "6ES7511-1AK02-0AB0",
        "display_name": "S7-1200 PLC",
        "status": "NEW",
        "details": {}
      },
      {
        "id": 2,
        "order_no": "6ES7135-4JF00-0AB0",
        "display_name": "DI Module",
        "status": "UPDATED",
        "details": {
          "old": { "channel_count": 8 },
          "new": { "channel_count": 16 }
        }
      }
      // ... more templates
    ]
  },
  "slotCompat": {
    "summary": {
      "new": 2,
      "updated": 0,
      "unchanged": 13,
      "removed": 0
    },
    "items": [
      {
        "id": "comp_1",
        "slot_order_no": "6ES7511-1AK02-0AB0",
        "slot_name": "S7-1200 PLC",
        "subslot_order_no": "6ES7135-4JF00-0AB0",
        "subslot_name": "DI Module",
        "status": "NEW"
      }
      // ... more slot compat rules
    ]
  },
  "signalTypes": {
    "summary": {
      "new": 1,
      "updated": 0,
      "unchanged": 7,
      "removed": 0
    },
    "items": [
      {
        "id": "CUSTOM_TYPE",
        "name": "CUSTOM_TYPE",
        "status": "NEW"
      }
      // ... more signal types
    ]
  }
}
```

**Logic:**
1. Parse JSON file
2. For each template: check if id exists in DB
   - If not found: status = "NEW"
   - If found and identical: status = "UNCHANGED"
   - If found and different: status = "UPDATED", include old/new values
3. For each slot compat: check if (slot_order_no, subslot_order_no) pair exists
   - Similar logic as templates
4. For each signal type: check if name exists in DB
   - Similar logic as templates
5. Generate unique token (used in Endpoint 3)
6. Return preview with all items and their statuses

### Endpoint 3: Commit Catalogue Import

```http
POST /hw-config/catalogue/import/commit
Content-Type: application/json
```

**Request:**
```json
{
  "token": "preview_token_abc123xyz",
  "selectedTemplateIds": [1, 2, 5, 7],
  "selectedSlotCompatIds": ["comp_1", "comp_3"],
  "selectedSignalTypes": ["CUSTOM_TYPE", "SPECIAL_TYPE"]
}
```

**Response:**
```json
{
  "templatesNew": 2,
  "templatesUpdated": 2,
  "templatesSkipped": 0,
  "slotCompatNew": 2,
  "slotCompatSkipped": 0,
  "signalTypesNew": 2,
  "signalTypesSkipped": 0,
  "success": true
}
```

**Logic:**
1. Validate token (should match preview token)
2. Load selected items from preview
3. For each selected template:
   - Upsert into `hw_module_templates` table
   - Delete existing module_parameters and re-insert all parameters from file
   - Validate: order_no and family should not conflict with in-use templates
4. For each selected slot compatibility:
   - Upsert into `hw_slot_compat` table
   - Both slot and subslot must exist in templates (or warn)
5. For each selected signal type:
   - Upsert into `hw_signal_types` table (or similar)
6. Return statistics and success flag

## Data Structures

### Module Template Fields
```python
{
  "id": int,
  "order_no": str,           # Unique identifier for hardware
  "display_name": str,       # User-friendly name
  "family": str,             # e.g., "Siemens", "Scalance"
  "hw_category": str,        # "station" | "slot" | "subslot"
  "signal_type": str,        # "DI" | "DO" | "AI" | "AO" | "PA" | "INFRA" | "MIXED"
  "channel_count": int,      # Number of channels
  "input_bytes": int,        # Input byte count
  "output_bytes": int,       # Output byte count
  "in_identifier": str,      # "I" | "IW" | etc
  "out_identifier": str,     # "Q" | "QW" | etc
  "default_datatype": str,   # "Bool" | "Real" | "Int" | etc
  "version": str | null,     # Optional version string
}
```

### Module Parameter Fields
```python
{
  "parameter_name": str,
  "parameter_value": str,
  "spare_value": str | null,        # Only for channel-level dynamic
  "channel_type": str | null,       # "AI", "AO", etc (null for module-level)
  "is_dynamic": bool,               # Can vary per channel
  "is_visible": int | bool,         # 1/0 or true/false
}
```

### Slot Compatibility Fields
```python
{
  "slot_order_no": str,         # Station or Slot order_no
  "subslot_order_no": str,      # Slot or Subslot order_no
  "is_default": bool,
}
```

## Error Handling

### Export Errors
- **No templates**: Return empty file (valid use case for new project)
- **Database error**: Return HTTP 500 with error message

### Preview Errors
- **Invalid JSON**: Return HTTP 400 "Invalid JSON format"
- **Missing required fields**: Return HTTP 400 with list of missing fields
- **Database read error**: Return HTTP 500

### Commit Errors
- **Invalid token**: Return HTTP 400 "Preview token expired or invalid"
- **Selected template doesn't exist in preview**: Return HTTP 400
- **Template order_no conflicts with existing in-use template**: Return HTTP 409 with conflict details
- **Slot compatibility references non-existent template**: Return HTTP 400 with warning
- **Database write error**: Return HTTP 500 (transaction rolled back)

## Security Considerations

1. **Token validation**: Preview token should be short-lived (e.g., 15 minutes) and server-side validated
2. **File size limits**: Enforce max file size (e.g., 10MB) to prevent DoS
3. **User permissions**: Consider if users need special permissions to import/export
4. **Audit logging**: Log all imports with user, timestamp, selected items
5. **Data validation**: Validate all imported data (no SQL injection, XSS, etc.)

## Integration Points

- Database tables: `hw_module_templates`, `hw_slot_compat`, `hw_signal_types`, `module_parameters`
- Existing endpoints for signal type/template CRUD should work alongside import
- No changes needed to existing catalogue functionality (backward compatible)

## Testing Scenarios

1. Export empty catalogue (no templates)
2. Export catalogue with templates, parameters, slot compat, signal types
3. Import into empty project
4. Import into project with some overlapping items (update scenario)
5. Selective import (choose subset of items)
6. Verify parameters are imported correctly (module-level and channel-level)
7. Verify slot compatibility validation (missing templates)
8. Large file import (1000+ templates)
9. Token expiration (wait 20 minutes then try commit)
10. Concurrent imports (multiple users)
