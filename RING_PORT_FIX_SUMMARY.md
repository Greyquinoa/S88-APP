# Ring Port 1 and Ring Port 2 Backfill Fix

## Root Cause
Ring Port values were not being extracted from the PCS 7 CFG file during the import-from-cfg operation. The database columns existed, but the parser and database INSERT statement were incomplete.

## Files Modified

### 1. backend/src/services/mrpCfgParser.js (lines 290-303)
Added extraction of ring port subslot numbers from device ports array:
```javascript
const ringPort1 = dev.ports && dev.ports.length > 0 ? dev.ports[0].subslot : null;
const ringPort2 = dev.ports && dev.ports.length > 1 ? dev.ports[1].subslot : null;

roles.push({
  ...
  ringPort1,
  ringPort2,
});
```

### 2. backend/src/routes/mrpConfig.js (lines 260-268)
Updated INSERT statement to include ring_port_1 and ring_port_2:
```javascript
const insRole = db.prepare(
  'INSERT INTO mrp_device_roles (..., ring_port_1, ring_port_2) VALUES (...,?,?)'
);
for (const r of roles) {
  insRole.run(..., r.ringPort1 ?? null, r.ringPort2 ?? null);
}
```

Added diagnostic logging to trace extraction and persistence.

## How It Works
- Ring ports are the first two port subslots from each device's ports array
- Values are extracted during CFG parsing
- Values are persisted to mrp_device_roles table
- Frontend displays and allows manual editing of these values

## Test Verification
Import a CFG with MRP-configured devices and verify:
1. Ring Port 1 and 2 columns are populated in database
2. Values match the first two port subslots in the CFG
3. Values are displayed in the MRP Device Roles UI
4. Logging shows extraction: `[MRP Import] Parsed X devices... ringPort1=..., ringPort2=...`
