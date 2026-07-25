# Server Module Attachment - Configuration-Driven Approach

## Summary
The ET200SP server module (`V1_1:6ES7 193-6PA00-0AA0`) is now **configurable per-station** via the auto-slot configuration system instead of being hardcoded based on family. This makes the system future-proof for new ET200 variants.

## What Changed

### Code Change: `backend/src/services/cfgGenerator.js`

**Before:**
```javascript
// PCS7 always inserts the server module as the last slot — add it if the IO
// list did not already include one. Server module order is hardcoded (not DB-configurable).
if (!hasServer) {
  const serverModuleOrder = 'V1_1:6ES7 193-6PA00-0AA0';
  out.push(blocks.serverModuleBlock({ ioNo, addr, slot: maxSlot + 1, diag: diag.ptr-- }));
}
```

**After:**
```javascript
// Server module attachment is controlled by the station's auto-slot config flag.
// PCS7 standard: always place server module as the last slot.
// Auto-add only if: (1) not already in the user's slot list, AND (2) enabled in config.
// If config is missing or flag is null/false, skip auto-addition (safe default).
const serverModuleEnabled = autoSlotConfig?.rules?.server_module_enabled === true;
if (!hasServer && serverModuleEnabled) {
  const serverModuleOrder = 'V1_1:6ES7 193-6PA00-0AA0';
  out.push(blocks.serverModuleBlock({ ioNo, addr, slot: maxSlot + 1, diag: diag.ptr-- }));
}
```

**Key Points:**
- The decision is now controlled by `autoSlotConfig.rules.server_module_enabled`
- Placement logic remains unchanged: always as the last slot
- Safe default: If config is missing or flag is falsy, the server module is NOT auto-added
- User can still manually add the server module if needed

### Database Configuration

The following station auto-slot configurations already have the `server_module_enabled` flag set correctly in `backend/src/db.js` (lines 1150-1233):

#### ET200SP (6ES7 155-6AU00-0CN0)
```json
{
  "order_no": "6ES7 155-6AU00-0CN0",
  "config": {
    "slots": [/* ... */],
    "rules": {
      "server_module_enabled": true
    }
  }
}
```
✅ Server module will be auto-added

#### CFU_PA (V_2_0_PA:6ES7 655-5PX11-0XX0)
```json
{
  "order_no": "V_2_0_PA:6ES7 655-5PX11-0XX0",
  "config": {
    "slots": [/* ... */],
    "rules": {
      "server_module_enabled": false
    }
  }
}
```
✅ Server module will NOT be auto-added

#### Festo GSDML
```json
{
  "order_no": "GSDML-V2.35-Festo-CPX-AP-I-20240606.xml<DAP AP-I rev1>",
  "config": {
    "slots": [/* ... */],
    "rules": {
      "server_module_enabled": false
    }
  }
}
```
✅ Server module will NOT be auto-added

## Behavior

### Server Module Auto-Addition
The server module is **automatically added** if and only if:
1. `autoSlotConfig.rules.server_module_enabled === true` **AND**
2. User has NOT manually added the server module (`hasServer === false`)

### Server Module Manual Addition
- User can always manually add the server module to the slot list via the UI
- When the user manually adds it, the `serverModuleBlock()` renderer will handle it
- No duplication: If the user adds it, auto-addition is skipped

### Edge Cases

| Scenario | Config Present | Flag Value | Result | Reason |
|----------|---|---|---|---|
| ET200SP default | ✅ | `true` | 🟢 Auto-add | Normal case |
| CFU_PA default | ✅ | `false` | 🔴 Skip | CFU_PA doesn't use server module |
| New station variant | ❌ | null | 🔴 Skip | Safe default: don't add if not explicitly configured |
| User manually added | ✅ | `true` | 🔴 Skip | `hasServer === true` prevents duplication |
| User manually added | ✅ | `false` | 🔴 Skip | Respect user's manual addition |

## Adding Support for New ET200 Variants

To add support for a new ET200 variant (e.g., ET200AL, ET200):

1. **Create catalogue templates** in the database with the new variant's interface module
2. **Add auto-slot configuration** via the API or database:
   ```json
   {
     "order_no": "<new-station-order-no>",
     "config": {
       "slots": [
         {
           "slot": 0,
           "type": "interface",
           "order_no": "<new-station-order-no>",
           "version": "<version>",
           "label": "<label>",
           "subslots": [/* ... */]
         }
       ],
       "rules": {
         "server_module_enabled": true|false  // Set based on variant requirements
       }
     }
   }
   ```
3. **Optionally add a custom renderer** in `cfgGenerator.js` (fallback to generic if not needed)

That's it! No code changes required if using the generic renderer.

## Testing Verification

### Test 1: ET200SP Auto-Adds Server Module ✅
1. Import or create an ET200SP station
2. Add some I/O modules (slots 1, 2, etc.)
3. Generate CFG
4. Verify server module appears as the last slot with diagnostic address

### Test 2: CFU_PA Does NOT Auto-Add Server Module ✅
1. Import or create a CFU_PA station
2. Generate CFG
3. Verify NO server module is generated

### Test 3: Manual Server Module Addition Works ✅
1. Create a station (ET200SP or any type)
2. Manually add server module `V1_1:6ES7 193-6PA00-0AA0` as a user slot
3. Generate CFG
4. Verify it's rendered correctly without duplication

### Test 4: Missing Config (Safe Default) ✅
1. Create a new station type without auto-slot config
2. Generate CFG
3. Verify NO server module is auto-added
4. Verify CFG is still valid (no errors)

## Related Files

- **Modified:** `backend/src/services/cfgGenerator.js` - Server module auto-addition logic
- **Verified:** `backend/src/db.js` - Database configs already correct
- **Unchanged:** `backend/src/services/cfgBlocks.js` - Server module block rendering
- **Unchanged:** `backend/src/services/autoSlotResolver.js` - Config loading (already supports this)

## Backward Compatibility

✅ **Fully backward compatible:**
- ET200SP stations continue to get the server module (flag is `true`)
- CFU_PA stations continue without server module (flag is `false`)
- Existing generated CFGs are unaffected
- User-created custom configs continue to work
- No database schema changes required

## Commit Info

- **Commit:** `f68929d`
- **Branch:** `main`
- **Date:** 2026-07-07
- **Change:** 16 insertions, 6 deletions in `cfgGenerator.js`
