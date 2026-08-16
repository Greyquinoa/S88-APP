# Per-User-Project PCS7 Config Implementation

## Summary

Implemented per-user-project scoping for PCS7 configuration, replacing the previous per-controller scoping. Users can now upload PCS7 XML files directly to each user project (AS01, AS02, etc.) with automatic validation and warning prompts for mismatches.

## Changes Made

### Backend

#### Database Migration (`backend/src/db.js`)
- Added migration to refactor `project_config` table from `hw_controller_id` scoping to `user_project` scoping
- Idempotent migration that safely drops old constraint and creates new one
- Preserves existing data (sets user_project to NULL for orphaned configs)

#### New API Endpoints (`backend/src/routes/projects.js`)

1. **`GET /api/projects/:id/user-projects/:userProjectName/pcs7-config`**
   - Retrieves config for specific user project
   - Returns config object or null if not found

2. **`PUT /api/projects/:id/user-projects/:userProjectName/pcs7-config`**
   - Updates config for specific user project
   - Upserts via `(project_id, user_project)` unique constraint

3. **`POST /api/projects/:id/user-projects/:userProjectName/pcs7-config/parse-xml`** (Main endpoint)
   - Parses PCS7 SimaticML XML to extract 13 hardware fields
   - Returns warning if extracted `project_name` doesn't match `userProjectName`
   - Auto-saves if names match

4. **`POST /api/projects/:id/user-projects/:userProjectName/pcs7-config/save-with-warning`**
   - Used after user confirms warning modal
   - Saves config to either requested or new user project

### Frontend

#### New Component (`frontend/src/UserProjectConfigModal.jsx`)
- Modal dialog for per-user-project XML upload
- File selection with parsing and config display
- Mismatch warning with [Cancel] / [Add & Save] buttons

#### App State & Integration (`frontend/src/App.jsx`)
- Added `userProjectConfigModal` state
- Updated user projects grid with "Upload Config" button per row
- Render modal at bottom of Projects step

#### API Functions (`frontend/src/api.js`)
- `getUserProjectConfig(projectId, userProjectName)`
- `saveUserProjectConfig(projectId, userProjectName, data)`
- `parseUserProjectXml(projectId, userProjectName, file)`
- `saveUserProjectConfigWithWarning(projectId, userProjectName, config, targetUserProject)`

## User Flow

### Happy Path (No Mismatch)
1. Click upload button for AS01
2. Select PCS7 XML with `<Project Name="AS01">`
3. System auto-saves config to AS01
4. Toast confirmation

### Warning Path (Mismatch)
1. Click upload button for AS01
2. Select PCS7 XML with `<Project Name="AS03">`
3. Warning modal appears
4. Click [Add & Save] to create AS03 and save config
5. New user project added to list

## Files Modified

1. `backend/src/db.js` — Migration
2. `backend/src/routes/projects.js` — 4 new endpoints
3. `frontend/src/api.js` — 4 new functions
4. `frontend/src/App.jsx` — State, grid, modal integration
5. `frontend/src/UserProjectConfigModal.jsx` — New component

## Testing

- Upload XML to user project without mismatch → auto-saves
- Upload XML with mismatched name → shows warning
- [Cancel] in warning → discards upload
- [Add & Save] in warning → creates user project and saves
- Multiple configs per project (different user projects) work correctly
- Configs persist across reload
