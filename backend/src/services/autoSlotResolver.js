// services/autoSlotResolver.js — Resolve auto-created slot configurations per station family
'use strict';

/**
 * Load the auto-slot configuration for a given station family.
 * Returns the parsed JSON config object, or null if the family is not found.
 * @param {object} db - Database instance
 * @param {string} family - Station family (e.g., 'ET200SP', 'CFU_PA', 'Scalance')
 * @returns {object|null} Parsed auto_slots_config JSON
 */
function loadFamilyAutoSlotConfig(db, family) {
  const row = db.prepare(
    'SELECT auto_slots_config FROM hw_station_auto_slots WHERE family = ?'
  ).get(family);

  if (!row) return null;

  try {
    return JSON.parse(row.auto_slots_config);
  } catch (e) {
    console.error(`[autoSlotResolver] Failed to parse config for family "${family}": ${e.message}`);
    return null;
  }
}

/**
 * Get all auto-slot configurations grouped by family.
 * @param {object} db - Database instance
 * @returns {Map<string, object>} Map of family → config
 */
function loadAllFamilyConfigs(db) {
  const rows = db.prepare('SELECT family, auto_slots_config FROM hw_station_auto_slots').all();
  const configMap = new Map();

  for (const row of rows) {
    try {
      const config = JSON.parse(row.auto_slots_config);
      configMap.set(row.family, config);
    } catch (e) {
      console.error(`[autoSlotResolver] Failed to parse config for family "${row.family}": ${e.message}`);
    }
  }

  return configMap;
}

/**
 * Build a fast lookup map of slots for a given family config.
 * Returns: Map<slotNo, slotConfig>
 * @param {object} config - Auto-slot config from DB
 * @returns {Map<number, object>}
 */
function buildSlotMap(config) {
  const slotMap = new Map();
  if (config && config.slots && Array.isArray(config.slots)) {
    for (const slot of config.slots) {
      slotMap.set(slot.slot, slot);
    }
  }
  return slotMap;
}

/**
 * Build a subslot lookup map for a given slot in the config.
 * Returns: Map<subslotNo, subslotConfig>
 * @param {object} slotConfig - Slot configuration object
 * @returns {Map<number, object>}
 */
function buildSubslotMap(slotConfig) {
  const subslotMap = new Map();
  if (slotConfig && slotConfig.subslots && Array.isArray(slotConfig.subslots)) {
    for (const subslot of slotConfig.subslots) {
      subslotMap.set(subslot.subslot, subslot);
    }
  }
  return subslotMap;
}

/**
 * Check if a slot is marked as auto-created in the config.
 * @param {object} slotConfig - Slot configuration
 * @returns {boolean}
 */
function isSlotAutocreated(slotConfig) {
  return slotConfig && slotConfig.is_autocreated === true;
}

/**
 * Check if a subslot is marked as auto-created in the config.
 * @param {object} subslotConfig - Subslot configuration
 * @returns {boolean}
 */
function isSubslotAutocreated(subslotConfig) {
  return subslotConfig && subslotConfig.is_autocreated === true;
}

/**
 * Get the order number for a slot. Handles both:
 *   - use_from_station_slot: true → get from station.slots[0]
 *   - order_no: "..." → return explicit order number
 * @param {object} slotConfig - Slot configuration
 * @param {object} stationSlot - station.slots[slotNo] (may be undefined)
 * @returns {string|null} Order number or null if not determinable
 */
function resolveSlotOrderNo(slotConfig, stationSlot) {
  if (!slotConfig) return null;

  // Explicit order_no wins
  if (slotConfig.order_no) {
    return slotConfig.order_no;
  }

  // use_from_station_slot: get from actual station slot
  if (slotConfig.use_from_station_slot && stationSlot) {
    return stationSlot.orderNo || null;
  }

  return null;
}

/**
 * Get the order number for a subslot from the config.
 * @param {object} subslotConfig - Subslot configuration
 * @returns {string|null} Order number or null
 */
function resolveSubslotOrderNo(subslotConfig) {
  return (subslotConfig && subslotConfig.order_no) || null;
}

module.exports = {
  loadFamilyAutoSlotConfig,
  loadAllFamilyConfigs,
  buildSlotMap,
  buildSubslotMap,
  isSlotAutocreated,
  isSubslotAutocreated,
  resolveSlotOrderNo,
  resolveSubslotOrderNo,
};
