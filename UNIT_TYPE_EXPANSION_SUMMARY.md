# Unit Type Instance Expansion - Conflict Resolution Extension

## Overview

Extended the instance name duplication validation system to also handle **Unit Type instance expansion**. This prevents duplicate instance names from being created when expanding unit types to instances.

## Problem Addressed

Previously, when expanding unit types to instances, if instance names already existed in the project, they would be created anyway, resulting in duplicate names displayed in the Instances grid with a warning banner. The system now:

1. **Detects conflicts** before expansion
2. **Shows the conflict modal** with existing instance details
3. **Allows user to resolve** each conflict (Skip/Update/Create Anyway)
4. **Applies resolutions** atomically
5. **Expands instances** after resolution

## Architecture

### Backend Services

#### `backend/src/services/unitInstanceExpander.js` (NEW)

**Functions:**

1. **`planUnitInstanceExpansion(db, projectId)`**
   - Simulates unit instance expansion WITHOUT modifying the database
   - Returns array of instances that WOULD be created
   - Shape: `[{name: string, cmType: string}, ...]`

2. **`detectUnitInstanceConflicts(db, projectId, plannedInstances)`**
   - Compares planned instances against existing project instances
   - Returns conflicts with existing instance details
   - Same return structure as EPH/EM conflict detection

3. **`expandUnitInstances(db, projectId)`**
   - Performs the actual unit instance expansion (exact logic from unitTypes.js route)
   - Creates project instances, folders, and connections
   - Should be called AFTER conflict resolutions are applied
   - Uses database transaction for atomic operations

### Backend API Routes

#### `backend/src/routes/instanceConflicts.js` (EXTENDED)

**New Endpoints:**

1. **POST `/api/instance-conflicts/unit-instances/detect`**
   - Plans unit instance expansion and detects conflicts
   - Request: `{ projectId: number }`
   - Response: `{ conflicts, clean, summary, plannedInstances }`
   - The `plannedInstances` field is included so frontend can use it for resolution

2. **POST `/api/instance-conflicts/unit-instances/expand`**
   - Applies conflict resolutions and expands unit instances
   - Request: `{ projectId, plannedInstances, resolutions }`
   - Response: `{ success, instanceCount, folderCount, resolutions }`
   - The `resolutions` sub-object contains counts (created/updated/skipped)

### Frontend API Functions

#### `frontend/src/api.js` (EXTENDED)

**New Functions:**

1. `detectUnitInstanceConflicts(projectId)` — Calls POST `/instance-conflicts/unit-instances/detect`
2. `expandUnitInstancesWithResolution(projectId, plannedInstances, resolutions)` — Calls POST `/instance-conflicts/unit-instances/expand`

### Frontend Integration

#### `frontend/src/App.jsx` (MODIFIED)

**State Added:**
- `unitInstanceConflictData` — Stores conflict detection result
- `isResolvingUnitConflicts` — Loading state during resolution

**Handler Added:**
- `onApplyUnitConflictResolutions(resolutions)` — Applies user-selected resolutions

**Modified Callback:**
- `onExpand` in StepUnitTypes component — Now detects conflicts before expanding
  - Detects conflicts → Show modal if any found
  - No conflicts → Expand directly (existing behavior)

**Modal Rendering:**
- `InstanceConflictModal` rendered conditionally when `unitInstanceConflictData` is set
- Passes `onApplyUnitConflictResolutions` handler to modal

## Workflow

### Unit Type Expansion Flow

```
User clicks "Expand" in Unit Types tab
  ↓
[planUnitInstanceExpansion] → Simulates expansion, builds instance list
  ↓
[detectUnitInstanceConflicts] → Compares against existing instances
  ↓
  ├─ No conflicts? → Proceed with expansion directly
  │
  └─ Conflicts found? → Show InstanceConflictModal
       ↓
       User selects action per conflict (Skip / Update / Create Anyway)
       ↓
       [applyConflictResolutions] → Executes resolutions atomically
         • Skip: Instance not created in expansion
         • Update: DELETE old instance + create new
         • Create Anyway: INSERT new instance (despite conflict)
       ↓
       [expandUnitInstances] → Perform actual expansion
       ↓
       Show summary: "X created, Y updated, Z skipped"
       ↓
       Reload instances → Update UI
```

