// services/autoSlotResolver.js — Resolve auto-created slot configurations per station order_no
'use strict';

/**
 * Load the auto-slot configuration for a given station (by order_no).
 * Returns the parsed JSON config object, or null if the order_no is not found.
 * @param {object} db - Database instance
 * @param {string} orderNo - Station order number (e.g., 'V_2_0_PA_ETER:6ES7 655-5PX11-0XX0')
 * @returns {object|null} Parsed auto_slots_config JSON
 */
async function loadStationAutoSlotConfig(db, orderNo) {
  if (!orderNo) return null;
  const row = await db.prepare(
    'SELECT auto_slots_config FROM hw_station_auto_slots WHERE order_no = ?'
  ).get(orderNo);

  if (!row) return null;

  try {
    return JSON.parse(row.auto_slots_config);
  } catch (e) {
    console.error(`[autoSlotResolver] Failed to parse config for orderNo "${orderNo}": ${e.message}`);
    return null;
  }
}

/**
 * Get all auto-slot configurations indexed by order_no.
 * @param {object} db - Database instance
 * @returns {Map<string, object>} Map of order_no → config
 */
async function loadAllStationConfigs(db) {
  const rows = await db.prepare('SELECT order_no, auto_slots_config FROM hw_station_auto_slots').all();
  const configMap = new Map();

  for (const row of rows) {
    try {
      const config = JSON.parse(row.auto_slots_config);
      configMap.set(row.order_no, config);
    } catch (e) {
      console.error(`[autoSlotResolver] Failed to parse config for orderNo "${row.order_no}": ${e.message}`);
    }
  }

  return configMap;
}

/**
 * Enrich configuration with is_autocreated metadata from hw_module_autocreated_slots.
 * This reads the AUTOCREATED flags that were extracted from baseline CFGs during module import.
 * @param {object} db - Database instance
 * @param {string} orderNo - Station order number
 * @param {object} config - Auto-slot config
 * @returns {object} Enriched config with is_autocreated populated
 */
async function enrichConfigWithAutoCreated(db, orderNo, config) {
  if (!config || !config.slots) return config;

  const enriched = JSON.parse(JSON.stringify(config)); // deep copy

  for (const slot of enriched.slots) {
    // Check if this slot is marked autocreated
    const slotRow = await db.prepare(
      'SELECT autocreated FROM hw_module_autocreated_slots WHERE order_no = ? AND slot = ? AND subslot IS NULL'
    ).get(orderNo, slot.slot);
    slot.is_autocreated = !!slotRow?.autocreated;

    // Check subslots
    if (slot.subslots) {
      for (const subslot of slot.subslots) {
        const subslotRow = await db.prepare(
          'SELECT autocreated FROM hw_module_autocreated_slots WHERE order_no = ? AND slot = ? AND subslot = ?'
        ).get(orderNo, slot.slot, subslot.subslot);
        subslot.is_autocreated = !!subslotRow?.autocreated;
      }
    }
  }

  return enriched;
}

/**
 * Build a fast lookup map of slots for a given config.
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
 * Get the order number for a slot from config.
 * @param {object} slotConfig - Slot configuration
 * @returns {string|null} Order number or null
 */
function resolveSlotOrderNo(slotConfig) {
  return (slotConfig && slotConfig.order_no) || null;
}

/**
 * Get the order number for a subslot from config.
 * @param {object} subslotConfig - Subslot configuration
 * @returns {string|null} Order number or null
 */
function resolveSubslotOrderNo(subslotConfig) {
  return (subslotConfig && subslotConfig.order_no) || null;
}

/**
 * Legacy: Load by family (for backward compatibility)
 * @deprecated Use loadStationAutoSlotConfig(db, orderNo) instead
 */
function loadFamilyAutoSlotConfig(db, family) {
  // This is deprecated — configs are now keyed by order_no, not family
  console.warn('[autoSlotResolver] loadFamilyAutoSlotConfig is deprecated; use loadStationAutoSlotConfig(db, orderNo)');
  return null;
}

module.exports = {
  loadStationAutoSlotConfig,
  loadAllStationConfigs,
  enrichConfigWithAutoCreated,
  buildSlotMap,
  buildSubslotMap,
  isSlotAutocreated,
  isSubslotAutocreated,
  resolveSlotOrderNo,
  resolveSubslotOrderNo,
  loadFamilyAutoSlotConfig, // deprecated
};
