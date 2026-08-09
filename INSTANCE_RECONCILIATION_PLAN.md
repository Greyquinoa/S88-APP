# Instance Reconciliation & Deduplication Plan

## Overview

This document outlines the implementation of **instance reconciliation** between Unit Types and IO lists, combined with **deduplication** to ensure only one instance exists in any project.

### Key Principles
- **Instance Uniqueness**: One instance per project (global constraint)
- **Source Separation**: IO list and Unit Type instances treated as separate sources, reconciled after creation
- **User Control**: Deduplication decisions (skip/update/create) are prompted per conflict
- **Non-Breaking**: All changes additive; existing code works unchanged


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
