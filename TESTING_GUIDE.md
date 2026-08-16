# Testing Guide: Per-User-Project PCS7 Config

## Prerequisites

- Dev server running: `npm run dev`
- Browser at http://localhost:5173

## Test 1: Upload Config to Matching User Project

### Steps
1. Create new project: "TestProj"
2. Add user project: "AS01"
3. Click upload button (↑ icon) on AS01 row
4. Select valid PCS7 XML with `<Project Name="AS01">`
5. Modal shows parsed fields
6. Config auto-saves (no warning)
7. Toast: "Config saved for AS01"
8. Modal closes

### Verify
- Check database: `SELECT * FROM project_config WHERE user_project='AS01';`
- All 13 config fields populated

---

## Test 2: Upload Config with Mismatch (Create New User Project)

### Steps
1. Click upload button on AS01
2. Select PCS7 XML with `<Project Name="AS99">`
3. Modal shows warning: "Project with Project Name 'AS99' does not exist..."
4. Click [Add & Save]
5. Modal closes
6. New user project "AS99" appears in list
7. Toast: "Config saved for AS99"

### Verify
- User projects list now contains: AS01, AS99
- Database shows: AS99 in project_user_projects
- Config saved to user_project='AS99'

---

## Test 3: Upload Config with Mismatch (Cancel)

### Steps
1. Click upload button on AS01
2. Select PCS7 XML with `<Project Name="AS88">`
3. Warning modal appears
4. Click [Cancel]
5. Modal closes without saving

### Verify
- User projects list unchanged
- No new AS88 user project created
- Database shows no config for AS88

---

## Test 4: Multiple Configs per Project

### Steps
1. Create project with user projects: AS01, AS02
2. Upload AS01-specific XML to AS01 → saves to user_project='AS01'
3. Upload AS02-specific XML to AS02 → saves to user_project='AS02'
4. Refresh page
5. Verify both configs still exist

### Verify
- Database: Two rows in project_config, different user_project values
- Same project_id, different user_project, different configs

---

## Test 5: Re-upload to Same User Project (Update)

### Steps
1. Upload config to AS01 with values (device_id="DEV123")
2. Upload different XML to same AS01 with values (device_id="DEV456")

### Verify
- Config updates (ON CONFLICT ... DO UPDATE SET)
- Database shows only one row for AS01 (not duplicate)
- device_id is now "DEV456"

---

## Manual API Testing (curl)

### Parse and auto-save (matching name)
```bash
curl -X POST http://localhost:3001/api/projects/1/user-projects/AS01/pcs7-config/parse-xml \
  -F pcs7xml=@test.xml
```

Expected response: `{ "config": {...}, "warning": false, ... }`

### Parse with mismatch
```bash
curl -X POST http://localhost:3001/api/projects/1/user-projects/AS01/pcs7-config/parse-xml \
  -F pcs7xml=@different_project.xml
```

Expected response: `{ "config": {...}, "warning": true, "extractedName": "AS99", "requestedName": "AS01" }`

### Confirm and save with different target
```bash
curl -X POST http://localhost:3001/api/projects/1/user-projects/AS01/pcs7-config/save-with-warning \
  -H "Content-Type: application/json" \
  -d '{
    "config": { "project_name": "AS99", ... },
    "targetUserProject": "AS99"
  }'
```

---

## Edge Cases to Test

- [ ] Empty XML file → error message displayed
- [ ] Invalid XML → parsing error shown
- [ ] Very large XML → no timeout/hang
- [ ] Special characters in project name → URL encoding works
- [ ] Two users uploading simultaneously → no race condition
- [ ] Upload to user project that doesn't exist (create new) → works
- [ ] Reload page with unsaved upload → modal state cleared

---

## Database Verification

### Check migration ran
```sql
SELECT * FROM information_schema.columns 
WHERE table_name='project_config' AND column_name='user_project';
```
Should return 1 row (user_project column exists)

### Check unique constraint
```sql
SELECT constraint_name FROM information_schema.table_constraints 
WHERE table_name='project_config' AND constraint_type='UNIQUE';
```
Should show constraint on (project_id, user_project)

### Check data scoping
```sql
SELECT project_id, user_project, project_name, device_id 
FROM project_config 
WHERE project_id=1;
```
Should show multiple rows if multiple user projects have configs

