# Instance Name Duplication Validation & Conflict Resolution

## Overview

Implement a robust validation and conflict resolution workflow for Unit Type instance generation. When creating instances from EPH/EM uploads or manual Unit Type instantiation, prevent duplicate instance names and offer users three conflict resolution strategies: Skip, Update, or Create Anyway.

## Problem Statement

**Current State:** The system throws an error if an instance name already exists (see `backend/src/services/workflowEngine.js:106`):
```javascript
if (existingSet.has(name)) throw new Error(`Instance "${name}" already exists in project — remove or rename first`);
```

**Desired Behavior:** Instead of hard-failure, detect conflicts early, present them to the user with resolution options, and execute their selections atomically.

---

## Architecture

### Phase 1: Backend Conflict Detection

**File:** `backend/src/services/instanceConflictResolver.js` (new)

```javascript
/**
 * Detects instance name conflicts and returns structured conflict data.
 * 
 * @param {Database} db
 * @param {number} projectId
 * @param {Array<{name: string, cmType: string, ...}>} incomingInstances
 * @returns {Promise<{
 *   conflicts: Array<{
 *     name: string,
 *     existingId: number,
 *     incoming: {cmType, ...},
 *     existing: {cmType, ...}
 *   }>,
 *   clean: Array<string>,  // names with no conflict
 *   summary: {total: number, conflicts: number, clean: number}
 * }>}
 */
async function detectInstanceConflicts(db, projectId, incomingInstances) {
  // Load all existing instances for the project
  const existing = await db.prepare(`
    SELECT id, instance_name, cm_type, created_at
    FROM project_instances
    WHERE project_id = ?
  `).all(projectId);
  
  const existingMap = new Map(existing.map(r => [r.instance_name, r]));
  const conflicts = [];
  const clean = [];
  
  for (const incoming of incomingInstances) {
    if (existingMap.has(incoming.name)) {
      conflicts.push({
        name: incoming.name,
        existingId: existingMap.get(incoming.name).id,
        incoming: {
          cmType: incoming.cmType,
          // other relevant fields
        },
        existing: {
          cmType: existingMap.get(incoming.name).cm_type,
          createdAt: existingMap.get(incoming.name).created_at,
          id: existingMap.get(incoming.name).id,
        },
      });
    } else {
      clean.push(incoming.name);
    }
  }
  
  return {
    conflicts,
    clean,
    summary: {
      total: incomingInstances.length,
      conflicts: conflicts.length,
      clean: clean.length,
    },
  };
}

/**
 * Applies user-selected resolutions to conflicts and creates/updates instances.
 * 
 * @param {Database} db
 * @param {number} projectId
 * @param {Array<{name: string, action: 'skip'|'update'|'create_anyway'}>} resolutions
 * @param {Array<{name: string, cmType: string, ...}>} incomingInstances
 * @returns {Promise<{
 *   created: number,
 *   updated: number,
 *   skipped: number,
 *   summary: string  // "3 created, 2 updated, 1 skipped"
 * }>}
 */
async function applyConflictResolutions(db, projectId, resolutions, incomingInstances) {
  const resolutionMap = new Map(resolutions.map(r => [r.name, r.action]));
  const stats = { created: 0, updated: 0, skipped: 0 };
  
  return await db.transaction(async () => {
    for (const incoming of incomingInstances) {
      const action = resolutionMap.get(incoming.name);
      
      if (action === 'skip') {
        stats.skipped++;
        continue;
      }
      
      if (action === 'update') {
        // UPDATE: Delete old instance and all related data, then insert new
        await db.prepare('DELETE FROM project_instances WHERE project_id = ? AND instance_name = ?')
          .run(projectId, incoming.name);
        // Insert new instance (cascading deletes handle roles, connections, etc.)
        await insertInstanceRecord(db, projectId, incoming);
        stats.updated++;
      } else if (action === 'create_anyway') {
        // CREATE_ANYWAY: Insert even if name exists (caller should have resolved duplicates in incoming)
        await insertInstanceRecord(db, projectId, incoming);
        stats.created++;
      }
    }
    
    return {
      ...stats,
      summary: `${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`,
    };
  });
}

async function insertInstanceRecord(db, projectId, instanceData) {
  // Insert into project_instances
  const result = await db.prepare(`
    INSERT INTO project_instances
    (project_id, instance_name, cm_type, sampling_time, folder_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    instanceData.name,
    instanceData.cmType,
    instanceData.samplingTime || '1000',
    instanceData.folderId || null,
    0  // sort_order updated later
  );
  
  return result.lastInsertRowid;
}
```

### Phase 2: API Endpoint for Conflict Detection

**File:** `backend/src/routes/instanceConflicts.js` (new)

```javascript
const express = require('express');
const { detectInstanceConflicts, applyConflictResolutions } = require('../services/instanceConflictResolver');
const { getDb } = require('../db');

