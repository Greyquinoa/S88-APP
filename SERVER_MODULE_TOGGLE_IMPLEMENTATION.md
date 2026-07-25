# Server Module Toggle Implementation - UI + Backend

## Overview
Implemented a **configurable UI toggle** in the Auto-Slot Configuration panel that controls server module attachment for any station type. The toggle sets the `server_module_enabled` flag in the config's `rules` section.

## What Was Implemented

### 1. Frontend - UI Toggle Component
**File:** `frontend/src/StationAutoSlotsEditor.jsx`

**Changes:**
- Added a **Server Module Configuration** section at the top of the editor
- Shows a **checkbox toggle** labeled "Auto-attach Server Module"
- Dynamic status indicator showing whether server module will be auto-added
- Toggle directly updates `config.rules.server_module_enabled`

**UI Layout:**
```
┌─────────────────────────────────────────────────────┐
│ ☑ Auto-attach Server Module                         │
│ ✓ Server module will be automatically added as the  │
│   last slot during CFG generation                   │
│─────────────────────────────────────────────────────┤
│ Slot Configuration                        [+ Add]   │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Slot │ Subslot │ Order Number │ Label │ Action │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Features:**
- Checkbox reflects current state of `config.rules.server_module_enabled`
- Status text updates in real-time as user toggles
- Styling uses CSS variables for consistency
- Compact footer message explains impact

### 2. Backend - Config-Driven Logic
**File:** `backend/src/services/cfgGenerator.js`

**Before:**
```javascript
// Server module always added to ET200SP stations
if (!hasServer) {
  const serverModuleOrder = 'V1_1:6ES7 193-6PA00-0AA0';
  out.push(blocks.serverModuleBlock({ ioNo, addr, slot: maxSlot + 1, diag: diag.ptr-- }));
}
```

**After:**
```javascript
// Check config flag before auto-adding
const serverModuleEnabled = autoSlotConfig?.rules?.server_module_enabled === true;
if (!hasServer && serverModuleEnabled) {
  const serverModuleOrder = 'V1_1:6ES7 193-6PA00-0AA0';
  out.push(blocks.serverModuleBlock({ ioNo, addr, slot: maxSlot + 1, diag: diag.ptr-- }));
}
```

**Logic:**
- Server module auto-added **only if**:
  1. User hasn't manually added it (`!hasServer`)
  2. Config flag is explicitly `true` (`autoSlotConfig?.rules?.server_module_enabled === true`)
- **Safe default**: If config missing or flag is `null`/`false`, skip auto-addition
- User can still manually add server module regardless of flag

## Database Configuration Status

All auto-slot configurations already have the `server_module_enabled` flag set:

| Station | Order No | Flag | Behavior |
|---------|----------|------|----------|
| **ET200SP** | 6ES7 155-6AU00-0CN0 | `true` | ✅ Auto-adds server module |
| **CFU_PA** | V_2_0_PA:6ES7 655-5PX11-0XX0 | `false` | ❌ No server module |
| **Festo GSDML** | GSDML-V2.35-Festo-CPX-AP-I-... | `false` | ❌ No server module |

## How It Works

### User Workflow

1. **Open Auto-Slot Editor** 
   - User navigates to Hardware Config → Auto-Slot Configuration
   - Selects a station (e.g., ET200SP)

2. **Toggle Server Module**
   - Sees "Auto-attach Server Module" toggle at top
   - Checks/unchecks to enable/disable
   - Status message updates immediately

3. **Save Configuration**
   - Click "Save" button
   - Config is sent to backend with `server_module_enabled: true/false`

4. **During CFG Generation**
   - Generator reads the flag from auto-slot config
   - If `true`: Automatically adds server module as last slot
   - If `false`: Skips auto-addition

### Adding to New Station Types

When adding support for a new ET200 variant:

1. **Create auto-slot config** (via API or database):
   ```json
   {
     "order_no": "<new-station-order-no>",
     "config": {
       "slots": [/* ... */],
       "rules": {
         "server_module_enabled": true|false
       }
     }
   }
   ```

2. **User can toggle** the flag in the UI for that station

3. **No code changes** required - generator uses the config flag

## Benefits

✅ **Family-agnostic** - Not hardcoded to ET200SP family  
✅ **User-controlled** - UI toggle gives users explicit control  
✅ **Future-proof** - New variants just set the flag  
✅ **Safe default** - Missing config doesn't accidentally add server module  
✅ **Backward compatible** - Existing behavior unchanged  
✅ **Minimal code** - Only one function modified, one UI component added  

## Technical Details

### Frontend State Management
```javascript
// Toggle updates config directly
onChange={(e) => {
  setConfig({
    ...config,
    rules: { ...config.rules, server_module_enabled: e.target.checked }
  });
}}
```

### Safe Config Access
```javascript
// Optional chaining ensures null/undefined handled gracefully
const serverModuleEnabled = autoSlotConfig?.rules?.server_module_enabled === true;
```

### Placement Logic Unchanged
- Server module always placed at `maxSlot + 1` (last slot)
- Positioning is independent of configuration flag
- Only the decision to auto-add is config-driven

## Testing Checklist

- [ ] Toggle appears in auto-slot config editor
- [ ] Toggling ON shows "✓ Server module will be..."
- [ ] Toggling OFF shows "○ Server module must be..."
- [ ] Config saves with `server_module_enabled: true`
- [ ] Config saves with `server_module_enabled: false`
- [ ] ET200SP with flag=true → server module auto-added
- [ ] CFU_PA with flag=false → no server module
- [ ] Manual server module addition works regardless of flag
- [ ] Generated CFG has server module at correct position
- [ ] Missing config → safe fallback (no auto-add)

## Files Modified

| File | Type | Changes |
|------|------|---------|
| `frontend/src/StationAutoSlotsEditor.jsx` | New | Toggle UI component for server module |
| `backend/src/services/cfgGenerator.js` | Modified | Config-driven auto-add logic |

## Commit Info

- **Commit ID:** `8a4f680`
- **Branch:** `main`
- **Changes:** Frontend UI component + Backend logic change

## Related Documentation

- `SERVER_MODULE_CONFIG_CHANGES.md` - Earlier documentation on the concept
- `AUTO_SLOTS_FEATURE.md` - Auto-slot configuration system docs
- `backend/src/db.js` - Database config seeding (lines 1150-1233)

## Future Enhancements

Possible future improvements:
- Disable toggle for station types that don't support server modules
- Add help tooltip explaining what server module does
- Allow setting default server_module_enabled per organization
- Archive old server module version configurations
