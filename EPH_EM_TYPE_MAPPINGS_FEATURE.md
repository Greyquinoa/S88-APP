# EPH/EM Type Mappings Feature

## Overview

Added a **Type Mappings configuration tab** at the start of the EPH/EM Import workflow. Users can create and manage mappings from Excel type columns to composite CM types.

## User Flow

1. **EPH/EM Import** step opens with **Type Mappings** tab (first phase)
2. User can:
   - **Create new mapping config** (e.g., "Physical Model Config")
   - **Add type mappings** in the form: `Excel_Column` → `Composite_Type`
     - Example: `EM_DNS` → `COMPOSITE_EM_DNS`
     - Example: `EM_UPS` → `COMPOSITE_EM_UPS`
   - **Edit existing configs**
   - **Delete unused configs**
3. Click **"Next: Upload File"** to proceed with import
4. During Function Mapping phase → user selects which saved config to apply

## Architecture

### Database
- New table: `eph_em_type_mapping_configs`
  - `id` (PK)
  - `name` (unique)
  - `mappings` (JSON: `{"EM_DNS": "COMPOSITE_EM_DNS", ...}`)
  - `created_at`, `updated_at`

### Backend Routes
```
GET    /api/eph-em/type-mapping-configs       → List all configs
POST   /api/eph-em/type-mapping-configs       → Create new
PATCH  /api/eph-em/type-mapping-configs/:id   → Update
DELETE /api/eph-em/type-mapping-configs/:id   → Delete
```

### Frontend
- New phase: `PHASE.TYPE_MAPPINGS` (first in workflow)
- UI allows:
  - Creating/editing inline (forms appear when editing)
  - Viewing saved configs with mapping details
  - Quick edit/delete buttons per config
  - Add/remove individual mappings dynamically

## Files Modified

**Backend:**
- `backend/src/db.js` — Added `eph_em_type_mapping_configs` table
- `backend/src/routes/ephEmImport.js` — Added CRUD routes

**Frontend:**
- `frontend/src/StepEphEmImport.jsx` — Added TYPE_MAPPINGS phase + UI
- `frontend/src/api.js` — Added API functions for config CRUD

## Next Steps

1. User creates mapping config (e.g., "Physical Model Config")
2. Adds mappings: `EM_DNS` → `COMPOSITE_EM_DNS`, `EM_UPS` → `COMPOSITE_EM_UPS`
3. Saves config
4. Proceeds to upload file
5. During Function Mapping phase, the saved config provides the composite type names to select from

## Example Workflow

**Step 1: Type Mappings Tab**
```
+ New Config
Config Name: Physical Model Config
Mappings:
  EM_DNS → COMPOSITE_EM_DNS
  EM_UPS → COMPOSITE_EM_UPS
[Save Config]
```

**Step 2-5: Normal Import Flow**
- Upload Excel with Unit_Name + EM_DNS + EM_UPS columns
- Select unit column
- Function Mapping phase shows dropdown with pre-defined composite types from the config
- Review rows and promote