const router = express.Router();

/**
 * POST /api/instance-conflicts/detect
 * Detects conflicts and returns structured data for modal rendering.
 * 
 * Body: {
 *   projectId: 5,
 *   instances: [
 *     { name: "U010_XV10", cmType: "CM_AO", ... },
 *     { name: "U020_XV20", cmType: "CM_DI", ... }
 *   ]
 * }
 * 
 * Response: {
 *   conflicts: [{name, existingId, incoming: {...}, existing: {...}}, ...],
 *   clean: ["U020_XV20"],
 *   summary: {total, conflicts, clean}
 * }
 */
router.post('/detect', async (req, res) => {
  try {
    const { projectId, instances } = req.body;
    if (!projectId || !Array.isArray(instances)) {
      return res.status(400).json({ error: 'projectId and instances array required' });
    }
    
    const db = getDb();
    const result = await detectInstanceConflicts(db, projectId, instances);
    res.json(result);
  } catch (err) {
    console.error('Error detecting conflicts:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/instance-conflicts/resolve
 * Applies user resolutions: skip, update, or create_anyway.
 * 
 * Body: {
 *   projectId: 5,
 *   instances: [...],  // original incoming instances
 *   resolutions: [
 *     { name: "U010_XV10", action: "update" },
 *     { name: "U020_XV20", action: "skip" },
 *     { name: "U030_XV30", action: "create_anyway" }
 *   ]
 * }
 * 
 * Response: {
 *   created: 1,
 *   updated: 1,
 *   skipped: 1,
 *   summary: "1 created, 1 updated, 1 skipped"
 * }
 */
router.post('/resolve', async (req, res) => {
  try {
    const { projectId, instances, resolutions } = req.body;
    if (!projectId || !Array.isArray(instances) || !Array.isArray(resolutions)) {
      return res.status(400).json({ error: 'projectId, instances, and resolutions arrays required' });
    }
    
    const db = getDb();
    const result = await applyConflictResolutions(db, projectId, resolutions, instances);
    res.json(result);
  } catch (err) {
    console.error('Error resolving conflicts:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

**Mount in `backend/src/server.js`:**
```javascript
app.use('/api/instance-conflicts', require('./routes/instanceConflicts'));
```

### Phase 3: Frontend Modal Component

**File:** `frontend/src/InstanceConflictModal.jsx` (new)

```jsx
import { useState, useMemo } from 'react';
import { Btn, panelSx } from './ImportUIKit.jsx';

export default function InstanceConflictModal({ conflicts, onResolve, onCancel }) {
  const [resolutions, setResolutions] = useState(() => 
    Object.fromEntries(conflicts.map(c => [c.name, null]))
  );
  
  const allResolved = useMemo(
    () => conflicts.every(c => resolutions[c.name] !== null),
    [conflicts, resolutions]
  );
  
  const handleResolution = (name, action) => {
    setResolutions(prev => ({ ...prev, [name]: action }));
  };
  
  const handleConfirm = () => {
    const resolutionArray = conflicts.map(c => ({
      name: c.name,
      action: resolutions[c.name],
    }));
    onResolve(resolutionArray);
  };
  
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        backgroundColor: 'var(--color-bg-primary)',
        borderRadius: '8px',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
        maxHeight: '80vh',
        width: '100%',
        maxWidth: '600px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '24px',
          borderBottom: '1px solid var(--color-border-tertiary)',
          flexShrink: 0,
        }}>
          <h2 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: 600 }}>
            Instance Name Conflicts
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-fg-secondary)' }}>
            {conflicts.length} instance{conflicts.length !== 1 ? 's' : ''} already exist in this project.
            Choose an action for each conflict.
          </p>
        </div>
        
        {/* Conflicts List */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px',
        }}>
          {conflicts.map(conflict => (
            <ConflictRow
              key={conflict.name}
              conflict={conflict}
              selected={resolutions[conflict.name]}
              onChange={action => handleResolution(conflict.name, action)}
            />
          ))}
        </div>
        
        {/* Footer */}
        <div style={{
          display: 'flex',
          gap: '8px',
          padding: '16px',
          borderTop: '1px solid var(--color-border-tertiary)',
          flexShrink: 0,
          justifyContent: 'flex-end',
        }}>
          <Btn onClick={onCancel} variant="secondary">
            Cancel
          </Btn>
          <Btn onClick={handleConfirm} disabled={!allResolved} variant="primary">
            Apply Resolutions
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ConflictRow({ conflict, selected, onChange }) {
  return (
    <div style={{
      padding: '12px',
      marginBottom: '8px',
      backgroundColor: 'var(--color-bg-secondary)',
      borderRadius: '6px',
      border: '1px solid var(--color-border-secondary)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-fg-primary)' }}>
            {conflict.name}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-fg-tertiary)', marginTop: '4px' }}>
            Already exists (ID #{conflict.existingId}) · Current type: <code>{conflict.existing.cmType}</code>
          </div>
        </div>
      </div>
      
      <div style={{
        display: 'flex',
        gap: '8px',
        marginTop: '12px',
        flexWrap: 'wrap',
      }}>
        {[
          { value: 'skip', label: 'Skip', title: 'Do not create or modify this instance' },
          { value: 'update', label: 'Update', title: 'Delete and recreate this instance' },
          { value: 'create_anyway', label: 'Create Anyway', title: 'Create despite the name conflict' },
        ].map(option => (
          <label key={option.value} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            cursor: 'pointer',
            userSelect: 'none',
            borderRadius: '4px',
            backgroundColor: selected === option.value ? 'var(--color-bg-selected)' : 'transparent',
            border: `1px solid ${selected === option.value ? 'var(--color-border-focus)' : 'transparent'}`,
          }} title={option.title}>
            <input
              type="radio"
              name={`conflict-${conflict.name}`}
              value={option.value}
              checked={selected === option.value}
              onChange={() => onChange(option.value)}
              style={{ cursor: 'pointer' }}
            />
            <span style={{ fontSize: '13px', fontWeight: 500 }}>
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
```

### Phase 4: Integration with StepEphEmImport

**File:** `frontend/src/StepEphEmImport.jsx` (modify)

```jsx
// At the top level state:
const [conflictData, setConflictData] = useState(null);
const [isResolvingConflicts, setIsResolvingConflicts] = useState(false);

// When promoting EPH/EM import (replace the direct promote call):
async function handlePromoteWithConflictCheck() {
  try {
    setIsPromoting(true);
    
    // 1. Get the incoming instances
    const incomingInstances = await fetchIncomingInstances(currentImportId, projectId);
    
    // 2. Detect conflicts
    const conflictResult = await fetch(`/api/instance-conflicts/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        instances: incomingInstances,
      }),
    }).then(r => r.json());
    
    if (conflictResult.conflicts.length > 0) {
      // 3. Show modal; wait for user resolution
      setConflictData(conflictResult);
      return; // Modal handler calls handleApplyResolutions
    }
    
    // 4. No conflicts, promote directly
    await promoteEphEmImport(currentImportId);
    setTab(PHASE.REVIEW);
  } catch (err) {
    showError(err.message);
  } finally {
    setIsPromoting(false);
  }
}

// Modal callback:
async function handleApplyResolutions(resolutions) {
  try {
    setIsResolvingConflicts(true);
    
    const incomingInstances = await fetchIncomingInstances(currentImportId, projectId);
    
    // 5. Apply resolutions
    const result = await fetch(`/api/instance-conflicts/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        instances: incomingInstances,
        resolutions,
      }),
    }).then(r => r.json());
    
    // 6. Close modal and show summary
    setConflictData(null);
    showSuccess(result.summary);
    
    // 7. Promote (will have no conflicts now)
    await promoteEphEmImport(currentImportId);
    setTab(PHASE.REVIEW);
  } catch (err) {
    showError(err.message);
  } finally {
    setIsResolvingConflicts(false);
  }
}

// In render:
return (
  <>
    {/* ... existing UI ... */}
    
    {conflictData && (
      <InstanceConflictModal
        conflicts={conflictData.conflicts}
        onResolve={handleApplyResolutions}
        onCancel={() => setConflictData(null)}
      />
    )}
  </>
);
```

---

## Database Impact

**No schema changes required.** All logic works with existing `project_instances` and related tables.

**Cascade behavior:** When an instance is deleted (Update action), all related data cascades:
- `unit_type_member_connections`
- `unit_type_member_roles`
- `instance_matrix_overrides`
- `instance_ios`
- etc.

Ensure the schema has proper `ON DELETE CASCADE` clauses (verify during review).

---

## Flow Diagram

```
User clicks "Promote EPH/EM Import"
  ↓
[detectInstanceConflicts] → Compares incoming names vs. existing in project
  ↓
  ├─ No conflicts? → Promote directly, show "Review" tab
  │
  └─ Conflicts? → Show InstanceConflictModal
       ↓
       User selects action per conflict (Skip / Update / Create Anyway)
       ↓
       [applyConflictResolutions] → Executes in transaction
         • Skip: do nothing
         • Update: DELETE old + INSERT new
         • Create Anyway: INSERT (may need dedup incoming names)
       ↓
       Show summary: "3 created, 2 updated, 1 skipped"
       ↓
       Promote to project
```

---

## Error Handling

1. **Duplicate names within incoming:** Before calling `/api/instance-conflicts/resolve`, deduplicate incoming instances by name (keep first occurrence). Log a warning: `"Duplicate 'U010' in upload; using first occurrence"`.

2. **Transaction failure during resolve:** Rollback all changes and show error: `"Conflict resolution failed: ..."`

3. **Instance deleted between detect and resolve:** Handle gracefully (UPDATE would succeed even if ID no longer exists; DELETE is idempotent).

---

## Testing Checklist

- [ ] Detect conflicts with 0 conflicts (clean path)
- [ ] Detect conflicts with 1 conflict
- [ ] Detect conflicts with multiple conflicts
- [ ] User selects Skip for all → no instances created
- [ ] User selects Update for one → old instance deleted, new created
- [ ] User selects Create Anyway → creates despite conflict
- [ ] Mix of Skip/Update/Create Anyway → all applied atomically
- [ ] Cancel modal → no changes, preserve state
- [ ] Network error during resolve → rollback, show error
- [ ] Duplicate names within incoming → deduplicate and warn
- [ ] UI: modal renders conflict details correctly
- [ ] UI: summary message updates correctly
- [ ] UI: buttons disabled until all conflicts resolved

---

## Summary Text Examples

- "3 created, 2 updated, 1 skipped"
- "0 created, 0 updated, 5 skipped" (all skipped)
- "5 created, 0 updated, 0 skipped" (all new)
- "0 created, 1 updated, 0 skipped" (just update)

---

## Implementation Order

1. **Backend detection service** (`instanceConflictResolver.js`)
2. **Backend API endpoint** (`instanceConflicts.js` route + server.js mount)
3. **Frontend modal** (`InstanceConflictModal.jsx`)
4. **Frontend integration** (StepEphEmImport.jsx hook + state)
5. **Testing** (unit tests + E2E)
6. **Documentation** (CLAUDE.md update)

---

## Notes

- The modal is **non-blocking** — user can cancel and retry without data loss.
- All resolutions are **atomic** — all succeed or all fail; no partial commits.
- The `summary` message is shown both in the modal and in a toast/callout after promotion.
- If future features add other instance creation points (e.g., manual "New Instance" button), reuse `instanceConflictResolver.js` for consistency.