## Key Design Decisions

1. **Two-Phase Approach:**
   - Phase 1: Plan/detect (no database writes)
   - Phase 2: Resolve/expand (atomic transaction)
   - Allows non-blocking UI without losing user work

2. **Conflict Resolution Reuse:**
   - Uses same `applyConflictResolutions` service from EPH/EM workflow
   - Ensures consistent behavior across different instance creation flows

3. **Atomic Expansion:**
   - Entire expand operation runs in a single database transaction
   - If anything fails, all changes roll back
   - Prevents partial or inconsistent state

4. **Modal Reuse:**
   - Same `InstanceConflictModal` component used for both EPH/EM and Unit Type workflows
   - Consistent UX across the application

## Files Modified

### New Files
- `backend/src/services/unitInstanceExpander.js` — Unit instance planning and expansion

### Modified Files
- `backend/src/routes/instanceConflicts.js` — Added two new endpoints
- `frontend/src/api.js` — Added two new API wrapper functions
- `frontend/src/App.jsx` — Added conflict detection to unit type expansion workflow

## Technical Details

### Planning Algorithm

`planUnitInstanceExpansion` mirrors the expansion logic from unitTypes.js route:

1. Load unit instances ordered by sort_order
2. For each unit instance:
   - Load unit type definition and its composite members
   - Derive instance names (base name + prefix/suffix per composite member)
   - Handle project-scope vs. unit-scope scoping rules
3. Collect all derived instance names into planned array
4. Return planned instances for conflict detection

### Conflict Detection

`detectUnitInstanceConflicts` compares planned instances:

1. Load all existing instances in the project
2. Build Map: instance_name → existing_instance_record
3. For each planned instance:
   - If name exists in map → conflict
   - Otherwise → clean
4. Return structured conflict data with existing instance details

### Expansion

`expandUnitInstances` performs the actual database operations:

1. Delete all previous expansions (by source_unit_instance_id)
2. For each unit instance, create new project instances:
   - Create folder hierarchy (cached to avoid duplicates)
   - Create project instances with proper scoping
   - Create role assignments
   - Create IO connections
   - Create member connections
3. Return counts: instanceCount, folderCount

## Testing Checklist

- [ ] Expand with 0 conflicts (clean path works)
- [ ] Expand with 1 conflict
- [ ] Expand with multiple conflicts
- [ ] User selects Skip for all → no new instances
- [ ] User selects Update → old deleted, new created
- [ ] User selects Create Anyway → created despite conflict
- [ ] Mixed resolutions → all applied atomically
- [ ] Cancel modal → no changes made
- [ ] Network error during resolution → rollback
- [ ] Modal renders correctly with existing instance details
- [ ] Summary shows correct counts
- [ ] Instances grid updates after expansion
- [ ] Modal appears on top of all other content

## Error Handling

1. **Planning errors:** Caught and displayed to user
2. **Detection errors:** Caught and displayed, modal not shown
3. **Resolution errors:** Caught, rollback, error displayed
4. **Expansion errors:** Part of resolution transaction, rolls back completely

## Future Enhancements

1. **Manual Instance Creation:** Could use same conflict detection
2. **Batch Operations:** Import multiple unit types at once with unified conflict resolution
3. **Dry-Run Mode:** Allow preview of what would be created before confirming

## Notes

- **Performance:** Planning is lightweight (no database writes), so modal appears quickly
- **Consistency:** Same conflict resolution logic works across multiple instance creation workflows
- **Atomicity:** Either all resolutions succeed or none do; never partial state
- **Compatibility:** Works with existing unit type definitions and composite structures
