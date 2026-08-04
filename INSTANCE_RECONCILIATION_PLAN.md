# Instance Reconciliation & Deduplication Plan

## Overview

This document outlines the implementation of **instance reconciliation** between Unit Types and IO lists, combined with **deduplication** to ensure only one instance per unit_name exists in any project.

### Key Principles
- **Instance Uniqueness**: One unit_name per project (global constraint)
- **Source Separation**: IO list and Unit Type instances treated as separate sources, reconciled after creation
- **User Control**: Deduplication decisions (skip/update/create) are prompted per conflict
- **Non-Breaking**: All changes additive; existing code works unchanged

---

## 1. Database Schema Changes

### 1.1 Add Column to `unit_instances`

```sql
ALTER TABLE unit_instances ADD COLUMN IF NOT EXISTS reconciliation_status 
  TEXT NOT NULL DEFAULT 'pending' 
  CHECK (reconciliation_status IN ('pending','ok','dummy','imported_only','rejected'));

CREATE INDEX IF NOT EXISTS idx_ui_reconciliation 
  ON unit_instances(project_id, reconciliation_status);
```

**Why**: Track whether instance was accepted/rejected during reconciliation phase before XML generation.

---

### 1.2 Create `unit_instance_io_mappings` Table

```sql
CREATE TABLE IF NOT EXISTS unit_instance_io_mappings (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  unit_instance_id  INTEGER NOT NULL REFERENCES unit_instances(id),
  io_tag_id         INTEGER REFERENCES io_tags(id),
  io_tag_name       TEXT,  -- snapshot of IO tag name (for rejected/unmatched cases)
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('matched','unmatched','rejected')),
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, unit_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_uiim_unit_inst 
  ON unit_instance_io_mappings(unit_instance_id);
CREATE INDEX IF NOT EXISTS idx_uiim_io_tag 
  ON unit_instance_io_mappings(io_tag_id);
```

**Why**: Links unit instances to IO tags (master source) without tight coupling. Snapshot preserves data if IO import deleted.

---

### 1.3 Add Unique Constraint (Data Validation)

```sql
-- Enforce unit_name uniqueness per project
ALTER TABLE unit_instances 
  ADD CONSTRAINT uq_unit_instances_project_name 
  UNIQUE(project_id, unit_name);
```

**Why**: Database-level enforcement prevents accidental duplicates. If a duplicate is created, the DB rejects it with a constraint violation, which the backend can catch and surface to user.

---

## 2. Backend Deduplication Service

### 2.1 Create `/backend/src/services/deduplicator.js`

**Responsibility**: Detect and prompt for deduplication decisions.

#### Function: `detectIoImportDuplicates(rows, unitNameColumn)`

```javascript
/**
 * Scan IO import rows for duplicate unit_names within the import file.
 * @param {Array} rows - Raw import rows [{ rowNum, raw_data }, ...]
 * @param {String} unitNameColumn - Column name where unit_name is stored
 * @returns {Object} 
 *   {
 *     hasDuplicates: Boolean,
 *     duplicates: {
 *       "UNIT_001": [{ rowNum: 2 }, { rowNum: 5 }],
 *       "UNIT_002": [{ rowNum: 8 }, { rowNum: 9 }, { rowNum: 15 }]
 *     }
 *   }
 */
```

**Usage**: Called after column mapping is selected but before promoting to unit_instances.

#### Function: `detectUnitTypeGenerationConflicts(db, projectId, unitNames)`

```javascript
/**
 * Check which unit_names already exist in project.
 * @param {DB} db - Database connection
 * @param {Number} projectId
 * @param {Array<String>} unitNames - Names to check
 * @returns {Object}
 *   {
 *     existing: [
 *       { unitName: "UNIT_001", instanceId: 5, unitTypeId: 2 },
 *       ...
 *     ],
 *     new: ["UNIT_003", "UNIT_004"]
 *   }
 */
```

**Usage**: Called before creating instances from Unit Type. Results fed to frontend for per-conflict prompting.

---

## 3. Backend Service: Instance Reconciler

### 3.1 Create `/backend/src/services/instanceReconciler.js`

**Responsibility**: Match unit_instances to io_tags and determine reconciliation status.

#### Function: `reconcileInstances(db, projectId, ioImportId?)`

