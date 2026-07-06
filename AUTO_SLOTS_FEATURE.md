# Auto-Created Slot Configuration Feature

## Overview

This feature moves the hardcoded auto-created slot configuration from `cfgGenerator.js` to the database (`hw_station_auto_slots` table). Now, station families (ET200SP, CFU_PA, Scalance) have complete, configurable definitions for their auto-created slots, stored as JSON in the database.

## What Changed

### Before (Hardcoded)
- Slot 0 subslots, port orders, and PA master configuration were hardcoded constants in `cfgGenerator.js`
- Adding new station families or modifying existing ones required code changes
- Maintenance burden: changes scattered across multiple render functions

### After (Database-Driven)
- All auto-slot configurations stored in `hw_station_auto_slots` table
- Each family has a single JSON document defining:
  - Which slots auto-create (slot 0, slot 1, slot 2, etc.)
  - Subslot definitions (type, order_no, port labels)
  - Rendering rules (server module placement, etc.)
- Changes to auto-slot behavior require only database updates, not code changes
- User can configure station families without touching code

## Database Schema

### Table: `hw_station_auto_slots`
```sql
CREATE TABLE hw_station_auto_slots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  family                TEXT NOT NULL UNIQUE,
  auto_slots_config     TEXT NOT NULL,              -- JSON string
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);
```

## Configuration Structure

### Example: ET200SP Configuration
```json
{
  "family": "ET200SP",
  "slots": [
    {
      "slot": 0,
      "type": "interface",
      "is_autocreated": true,
      "use_from_station_slot": true,
      "subslots": [
        {
          "subslot": 1,
          "type": "iface",
          "is_autocreated": true
        },
        {
          "subslot": 2,
          "type": "port",
          "port_label": "Port 1 RJ45",
          "order_no": "DEFAULT:6ES7 193-6AR00-0AA0",
          "is_autocreated": true
        },
        {
          "subslot": 3,
          "type": "port",
          "port_label": "Port 2 RJ45",
          "order_no": "DEFAULT:6ES7 193-6AR00-0AA0",
          "is_autocreated": true
        }
      ]
    }
  ],
  "rules": {
    "server_module_enabled": true,
    "server_module_order": "V1_1:6ES7 193-6PA00-0AA0",
    "server_module_placement": "after_last_io"
  }
}
```

### Example: CFU_PA Configuration
```json
{
  "family": "CFU_PA",
  "slots": [
    {
      "slot": 0,
      "type": "interface",
      "is_autocreated": true,
      "order_no": "V_2_0_PA_ETER:6ES7 655-5PX11-0XX0",
      "subslots": [
        {
          "subslot": 1,
          "type": "iface",
          "is_autocreated": true
        },
        {
          "subslot": 2,
          "type": "port",
          "port_label": "Port 1 RJ45",
          "order_no": "V_2_0_PORT_1:6DL1 193-6AR00-0AA0",
          "is_autocreated": true
        },
        {
          "subslot": 3,
          "type": "port",
          "port_label": "Port 2 RJ45",
          "order_no": "V_2_0_PORT_2:6DL1 193-6AR00-0AA0",
          "is_autocreated": true
        }
      ]
    },
    {
      "slot": 2,
      "type": "pa_master",
      "is_autocreated": true,
      "subslots": [
        {
          "subslot": 1,
          "type": "pa_master_param",
          "is_autocreated": true
        },
        {
          "subslot": 2,
          "type": "pa_master_status",
          "is_autocreated": true
        }
      ]
    }
  ],
  "rules": {
    "server_module_enabled": false
  }
}
```

### Configuration Fields

**Slot-level fields:**
- `slot` (number): Slot number (0, 1, 2, etc.)
- `type` (string): Slot type (interface, pa_master, user_io, etc.)
- `is_autocreated` (boolean): Whether this slot is auto-created during CFG generation
- `use_from_station_slot` (boolean): If true, get `order_no` from `station.slots[slot]`; if false, use explicit `order_no`
- `order_no` (string): Explicit order number (e.g., "V_2_0_PA_ETER:6ES7 655-5PX11-0XX0")
- `subslots` (array): Array of subslot definitions

**Subslot-level fields:**
- `subslot` (number): Subslot number (1, 2, 3, etc.)
- `type` (string): Subslot type (iface, port, pa_master_param, pa_master_status, etc.)
- `is_autocreated` (boolean): Whether this subslot is auto-created
- `port_label` (string): Human-readable port name (e.g., "Port 1 RJ45")
- `order_no` (string): Order number for this subslot (for ports, IFACE blocks, etc.)

**Family-level rules:**
- `server_module_enabled` (boolean): Whether to auto-add server module (ET200SP only)
- `server_module_order` (string): Order number of server module (currently hardcoded per family)
- `server_module_placement` (string): Where to place server module (after_last_io, etc.)

## API Endpoints

### GET `/api/hw-config/station-auto-slots`
Returns all families and their auto-slot configurations.

**Response:**
```json
[
  {
    "family": "ET200SP",
    "config": {...},
    "created_at": "2026-07-06 10:05:02",
    "updated_at": "2026-07-06 10:05:02"
  },
  ...
]
```

### GET `/api/hw-config/station-auto-slots/:family`
Returns the auto-slot configuration for a specific family.

**Response:**
```json
{
  "family": "ET200SP",
  "config": {...},
  "created_at": "2026-07-06 10:05:02",
  "updated_at": "2026-07-06 10:05:02"
}
```

