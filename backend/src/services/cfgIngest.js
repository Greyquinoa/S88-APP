'use strict';
// services/cfgIngest.js — Extract and compose CFG ingest operations for Phase 2 merge
// Functions here are called by both the old /upload-baseline and /backfill-from-cfg routes,
// and by the new merged /upload-cfg route. They do not open their own transactions — callers own the boundary.

const { parseCfg, parseCfgDevices } = require('./cfgParser');
const { loadExistingStations, findStationConflicts, buildConflictTable } = require('./stationUniqueness');

/**
 * Upsert hw_controller and hw_fieldbuses from a parsed baseline CFG.
 * Returns { controllerId, created: bool }.
 * Does NOT open a transaction.
 */
async function upsertControllerFromCfg(db, projectId, parsed) {
  // Rack chassis is on the RACK header line "RACK N, "orderNo", "name"" — not a SLOT entry
  const rackHeaderMatch = parsed.racks.length > 0
    ? parsed.racks[0].match(/^RACK\s+\d+,\s*"([^"]+)"[^,\n]*,\s*"([^"]+)"/m)
    : null;
  const rackOrderNo = rackHeaderMatch ? rackHeaderMatch[1] : null;
  const rackName    = rackHeaderMatch ? rackHeaderMatch[2] : null;

  // PS is at slot 1 in an S7-400 rack
  const psModule = parsed.rackModules.find(m => m.slot === 1)
                || parsed.rackModules.find(m => /\bps\b/i.test(m.name));

  const ctrlFields = {
    T16_Controller_TagName: parsed.stationName || null,
    T16_Station_Type:       parsed.stationType || null,
    T15_IP_Address:         (parsed.ioControllers[0] && parsed.ioControllers[0].ip) || null,
    T50_Rack_Order_No:      rackOrderNo,
    T50_Rack_Name:          rackName,
    T50_PS_Order_No:        psModule   ? psModule.orderNo   : null,
    T50_PS_Name:            psModule   ? psModule.name      : null,
  };

  // Match by station name so re-uploading the same CFG updates the same record
  const existingCtrl = parsed.stationName
    ? await db.prepare('SELECT id FROM hw_controllers WHERE project_id=? AND T16_Controller_TagName=?')
        .get(projectId, parsed.stationName)
    : await db.prepare('SELECT id FROM hw_controllers WHERE project_id=? ORDER BY id LIMIT 1').get(projectId);

  let controllerId;
  let created = false;
  if (existingCtrl) {
    await db.prepare(`UPDATE hw_controllers SET
      T16_Controller_TagName=?, T16_Station_Type=?,
      T15_IP_Address=?, T50_Rack_Order_No=?, T50_Rack_Name=?,
      T50_PS_Order_No=?, T50_PS_Name=?, updated_at=NOW()
      WHERE id=?`).run(
      ctrlFields.T16_Controller_TagName, ctrlFields.T16_Station_Type,
      ctrlFields.T15_IP_Address,
      ctrlFields.T50_Rack_Order_No, ctrlFields.T50_Rack_Name,
      ctrlFields.T50_PS_Order_No, ctrlFields.T50_PS_Name,
      existingCtrl.id
    );
    controllerId = existingCtrl.id;
  } else {
    const r = await db.prepare(`INSERT INTO hw_controllers
      (project_id, T16_Controller_TagName, T16_Station_Type, T15_IP_Address,
       T50_Rack_Order_No, T50_Rack_Name, T50_PS_Order_No, T50_PS_Name)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      projectId,
      ctrlFields.T16_Controller_TagName, ctrlFields.T16_Station_Type,
      ctrlFields.T15_IP_Address,
      ctrlFields.T50_Rack_Order_No, ctrlFields.T50_Rack_Name,
      ctrlFields.T50_PS_Order_No, ctrlFields.T50_PS_Name
    );
    controllerId = r.lastInsertRowid;
    created = true;
  }

  // Replace fieldbuses: one row per PN IO controller found in the CFG
  await db.prepare('DELETE FROM hw_fieldbuses WHERE hw_controller_id=?').run(controllerId);
  const fbIns = db.prepare(`INSERT INTO hw_fieldbuses
    (hw_controller_id, INT_DP_Subsystem, T50_Fieldbus_Name, T15_IP_Address)
    VALUES (?,?,?,?)`);
  for (const c of parsed.ioControllers) {
    await fbIns.run(controllerId, c.no, c.subnetName || null, c.ip || null);
  }

  return { controllerId, created };
}

/**
 * Build a rich baseline_info object for the frontend from a parsed CFG.
 */
function buildBaselineInfo(parsed) {
  return {
    stationName:   parsed.stationName,
    stationType:   parsed.stationType,
    subnetNames:   parsed.subnetNames,
    subnets:       parsed.subnets.length,
    racks:         parsed.racks.length,
    rackModules:   parsed.rackModules,
    ioControllers: parsed.ioControllers,
    ioSubsystems:  parsed.ioSubsystemHeaders.map(h => ({ no: h.no })),
    existingDevices: parsed.existingDevices,
    existingAddresses: parsed.existingAddresses,
    pipMappings:   parsed.pipMappings,   // [{pipNo, ob, executionTime, timeScale}]
  };
}

/**
 * Ingest device data from a parsed CFG into hw_signals + hw_slot_subslots for an import.
 * Additive: does NOT wipe existing data. Returns { stations, slots, mrpDevices, skipped, overwritten }.
 * Does NOT open a transaction — caller owns the boundary.
 */
async function ingestDevicesFromCfg(db, importId, cfgText, opts = {}) {
  const devices = parseCfgDevices(cfgText);
  if (devices.length === 0) {
    return { stations: 0, slots: 0, mrpDevices: 0, skipped: [], overwritten: [] };
  }

  // TODO Phase 2: implement skip/overwrite logic here. For now, additive only.
  // This is where we'd check for existing stations and prompt the user.

  const tplRows = await db.prepare('SELECT order_no, signal_type FROM hw_module_templates').all();
  const tplMap  = new Map(tplRows.map(t => [t.order_no, t]));

  const insertSignal = db.prepare(`
    INSERT INTO hw_signals
      (hw_import_id, station_address, station_name, ip_address, router_address,
       subsystem_no, slot, module_order_no, module_name, signal_type,
       pip_no, potential_group, tag, description, station_mlfb)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const insertSubslot = db.prepare(`
    INSERT INTO hw_slot_subslots
      (hw_import_id, station_address, slot, subslot_no, pa_profile)
    VALUES (?,?,?,?,?)
    ON CONFLICT (hw_import_id, station_address, slot, subslot_no) DO UPDATE SET
      pa_profile = EXCLUDED.pa_profile`);

  let stationCount = 0;
  let slotCount    = 0;

  // Process devices (additive insertion)
  for (const dev of devices) {
    stationCount++;

    const slot0OrderNo = (dev.mlfbNo && !tplMap.has(dev.orderNo))
      ? dev.mlfbNo
      : dev.orderNo;
    await insertSignal.run(
      importId,
      dev.address, dev.name, dev.ip, dev.routerAddress,
      dev.subsystemNo, 0,
      slot0OrderNo, dev.name,
      null, null, null, null, null,
      dev.mlfbNo || null,
    );

    for (const slot of dev.slots) {
      if ((slot.orderNo || '').includes('193-6PA00-0AA0')) continue; // skip server module

      const tpl        = tplMap.get(slot.orderNo);
      const signalType = tpl ? tpl.signal_type : null;

      if (slot.symbols.length === 0) {
        await insertSignal.run(
          importId,
          dev.address, dev.name, dev.ip, dev.routerAddress,
          dev.subsystemNo, slot.slot,
          slot.orderNo, slot.name,
          signalType,
          slot.pipNo, slot.potentialGroup,
          null, null,
          slot.mlfb || null,
        );
        slotCount++;
      } else {
        for (const sym of slot.symbols) {
          await insertSignal.run(
            importId,
            dev.address, dev.name, dev.ip, dev.routerAddress,
            dev.subsystemNo, slot.slot,
            slot.orderNo, slot.name,
            signalType,
            slot.pipNo, slot.potentialGroup,
            sym.tag || null, sym.description || null,
            slot.mlfb || null,
          );
        }
        slotCount++;
      }

      for (const ss of slot.subslots) {
        await insertSubslot.run(importId, dev.address, slot.slot, ss.subslotNo, ss.orderNo || null);
      }
    }
  }

  // TODO: MRP backfill (phase 2, copied from hwConfig.js:678-732)
  let mrpDevices = 0;

  return { stations: stationCount, slots: slotCount, mrpDevices, skipped: [], overwritten: [] };
}

module.exports = { upsertControllerFromCfg, buildBaselineInfo, ingestDevicesFromCfg };