```javascript
/**
 * Compare unit_instances against io_tags and determine status:
 * - OK: unit_name found in both
 * - DUMMY: unit_name in unit_instances but NOT in io_tags
 * - IMPORTED_ONLY: unit_name in io_tags but NOT in unit_instances
 * 
 * @returns {Object}
 *   {
 *     ok: [{ id, unitName, ioTagId, ioTagName }, ...],
 *     dummy: [{ id, unitName }, ...],
 *     importedOnly: [{ ioTagId, ioTagName }, ...],
 *     summary: { ok: 5, dummy: 3, importedOnly: 2 }
 *   }
 */
```

**Matching logic**:
- Match by `unit_name` (case-insensitive trim) from `unit_instances.unit_name` to `io_tags.raw_data['Unit']` or similar mapped column
- Store mapping in `unit_instance_io_mappings` with status='matched' or 'unmatched'

---

## 4. Backend Endpoints

### 4.1 POST `/api/unit-types/project/:projectId/check-duplicates`

**Purpose**: Check for duplicates in IO import before promoting.

```javascript
// Request
POST /api/unit-types/project/1/check-duplicates
{
  "ioImportId": 5,
  "unitNameColumn": "Unit_Name"
}

// Response
{
  "hasDuplicates": true,
  "duplicates": {
    "UNIT_001": [{ rowNum: 2 }, { rowNum: 5 }],
    "UNIT_002": [{ rowNum: 8 }, { rowNum: 9 }]
  },
  "message": "Found 2 duplicate unit names. Please resolve before proceeding."
}
```

---

### 4.2 POST `/api/unit-types/project/:projectId/resolve-io-duplicates`

**Purpose**: User confirms how to handle duplicates (keep first/last/review).

```javascript
// Request
POST /api/unit-types/project/1/resolve-io-duplicates
{
  "ioImportId": 5,
  "resolution": "keep_first",  // or "keep_last"
  "unitNameColumn": "Unit_Name"
}

// Response
{
  "removed": { "UNIT_001": [5], "UNIT_002": [9] },
  "remaining": 15,
  "message": "Removed 2 duplicate rows. Ready to proceed with mapping."
}
```

---

### 4.3 POST `/api/unit-types/project/:projectId/check-generation-conflicts`

**Purpose**: Check for conflicts before creating unit_instances from Unit Type.

```javascript
// Request
POST /api/unit-types/project/1/check-generation-conflicts
{
  "unitTypeId": 3,
  "generateCount": 5
}

// Response
{
  "hasConflicts": true,
  "existing": [
    { unitName: "UNIT_001", instanceId: 5, unitTypeId: 2 },
    { unitName: "UNIT_002", instanceId: 6, unitTypeId: 2 }
  ],
  "message": "2 unit names already exist. Please choose action for each."
}
```

---

### 4.4 POST `/api/unit-types/project/:projectId/unit-instances/create-with-resolution`

**Purpose**: Create instances from Unit Type with conflict resolution.

```javascript
// Request
POST /api/unit-types/project/1/unit-instances/create-with-resolution
{
  "unitTypeId": 3,
  "resolutions": {
    "UNIT_001": "skip",        // or "update" or "create"
    "UNIT_002": "update",
    "UNIT_003": "create"
  }
}

// Response
{
  "created": ["UNIT_003"],
  "updated": ["UNIT_002"],
  "skipped": ["UNIT_001"],
  "summary": "1 created, 1 updated, 1 skipped"
}
```

---

### 4.5 POST `/api/unit-types/project/:projectId/reconcile`

**Purpose**: Trigger reconciliation between unit_instances and io_tags.

```javascript
// Request
POST /api/unit-types/project/1/reconcile
{
  "ioImportId": 5  // optional
}

// Response
{
  "ok": 5,
  "dummy": 3,
  "importedOnly": 2,
  "summary": {
    "ok": [
      { id: 1, unitName: "UNIT_001", ioTagId: 10, ioTagName: "UNIT_001" }
    ],
    "dummy": [
      { id: 2, unitName: "UNIT_002" }
    ],
    "importedOnly": [
      { ioTagId: 15, ioTagName: "UNIT_005" }
    ]
  }
}
```

---

### 4.6 PUT `/api/unit-types/project/:projectId/unit-instances/:id/reconciliation-status`

**Purpose**: Accept or reject a Dummy instance.

```javascript
// Request
PUT /api/unit-types/project/1/unit-instances/2/reconciliation-status
{
  "status": "ok"     // or "rejected"
}

// Response
{
  "id": 2,
  "unitName": "UNIT_002",
  "reconciliationStatus": "ok",
  "updated": true
}
```

---

### 4.7 GET `/api/unit-types/project/:projectId/reconciliation-summary`