### POST `/api/hw-config/station-auto-slots`
Create or update an auto-slot configuration for a family.

**Request:**
```json
{
  "family": "ET200SP",
  "auto_slots_config": { ... }
}
```

**Response:**
```json
{
  "ok": true,
  "action": "created|updated",
  "family": "ET200SP"
}
```

### PUT `/api/hw-config/station-auto-slots/:family`
Update an auto-slot configuration (full replace).

**Request:** JSON object (the config itself)

**Response:**
```json
{
  "ok": true,
  "action": "updated",
  "family": "ET200SP"
}
```

### DELETE `/api/hw-config/station-auto-slots/:family`
Delete an auto-slot configuration for a family.

**Response:**
```json
{
  "ok": true,
  "deleted": "ET200SP"
}
```

## Implementation Details

### New Files
1. **backend/src/services/autoSlotResolver.js**
   - Utility functions for loading and resolving auto-slot configurations
   - `loadFamilyAutoSlotConfig(db, family)` — fetch config from DB
   - `buildSlotMap(config)` — build fast lookup map
   - `resolveSlotOrderNo(slotConfig, stationSlot)` — handle both `order_no` and `use_from_station_slot`

### Modified Files
1. **backend/src/db.js**
   - Added `hw_station_auto_slots` table schema
   - Seeded initial configurations for ET200SP and CFU_PA

2. **backend/src/services/cfgGenerator.js**
   - Removed hardcoded constants (`ET200SP_PORT_ORDER`, `ET200SP_SERVER_ORDER`, etc.)
   - Updated `renderEt200sp()` to load port config from database
   - Updated `renderCfuPa()` to load slot 0 order and port config from database
   - Updated `renderStation()` to load and pass auto-slot config
   - Updated `generateCfg()` to accept `db` parameter and pass to renderers

3. **backend/src/routes/hwConfig.js**
   - Added 5 new API endpoints for managing station auto-slot configurations
   - Updated CFG generation call to pass `db` parameter

## Workflow

### 1. Hardware Import & CFG Generation
When a user imports an IO list and generates a CFG:

1. App loads the baseline CFG and parses it
2. App allocates process-image addresses using `allocateAddresses()`
3. App calls `generateCfg(parsedBaseline, stations, templateMap, db)` **with DB parameter**
4. For each station:
   - Determine its family (from slot 0 template)
   - Load auto-slot config from `hw_station_auto_slots` table
   - Pass config to the appropriate renderer (renderEt200sp, renderCfuPa, etc.)
5. Renderers use config to auto-create slots and subslots in the CFG

### 2. Customizing Station Families
To add or modify auto-slot behavior:

1. Use the API endpoints to view/update configurations
2. Alternatively, directly edit the database (for admins)
3. Changes take effect immediately on the next CFG generation

### 3. Adding a New Station Family
To add support for a new station family (e.g., ET200AL):

1. Create catalogue templates for all modules (interface, IO cards, etc.)
2. Create a JSON config defining auto-created slots
3. Call `POST /api/hw-config/station-auto-slots` with the config
4. Optionally, add a custom renderer function (if the rendering logic is unique)

## Benefits

✅ **Maintainability**: Configuration changes don't require code edits  
✅ **Flexibility**: Users can customize station families without recompiling  
✅ **Scalability**: Adding new families is easier and faster  
✅ **Auditability**: All configurations stored in database, versioned with updates  
✅ **Consistency**: Single source of truth for each family's auto-slot behavior  

## Seeded Configurations

The following configurations are seeded into the database on first run:

### ET200SP
- Slot 0: Interface module (uses `use_from_station_slot: true`)
- Subslot 0.1: IFACE block
- Subslots 0.2, 0.3: RJ45 ports (order: `DEFAULT:6ES7 193-6AR00-0AA0`)
- Server module: Auto-added after last IO slot (order: `V1_1:6ES7 193-6PA00-0AA0`)

### CFU_PA
- Slot 0: Interface module (explicit order: `V_2_0_PA_ETER:6ES7 655-5PX11-0XX0`)
- Subslot 0.1: IFACE block
- Subslots 0.2, 0.3: RJ45 ports (orders: `V_2_0_PORT_1/2:6DL1 193-6AR00-0AA0`)
- Slot 2: PA Master composite (subslots 2.1 param/diag, 2.2 status/notifications)
- Server module: Disabled (not auto-added)

## Notes

- **Server module logic** is still hardcoded in code (per user request) because it's a special-case rendering rule that appears in all station families with the same behavior
- **Slot 0 order resolution**: ET200SP uses `use_from_station_slot: true` to get slot 0 from the actual import; CFU_PA uses an explicit `order_no` because the interface module is always the same variant
- **Port order numbers** are database-configurable, allowing flexibility if hardware changes or new variants are introduced
- All order numbers must exist in the `hw_module_templates` table (catalogue)

## Testing

To verify the feature works:

1. Generate a CFG for an ET200SP or CFU_PA station with IO cards
2. Confirm that slot 0 and its ports (0.2, 0.3) are rendered correctly
3. Use the API endpoints to update a configuration and regenerate — verify the change takes effect
4. Check the database: `SELECT * FROM hw_station_auto_slots` to see the stored configs

## Future Enhancements

- Add UI for managing station auto-slot configurations
- Support custom render rules (more flexible than hardcoded constants)
- Add validation for order numbers (must exist in catalogue)
- Template system for common slot/subslot patterns
