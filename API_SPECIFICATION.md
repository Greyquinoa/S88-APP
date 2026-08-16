# Per-User-Project PCS7 Config API Specification

## Base URL
```
/api/projects/:projectId/user-projects/:userProjectName/pcs7-config
```

---

## Endpoints

### 1. GET - Retrieve Config
```
GET /api/projects/:projectId/user-projects/:userProjectName/pcs7-config
```

**Response (200 OK)**
```json
{
  "id": 1,
  "project_id": 5,
  "user_project": "AS01",
  "project_name": "AS01",
  "project_id_val": "D0001200100008000000000000000000",
  "device_name": "AS01",
  "device_id": "D00014109A00008000011200100002D0",
  "cpu_id": "D0024117E00008000010241....",
  "process_cell": "default",
  "process_cell_id": "default",
  "unit_name": "default",
  "unit_id": "default",
  "cm_folder_id": "default",
  "export_user": "admin",
  "unit_author": "Siemens",
  "updated_at": "2026-08-16T10:30:00.000Z"
}
```

**Response (204 No Content)** - Config not found for user project

---

### 2. PUT - Update Config
```
PUT /api/projects/:projectId/user-projects/:userProjectName/pcs7-config
Content-Type: application/json
```

**Request Body**
```json
{
  "project_name": "AS01",
  "project_id_val": "D0001200100008000000000000000000",
  "device_name": "AS01",
  "device_id": "D00014109A00008000011200100002D0",
  "cpu_id": "D0024117E00008000010241....",
  "process_cell": "default",
  "process_cell_id": "default",
  "unit_name": "default",
  "unit_id": "default",
  "cm_folder_id": "default",
  "export_user": "admin",
  "unit_author": "Siemens"
}
```

**Response (200 OK)** - Returns updated config object

---

### 3. POST - Parse and Save XML
```
POST /api/projects/:projectId/user-projects/:userProjectName/pcs7-config/parse-xml
Content-Type: multipart/form-data
```

**Request**
```
Form field: pcs7xml (file)
Value: PCS7 SimaticML XML file
```

**Response (200 OK) - Case A: Match (auto-saved)**
```json
{
  "config": { /* 13 config fields */ },
  "missing": [],
  "warning": false
}
```

**Response (200 OK) - Case B: Mismatch (no auto-save)**
```json
{
  "config": { /* 13 config fields */ },
  "missing": [],
  "warning": true,
  "extractedName": "AS99",
  "requestedName": "AS01"
}
```

**Response (400 Bad Request)**
```json
{
  "error": "No file uploaded (field name: pcs7xml)"
}
```

**Response (500 Internal Error)**
```json
{
  "error": "XML parse error: ..."
}
```

---

### 4. POST - Save with Warning Confirmation
```
POST /api/projects/:projectId/user-projects/:userProjectName/pcs7-config/save-with-warning
Content-Type: application/json
```

**Request Body**
```json
{
  "config": { /* 13 config fields extracted from XML */ },
  "targetUserProject": "AS99"
}
```

**Response (200 OK)**
```json
{
  "config": { /* saved config object */ },
  "success": true
}
```

---

## Field Definitions

All 13 config fields are strings (or empty strings if missing from XML):

| Field | Source in XML | Example |
|-------|---------------|---------|
| `project_name` | `<Project Name="...">` | "AS01" |
| `project_id_val` | `<Project ID="...">` | "D0001200100008000000000000000000" |
| `device_name` | `<Device Name="...">` | "AS01" |
| `device_id` | `<Device ID="...">` | "D00014109A00008000011200100002D0" |
| `cpu_id` | `<DeviceItem Type="ControllerTarget" ID="...">` | "D0024117E..." |
| `process_cell` | `<PlantHierarchyFolder Type="ProcessCell" Name="...">` | "default" |
| `process_cell_id` | `<PlantHierarchyFolder Type="ProcessCell" ID="...">` | "default" |
| `unit_name` | `<PlantHierarchyFolder Type="Unit" Name="...">` | "default" |
| `unit_id` | `<PlantHierarchyFolder Type="Unit" ID="...">` | "default" |
| `cm_folder_id` | `<PlantHierarchyFolder Name="CM" ID="...">` | "default" |
| `export_user` | `<DocumentInfo UserName="...">` | "admin" |
| `unit_author` | `<Unit><AttributeList><Author>...</Author>` | "Siemens" |

**`missing`** field in response: Array of field names that were not found in the XML
```json
["unit_id", "cm_folder_id"]
```

---

## Error Handling

### 404 Project Not Found
```json
{ "error": "Project not found" }
```

### 400 Bad Request
- No file uploaded
- Invalid XML format
- Missing required body fields (for PUT/save-with-warning)

### 500 Server Error
- XML parsing failure
- Database constraint violation
- Unexpected error

---

## Constraints & Rules

1. **Unique scoping**: Only one config per (project_id, user_project) pair
2. **Auto-save**: XML auto-saves if `project_name` == `userProjectName`
3. **Warning**: If mismatch, client must explicitly confirm via save-with-warning endpoint
4. **User project creation**: Mismatch flow can create new user project (via client, not API)
5. **Null user_project**: Supported (legacy configs from before this feature)

---

## Flow Diagrams

### Happy Path (Auto-Save)
```
POST parse-xml (userProjectName="AS01", file with project_name="AS01")
    ↓
Extract config
    ↓
Check: extracted == requested? YES
    ↓
Auto-save to (project_id, user_project="AS01")
    ↓
Return: { config, warning: false }
```

### Warning Path (Manual Confirmation)
```
POST parse-xml (userProjectName="AS01", file with project_name="AS99")
    ↓
Extract config
    ↓
Check: extracted == requested? NO
    ↓
Return: { config, warning: true, extractedName: "AS99", requestedName: "AS01" }
    ↓ Client shows warning modal
    ↓
User clicks [Add & Save]
    ↓
Client: Create new user project "AS99" (not API call)
    ↓
POST save-with-warning (config, targetUserProject="AS99")
    ↓
Save to (project_id, user_project="AS99")
    ↓
Return: { config, success: true }
```