**Purpose**: Fetch current reconciliation state for all instances.

```javascript
// Response
{
  "instances": [
    { id: 1, unitName: "UNIT_001", status: "ok", ioTagName: "UNIT_001" },
    { id: 2, unitName: "UNIT_002", status: "rejected", reason: "Not in IO list" },
    { id: 3, unitName: "UNIT_003", status: "dummy", ioTagName: null }
  ],
  "counts": { ok: 1, dummy: 1, importedOnly: 2, rejected: 1 }
}
```

---

## 5. Frontend UI Flow

### 5.1 IO Import Workflow (Deduplication Added)

**Current Flow**:
1. Upload file
2. Select sheet
3. Map columns
4. Preview & map instances

**New Flow**:
1. Upload file
2. Select sheet
3. Map columns
4. **CHECK DUPLICATES** ← NEW
   - If duplicates found, show dialog:
     - "Found 3 duplicate unit names: UNIT_001 (rows 2,5), UNIT_002 (rows 8,9)"
     - Buttons: [Keep First] [Keep Last] [Review in Excel]
   - User chooses action
   - System removes duplicate rows from import
5. Preview & map instances

**Code location**: `frontend/src/StepIOImport.jsx` — add new phase after column mapping, before preview.

---

### 5.2 Unit Type Generation Workflow (Deduplication Added)

**Current Flow**:
1. Select Unit Type
2. Input name/count
3. Generate instances

**New Flow**:
1. Select Unit Type
2. Input name/count
3. **CHECK CONFLICTS** ← NEW
   - Call `check-generation-conflicts`
   - If conflicts found, show modal per conflict:
     ```
     "UNIT_001" already exists (ID #5)
     [○ Skip] [○ Update] [○ Create Anyway]
     ```
   - User selects action for each
4. Create instances with resolutions
5. Show summary: "3 created, 2 updated, 1 skipped"

**Code location**: New UI component `UnitInstanceConflictResolver.jsx`.

---

### 5.3 Reconciliation Tab (NEW)

**Location**: New tab in Unit Types panel called **"Reconciliation"**

**Three-phase workflow**:

#### Phase 1: Upload IO List
- Reuse existing StepIOImport component
- File uploaded → column mapping → deduplication check ✓
- Stores io_import_id in local state

#### Phase 2: Reconcile
- Button: "Reconcile with IO List"
- Calls `POST /reconcile` with io_import_id
- Shows grid with all instances + status badges:
  ```
  | Instance Name | Unit Type | Status   | IO Tag Name | Actions  |
  |---------------|-----------|----------|-------------|----------|
  | UNIT_001      | UT_Main   | 🟢 OK    | UNIT_001    | -        |
  | UNIT_002      | UT_Main   | 🟡 DUMMY | (none)      | ✓ Accept |
  | UNIT_003      | UT_Main   | 🟡 DUMMY | (none)      | ✗ Reject |
  | UNIT_004      | (IO only) | 🔵 IMP   | UNIT_004    | -        |
  ```

#### Phase 3: Accept/Reject Dummies
- User clicks ✓ or ✗ on each Dummy
- Updates reconciliation_status via `PUT /unit-instances/:id/reconciliation-status`
- Summary: "2 OK, 1 Accepted, 1 Rejected"

---

## 6. XML Generation Integration

### 6.1 Filter Rejected Instances

**File**: `backend/src/services/xmlGenerator.js`

**Pseudo-code**:

```javascript
async function expandInstancesToXml(db, projectId) {
  // When expanding unit_instances to project_instances for XML,
  // filter out instances with reconciliation_status = 'rejected'
  
  const instances = await db.prepare(`
    SELECT ui.* FROM unit_instances ui
    WHERE ui.project_id = ?
      AND (ui.reconciliation_status IS NULL OR ui.reconciliation_status != 'rejected')
    ORDER BY ui.sort_order, ui.id
  `).all(projectId);
  
  // Continue with normal expansion logic
}
```

**Effect**: Rejected instances are silently excluded from XML. User sees in reconciliation tab which ones were rejected, but they don't appear in generated output.

---

### 6.2 Validation Before Generation

Add a check in the generate endpoint:

```javascript
// POST /api/generate/:projectId
async function generate(req, res) {
  const db = getDb();
  const projectId = parseInt(req.params.projectId, 10);
  
  // Check for unresolved reconciliation
  const unresolved = await db.prepare(`
    SELECT COUNT(*) as count FROM unit_instances
    WHERE project_id = ? AND reconciliation_status = 'pending'
  `).get(projectId);
  
  if (unresolved.count > 0) {
    return res.status(400).json({
      error: `${unresolved.count} instances pending reconciliation. Please review and accept/reject before generating.`,
      code: 'RECONCILIATION_PENDING'
    });
  }
  
  // Proceed with generation
}
```

**Effect**: User is blocked from generating XML if there are unresolved instances. They must complete reconciliation first.

---

## 7. Implementation Sequence

### Phase 1: Database & Validation (Non-breaking)
- [ ] Add `reconciliation_status` column to `unit_instances`
- [ ] Create `unit_instance_io_mappings` table
- [ ] Add UNIQUE constraint on (project_id, unit_name)

### Phase 2: Deduplication Service
- [ ] Create `deduplicator.js` service
- [ ] Implement `detectIoImportDuplicates()`
- [ ] Implement `detectUnitTypeGenerationConflicts()`
- [ ] Add 3 deduplication endpoints

### Phase 3: Reconciliation Service
- [ ] Create `instanceReconciler.js` service
- [ ] Implement `reconcileInstances()`
- [ ] Add reconciliation endpoints (2 more)

### Phase 4: Frontend - IO Import Dedup
- [ ] Add deduplication check phase to StepIOImport
- [ ] Show duplicate dialog with keep-first/keep-last options
- [ ] Call resolve-duplicates endpoint

### Phase 5: Frontend - Unit Type Generation Dedup
- [ ] Create `UnitInstanceConflictResolver.jsx` component
- [ ] Add conflict checking to Unit Type instance creation
- [ ] Show per-conflict prompts (skip/update/create)

### Phase 6: Frontend - Reconciliation Tab
- [ ] Create reconciliation grid with status badges
- [ ] Implement accept/reject buttons for Dummy instances
- [ ] Wire up reconciliation endpoints

### Phase 7: Integration & Testing
- [ ] Update xmlGenerator to filter rejected instances
- [ ] Add validation before generation
- [ ] E2E test: upload IO → generate instances → check conflicts → create → reconcile → generate XML
- [ ] Test: IO duplicates detection and resolution
- [ ] Test: Unit Type conflicts and resolution

---

## 8. Critical Files

**Backend**:
- `backend/src/db.js` — schema migrations
- `backend/src/services/deduplicator.js` — NEW
- `backend/src/services/instanceReconciler.js` — NEW
- `backend/src/routes/unitTypes.js` — 5 new endpoints
- `backend/src/services/xmlGenerator.js` — filter rejected instances
- `backend/src/routes/io.js` — validation before promotion

**Frontend**:
- `frontend/src/StepIOImport.jsx` — add dedup phase
- `frontend/src/UnitInstanceConflictResolver.jsx` — NEW
- `frontend/src/App.jsx` — add Reconciliation tab
- `frontend/src/api.js` — 5 new API calls

---

## 9. Edge Cases & Safeguards

| Scenario | Handling |
|----------|----------|
| IO import has 10 duplicates of "UNIT_001" | User chooses keep-first → 9 rows removed → 1 remains |
| User creates instances, rejects some, then wants to recreate | Rejected instances remain in DB but filtered from XML. User can call update endpoint to change status back to 'ok' |
| IO import deleted but unit_instance still references it | io_tag_id becomes NULL, but io_tag_name snapshot preserved in mapping table |
| User generates Unit Type instances, sees conflicts, chooses "skip" | Instances not created. User can retry later with different resolution |
| Reconciliation status is "pending" and user tries to generate XML | Generation blocked with clear error message |

---

## 10. Design Principles (Pragmatic)

✓ **Minimal schema**: Single column + one mapping table
✓ **Non-breaking**: Defaults allow old code to work unchanged  
✓ **Reusable patterns**: Ag-grid + API structure follows existing imports
✓ **User control**: Every dedup/reconciliation decision is explicit
✓ **Atomic**: Transactions for batch status updates
✓ **Traceable**: Snapshots preserve data even if source deleted
✓ **Performance**: Indexed lookups on (project_id, status)

---

## 11. Success Criteria

- [x] Planning document complete
- [ ] Deduplication endpoints working
- [ ] IO import dedup phase working
- [ ] Unit Type generation conflict resolver working
- [ ] Reconciliation tab working (accept/reject)
- [ ] XML generation filters rejected instances
- [ ] E2E workflow tested end-to-end
- [ ] No duplicate unit_names in any project
