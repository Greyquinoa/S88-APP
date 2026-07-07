import React, { useState, useEffect, useRef } from "react";
import MRPTopologyView from "./MRPTopologyView.jsx";
import HwImportReview from "./HwImportReview.jsx";
import HwColumnMappingPanel from "./HwColumnMappingPanel.jsx";
import {
  listHwImports, uploadHwBaseline, uploadHwIoList, previewHwIoList,
  getHwStations, getHwAddressPreview, generateHwCfg, listHwCfgs, hwCfgDownloadUrl,
  backfillFromCfg, getColumnMappingSuggestions,
  updateHwStation, updateHwSlot,
  listHwModuleTemplates,
  addHwStation, deleteHwStation, addHwSlot, deleteHwSlot,
  listHwControllers, listHwFieldbuses,
  getSlotChannels, patchSlotChannel, patchSlotPip, patchSlotPotentialGroup, patchSlotPaProfile, patchSlotSubslotProfile,
  copyHwStation,
  bulkDeleteHwStations, bulkApproveHwStations,
  parseCfgForCatalogue, bulkUpsertCatalogueTemplates,
  deleteHwModuleTemplate, getHwModuleTemplateUsage,
  upsertHwModuleTemplate,
  listSlotCompat, addSlotCompat, removeSlotCompat,
  listHwSignalTypes, addHwSignalType,
  mrpGetDevices, mrpGetConfig, mrpSaveConfig, mrpDownloadCfg,
  listHwHardwareResolutions, upsertHwHardwareResolution, deleteHwHardwareResolution,
  exportHwHardwareResolutionUrl, importHwHardwareResolutionCsv,
} from "./api.js";

import StepController from "./StepController.jsx";
import HwConfigGrid from "./HwConfigGrid.tsx";
import CatalogueGrid from "./CatalogueGrid.jsx";
import SymbolTableModal from "./SymbolTableModal.jsx";
import StationAutoSlotsEditor from "./StationAutoSlotsEditor.jsx";


export default function StepHWConfig({ projectId }) {
  const [hwTab,        setHwTab]        = useState("import");
  const [importId,     setImportId]     = useState(null);
  const [baselineOk,   setBaselineOk]   = useState(false);
  const [baselineInfo, setBaselineInfo] = useState(null);
  const [ioListOk,     setIoListOk]     = useState(false);
  const [ioListInfo,   setIoListInfo]   = useState(null);
  const [reviewData,   setReviewData]   = useState(null);   // diff payload → opens HwImportReview modal
  const [controllers,  setControllers]  = useState([]);
  const [selectedId,   setSelectedId]   = useState(null);
  const [stations,     setStations]     = useState([]);
  const [addrMap,      setAddrMap]      = useState({});   // { "<stationAddr>:<slot>": { inputAddr, outputAddr } }
  const [templates,    setTemplates]    = useState([]);
  const [fieldbuses,   setFieldbuses]   = useState([]);
  const [cfgs,         setCfgs]         = useState([]);
  const [loading,      setLoading]      = useState("");
  const [error,        setError]        = useState("");
  const [genWarnings,  setGenWarnings]  = useState([]);   // identifier diagnostics from last CFG generate

  // Inline-edit state
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState("");

  // Add-station form
  const [addingStation, setAddingStation] = useState(false);
  const [newStation,    setNewStation]    = useState({ address: "", name: "", ip: "", subsystemNo: 100, imOrderNo: "", imName: "" });

  // Add-slot form: keyed by stationAddr
  const [addingSlot,  setAddingSlot]  = useState(null);  // station addr or null
  const [newSlot,     setNewSlot]     = useState({ slot: "", moduleOrderNo: "", moduleName: "" });

  // Multi-select state for bulk operations
  const [selectedAddrs, setSelectedAddrs] = useState(new Set());

  // Catalogue delete confirmation modal
  const [deleteCatalogueTarget, setDeleteCatalogueTarget] = useState(null);

  // Symbol Table modal
  const [showSymbolTable, setShowSymbolTable] = useState(false);

  // Column mapping workflow (HW Import) — separate tab
  const [excelFile, setExcelFile] = useState(null);
  const [excelHeaders, setExcelHeaders] = useState([]);
  const [selectedColumns, setSelectedColumns] = useState(new Set());

  // Slot ↔ Subslot compatibility map
  const [slotCompat, setSlotCompat] = useState([]); // [{ id, slot_order_no, subslot_order_no, is_default }]
  const reloadSlotCompat = () => listSlotCompat().then(setSlotCompat).catch(() => {});

  // Signal types — loaded from DB; user-extensible
  const [sigTypes, setSigTypes] = useState([]);

  const baselineRef     = useRef();
  const ioListRef       = useRef();
  const cfgBackfillRef  = useRef();

  useEffect(() => {
    listHwModuleTemplates().then(setTemplates).catch(() => {});
    listSlotCompat().then(setSlotCompat).catch(() => {});
    listHwSignalTypes().then(setSigTypes).catch(() => {});
  }, []);

  const loadControllers = async () => {
    if (!projectId) return;
    try {
      const data = await listHwControllers(projectId);
      setControllers(data);
      if (data.length > 0 && !selectedId) setSelectedId(data[0].id);
    } catch {}
  };

  useEffect(() => { loadControllers(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) { setFieldbuses([]); return; }
    listHwFieldbuses(selectedId).then(setFieldbuses).catch(() => setFieldbuses([]));
  }, [selectedId]);

  useEffect(() => {
    if (!projectId) return;
    setError("");
    listHwImports(projectId)
      .then(rows => {
        if (rows.length > 0) {
          const latest = rows[0];
          setImportId(latest.id);
          setBaselineOk(true);
          if (latest.baseline_info) setBaselineInfo(latest.baseline_info);
          if (latest.status === "ready" || latest.status === "generated") setIoListOk(true);
          loadStations(latest.id);
          loadCfgs(latest.id);
        }
      })
      .catch(() => {});
  }, [projectId]);

  async function loadStations(id) {
    try {
      const [sts, addrs] = await Promise.all([
        getHwStations(id),
        getHwAddressPreview(id).catch(() => ({})),
      ]);
      setStations(sts);
      setAddrMap(addrs);
    } catch (e) { setError(e.message); }
  }

  async function loadCfgs(id) {
    try { setCfgs(await listHwCfgs(id)); }
    catch (e) { setError(e.message); }
  }

  async function handleBaselineUpload(e) {
    const file = e.target.files[0];
    if (!file || !projectId) return;
    setLoading("Uploading baseline CFG…");
    setError("");
    try {
      const result = await uploadHwBaseline(projectId, file);
      setImportId(result.importId);
      setBaselineOk(true);
      setBaselineInfo(result);
    } catch (err) { setError(err.message); }
    finally { setLoading(""); }
  }

  async function handleIoListUpload(e) {
    const file = e.target.files[0];
    if (!file || !importId) { setError("Upload a baseline CFG first."); return; }
    setLoading("Reading Excel headers…");
    setError("");
    try {
      const fd = new FormData();
      fd.append('iolist', file);
      const headersResp = await fetch(`/api/hw-config/imports/${importId}/parse-headers`, {
        method: 'POST',
        body: fd,
      });
      if (!headersResp.ok) throw new Error('Failed to read Excel headers');
      const { headers } = await headersResp.json();

      // Store file and headers — colmap sub-tab lives inside the import panel now
      setExcelFile(file);
      setExcelHeaders(headers);
      setSelectedColumns(new Set(headers));
      setHwTab("import"); // stay on import tab; sub-tab switching happens inside ImportPanel
    } catch (err) { setError(err.message); }
    finally { setLoading(""); }
  }

  async function handleReviewApplied() {
    setReviewData(null);
    setIoListOk(true);
    await loadStations(importId);
    await loadCfgs(importId);
    setHwTab("config");
  }

  async function handleBackfillFromCfg(file) {
    if (!importId) { setError("Upload a baseline CFG first."); return; }
    if (!file)     { setError("No CFG file selected."); return; }
    setLoading("Reading device data from CFG…");
    setError("");
    try {
      const result = await backfillFromCfg(importId, file);
      setIoListOk(true);
      setIoListInfo({ stationCount: result.stations, signalCount: result.slots });
      await loadStations(importId);
      await loadCfgs(importId);
      setHwTab("config");
    } catch (e) { setError(e.message); }
    finally { setLoading(""); }
  }

  async function handleGenerate(filterMode = null) {
    if (!importId) return;
    const opts = {};
    if (filterMode === 'selected') {
      if (selectedAddrs.size === 0) { setError("Select at least one station first."); return; }
      opts.filterMode = 'selected';
      opts.addresses  = [...selectedAddrs];
    } else if (filterMode === 'approved') {
      const hasApproved = stations.some(s => s.approved);
      if (!hasApproved) { setError("No stations have approved status."); return; }
      opts.filterMode = 'approved';
    }
    setLoading("Generating CFG…");
    setError("");
    setGenWarnings([]);
    try {
      const result = await generateHwCfg(importId, opts);
      setGenWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      await loadCfgs(importId);
    } catch (err) { setError(err.message); }
    finally { setLoading(""); }
  }

  async function handleBulkDelete() {
    const addrsToDelete = selectedAddrs;
    if (addrsToDelete.size === 0) return;
    const isAll = addrsToDelete.size === stations.length;
    const msg = isAll
      ? `⚠ WARNING — PERMANENT DELETION\n\nYou are about to delete ALL ${addrsToDelete.size} station(s) and every module and signal assigned to them.\n\nThis action CANNOT be undone. There is no recovery.\nThe controller (baseline CFG) will NOT be affected.\n\nType-check: are you sure you want to permanently erase all stations?`
      : `Delete ${addrsToDelete.size} station(s) and all their modules?\n\nThis cannot be undone.`;
    if (!window.confirm(msg)) return;
    setError("");
    try {
      await bulkDeleteHwStations(importId, [...addrsToDelete]);
      setStations(prev => prev.filter(s => !addrsToDelete.has(s.address)));
      setSelectedAddrs(new Set());
    } catch (e) { setError(e.message); }
  }

  async function handleBulkApprove(approved) {
    if (selectedAddrs.size === 0) return;
    setError("");
    try {
      await bulkApproveHwStations(importId, [...selectedAddrs], approved);
      setStations(prev => prev.map(s => selectedAddrs.has(s.address) ? { ...s, approved } : s));
    } catch (e) { setError(e.message); }
  }

  function toggleSelectStation(addr) {
    setSelectedAddrs(prev => {
      const next = new Set(prev);
      next.has(addr) ? next.delete(addr) : next.add(addr);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedAddrs.size === stations.length) {
      setSelectedAddrs(new Set());
    } else {
      setSelectedAddrs(new Set(stations.map(s => s.address)));
    }
  }

  // ── Inline edit ────────────────────────────────────────────────────────────
  function startEdit(stationAddr, field, currentVal, slotNo = null) {
    setEditing({ stationAddr, field, slotNo });
    setEditVal(currentVal ?? "");
  }
  function cancelEdit() { setEditing(null); setEditVal(""); }

  async function commitEdit() {
    if (!editing) return;
    const { stationAddr, field, slotNo } = editing;
    const val = editVal.trim();
    try {
      if (slotNo === null) {
        await updateHwStation(importId, stationAddr, { [field]: val });
        setStations(prev => prev.map(s =>
          s.address === stationAddr
            ? { ...s, [field === "station_name" ? "name" : field === "ip_address" ? "ip" : "subsystemNo"]: val }
            : s
        ));
      } else {
        await updateHwSlot(importId, stationAddr, slotNo, { [field]: val });
        setStations(prev => prev.map(s => {
          if (s.address !== stationAddr) return s;
          return {
            ...s,
            slots: s.slots.map(sl => sl.slot === slotNo
              ? { ...sl, [field === "module_name" ? "name" : "orderNo"]: val }
              : sl
            ),
          };
        }));
      }
    } catch (e) { setError(e.message); }
    cancelEdit();
  }

  function isEditing(stationAddr, field, slotNo = null) {
    return editing &&
      editing.stationAddr === stationAddr &&
      editing.field === field &&
      editing.slotNo === slotNo;
  }

  // ── Add Station ────────────────────────────────────────────────────────────
  async function commitAddStation() {
    const addr = parseInt(newStation.address, 10);
    if (!addr) { setError("Station address is required."); return; }
    if (!newStation.imOrderNo) { setError("Select an Interface Module (Slot 0) type."); return; }
    setLoading("Adding station…");
    setError("");
    try {
      await addHwStation(importId, {
        address: addr,
        name: newStation.name || `Station_${addr}`,
        ip: newStation.ip || null,
        subsystemNo: parseInt(newStation.subsystemNo, 10) || 100,
        imOrderNo: newStation.imOrderNo,
        imName: newStation.imName,
      });
      await loadStations(importId);
      setAddingStation(false);
      setNewStation({ address: "", name: "", ip: "", subsystemNo: 100, imOrderNo: "", imName: "" });
    } catch (e) { setError(e.message); }
    finally { setLoading(""); }
  }

  async function handleCopyStation(addr) {
    setError("");
    try {
      await copyHwStation(importId, addr);
      await loadStations(importId);
    } catch (e) { setError(e.message); }
  }

  async function handleDeleteStation(addr) {
    if (!window.confirm(`Delete station ${addr} and all its modules?`)) return;
    setError("");
    try {
      await deleteHwStation(importId, addr);
      await loadStations(importId);
    } catch (e) { setError(e.message); }
  }

  // ── Add Slot ───────────────────────────────────────────────────────────────
  function openAddSlot(stationAddr) {
    const station = stations.find(s => s.address === stationAddr);
    const imSlot  = station && station.slots.find(s => s.slot === 0);
    const imTpl   = imSlot ? templates.find(t => t.order_no === imSlot.orderNo) : null;
    const isCfuPa = imTpl && imTpl.family === 'CFU_PA';
    const minSlot = isCfuPa ? 3 : 1;
    const maxSlot = station && station.slots.length > 0
      ? Math.max(...station.slots.map(sl => sl.slot))
      : 0;
    setNewSlot({ slot: Math.max(minSlot, maxSlot + 1), moduleOrderNo: "", moduleName: "" });
    setAddingSlot(stationAddr);
  }

  function handleModuleSelect(orderNo) {
    const tpl = templates.find(t => t.order_no === orderNo);
    setNewSlot(prev => ({ ...prev, moduleOrderNo: orderNo, moduleName: tpl ? tpl.display_name : orderNo }));
  }

  async function commitAddSlot(stationAddr) {
    if (!newSlot.moduleOrderNo) { setError("Select a module."); return; }
    if (!newSlot.moduleName.trim()) { setError("Module Name is required."); return; }
    setLoading("Adding slot…");
    setError("");
    try {
      const slotNo = parseInt(newSlot.slot, 10);
      await addHwSlot(importId, stationAddr, {
        slot: slotNo,
        moduleOrderNo: newSlot.moduleOrderNo,
        moduleName: newSlot.moduleName,
      });

      // CFU_PA only: apply per-subslot defaults captured from the CFG file at import time.
      // subslot_defaults is a JSON array of {ssNo, paProfile} — one entry per function subslot.
      // ET200 stations are never affected — they have no per-subslot paProfile concept.
      const selectedTpl = templates.find(t => t.order_no === newSlot.moduleOrderNo);
      if (selectedTpl && selectedTpl.family === 'CFU_PA') {
        let defaults = [];
        try { defaults = selectedTpl.subslot_defaults ? JSON.parse(selectedTpl.subslot_defaults) : []; } catch {}
        for (const { ssNo, paProfile } of defaults) {
          if (ssNo && paProfile) {
            await patchSlotSubslotProfile(importId, stationAddr, slotNo, ssNo, paProfile);
          }
        }
      }

      await loadStations(importId);
      setAddingSlot(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(""); }
  }

  async function handleSaveSlotPotentialGroup(stationAddr, slotNo, potentialGroup) {
    setError("");
    try {
      await patchSlotPotentialGroup(importId, stationAddr, slotNo, potentialGroup);
      setStations(prev => prev.map(s => {
        if (s.address !== stationAddr) return s;
        return {
          ...s,
          slots: s.slots.map(sl =>
            sl.slot === slotNo ? { ...sl, potentialGroup } : sl
          ),
        };
      }));
    } catch (e) { setError(e.message); }
  }

  async function handleSaveSlotPaProfile(stationAddr, slotNo, paProfile) {
    setError("");
    try {
      await patchSlotPaProfile(importId, stationAddr, slotNo, paProfile || null);
      // Update local station state and refresh addresses
      setStations(prev => prev.map(s => {
        if (s.address !== stationAddr) return s;
        return {
          ...s,
          slots: s.slots.map(sl =>
            sl.slot === slotNo ? { ...sl, paProfile: paProfile || null } : sl
          ),
        };
      }));
      // Refresh address map since profile change may affect byte counts
      getHwAddressPreview(importId).then(setAddrMap).catch(() => {});
    } catch (e) { setError(e.message); }
  }

  async function handleSaveSlotSubslotProfile(stationAddr, slotNo, ssNo, paProfile) {
    setError("");
    try {
      await patchSlotSubslotProfile(importId, stationAddr, slotNo, ssNo, paProfile || null);
      setStations(prev => prev.map(s => {
        if (s.address !== stationAddr) return s;
        return {
          ...s,
          slots: s.slots.map(sl => {
            if (sl.slot !== slotNo) return sl;
            const existing = sl.subslots || [];
            const updated = existing.filter(ss => ss.subslotNo !== ssNo);
            updated.push({ subslotNo: ssNo, paProfile: paProfile || null });
            updated.sort((a, b) => a.subslotNo - b.subslotNo);
            return { ...sl, subslots: updated };
          }),
        };
      }));
      getHwAddressPreview(importId).then(setAddrMap).catch(() => {});
    } catch (e) { setError(e.message); }
  }

  async function handleSaveSlotPip(stationAddr, slotNo, pipNo) {
    setError("");
    try {
      await patchSlotPip(importId, stationAddr, slotNo, pipNo);
      setStations(prev => prev.map(s => {
        if (s.address !== stationAddr) return s;
        return {
          ...s,
          slots: s.slots.map(sl =>
            sl.slot === slotNo ? { ...sl, pipNo: pipNo != null ? parseInt(pipNo, 10) : null } : sl
          ),
        };
      }));
    } catch (e) { setError(e.message); }
  }

  async function handleDeleteSlot(stationAddr, slotNo) {
    setError("");
    try {
      await deleteHwSlot(importId, stationAddr, slotNo);
      await loadStations(importId);
    } catch (e) { setError(e.message); }
  }

  if (!projectId) {
    return <p style={{ padding: 24, color: "#888" }}>Save a project first to use HW Config.</p>;
  }

  const selectedController = controllers.find(c => c.id === selectedId) || null;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", display: "flex", gap: 0, alignItems: "flex-start" }}>

      {/* ── Collapsible left panel ───────────────────────────────────── */}
      <NavPanel
        hwTab={hwTab}
        setHwTab={setHwTab}
        controllers={controllers}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          if (hwTab === "import" || hwTab === "catalogue") setHwTab("controller");
        }}
      />

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, paddingLeft: 24 }}>
        <h2 style={{ marginTop: 0, marginBottom: 12 }}>Hardware Configuration Generator</h2>

        {error && <div style={alertStyle("#ffeaea", "#e88", "#b00")}>{error}</div>}
        {loading && <div style={alertStyle("#eef4ff", "#99b", "#336")}>{loading}</div>}
        {genWarnings.length > 0 && (
          <div style={alertStyle("#fffbeb", "#fcd34d", "#92400e")}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <strong>⚠ CFG generated with {genWarnings.length} identifier warning{genWarnings.length !== 1 ? "s" : ""}</strong>
              <button onClick={() => setGenWarnings([])}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#92400e", fontSize: 16, lineHeight: 1 }}
                title="Dismiss">✕</button>
            </div>
            <ul style={{ margin: "6px 0 0 0", paddingLeft: 20, fontSize: 12 }}>
              {genWarnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
              {genWarnings.length > 20 && <li>…and {genWarnings.length - 20} more</li>}
            </ul>
          </div>
        )}

        {/* Import + Column Mapping — tabbed workspace */}
        {hwTab === "import" && (
          <ImportWorkspace
            /* import panel props */
            baselineOk={baselineOk}
            baselineInfo={baselineInfo}
            ioListOk={ioListOk}
            ioListInfo={ioListInfo}
            importId={importId}
            baselineRef={baselineRef}
            ioListRef={ioListRef}
            onBaselineChange={async (e) => { await handleBaselineUpload(e); await loadControllers(); }}
            onIoListChange={handleIoListUpload}
            onBaselineBtn={() => baselineRef.current.click()}
            onIoListBtn={() => {
              if (!importId) { setError("Upload a baseline CFG first."); return; }
              ioListRef.current.click();
            }}
            cfgBackfillRef={cfgBackfillRef}
            onBackfillFromCfg={() => {
              if (!importId) { setError("Upload a baseline CFG first."); return; }
              cfgBackfillRef.current.value = "";
              cfgBackfillRef.current.click();
            }}
            onCfgBackfillChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleBackfillFromCfg(file);
            }}
            loading={loading}
            /* column mapping props */
            excelHeaders={excelHeaders}
            selectedColumns={selectedColumns}
            setSelectedColumns={setSelectedColumns}
            setError={setError}
            setLoading={setLoading}
            showColmap={excelHeaders.length > 0}
            onMappingComplete={(data) => {
              setReviewData(data);
            }}
          />
        )}

        {/* Catalogue */}
        {hwTab === "catalogue" && (
          <CataloguePanel
            templates={templates}
            slotCompat={slotCompat}
            sigTypes={sigTypes}
            onTemplatesChanged={() => listHwModuleTemplates().then(setTemplates).catch(() => {})}
            onPatchTemplate={async (tpl, patch) => {
              setError("");
              try {
                await upsertHwModuleTemplate({ ...tpl, ...patch });
                setTemplates(prev => prev.map(t => t.id === tpl.id ? { ...t, ...patch } : t));
              } catch (e) { setError(e.message); }
            }}
            onAddSigType={async (name) => {
              try {
                const updated = await addHwSignalType(name);
                setSigTypes(updated);
              } catch (e) { setError(e.message); }
            }}
            onAddCompat={async (slotOrderNo, subslotOrderNo) => {
              await addSlotCompat(slotOrderNo, subslotOrderNo);
              reloadSlotCompat();
            }}
            onRemoveCompat={async (slotOrderNo, subslotOrderNo) => {
              await removeSlotCompat(slotOrderNo, subslotOrderNo);
              reloadSlotCompat();
            }}
            onDeleteTemplate={async (tpl) => {
              setError("");
              try {
                const info = await getHwModuleTemplateUsage(tpl.id);
                setDeleteCatalogueTarget({ ...tpl, usage: info.usage });
              } catch (e) { setError(e.message); }
            }}
          />
        )}
        {deleteCatalogueTarget && (
          <CatalogueDeleteModal
            target={deleteCatalogueTarget}
            onClose={() => setDeleteCatalogueTarget(null)}
            onConfirm={async () => {
              try {
                await deleteHwModuleTemplate(deleteCatalogueTarget.id);
                setTemplates(prev => prev.filter(t => t.id !== deleteCatalogueTarget.id));
                setDeleteCatalogueTarget(null);
              } catch (e) { setError(e.message); setDeleteCatalogueTarget(null); }
            }}
          />
        )}


        {/* Controller — sub-tabs when a controller is selected */}
        {(hwTab === "controller" || hwTab === "config" || hwTab === "mrp") && (
          <>
            {/* Sub-tab bar */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #dde" }}>
              {[["controller", "Controller"], ["config", "Configuration"], ["mrp", "MRP"]].map(([id, label]) => (
                <button key={id} onClick={() => setHwTab(id)}
                  style={{
                    padding: "7px 18px", border: "none", background: "none", cursor: "pointer",
                    fontWeight: hwTab === id ? 700 : 400, fontSize: 14,
                    color: hwTab === id ? "#2255cc" : "#555",
                    borderBottom: hwTab === id ? "2px solid #2255cc" : "2px solid transparent",
                    marginBottom: -2,
                  }}
                >{label}</button>
              ))}
            </div>

            {hwTab === "controller" && (
              <StepController
                controller={selectedController}
                onSaved={loadControllers}
                onDeleted={() => { setSelectedId(null); loadControllers(); }}
                pipMappings={baselineInfo?.pipMappings || []}
              />
            )}

            {hwTab === "mrp" && (
              <MrpPanel
                importId={importId}
                fieldbuses={fieldbuses}
                stations={stations}
                controllers={controllers}
                templates={templates}
              />
            )}

            {hwTab === "config" && (
              <ConfigurationPanel
                importId={importId}
                baselineOk={baselineOk}
                baselineInfo={baselineInfo}
                controllerTagName={selectedController?.T16_Controller_TagName}
                stations={stations}
                addrMap={addrMap}
                templates={templates}
                fieldbuses={fieldbuses}
                cfgs={cfgs}
                loading={loading}
                addingStation={addingStation}
                newStation={newStation}
                addingSlot={addingSlot}
                newSlot={newSlot}
                editing={editing}
                editVal={editVal}
                selectedAddrs={selectedAddrs}
                onToggleSelect={toggleSelectStation}
                onToggleSelectAll={toggleSelectAll}
                onClearSelection={() => setSelectedAddrs(new Set())}
                onSetSelectedAddrs={setSelectedAddrs}
                onSetNewStation={setNewStation}
                onStartAddStation={() => {
                  if (!importId) { setError("Upload a baseline CFG first."); return; }
                  // Auto-fill next address and next IP from existing stations
                  const nextAddr = stations.length > 0
                    ? Math.max(...stations.map(s => s.address)) + 1
                    : 1;
                  const lastIp = stations.length > 0
                    ? stations.reduce((best, s) => {
                        if (!s.ip) return best;
                        const lastOctet = parseInt(s.ip.split('.').pop(), 10);
                        if (!best || lastOctet > parseInt(best.split('.').pop(), 10)) return s.ip;
                        return best;
                      }, null)
                    : null;
                  const nextIp = lastIp ? (() => {
                    const parts = lastIp.split('.');
                    parts[3] = String(parseInt(parts[3], 10) + 1);
                    return parts.join('.');
                  })() : "";
                  setNewStation({ address: String(nextAddr), name: "", ip: nextIp, subsystemNo: 100, imOrderNo: "", imName: "" });
                  setAddingStation(true);
                }}
                onCancelAddStation={() => { setAddingStation(false); setNewStation({ address: "", name: "", ip: "", subsystemNo: 100, imOrderNo: "", imName: "" }); }}
                onCommitAddStation={commitAddStation}
                onCopyStation={handleCopyStation}
                onDeleteStation={handleDeleteStation}
                onBulkDelete={handleBulkDelete}
                onBulkApprove={handleBulkApprove}
                onOpenAddSlot={openAddSlot}
                onCancelAddSlot={() => setAddingSlot(null)}
                onModuleSelect={handleModuleSelect}
                onSetNewSlot={setNewSlot}
                onCommitAddSlot={commitAddSlot}
                onDeleteSlot={handleDeleteSlot}
                onSaveSlotPip={handleSaveSlotPip}
                onSaveSlotPotentialGroup={handleSaveSlotPotentialGroup}
                onSaveSlotPaProfile={handleSaveSlotPaProfile}
                onSaveSlotSubslotProfile={handleSaveSlotSubslotProfile}
                onGenerate={handleGenerate}
                isEditing={isEditing}
                onStartEdit={startEdit}
                onChangeEdit={setEditVal}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
                onShowSymbolTable={() => setShowSymbolTable(true)}
              />
            )}
          </>
        )}
      </div>

      {/* ── Delta-review modal ──────────────────────────────────────────── */}
      {reviewData && (
        <HwImportReview
          importId={importId}
          summary={reviewData.summary}
          items={reviewData.items}
          parsedRows={reviewData.parsedRows}
          fileName={reviewData.fileName}
          resolutionStats={reviewData.resolutionStats}
          onApplied={handleReviewApplied}
          onClose={() => setReviewData(null)}
        />
      )}

      {/* ── Symbol Table modal ──────────────────────────────────────────── */}
      {showSymbolTable && importId && (
        <SymbolTableModal
          importId={importId}
          stations={stations}
          onClose={() => setShowSymbolTable(false)}
        />
      )}
    </div>
  );
}

// ── MRP Ring Canvas (visual topology editor for screen 3) ────────────────────
const RC_W          = 118;  // node width
const RC_PORT_PITCH = 22;   // vertical px between port rows
const RC_PORT_TOP   = 36;   // y-offset of first port inside node
const RC_PORT_R     = 5;    // port circle radius

function rcNodeH(portCount) {
  return RC_PORT_TOP + Math.max(portCount, 1) * RC_PORT_PITCH + 10;
}

// Port dot lives on the right edge of the node
function rcPortXY(pos, portIdx) {
  return {
    x: pos.x + RC_W,
    y: pos.y + RC_PORT_TOP + portIdx * RC_PORT_PITCH + RC_PORT_PITCH / 2,
  };
}

function RingCanvas({ ringDevices, roles, links, setRole, setLink, nodePos, setNodePos, edgeOffsets, setEdgeOffsets }) {
  const svgRef = useRef(null);
  const [selectedAlias, setSelectedAlias] = useState(null);
  const [dragging,      setDragging]      = useState(null);  // {alias, ox, oy}
  const [edgeDragging,  setEdgeDragging]  = useState(null);  // {edgeKey, ox, oy, initBulge, initMidYOff}
  const [pendingEdge,   setPendingEdge]   = useState(null);  // {fromAlias, fromSubslot, fromPortIdx, mx, my}

  // Auto-layout: circle on first appearance
  useEffect(() => {
    const N = ringDevices.length;
    if (!N) return;
    const cx = 420, cy = 270, r = Math.max(140, Math.min(230, N * 42));
    setNodePos(prev => {
      const next = { ...prev };
      ringDevices.forEach((d, i) => {
        if (!next[d.alias]) {
          const a  = (2 * Math.PI * i / N) - Math.PI / 2;
          const nh = rcNodeH(d.ports.length);
          next[d.alias] = {
            x: Math.round(cx + r * Math.cos(a) - RC_W / 2),
            y: Math.round(cy + r * Math.sin(a) - nh / 2),
          };
        }
      });
      return next;
    });
  }, [ringDevices.map(d => d.alias).join(",")]); // eslint-disable-line

  useEffect(() => {
    const h = e => { if (e.key === "Escape") setPendingEdge(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  function getSvgXY(e) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function onSvgMouseMove(e) {
    const { x, y } = getSvgXY(e);
    if (dragging)     setNodePos(prev => ({ ...prev, [dragging.alias]: { x: x - dragging.ox, y: y - dragging.oy } }));
    if (pendingEdge)  setPendingEdge(p => ({ ...p, mx: x, my: y }));
    if (edgeDragging) {
      setEdgeOffsets(prev => ({
        ...prev,
        [edgeDragging.edgeKey]: { hx: x - edgeDragging.ox, hy: y - edgeDragging.oy },
      }));
    }
  }

  function onNodeMouseDown(e, alias) {
    e.stopPropagation();
    const { x, y } = getSvgXY(e);
    const pos = nodePos[alias] || { x: 0, y: 0 };
    setDragging({ alias, ox: x - pos.x, oy: y - pos.y });
    setSelectedAlias(alias);
  }

  function onPortClick(e, dev, portIdx, port) {
    e.stopPropagation();
    if (pendingEdge && pendingEdge.fromAlias !== dev.alias) {
      const { fromAlias, fromSubslot } = pendingEdge;
      const fromDev = ringDevices.find(d => d.alias === fromAlias);
      // Set both directions
      setLink(fromAlias,  fromSubslot,    "toDevice",        dev.alias);
      setLink(fromAlias,  fromSubslot,    "toIfaceSubslot",  dev.ifaceSubslot ?? 1);
      setLink(fromAlias,  fromSubslot,    "toPortSubslot",   port.subslot);
      setLink(dev.alias,  port.subslot,   "toDevice",        fromAlias);
      setLink(dev.alias,  port.subslot,   "toIfaceSubslot",  fromDev?.ifaceSubslot ?? 1);
      setLink(dev.alias,  port.subslot,   "toPortSubslot",   fromSubslot);
      setPendingEdge(null);
    } else if (!pendingEdge) {
      const pos = nodePos[dev.alias] || { x: 0, y: 0 };
      const { x, y } = rcPortXY(pos, portIdx);
      setPendingEdge({ fromAlias: dev.alias, fromSubslot: port.subslot, fromPortIdx: portIdx, mx: x, my: y });
    }
  }

  // Build deduplicated bezier edges
  const edgeElems   = [];
  const drawnEdges  = new Set();
  const ROLE_COLORS = { 0: "#94a3b8", 1: "#dc2626", 2: "#2563eb", 3: "#d97706" };

  for (const dev of ringDevices) {
    const fromPos = nodePos[dev.alias];
    if (!fromPos) continue;
    for (let pi = 0; pi < dev.ports.length; pi++) {
      const port = dev.ports[pi];
      const link = links.get(`${dev.alias}:${port.subslot}`);
      if (!link?.toDevice) continue;
      const toDev = ringDevices.find(d => d.alias === link.toDevice);
      if (!toDev) continue;
      const toPos = nodePos[link.toDevice];
      if (!toPos) continue;
      const toPortIdx = toDev.ports.findIndex(p => p.subslot === link.toPortSubslot);
      if (toPortIdx < 0) continue;

      const edgeKey = [dev.alias + ":" + port.subslot, link.toDevice + ":" + link.toPortSubslot].sort().join("|");
      if (drawnEdges.has(edgeKey)) continue;
      drawnEdges.add(edgeKey);

      const from  = rcPortXY(fromPos, pi);
      const to    = rcPortXY(toPos, toPortIdx);
      const rev   = links.get(`${link.toDevice}:${link.toPortSubslot}`);
      const isBidi = rev?.toDevice === dev.alias && rev?.toPortSubslot === port.subslot;
      const col   = isBidi ? "#16a34a" : "#f59e0b";

      // Quadratic bezier: handle (hx,hy) is where the curve visually peaks.
      // Default handle = midpoint offset perpendicular by 40px (alternating side).
      // When user drags the handle, we store (hx, hy) = absolute SVG coords of the handle.
      // The quadratic control point that produces the desired handle position:
      //   cp = 2·handle − 0.5·(from + to)
      // which satisfies: midpoint@t=0.5 of Q(from, cp, to) = 0.25·from + 0.5·cp + 0.25·to = handle
      const off  = edgeOffsets[edgeKey];
      const defMidX = (from.x + to.x) / 2;
      const defMidY = (from.y + to.y) / 2;
      // Default perpendicular offset so parallel edges between same nodes don't overlap
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpDir = ((pi + toPortIdx) % 2 === 0 ? 1 : -1);
      const perpOff = 50 + (pi + toPortIdx) * 15;
      const hx = off ? off.hx : defMidX + (-dy / len) * perpOff * perpDir;
      const hy = off ? off.hy : defMidY + ( dx / len) * perpOff * perpDir;
      // Quadratic control point from handle
      const cpx  = 2 * hx - 0.5 * (from.x + to.x);
      const cpy  = 2 * hy - 0.5 * (from.y + to.y);
      const path = `M ${from.x} ${from.y} Q ${cpx} ${cpy} ${to.x} ${to.y}`;

      const fromLbl = (port.label || `P${pi + 1}`).replace(/^Port\s+/i, "P");
      const toLbl   = (toDev.ports[toPortIdx]?.label || `P${toPortIdx + 1}`).replace(/^Port\s+/i, "P");
      const edgeTxt = `${dev.alias.slice(0, 7)}:${fromLbl} ↔ ${toDev.alias.slice(0, 7)}:${toLbl}`;
      const isEdgeDragging = edgeDragging?.edgeKey === edgeKey;

      function startEdgeDrag(e) {
        e.stopPropagation();
        const { x, y } = getSvgXY(e);
        // Store offset from cursor to handle so the handle jumps exactly to cursor
        setEdgeDragging({ edgeKey, ox: x - hx, oy: y - hy });
      }

      edgeElems.push(
        <g key={edgeKey}>
          <path d={path} fill="none" stroke={col} strokeWidth={2}
            strokeDasharray={isBidi ? undefined : "6 3"} />
          {/* Invisible wider hit-area — drag anywhere on the line */}
          <path d={path} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: "grab" }}
            onMouseDown={startEdgeDrag} />
          {/* Draggable handle at the visual midpoint of the curve */}
          <circle cx={hx} cy={hy} r={7}
            fill={isEdgeDragging ? "#2563eb" : "white"}
            stroke={isEdgeDragging ? "#1d4ed8" : col}
            strokeWidth={1.5} style={{ cursor: "grab" }}
            onMouseDown={startEdgeDrag}>
            <title>Drag to reshape this connection line</title>
          </circle>
          {/* Edge label above the handle */}
          <rect x={hx - edgeTxt.length * 2.9} y={hy - 22} width={edgeTxt.length * 5.8} height={13}
            fill="white" opacity={0.88} rx={2} pointerEvents="none" />
          <text x={hx} y={hy - 11} textAnchor="middle" fontSize={9} fill={col} fontWeight={500}
            style={{ pointerEvents: "none", userSelect: "none" }}>
            {edgeTxt}
          </text>
        </g>
      );
    }
  }

  const selectedDev = selectedAlias ? ringDevices.find(d => d.alias === selectedAlias) : null;

  return (
    <div style={{ display: "flex", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
      {/* Scrollable SVG canvas */}
      <div style={{ flex: 1, overflow: "auto", background: "#f8fafc", minHeight: 480 }}>
        <svg ref={svgRef} viewBox="0 0 920 580" width={920} height={580}
          style={{ display: "block", cursor: (dragging || edgeDragging) ? "grabbing" : "default" }}
          onMouseMove={onSvgMouseMove}
          onMouseUp={() => { setDragging(null); setEdgeDragging(null); }}
          onClick={() => { if (!dragging) { setSelectedAlias(null); setPendingEdge(null); } }}>

          {/* Edges first (below nodes) */}
          {edgeElems}

          {/* In-progress edge */}
          {pendingEdge && (() => {
            const fd = ringDevices.find(d => d.alias === pendingEdge.fromAlias);
            const fp = nodePos[pendingEdge.fromAlias];
            if (!fd || !fp) return null;
            const { x, y } = rcPortXY(fp, pendingEdge.fromPortIdx);
            return <line x1={x} y1={y} x2={pendingEdge.mx} y2={pendingEdge.my}
              stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />;
          })()}

          {/* Nodes */}
          {ringDevices.map(dev => {
            const pos  = nodePos[dev.alias] || { x: 30, y: 30 };
            const role = roles.get(dev.alias)?.role ?? 0;
            const rc   = ROLE_COLORS[role] || "#94a3b8";
            const sel  = selectedAlias === dev.alias;
            const nh   = rcNodeH(dev.ports.length);
            return (
              <g key={dev.alias} onMouseDown={e => onNodeMouseDown(e, dev.alias)} style={{ cursor: "grab" }}>
                {/* Box */}
                <rect x={pos.x} y={pos.y} width={RC_W} height={nh} rx={6}
                  fill={sel ? "#eff6ff" : "#ffffff"}
                  stroke={sel ? "#2563eb" : "#cbd5e1"} strokeWidth={sel ? 2 : 1.5} />
                {/* Role color accent */}
                <rect x={pos.x + 1} y={pos.y + 1} width={RC_W - 2} height={5} rx={2} fill={rc} />
                {/* Device name */}
                <text x={pos.x + RC_W / 2} y={pos.y + 22} textAnchor="middle"
                  fontSize={11} fontWeight={700} fill="#1e293b"
                  style={{ pointerEvents: "none", userSelect: "none" }}>
                  {dev.alias.length > 15 ? dev.alias.slice(0, 13) + "…" : dev.alias}
                </text>

                {/* Port rows */}
                {dev.ports.map((port, pi) => {
                  const { x: px, y: py } = rcPortXY(pos, pi);
                  const link    = links.get(`${dev.alias}:${port.subslot}`);
                  const hasLink = !!link?.toDevice;
                  const isSrc   = pendingEdge?.fromAlias === dev.alias && pendingEdge?.fromSubslot === port.subslot;
                  // Short label: strip "Port " prefix
                  const shortLbl = (port.label || `Port ${pi + 1}`).replace(/^Port\s+/i, "P");
                  return (
                    <g key={port.subslot}>
                      {/* Port name inside node, right-aligned */}
                      <text x={px - 9} y={py + 4} textAnchor="end" fontSize={9}
                        fill={hasLink ? "#374151" : "#9ca3af"}
                        style={{ pointerEvents: "none", userSelect: "none" }}>
                        {shortLbl}
                      </text>
                      {/* Separator line between port rows */}
                      {pi > 0 && (
                        <line x1={pos.x + 4} y1={py - RC_PORT_PITCH / 2}
                              x2={pos.x + RC_W - 4} y2={py - RC_PORT_PITCH / 2}
                              stroke="#f1f5f9" strokeWidth={1} pointerEvents="none" />
                      )}
                      {/* Large transparent hit area */}
                      <circle cx={px} cy={py} r={RC_PORT_R + 7} fill="transparent"
                        style={{ cursor: "crosshair" }}
                        onClick={e => onPortClick(e, dev, pi, port)} />
                      {/* Visible port dot */}
                      <circle cx={px} cy={py} r={RC_PORT_R}
                        fill={isSrc ? "#2563eb" : hasLink ? "#bbf7d0" : "#f1f5f9"}
                        stroke={isSrc ? "#1d4ed8" : hasLink ? "#16a34a" : "#94a3b8"}
                        strokeWidth={1.5} pointerEvents="none" />
                      <title>{port.label || `Port ${port.subslot}`}{hasLink ? ` → ${link.toDevice}` : " (unconnected)"}</title>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {ringDevices.length === 0 && (
            <text x="460" y="280" textAnchor="middle" fontSize={13} fill="#94a3b8">
              No ring devices — assign MRP roles in Step 2 first
            </text>
          )}

          {/* Drawing hint banner */}
          {pendingEdge && (
            <>
              <rect x={0} y={0} width={920} height={24} fill="#eff6ff" opacity={0.93} pointerEvents="none" />
              <text x="460" y="16" textAnchor="middle" fontSize={11} fill="#2563eb" fontWeight={500} pointerEvents="none">
                Click a port ● on another device to connect · Esc to cancel
              </text>
            </>
          )}

          {/* Legend */}
          <g transform="translate(14, 555)">
            <circle cx={6}  cy={6} r={5} fill="#bbf7d0" stroke="#16a34a" strokeWidth={1.5} />
            <text x={16} y={10} fontSize={9} fill="#64748b">= connected port</text>
            <circle cx={96} cy={6} r={5} fill="#f1f5f9" stroke="#94a3b8" strokeWidth={1.5} />
            <text x={106} y={10} fontSize={9} fill="#64748b">= unconnected</text>
            <line x1={196} y1={6} x2={220} y2={6} stroke="#16a34a" strokeWidth={2} />
            <text x={224} y={10} fontSize={9} fill="#64748b">= bidirectional link</text>
            <line x1={326} y1={6} x2={350} y2={6} stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 3" />
            <text x={354} y={10} fontSize={9} fill="#64748b">= one-way only</text>
          </g>
        </svg>
      </div>

      {/* Side panel — port connection detail for selected node */}
      {selectedDev && (
        <div style={{ width: 240, flexShrink: 0, borderLeft: "1px solid #e2e8f0", background: "#fff", padding: 14, fontSize: 13, overflowY: "auto" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#1e293b", paddingBottom: 8, marginBottom: 10, borderBottom: "1px solid #f1f5f9" }}>
            {selectedDev.alias}
          </div>

          <label style={{ display: "block", color: "#6b7280", fontSize: 11, marginBottom: 3 }}>MRP Role</label>
          <select style={{ width: "100%", padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 5, fontSize: 12, marginBottom: 14 }}
            value={roles.get(selectedDev.alias)?.role ?? 0}
            onChange={e => setRole(selectedDev.alias, parseInt(e.target.value, 10))}>
            {MRP_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>

          <div style={{ fontWeight: 600, fontSize: 12, color: "#374151", marginBottom: 8 }}>
            Port Connections ({selectedDev.ports.filter(p => !!links.get(`${selectedDev.alias}:${p.subslot}`)?.toDevice).length}/{selectedDev.ports.length} connected)
          </div>

          {selectedDev.ports.length === 0 && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>No ports detected</div>
          )}
          {selectedDev.ports.map((port, pi) => {
            const lKey    = `${selectedDev.alias}:${port.subslot}`;
            const link    = links.get(lKey);
            const toDev   = link?.toDevice ? ringDevices.find(d => d.alias === link.toDevice) : null;
            const toPort  = toDev?.ports.find(p => p.subslot === link.toPortSubslot);
            const connected = !!link?.toDevice;
            return (
              <div key={port.subslot} style={{
                marginBottom: 6, padding: "8px 10px",
                background: connected ? "#f0fdf4" : "#f8fafc",
                border: `1px solid ${connected ? "#bbf7d0" : "#e2e8f0"}`,
                borderRadius: 6, fontSize: 12,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <span style={{ fontWeight: 600, color: "#1e293b" }}>
                    {port.label || `Port ${pi + 1}`}
                  </span>
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>ss{port.subslot}</span>
                </div>
                {connected ? (
                  <>
                    <div style={{ color: "#15803d", fontSize: 11, marginBottom: 1 }}>→ {link.toDevice}</div>
                    <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 5 }}>
                      {toPort?.label || `Port ss${link.toPortSubslot}`}
                    </div>
                    <button
                      style={{ fontSize: 11, padding: "2px 8px", background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", borderRadius: 4, cursor: "pointer" }}
                      onClick={() => {
                        const rev = links.get(`${link.toDevice}:${link.toPortSubslot}`);
                        if (rev?.toDevice === selectedDev.alias) {
                          setLink(link.toDevice, link.toPortSubslot, "toDevice",       "");
                          setLink(link.toDevice, link.toPortSubslot, "toPortSubslot",  2);
                        }
                        setLink(selectedDev.alias, port.subslot, "toDevice",       "");
                        setLink(selectedDev.alias, port.subslot, "toPortSubslot",  2);
                      }}>✕ Disconnect</button>
                  </>
                ) : (
                  <div style={{ color: "#94a3b8", fontSize: 11 }}>Not connected — click port dot to wire</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── MRP Panel ─────────────────────────────────────────────────────────────────
const MRP_ROLES = [
  { value: 0, label: "0 – Not participating (Auto/disabled)" },
  { value: 1, label: "1 – Manager (active ring master)" },
  { value: 2, label: "2 – Client (ring participant)" },
  { value: 3, label: "3 – Manager Auto (auto-negotiate MRM)" },
];

function mrpRoleLabel(v) {
  return MRP_ROLES.find(r => r.value === v)?.label ?? "Off";
}

function MrpPanel({ importId, fieldbuses, stations, controllers, templates }) {
  const [cfgPortMap,   setCfgPortMap]   = useState({});  // alias → ports[] from CFG (optional enrichment)
  const [cfgDeviceMap, setCfgDeviceMap] = useState({}); // subsystemNo → { alias, rackSlot, ifaceSubslot, subnetName } from CFG parser
  const [cfgSubnetMap, setCfgSubnetMap] = useState({}); // "addr:N" → subnetName for IO devices
  const [domainName,  setDomainName]  = useState("mrpdomain-1");
  const [fieldbusNo,  setFieldbusNo]  = useState(null);
  const [roles,       setRoles]       = useState(new Map());
  const [links,       setLinks]       = useState(new Map());

  const [screen,      setScreen]      = useState(1);
  const [portView,    setPortView]    = useState("canvas"); // "canvas" | "form"
  const [nodePos,     setNodePos]     = useState(() => {
    try { return JSON.parse(localStorage.getItem(`mrp_nodePos_${importId}`) || '{}'); } catch { return {}; }
  });
  const [edgeOffsets, setEdgeOffsets] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`mrp_edgeOffsets_${importId}`) || '{}'); } catch { return {}; }
  });
  const [loading,     setLoading]     = useState("");
  const [error,       setError]       = useState("");
  const [saved,       setSaved]       = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Derive port list for a station from its slot-0 template's port_config.
  // Same logic as StationDetailPanel: parse port_config, keep subslots ≥ 2.
  function stationPorts(st) {
    const imSlot = (st.slots || []).find(s => s.slot === 0);
    if (!imSlot) return cfgPortMap[`addr:${st.address}`] || [];
    let tpl = (templates || []).find(t => t.order_no === imSlot.orderNo);
    // Fallback for GSDML-path order_no (Scalance stations)
    if (!tpl && /^GSDML-.*\.xml<DAP/.test(imSlot.orderNo)) {
      const gsdmlFile = imSlot.orderNo.replace(/<DAP[\s\S]*/, '').trim();
      tpl = (templates || []).find(t => t.family === 'Scalance' && t.gsdml_file === gsdmlFile);
    }
    if (!tpl || !tpl.port_config) return cfgPortMap[`addr:${st.address}`] || [];
    try {
      const parsed = JSON.parse(tpl.port_config);
      const isScalance = tpl.family === 'Scalance' || tpl.family === 'SCALANCE';
      // Scalance: port_config has {type:'port'} entries; ET200: all entries are ports (subslot >= 2)
      const portArr = isScalance ? parsed.filter(p => p.type === 'port') : parsed.filter(p => p.subslot >= 2);
      if (portArr.length > 0) return portArr.map(p => ({ subslot: p.subslot, label: p.label || p.name || `Port ${p.subslot}` }));
    } catch (_) {}
    return cfgPortMap[`addr:${st.address}`] || [];
  }

  // Build device list directly from stations already loaded in HW Config.
  const devices = React.useMemo(() => {
    const list = [];
    // Controllers (CPUs) — one entry per PN-IO interface (one per fieldbus)
    for (const ctrl of (controllers || [])) {
      const alias = ctrl.T16_Controller_TagName || ctrl.name || `CPU-${ctrl.id}`;
      if (fieldbuses.length === 0) {
        list.push({ alias, ioAddress: null, rackSlot: null, ifaceSubslot: null, ports: [], isSwitch: false, deviceType: "cpu", subsystemNo: null });
      } else {
        for (const fb of fieldbuses) {
          const sno     = fb.INT_DP_Subsystem;
          const ports   = cfgPortMap[`cpu:${sno}`] || [];
          const cfgDev  = cfgDeviceMap[sno];
          const label   = fieldbuses.length > 1 ? `${alias} (${fb.T50_Fieldbus_Name || `SS${sno}`})` : alias;
          // subnetName: prefer CFG LINKED_SUBNETNAME, fallback to fieldbus table name
          const subnetName = cfgDev?.subnetName ?? fb.T50_Fieldbus_Name ?? null;
          list.push({
            alias: label,
            cfgAlias: cfgDev?.alias ?? null,   // real PN-IO subslot name used in LINKED_PORT
            ioAddress: null,
            rackSlot: cfgDev?.rackSlot ?? null,
            ifaceSubslot: cfgDev?.ifaceSubslot ?? null,
            ports, isSwitch: false, deviceType: "cpu", subsystemNo: sno,
            subnetName,
          });
        }
      }
    }
    // IO stations — ports from template port_config, CFG parser as fallback
    for (const st of (stations || [])) {
      const alias = st.name || st.deviceName || `Station-${st.address}`;
      const ports = stationPorts(st);
      const subnetName = cfgSubnetMap[`addr:${st.address}`] ?? null;
      list.push({ alias, ioAddress: st.address, rackSlot: null, ifaceSubslot: null, ports, isSwitch: false, deviceType: "device", subsystemNo: st.subsystemNo, subnetName });
    }
    return list;
  }, [controllers, stations, fieldbuses, templates, cfgPortMap, cfgDeviceMap, cfgSubnetMap]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fieldbuses.length > 0 && fieldbusNo == null) {
      setFieldbusNo(fieldbuses[0].INT_DP_Subsystem);
    }
  }, [fieldbuses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist canvas layout to localStorage so moves survive page refresh
  useEffect(() => {
    if (!importId || !Object.keys(nodePos).length) return;
    localStorage.setItem(`mrp_nodePos_${importId}`, JSON.stringify(nodePos));
  }, [nodePos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!importId) return;
    localStorage.setItem(`mrp_edgeOffsets_${importId}`, JSON.stringify(edgeOffsets));
  }, [edgeOffsets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!importId) return;
    // Load saved MRP config and optionally enrich port info from CFG parser
    Promise.all([
      mrpGetDevices(importId).catch(() => ({ devices: [] })),
      mrpGetConfig(importId).catch(() => null),
    ]).then(([devData, cfg]) => {
      // Build a port map keyed by ioAddress (for IO devices) or subsystemNo (for CPU).
      // Station names in the DB rarely match CFG aliases, so key by address instead.
      const pm = {};
      const dm = {};
      const sm = {}; // "addr:N" → subnetName for IO devices
      for (const d of (devData.devices || [])) {
        if (d.ioAddress != null) {
          if (d.ports && d.ports.length > 0) pm[`addr:${d.ioAddress}`] = d.ports;
          if (d.subnetName) sm[`addr:${d.ioAddress}`] = d.subnetName;
        } else if (d.subsystemNo != null) {
          if (d.ports && d.ports.length > 0) pm[`cpu:${d.subsystemNo}`] = d.ports;
          // Store real CFG alias, rackSlot, ifaceSubslot and subnetName keyed by subsystemNo
          dm[d.subsystemNo] = { alias: d.alias, rackSlot: d.rackSlot, ifaceSubslot: d.ifaceSubslot, subnetName: d.subnetName ?? null };
        }
      }
      setCfgPortMap(pm);
      setCfgDeviceMap(dm);
      setCfgSubnetMap(sm);

      if (cfg) {
        setDomainName(cfg.domain_name || "mrpdomain-1");
        if (cfg.fieldbus_no != null) setFieldbusNo(cfg.fieldbus_no);
        // DB stores cfgAlias for CPU (e.g. "PN-IO-X8") and raw alias without #N for
        // switch sub-rows (e.g. "S2"). The UI keys roles AND links by display alias
        // (e.g. "AS01 (Fieldbus)") and sub-row alias (e.g. "S2#0"). Reverse-map here.

        // 1. CPU: cfgAlias → UI display alias (mirrors devices useMemo label logic)
        const cfgAliasToUi = new Map();
        for (const ctrl of (controllers || [])) {
          const ctrlAlias = ctrl.T16_Controller_TagName || ctrl.name || `CPU-${ctrl.id}`;
          for (const fb of (fieldbuses || [])) {
            const sno = fb.INT_DP_Subsystem;
            const cfgDev = dm[sno];
            if (cfgDev?.alias) {
              const uiLabel = (fieldbuses || []).length > 1
                ? `${ctrlAlias} (${fb.T50_Fieldbus_Name || `SS${sno}`})`
                : ctrlAlias;
              cfgAliasToUi.set(cfgDev.alias, uiLabel);
            }
          }
        }

        // 2. Switch sub-rows: "rawAlias:portSubslot" → "rawAlias#N".
        // Built from the grid's own device list (derived from the backfilled stations)
        // so it works even when the baseline CFG stored in the DB has no IO devices.
        // The CFG-parser port list (pm) is merged first as a fallback for any device
        // not yet present in the grid; grid entries override it (same key, same value).
        const portSubslotToRowAlias = new Map();
        const addSubRows = (alias, physPorts) => {
          const ringCount = Math.max(1, Math.floor(physPorts.length / 2));
          if (ringCount <= 1) return;
          for (let i = 0; i < ringCount; i++) {
            for (const p of physPorts.slice(i * 2, i * 2 + 2)) {
              portSubslotToRowAlias.set(`${alias}:${p.subslot}`, `${alias}#${i}`);
            }
          }
        };
        for (const d of (devData.devices || [])) {
          if (d.ioAddress != null) {
            addSubRows(d.alias, (pm[`addr:${d.ioAddress}`] || []).filter(p => /port/i.test(p.label || '')));
          }
        }
        for (const d of devices) {
          addSubRows(d.alias, (d.ports ?? []).filter(p => /port/i.test(p.label || '')));
        }

        function dbAliasToUi(dbDevice, portSubslot) {
          const plain = dbDevice.replace(/#\d+$/, '');
          const rowKey = portSubslotToRowAlias.get(`${plain}:${portSubslot}`);
          if (rowKey) return rowKey;
          return cfgAliasToUi.get(plain) ?? plain;
        }

        // Roles — reverse-map each saved role onto its grid row key. For switches the
        // ring port picks which sub-row (#N) the role belongs to; CPU/IO devices map
        // by their display alias.
        const rMap = new Map();
        for (const r of cfg.roles || []) {
          const uiKey = dbAliasToUi(r.device_alias, r.ring_port_1 ?? r.ring_port_2);
          rMap.set(uiKey, { role: r.mrp_role, mrpInstances: r.mrp_instances, ringPort1: r.ring_port_1 ?? null, ringPort2: r.ring_port_2 ?? null });
        }
        setRoles(rMap);

        const lMap = new Map();
        for (const l of cfg.links || []) {
          const fromUi = dbAliasToUi(l.from_device, l.from_port_subslot);
          const toUi   = dbAliasToUi(l.to_device,   l.to_port_subslot);
          lMap.set(`${fromUi}:${l.from_port_subslot}`, {
            toDevice: toUi, toIfaceSubslot: l.to_iface_subslot, toPortSubslot: l.to_port_subslot,
          });
        }
        setLinks(lMap);
      }
      setLoading("");
    }).catch(e => { setError(e.message); setLoading(""); });
  }, [importId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive the subnet name for the currently selected fieldbus so screen 2 can
  // filter devices to only those connected to that network.
  const selectedFieldbus = fieldbuses.find(fb => fb.INT_DP_Subsystem === fieldbusNo) ?? null;
  const selectedSubnetName = selectedFieldbus?.T50_Fieldbus_Name ?? null;

  // Filter devices to those whose LINKED_SUBNETNAME matches the selected fieldbus,
  // or include all if subnet info is missing (e.g. no LINKED_SUBNETNAME in CFG).
  const filteredDevices = React.useMemo(() => {
    if (!selectedSubnetName) return devices;
    // A device matches if its subnetName equals the selected fieldbus name (case-insensitive),
    // or if subnetName is null (subnet info not available from CFG — don't hide it).
    return devices.filter(d =>
      d.subnetName == null ||
      d.subnetName.toLowerCase() === selectedSubnetName.toLowerCase()
    );
  }, [devices, selectedSubnetName]); // eslint-disable-line react-hooks/exhaustive-deps

  const allPortDevices  = filteredDevices.filter(d => d.ports && d.ports.length > 0);

  // Expanded flat list matching the sub-row logic in the Device Roles table.
  // Each entry has alias = row key (e.g. "SCALANCE-1#0"), ports = the 2-port slice for that ring.
  const expandedDevices = React.useMemo(() => {
    const rows = [];
    for (const dev of devices) {
      const physPorts = (dev.ports ?? []).filter(p => /port/i.test(p.label));
      const ringCount = Math.max(1, Math.floor(physPorts.length / 2));
      for (let i = 0; i < ringCount; i++) {
        const rowKey   = ringCount > 1 ? `${dev.alias}#${i}` : dev.alias;
        const rowPorts = ringCount > 1 ? physPorts.slice(i * 2, i * 2 + 2) : physPorts;
        rows.push({ ...dev, alias: rowKey, displayAlias: dev.alias, ringLabel: ringCount > 1 ? `Ring ${i + 1}` : null, ports: rowPorts });
      }
    }
    return rows;
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps


  function setRole(alias, role) {
    setRoles(prev => {
      const next = new Map(prev);
      const existing = next.get(alias) || { role: 0, mrpInstances: 0, ringPort1: null, ringPort2: null };
      next.set(alias, { ...existing, role, mrpInstances: (role === 1 || role === 3) ? 1 : 0 });
      return next;
    });
    setSaved(false);
  }

  function setRingPort(alias, field, subslot) {
    setRoles(prev => {
      const next = new Map(prev);
      const existing = next.get(alias) || { role: 0, mrpInstances: 0, ringPort1: null, ringPort2: null };
      next.set(alias, { ...existing, [field]: subslot });
      return next;
    });
    setSaved(false);
  }

  function setLink(fromAlias, fromPortSubslot, field, value) {
    const key = `${fromAlias}:${fromPortSubslot}`;
    setLinks(prev => {
      const next = new Map(prev);
      const existing = next.get(key) || { toDevice: "", toIfaceSubslot: 1, toPortSubslot: 2 };
      next.set(key, { ...existing, [field]: value });
      return next;
    });
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true); setError("");
    try {
      const rolesArr = [...roles.entries()].map(([alias, r]) => {
        const dev = expandedDevices.find(d => d.alias === alias);
        return { deviceAlias: alias, ioAddress: dev?.ioAddress ?? null, subsystemNo: dev?.subsystemNo ?? null, mrpRole: r.role, mrpInstances: r.mrpInstances, ringPort1: r.ringPort1 ?? null, ringPort2: r.ringPort2 ?? null };
      });
      const linksArr = [...links.entries()].map(([key, l]) => {
        const [fromDevice, fromPortSubslot] = key.split(":");
        const fromDev = expandedDevices.find(d => d.alias === fromDevice);
        const toDev   = expandedDevices.find(d => d.alias === (l.toDevice || "").replace(/#\d+$/, ''));
        // Use cfgAlias (real PN-IO subslot name) if available, else the display alias
        const realFrom = (fromDev?.cfgAlias ?? fromDevice).replace(/#\d+$/, '');
        const realTo   = toDev?.cfgAlias ?? (l.toDevice || "").replace(/#\d+$/, '');
        return {
          fromDevice: realFrom, fromIfaceSubslot: fromDev?.ifaceSubslot ?? 1,
          fromPortSubslot: parseInt(fromPortSubslot, 10),
          toDevice: realTo, toIfaceSubslot: l.toIfaceSubslot, toPortSubslot: l.toPortSubslot,
        };
      });
      const stationName = controllers[0]?.T16_Controller_TagName || "";
      await mrpSaveConfig(importId, { domainName, fieldbusNo, stationName, roles: rolesArr, links: linksArr });
      setSaved(true);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function handleDownload() {
    setDownloading(true); setError("");
    try {
      // Always regenerate the HW Config CFG before applying MRP, so all IO devices
      // are present in the source (the cached CFG may be stale or absent).
      await generateHwCfg(importId);
      await mrpDownloadCfg(importId);
    }
    catch (e) { setError(e.message); }
    finally { setDownloading(false); }
  }

  const ringDevices = expandedDevices.filter(d => (roles.get(d.alias)?.role ?? 0) !== 0);

  function validateRing() {
    const issues = [];
    for (const dev of ringDevices) {
      for (const port of dev.ports || []) {
        const key = `${dev.alias}:${port.subslot}`;
        const link = links.get(key);
        if (!link || !link.toDevice) issues.push(`${dev.alias} port (subslot ${port.subslot}) has no connection`);
      }
    }
    return issues;
  }

  const ringIssues = validateRing();
  const canDownload = saved && ringIssues.length === 0;

  if (!importId) {
    return <div style={mrpSt.notice}>No HW import found. Upload a baseline CFG in the Import tab first.</div>;
  }
  if (loading) return <div style={mrpSt.notice}>{loading}</div>;

  return (
    <div>
      <h3 style={{ margin: "0 0 16px 0", fontSize: 16, fontWeight: 600 }}>MRP Ring Configuration</h3>

      <div style={mrpSt.tabs}>
        {["1. Domain & Fieldbus", "2. Device Roles", "3. Port Connections"].map((label, idx) => (
          <button key={idx}
            style={{ ...mrpSt.tab, ...(screen === idx + 1 ? mrpSt.tabActive : {}) }}
            onClick={() => setScreen(idx + 1)}
          >{label}</button>
        ))}
      </div>

      {error && <div style={mrpSt.error}>{error}</div>}

      {screen === 1 && (
        <div style={mrpSt.section}>
          <label style={mrpSt.label}>MRP Domain Name</label>
          <input style={mrpSt.input} value={domainName}
            onChange={e => { setDomainName(e.target.value); setSaved(false); }}
            placeholder="mrpdomain-1" />

          <label style={{ ...mrpSt.label, marginTop: 16 }}>Fieldbus</label>
          <select style={mrpSt.input} value={fieldbusNo ?? ""}
            onChange={e => { setFieldbusNo(parseInt(e.target.value, 10)); setSaved(false); }}>
            <option value="">— select fieldbus —</option>
            {fieldbuses.map(fb => (
              <option key={fb.id} value={fb.INT_DP_Subsystem}>
                {fb.T50_Fieldbus_Name
                  ? `${fb.T50_Fieldbus_Name} (IOSUBSYSTEM ${fb.INT_DP_Subsystem})`
                  : `IOSUBSYSTEM ${fb.INT_DP_Subsystem}`}
              </option>
            ))}
          </select>

          <p style={{ ...mrpSt.hint, marginTop: 20 }}>
            The domain name and fieldbus selected here will be used for all ring devices.
          </p>
          <div style={mrpSt.row}>
            <button style={mrpSt.btnPrimary} onClick={() => setScreen(2)}>Next: Device Roles →</button>
          </div>
        </div>
      )}

      {screen === 2 && (
        <div style={mrpSt.section}>
          <p style={mrpSt.hint}>Assign an MRP role to each device. Devices with "Off" are excluded from the ring.</p>
          {filteredDevices.length === 0 && (
            <div style={mrpSt.notice}>No devices found. Check that the baseline CFG has IOSUBSYSTEM devices.</div>
          )}
          <table style={mrpSt.table}>
            <thead>
              <tr>
                <th style={mrpSt.th}>Device</th>
                <th style={mrpSt.th}>IO Address / Type</th>
                <th style={mrpSt.th}>Subnet</th>
                <th style={mrpSt.th}>Ports</th>
                <th style={mrpSt.th}>Sub-ring</th>
                <th style={mrpSt.th}>Ring Port 1</th>
                <th style={mrpSt.th}>Ring Port 2</th>
                <th style={mrpSt.th}>MRP Role</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.flatMap(dev => {
                const physPorts = (dev.ports ?? []).filter(p => /port/i.test(p.label));
                const ringCount = Math.max(1, Math.floor(physPorts.length / 2));

                return Array.from({ length: ringCount }, (_, i) => {
                  const rowKey   = ringCount > 1 ? `${dev.alias}#${i}` : dev.alias;
                  const rowLabel = ringCount > 1 ? `Ring ${i + 1}` : null;
                  // Ports available for this sub-row: pairs [p0, p1] for switches
                  const rowPorts = ringCount > 1 ? physPorts.slice(i * 2, i * 2 + 2) : physPorts;
                  const currentRole = roles.get(rowKey)?.role ?? 0;

                  const deviceCell = i === 0 ? (
                    <td style={mrpSt.td} rowSpan={ringCount}><b>{dev.alias}</b></td>
                  ) : null;
                  const addrCell = i === 0 ? (
                    <td style={mrpSt.td} rowSpan={ringCount}>
                      {dev.ioAddress != null ? `IOADDR ${dev.ioAddress}` : `Rack slot ${dev.rackSlot}`}
                      {dev.isSwitch ? " (Switch)" : ""}
                    </td>
                  ) : null;
                  const subnetCell = i === 0 ? (
                    <td style={mrpSt.td} rowSpan={ringCount}>
                      {dev.subnetName
                        ? <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 10, background: "#e0f2fe", color: "#0369a1", fontWeight: 500 }}>{dev.subnetName}</span>
                        : <span style={{ color: "#9ca3af", fontSize: 11 }}>—</span>}
                    </td>
                  ) : null;
                  const portsCell = i === 0 ? (
                    <td style={mrpSt.td} rowSpan={ringCount}>{dev.ports?.length ?? 0} port(s)</td>
                  ) : null;

                  return (
                    <tr key={rowKey} style={currentRole !== 0 ? mrpSt.rowActive : {}}>
                      {deviceCell}
                      {addrCell}
                      {subnetCell}
                      {portsCell}
                      <td style={{ ...mrpSt.td, color: "#6b7280", fontSize: 12 }}>{rowLabel ?? ""}</td>
                      <td style={mrpSt.td}>
                        <select style={mrpSt.select}
                          value={roles.get(rowKey)?.ringPort1 ?? ""}
                          onChange={e => setRingPort(rowKey, "ringPort1", e.target.value ? parseInt(e.target.value, 10) : null)}>
                          <option value="">— none —</option>
                          {rowPorts.map(p => <option key={p.subslot} value={p.subslot}>{p.label}</option>)}
                        </select>
                      </td>
                      <td style={mrpSt.td}>
                        <select style={mrpSt.select}
                          value={roles.get(rowKey)?.ringPort2 ?? ""}
                          onChange={e => setRingPort(rowKey, "ringPort2", e.target.value ? parseInt(e.target.value, 10) : null)}>
                          <option value="">— none —</option>
                          {rowPorts.map(p => <option key={p.subslot} value={p.subslot}>{p.label}</option>)}
                        </select>
                      </td>
                      <td style={mrpSt.td}>
                        <select style={mrpSt.select} value={currentRole}
                          onChange={e => setRole(rowKey, parseInt(e.target.value, 10))}>
                          {MRP_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
          <div style={mrpSt.row}>
            <button style={mrpSt.btnSecondary} onClick={() => setScreen(1)}>← Back</button>
            <button style={mrpSt.btnPrimary} onClick={() => setScreen(3)}>Next: Port Connections →</button>
          </div>
        </div>
      )}

      {screen === 3 && (
        <div style={mrpSt.section}>
          {/* View toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <p style={{ ...mrpSt.hint, margin: 0 }}>
              {portView === "canvas"
                ? "Drag nodes or connection lines to arrange · Click a port circle to start a connection · Click another port to complete"
                : "For each ring port, select which device and port it connects to (physical cable)."}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 16 }}>
              {portView === "canvas" && (
                <button style={{ padding: "5px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", color: "#374151", fontSize: 12, cursor: "pointer" }}
                  onClick={() => { setNodePos({}); setEdgeOffsets({}); }}
                  title="Reset all node and edge positions">
                  Reset Layout
                </button>
              )}
              <div style={{ display: "flex", border: "1px solid #d1d5db", borderRadius: 6, overflow: "hidden" }}>
                {[["canvas", "Ring Canvas"], ["form", "Form View"]].map(([v, lbl]) => (
                  <button key={v} style={{
                    padding: "5px 14px", border: "none", cursor: "pointer", fontSize: 13,
                    background: portView === v ? "#2563eb" : "#fff",
                    color: portView === v ? "#fff" : "#374151",
                    fontWeight: portView === v ? 600 : 400,
                  }} onClick={() => setPortView(v)}>{lbl}</button>
                ))}
              </div>
            </div>
          </div>

          {ringDevices.length === 0 && (
            <div style={mrpSt.notice}>No devices have MRP roles assigned. Go back to Device Roles.</div>
          )}

          {/* ── Ring Canvas ─────────────────────────────────────── */}
          {portView === "canvas" && (
            <RingCanvas
              ringDevices={ringDevices}
              roles={roles}
              links={links}
              setRole={setRole}
              setLink={setLink}
              nodePos={nodePos}
              setNodePos={setNodePos}
              edgeOffsets={edgeOffsets}
              setEdgeOffsets={setEdgeOffsets}
            />
          )}

          {/* ── Form View ───────────────────────────────────────── */}
          {portView === "form" && ringDevices.map(dev => (
            <div key={dev.alias} style={mrpSt.devCard}>
              <div style={mrpSt.devHeader}>
                <b>{dev.displayAlias ?? dev.alias}</b>
                {dev.ringLabel && <span style={{ marginLeft: 6, fontSize: 12, color: "#6b7280" }}>{dev.ringLabel}</span>}
                <span style={mrpSt.badge}>{mrpRoleLabel(roles.get(dev.alias)?.role ?? 0)}</span>
              </div>
              {(dev.ports || []).map(port => {
                const key = `${dev.alias}:${port.subslot}`;
                const link = links.get(key) || { toDevice: "", toIfaceSubslot: 1, toPortSubslot: 2 };
                const toDevObj = expandedDevices.find(d => d.alias === link.toDevice);
                return (
                  <div key={port.subslot} style={mrpSt.portRow}>
                    <span style={mrpSt.portLabel}>Port {port.label || port.subslot} (subslot {port.subslot})</span>
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>→ connects to</span>
                    <select style={mrpSt.selectSm} value={link.toDevice}
                      onChange={e => {
                        const newDev = allPortDevices.find(d => d.alias === e.target.value);
                        setLink(dev.alias, port.subslot, "toDevice", e.target.value);
                        if (newDev?.ports?.[0]) {
                          setLink(dev.alias, port.subslot, "toIfaceSubslot", newDev.ifaceSubslot ?? 1);
                          setLink(dev.alias, port.subslot, "toPortSubslot", newDev.ports[0].subslot);
                        }
                      }}>
                      <option value="">— device —</option>
                      {expandedDevices.filter(d => d.alias !== dev.alias && d.ports.length > 0).map(d => (
                        <option key={d.alias} value={d.alias}>{d.displayAlias ?? d.alias}{d.ringLabel ? ` (${d.ringLabel})` : ""}</option>
                      ))}
                    </select>
                    <select style={mrpSt.selectSm} value={link.toPortSubslot}
                      onChange={e => setLink(dev.alias, port.subslot, "toPortSubslot", parseInt(e.target.value, 10))}
                      disabled={!link.toDevice}>
                      {(toDevObj?.ports || []).map(p => (
                        <option key={p.subslot} value={p.subslot}>Port {p.label || p.subslot} (ss {p.subslot})</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          ))}

          {ringIssues.length > 0 && (
            <div style={mrpSt.warn}>
              <b>Ring validation issues:</b>
              <ul style={{ margin: "4px 0 0 0", paddingLeft: 20 }}>
                {ringIssues.map((issue, i) => <li key={i}>{issue}</li>)}
              </ul>
            </div>
          )}
          <div style={mrpSt.row}>
            <button style={mrpSt.btnSecondary} onClick={() => setScreen(2)}>← Back</button>
            <button style={saving ? mrpSt.btnDisabled : mrpSt.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : saved ? "✓ Saved" : "Save Configuration"}
            </button>
            <button
              style={(!canDownload || downloading) ? mrpSt.btnDisabled : mrpSt.btnSuccess}
              onClick={handleDownload} disabled={!canDownload || downloading}
              title={!saved ? "Save configuration first" : ringIssues.length > 0 ? "Fix ring issues first" : ""}>
              {downloading ? "Generating…" : "Generate CFG with MRP"}
            </button>
          </div>
          {saved && ringIssues.length === 0 && (
            <div style={{ marginTop: 12, color: "#15803d", fontSize: 13 }}>
              Configuration saved. Click <b>Generate CFG with MRP</b> to download the patched .cfg file.
            </div>
          )}
        </div>
      )}

    </div>
  );
}

const mrpSt = {
  tabs: { display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #e2e8f0" },
  tab: { padding: "8px 20px", border: "none", background: "none", cursor: "pointer", fontSize: 14, color: "#64748b", borderBottom: "2px solid transparent", marginBottom: -2 },
  tabActive: { color: "#2563eb", borderBottomColor: "#2563eb", fontWeight: 600 },
  section: { background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0", padding: 24 },
  label: { display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 },
  input: { display: "block", width: "100%", padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, boxSizing: "border-box", maxWidth: 400 },
  hint: { fontSize: 13, color: "#6b7280", marginBottom: 16 },
  notice: { padding: 20, color: "#6b7280", fontStyle: "italic" },
  error: { background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", padding: "10px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14 },
  warn: { background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", padding: "10px 14px", borderRadius: 6, marginTop: 16, fontSize: 13 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14, marginBottom: 20 },
  th: { textAlign: "left", padding: "8px 12px", borderBottom: "2px solid #e2e8f0", color: "#374151", fontWeight: 600, fontSize: 13 },
  td: { padding: "8px 12px", borderBottom: "1px solid #f1f5f9" },
  rowActive: { background: "#eff6ff" },
  select: { padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 5, fontSize: 13, minWidth: 200 },
  selectSm: { padding: "4px 8px", border: "1px solid #d1d5db", borderRadius: 5, fontSize: 13, minWidth: 120 },
  devCard: { border: "1px solid #e2e8f0", borderRadius: 8, marginBottom: 16, overflow: "hidden" },
  devHeader: { background: "#f8fafc", padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid #e2e8f0", fontSize: 14 },
  badge: { background: "#dbeafe", color: "#1d4ed8", padding: "2px 8px", borderRadius: 12, fontSize: 12, fontWeight: 500 },
  portRow: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid #f1f5f9", fontSize: 13, flexWrap: "wrap" },
  portLabel: { minWidth: 180, color: "#374151", fontWeight: 500 },
  row: { display: "flex", gap: 12, marginTop: 20, alignItems: "center" },
  btnPrimary: { padding: "9px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, fontSize: 14, cursor: "pointer", fontWeight: 500 },
  btnSecondary: { padding: "9px 20px", background: "#f1f5f9", color: "#374151", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, cursor: "pointer" },
  btnSuccess: { padding: "9px 20px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, fontSize: 14, cursor: "pointer", fontWeight: 500 },
  btnDisabled: { padding: "9px 20px", background: "#e5e7eb", color: "#9ca3af", border: "none", borderRadius: 6, fontSize: 14, cursor: "not-allowed" },
};

// ── Nav Panel (collapsible left sidebar) ──────────────────────────────────────
function NavPanel({ hwTab, setHwTab, controllers, selectedId, onSelect }) {
  const [collapsed, setCollapsed] = useState(false);

  const navBtn = (id, label) => {
    const active = hwTab === id;
    return (
      <button key={id} onClick={() => setHwTab(id)}
        style={{
          display: "block", width: "100%", textAlign: "left",
          padding: "8px 14px", border: "none", cursor: "pointer", fontSize: 13,
          fontWeight: active ? 700 : 400,
          background: active ? "#EEEDFE" : "transparent",
          color: active ? "#2255cc" : "var(--color-text-primary)",
          borderLeft: active ? "3px solid #2255cc" : "3px solid transparent",
        }}
      >{label}</button>
    );
  };

  if (collapsed) {
    return (
      <div style={{
        width: 32, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center",
        paddingTop: 6, gap: 8,
        borderRight: "0.5px solid var(--color-border-tertiary)",
      }}>
        <button onClick={() => setCollapsed(false)}
          title="Expand panel"
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#888", padding: 4 }}>
          ›
        </button>
      </div>
    );
  }

  return (
    <div style={{
      width: 210, flexShrink: 0,
      borderRight: "0.5px solid var(--color-border-tertiary)",
      display: "flex", flexDirection: "column",
      minHeight: 400,
    }}>
      {/* Collapse toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 8px 2px" }}>
        <button onClick={() => setCollapsed(true)}
          title="Collapse panel"
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#aaa", padding: "2px 4px" }}>
          ‹
        </button>
      </div>

      {/* Global actions */}
      <div style={{ paddingBottom: 8, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        {navBtn("import", "Import")}
        {navBtn("catalogue", "Catalogue")}
      </div>

      {/* Controllers section */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", paddingTop: 6 }}>
        <div style={{
          padding: "4px 14px 6px",
          fontSize: 10, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.06em", color: "var(--color-text-secondary)",
        }}>
          Controllers
        </div>
        {controllers.length === 0 ? (
          <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic" }}>
            Upload a CFG first
          </div>
        ) : controllers.map(c => {
          const isSelected = selectedId === c.id;
          const isActive = isSelected && (hwTab === "controller" || hwTab === "config" || hwTab === "mrp");
          return (
            <div key={c.id} onClick={() => onSelect(c.id)}
              style={{
                padding: "7px 14px", cursor: "pointer",
                borderLeft: isActive ? "3px solid #2255cc" : "3px solid transparent",
                background: isActive ? "#EEEDFE" : "transparent",
              }}>
              <div style={{ fontSize: 13, fontWeight: isActive ? 700 : 400,
                            color: isActive ? "#2255cc" : "var(--color-text-primary)",
                            fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {c.T16_Controller_TagName || "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>
                {c.T16_Station_Type || ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Import Workspace (Import + Column Mapping tabs) ───────────────────────────
function ImportWorkspace({
  // ImportPanel props
  baselineOk, baselineInfo, ioListOk, ioListInfo, importId,
  baselineRef, ioListRef, cfgBackfillRef,
  onBaselineChange, onIoListChange, onBaselineBtn, onIoListBtn,
  onBackfillFromCfg, onCfgBackfillChange, loading,
  // Column Mapping props
  excelHeaders, selectedColumns, setSelectedColumns,
  setError, setLoading, showColmap, onMappingComplete,
}) {
  const [subTab, setSubTab] = React.useState(showColmap ? 'colmap' : 'import');

  // Switch to colmap automatically when Excel is uploaded
  React.useEffect(() => {
    if (showColmap) setSubTab('colmap');
  }, [showColmap]);

  const tabStyle = (id) => ({
    padding: '8px 20px', fontSize: 13, border: 'none', borderBottom: subTab === id ? '2px solid #2255cc' : '2px solid transparent',
    background: 'transparent', cursor: 'pointer', fontWeight: subTab === id ? 700 : 400,
    color: subTab === id ? '#2255cc' : 'var(--color-text-secondary)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border-secondary)', flexShrink: 0 }}>
        <button style={tabStyle('import')} onClick={() => setSubTab('import')}>Import</button>
        {showColmap && (
          <button style={tabStyle('colmap')} onClick={() => setSubTab('colmap')}>Column Mapping</button>
        )}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {subTab === 'import' && (
          <ImportPanel
            baselineOk={baselineOk} baselineInfo={baselineInfo}
            ioListOk={ioListOk} ioListInfo={ioListInfo}
            importId={importId}
            baselineRef={baselineRef} ioListRef={ioListRef} cfgBackfillRef={cfgBackfillRef}
            onBaselineChange={onBaselineChange} onIoListChange={onIoListChange}
            onBaselineBtn={onBaselineBtn} onIoListBtn={onIoListBtn}
            onBackfillFromCfg={onBackfillFromCfg} onCfgBackfillChange={onCfgBackfillChange}
            loading={loading}
          />
        )}
        {subTab === 'colmap' && (
          <HwColumnMappingPanel
            importId={importId}
            excelHeaders={excelHeaders}
            selectedColumns={selectedColumns}
            setSelectedColumns={setSelectedColumns}
            setError={setError}
            setLoading={setLoading}
            loading={loading}
            onMappingComplete={onMappingComplete}
          />
        )}
      </div>
    </div>
  );
}

// ── Import Panel ───────────────────────────────────────────────────────────────
function ImportPanel({
  baselineOk, baselineInfo, ioListOk, ioListInfo, importId,
  baselineRef, ioListRef, cfgBackfillRef,
  onBaselineChange, onIoListChange, onBaselineBtn, onIoListBtn,
  onBackfillFromCfg, onCfgBackfillChange, loading,
}) {
  const dlFile = (filename) => {
    const link = document.createElement('a');
    link.href = '/' + filename;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div>
      <div style={{ marginBottom: 20, padding: "12px 16px", background: "#e3f2fd", border: "1px solid #90caf9", borderRadius: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#1565c0" }}>Downloads</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => dlFile('HW_IMPORT_TEMPLATE.xlsx')}
            style={{ padding: "8px 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            onMouseEnter={(e) => e.target.style.background = "#1565c0"}
            onMouseLeave={(e) => e.target.style.background = "#1976d2"}
          >
            ⬇ Blank Template
          </button>
          <button
            onClick={() => dlFile('HW_TEST_IMPORT.xlsx')}
            style={{ padding: "8px 16px", background: "#388e3c", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            onMouseEnter={(e) => e.target.style.background = "#2e7d32"}
            onMouseLeave={(e) => e.target.style.background = "#388e3c"}
          >
            ⬇ Test File (current config)
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 24, marginBottom: 24, flexWrap: "wrap" }}>
        <UploadCard
          label="1. Baseline PCS7 CFG"
          ok={baselineOk} okLabel="✓ Loaded"
          btnLabel={baselineOk ? "Replace CFG" : "Upload .cfg"}
          onBtn={onBaselineBtn}
          accept=".cfg"
          inputRef={baselineRef}
          onChange={onBaselineChange}
        />
        <UploadCard
          label="2. HW IO List (Excel)"
          ok={ioListOk} okLabel="✓ Loaded"
          btnLabel={ioListOk ? "Replace IO List" : "Upload Excel"}
          onBtn={onIoListBtn}
          accept=".xlsx,.xlsm,.xls"
          inputRef={ioListRef}
          onChange={onIoListChange}
          disabled={!importId}
        />
      </div>

      {/* Divider with OR label */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1, height: 1, background: "var(--color-border-tertiary, #e5e7eb)" }} />
        <span style={{ fontSize: 12, color: "var(--color-text-secondary, #6b7280)", fontWeight: 500 }}>OR</span>
        <div style={{ flex: 1, height: 1, background: "var(--color-border-tertiary, #e5e7eb)" }} />
      </div>

      {/* Import from CFG option */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "14px 18px",
        background: baselineOk ? "var(--color-background-secondary, #f5f5f5)" : "#f9fafb",
        border: `1px solid ${baselineOk ? "var(--color-border-secondary, rgba(0,0,0,.2))" : "#e5e7eb"}`,
        borderRadius: "var(--border-radius-lg, 12px)",
        opacity: baselineOk ? 1 : 0.5,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3, color: "var(--color-text-primary, #1a1a1a)" }}>
            2. Import device list from CFG
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary, #6b7280)", lineHeight: 1.5 }}>
            Select a previously generated CFG file to restore station, module, IP,
            PIP, POTENTIAL_GROUP and tag data — no Excel sheet needed.
            {!baselineOk && " Upload a baseline CFG first."}
          </div>
        </div>
        <input
          ref={cfgBackfillRef}
          type="file"
          accept=".cfg"
          style={{ display: "none" }}
          onChange={onCfgBackfillChange}
        />
        <button
          onClick={onBackfillFromCfg}
          disabled={!baselineOk || !!loading}
          style={{
            ...btnStyle,
            background: baselineOk ? "#0C447C" : "#e5e7eb",
            color: baselineOk ? "#fff" : "#9ca3af",
            border: "none",
            padding: "8px 18px",
            fontSize: 13,
            flexShrink: 0,
            opacity: !baselineOk || !!loading ? 0.6 : 1,
            cursor: !baselineOk || !!loading ? "not-allowed" : "pointer",
          }}
        >
          {loading && loading.includes("Reading") ? "Reading…" : "Select & Import CFG"}
        </button>
      </div>

      {ioListInfo && (
        <div style={{ marginTop: 20, fontSize: 13, color: "#444",
                      background: "#f5fff5", border: "1px solid #9d9", borderRadius: 6, padding: "8px 14px" }}>
          Device data imported — <strong>{ioListInfo.stationCount}</strong> station{ioListInfo.stationCount !== 1 ? "s" : ""},{" "}
          <strong>{ioListInfo.signalCount}</strong> slot{ioListInfo.signalCount !== 1 ? "s" : ""}.{" "}
          <span style={{ color: "#2255cc", cursor: "pointer", textDecoration: "underline" }}
                onClick={() => {}}>
            Switch to Configuration tab to review and generate.
          </span>
        </div>
      )}
    </div>
  );
}

// ── Catalogue Panel ────────────────────────────────────────────────────────────

const CATEGORY_BADGE = {
  station: { label: "Station", bg: "#e0f2fe", color: "#0369a1" },
  slot:    { label: "Slot",    bg: "#dcfce7", color: "#166534" },
  subslot: { label: "Subslot", bg: "#fef9c3", color: "#854d0e" },
};
function CategoryBadge({ category }) {
  const s = CATEGORY_BADGE[category];
  if (!s) return <span style={{ color: "#aaa", fontSize: 11 }}>—</span>;
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px",
                   borderRadius: 10, background: s.bg, color: s.color,
                   letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

const SIG_TYPES = ['DI', 'DO', 'AI', 'AO', 'PA', 'INFRA', 'MIXED'];

// ── Protocol Mapping Panel (Tier 2 Hardware Resolution admin UI) ─────────────
function HwImportMappingPanel({ templates }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editRow, setEditRow] = useState(null); // row being edited, or null
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [error, setError] = useState("");
  const csvInputRef = useRef();

  function reload() {
    setLoading(true);
    listHwHardwareResolutions()
      .then(data => setRows(data.rows || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = rows.filter(r => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (r.protocol || "").toLowerCase().includes(q)
      || (r.signal_type || "").toLowerCase().includes(q)
      || (r.card_mlfb || "").toLowerCase().includes(q)
      || (r.display_name || "").toLowerCase().includes(q);
  });

  async function handleSave(data) {
    setError("");
    try {
      await upsertHwHardwareResolution(data);
      setShowAdd(false);
      setEditRow(null);
      reload();
    } catch (e) { setError(e.message); }
  }

  async function handleDelete(row) {
    setError("");
    try {
      await deleteHwHardwareResolution(row.id);
      setDeleteTarget(null);
      reload();
    } catch (e) { setError(e.message); }
  }

  async function handleCsvImport(file) {
    setError("");
    try {
      const result = await importHwHardwareResolutionCsv(file);
      reload();
      if (result.errors && result.errors.length) {
        setError(`Imported ${result.imported}, skipped ${result.skipped}. Errors: ${result.errors.join('; ')}`);
      }
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      {error && <div style={{ ...alertStyle("#ffeaea", "#e88", "#b00"), marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Tier 2 Hardware Resolution</h4>
          <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "#666" }}>
            Maps Protocol + Signal Type combinations to a Card MLFB. Used during Excel import when the
            "Card MLFB" column is not mapped — the parser derives the card (and station) from these entries instead.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <input type="file" accept=".csv" ref={csvInputRef} style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) handleCsvImport(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={() => csvInputRef.current?.click()} style={btnSecondary}>Import CSV</button>
          <a href={exportHwHardwareResolutionUrl()} style={{ ...btnSecondary, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>⬇ Export CSV</a>
          <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add Mapping</button>
        </div>
      </div>

      <input
        type="text" placeholder="Search protocol, signal type, or card MLFB…"
        value={search} onChange={e => setSearch(e.target.value)}
        style={{
          width: "100%", maxWidth: 400, padding: "7px 10px", fontSize: 12, marginBottom: 12,
          border: "0.5px solid var(--color-border-secondary)", borderRadius: 4,
          background: "var(--color-background-secondary)", color: "var(--color-text-primary)",
        }}
      />

      {loading ? (
        <div style={{ padding: 20, fontSize: 13, color: "var(--color-text-secondary)" }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 20, fontSize: 13, color: "var(--color-text-secondary)", fontStyle: "italic" }}>
          {rows.length === 0 ? "No mappings defined yet. Click \"Add Mapping\" to create one." : "No mappings match your search."}
        </div>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--color-background-secondary)" }}>
              <th style={pmThStyle}>Protocol</th>
              <th style={pmThStyle}>Signal Type</th>
              <th style={pmThStyle}>Card MLFB</th>
              <th style={pmThStyle}>Station MLFB</th>
              <th style={pmThStyle}>Description</th>
              <th style={{ ...pmThStyle, width: 110 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id} style={{ borderBottom: "1px solid var(--color-border-tertiary)" }}>
                <td style={pmTdStyle}>{r.protocol}</td>
                <td style={pmTdStyle}>{r.signal_type}</td>
                <td style={{ ...pmTdStyle, fontFamily: "var(--font-mono, monospace)" }}>{r.card_mlfb}</td>
                <td style={{ ...pmTdStyle, fontFamily: "var(--font-mono, monospace)" }}>{r.station_mlfb}</td>
                <td style={pmTdStyle}>{r.description || "—"}</td>
                <td style={pmTdStyle}>
                  <button onClick={() => setEditRow(r)} style={linkBtn}>Edit</button>
                  <button onClick={() => setDeleteTarget(r)} style={{ ...linkBtn, color: "#c00" }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(showAdd || editRow) && (
        <ProtocolMappingModal
          initial={editRow}
          templates={templates}
          onClose={() => { setShowAdd(false); setEditRow(null); }}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <ProtocolMappingDeleteConfirm
          title="Delete Mapping"
          message={`Delete mapping "${deleteTarget.protocol} + ${deleteTarget.signal_type}" → ${deleteTarget.card_mlfb}?`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
        />
      )}
    </div>
  );
}

const pmThStyle = { padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, borderBottom: "1px solid var(--color-border-secondary)" };
const pmTdStyle = { padding: "7px 12px" };
const linkBtn = { background: "none", border: "none", color: "#2255cc", cursor: "pointer", fontSize: 12, padding: "2px 6px", marginRight: 4 };
const btnPrimary = { padding: "7px 14px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 4, background: "#2255cc", color: "#fff", cursor: "pointer" };
const btnSecondary = { padding: "7px 14px", fontSize: 12, fontWeight: 600, border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "transparent", color: "var(--color-text-primary)", cursor: "pointer" };

function ProtocolMappingModal({ initial, templates, onClose, onSave }) {
  const [protocol, setProtocol] = useState(initial?.protocol || "");
  const [signalType, setSignalType] = useState(initial?.signal_type || "");
  const [cardMlfb, setCardMlfb] = useState(initial?.card_mlfb || "");
  const [stationMlfb, setStationMlfb] = useState(initial?.station_mlfb || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit() {
    if (!protocol.trim() || !signalType.trim() || !cardMlfb.trim() || !stationMlfb.trim()) {
      setErr("Protocol, Signal Type, Card MLFB, and Station MLFB are all required");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      await onSave({
        ...(initial?.id && { id: initial.id }),
        protocol: protocol.trim(),
        signal_type: signalType.trim(),
        card_mlfb: cardMlfb,
        station_mlfb: stationMlfb,
        description: description.trim() || null
      });
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 440, background: "var(--color-background-primary)", borderRadius: 8, padding: 24, boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}>
        <h3 style={{ margin: "0 0 16px 0", fontSize: 15, fontWeight: 700 }}>{initial ? "Edit Mapping" : "Add Mapping"}</h3>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Protocol</label>
          <input type="text" value={protocol} onChange={e => setProtocol(e.target.value)}
            placeholder="e.g. SoftIO, STD, PF, Profibus DP…"
            style={{ width: "100%", padding: "7px 10px", fontSize: 12, border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Signal Type</label>
          <input type="text" value={signalType} onChange={e => setSignalType(e.target.value)}
            placeholder="e.g. DI, DO, AI, AO…"
            style={{ width: "100%", padding: "7px 10px", fontSize: 12, border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Card MLFB (slot module)</label>
          {templates.filter(t => t.hw_category === 'slot' || !t.hw_category).length > 0 ? (
            <select value={cardMlfb} onChange={e => setCardMlfb(e.target.value)}
              style={{ width: "100%", padding: "7px 10px", fontSize: 12, fontFamily: "var(--font-mono, monospace)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }}>
              <option value="">— Select card module —</option>
              {templates.filter(t => t.hw_category === 'slot' || !t.hw_category).map(t => (
                <option key={t.id} value={t.order_no}>{t.order_no} · {t.display_name}</option>
              ))}
            </select>
          ) : (
            <input type="text" value={cardMlfb} onChange={e => setCardMlfb(e.target.value)}
              placeholder="e.g. 6ES7 131-6BH01-0BA0"
              style={{ width: "100%", padding: "7px 10px", fontSize: 12, fontFamily: "var(--font-mono, monospace)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }} />
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Station MLFB</label>
          {templates.filter(t => t.hw_category === 'station').length > 0 ? (
            <select value={stationMlfb} onChange={e => setStationMlfb(e.target.value)}
              style={{ width: "100%", padding: "7px 10px", fontSize: 12, fontFamily: "var(--font-mono, monospace)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }}>
              <option value="">— Select station module —</option>
              {templates.filter(t => t.hw_category === 'station').map(t => (
                <option key={t.id} value={t.order_no}>{t.order_no} · {t.display_name}</option>
              ))}
            </select>
          ) : (
            <input type="text" value={stationMlfb} onChange={e => setStationMlfb(e.target.value)}
              placeholder="e.g. 6ES7 155-6AU00-0CN0"
              style={{ width: "100%", padding: "7px 10px", fontSize: 12, fontFamily: "var(--font-mono, monospace)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }} />
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Description (optional)</label>
          <input type="text" value={description} onChange={e => setDescription(e.target.value)}
            style={{ width: "100%", padding: "7px 10px", fontSize: 12, border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }} />
        </div>

        {err && <div style={{ color: "#c00", fontSize: 12, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProtocolMappingDeleteConfirm({ title, message, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 380, background: "var(--color-background-primary)", borderRadius: 8, padding: 24, boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 15, fontWeight: 700 }}>{title}</h3>
        <p style={{ margin: "0 0 20px 0", fontSize: 13, color: "var(--color-text-secondary)" }}>{message}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnSecondary}>Cancel</button>
          <button onClick={async () => { setBusy(true); await onConfirm(); }} disabled={busy}
            style={{ ...btnPrimary, background: "#c00", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CataloguePanel({ templates, slotCompat, sigTypes, onTemplatesChanged, onPatchTemplate, onAddSigType, onAddCompat, onRemoveCompat, onDeleteTemplate }) {
  const [showImport, setShowImport] = useState(false);
  const [catalogueTab, setCatalogueTab] = useState("modules"); // "modules" or "hwImportMapping"
  const [autoSlotConfigOrderNo, setAutoSlotConfigOrderNo] = useState(null); // order_no for auto-slot modal
  const cfgImportRef = useRef();

  // All known signal types come from the DB (sigTypes prop).
  // Fall back to hardcoded SIG_TYPES only while the initial fetch is in-flight.
  const allSigTypes = sigTypes && sigTypes.length ? sigTypes : SIG_TYPES;

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #dde" }}>
        {[["modules", "Modules"], ["hwImportMapping", "HW Import Mapping"]].map(([id, label]) => (
          <button key={id} onClick={() => setCatalogueTab(id)}
            style={{
              padding: "7px 18px", border: "none", background: "none", cursor: "pointer",
              fontWeight: catalogueTab === id ? 700 : 400, fontSize: 14,
              color: catalogueTab === id ? "#2255cc" : "#555",
              borderBottom: catalogueTab === id ? "2px solid #2255cc" : "2px solid transparent",
              marginBottom: -2,
            }}
          >{label}</button>
        ))}
      </div>

      {/* Modules Tab */}
      {catalogueTab === "modules" && (
        <>
          {/* Hidden .cfg file input, triggered from the grid toolbar's Import button */}
          <input type="file" accept=".cfg" ref={cfgImportRef} style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) setShowImport(e.target.files[0]); e.target.value = ""; }} />

          <CatalogueGrid
            templates={templates}
            slotCompat={slotCompat}
            sigTypes={sigTypes}
            onPatchTemplate={onPatchTemplate}
            onAddSigType={onAddSigType}
            onAddCompat={onAddCompat}
            onRemoveCompat={onRemoveCompat}
            onDeleteTemplate={onDeleteTemplate}
            onAutoSlotConfig={(template) => setAutoSlotConfigOrderNo(template.order_no)}
            onImportClick={() => cfgImportRef.current?.click()}
          />

          {/* ── Auto-Slot Config Modal ── */}
          {autoSlotConfigOrderNo != null && (
            <StationAutoSlotsEditor
              station={{ orderNo: autoSlotConfigOrderNo }}
              catalogue={templates}
              onClose={() => setAutoSlotConfigOrderNo(null)}
            />
          )}

          {/* Import modal */}
          {showImport && (
            <CfgImportModal
              file={showImport}
              sigTypes={allSigTypes}
              onClose={() => setShowImport(false)}
              onDone={() => { setShowImport(false); onTemplatesChanged?.(); }}
            />
          )}
        </>
      )}

      {/* HW Import Mapping Tab */}
      {catalogueTab === "hwImportMapping" && (
        <HwImportMappingPanel templates={templates} />
      )}
    </div>
  );
}

// ── CFG Import Modal ───────────────────────────────────────────────────────────
const ACTION_LABELS = { new: "Add", conflict: "Skip", skip: "Skip", error: "—" };

function CfgImportModal({ file, sigTypes, onClose, onDone }) {
  const [stage,      setStage]      = useState("parsing");
  const [parseErr,   setParseErr]   = useState("");
  const [warning,    setWarning]    = useState("");
  // checked is the only stored state. action is derived:
  //   new  + checked   → 'add'
  //   conflict + checked → 'overwrite'  (requires explicit check — safe default is unchecked)
  //   unchecked / error → 'skip'
  const [candidates, setCandidates] = useState([]);
  const [result,     setResult]     = useState(null);

  useEffect(() => {
    parseCfgForCatalogue(file)
      .then(({ warning, candidates }) => {
        setWarning(warning || "");
        setCandidates(candidates.map(c => ({
          ...c,
          // New = include by default; Exists = skip by default (no accidental overwrites)
          checked: c.status === 'new',
          family: c.family,
        })));
        setStage("preview");
      })
      .catch(e => { setParseErr(e.message); setStage("preview"); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive action from checked + status (never stored, always computed)
  function deriveAction(c) {
    if (c.status === 'error' || !c.checked) return 'skip';
    return c.status === 'conflict' ? 'overwrite' : 'add';
  }

  function setChecked(idx, checked) {
    setCandidates(prev => prev.map((c, i) => i === idx ? { ...c, checked } : c));
  }
  function setFamily(idx, family) {
    setCandidates(prev => {
      const ioAddress = prev[idx]?.ioAddress;
      return prev.map((c, i) => {
        if (i === idx) return { ...c, family, familySource: 'manual' };
        // Propagate to all entries in the same station (background IFACE heads + visible subslots)
        if (c.ioAddress === ioAddress) return { ...c, family, familySource: 'manual' };
        return c;
      });
    });
  }
  function setSignalType(idx, signal_type) {
    setCandidates(prev => prev.map((c, i) => i === idx ? { ...c, signal_type } : c));
  }
  // Group header: toggle only visible New rows in the group; never auto-check Exists or background
  function toggleGroupNew(ioAddress, toCheck) {
    setCandidates(prev => prev.map(c =>
      c.ioAddress === ioAddress && c.status === 'new' && !c.isBackground
        ? { ...c, checked: toCheck } : c
    ));
  }
  // Global header: toggle all visible New rows; never auto-check Exists or background
  function toggleAllNew(toCheck) {
    setCandidates(prev => prev.map(c =>
      c.status === 'new' && !c.isBackground ? { ...c, checked: toCheck } : c
    ));
  }

  async function handleConfirm() {
    // Snapshot skip count NOW — candidates still reflects user choices.
    // The backend only receives checked rows, so result.skipped always comes back 0 without this.
    const skippedCount = candidates.filter(c => !c.isBackground && c.status !== 'error' && !c.checked).length;
    setStage("confirming");
    try {
      // Visible rows that the user checked
      const checkedVisible = candidates.filter(c => !c.isBackground && c.status !== 'error' && c.checked);

      // IO addresses that have at least one checked visible row
      const checkedAddresses = new Set(checkedVisible.map(c => c.ioAddress));

      // Background rows (SUBSLOT 1 IFACE heads) whose station has at least one checked visible row.
      // These are imported silently as 'add' (INSERT OR IGNORE — never overwrite without asking).
      const backgroundToImport = candidates.filter(c =>
        c.isBackground && c.status !== 'error' && checkedAddresses.has(c.ioAddress)
      );

      const toDevice = c => ({
        order_no: c.order_no, display_name: c.display_name, family: c.family,
        signal_type: c.signal_type, channel_count: c.channel_count,
        input_bytes: c.input_bytes, output_bytes: c.output_bytes,
        in_addr_fmt: c.in_addr_fmt, out_addr_fmt: c.out_addr_fmt,
        param_template: c.param_template, version: c.version,
        gsdml_file: c.gsdml_file || null, dap_id: c.dap_id || null,
        hw_category: c.hw_category || null,
        subslot_defaults: c.subslot_defaults || null,
        port_config: c.port_config || null,
        mlfb: c.mlfb || null,
        action: deriveAction(c),
      });

      // For each IO address, pick the family from the first checked visible row in that station
      // so background subslots always end up in the same family even if the user edited it.
      const familyByAddress = {};
      for (const c of checkedVisible) {
        if (!(c.ioAddress in familyByAddress)) familyByAddress[c.ioAddress] = c.family;
      }

      const devices = [
        ...checkedVisible.map(toDevice),
        // Background rows always use 'add' (INSERT OR IGNORE) — no user confirmation needed
        ...backgroundToImport.map(c => ({
          ...toDevice(c),
          action: 'add',
          family: familyByAddress[c.ioAddress] ?? c.family,
        })),
      ];

      const res = await bulkUpsertCatalogueTemplates(devices);
      setResult({ ...res, skipped: skippedCount });
      setStage("done");
    } catch (e) { setParseErr(e.message); setStage("preview"); }
  }

  // Live footer counts — visible rows only (background rows don't count toward user selections)
  const visible       = candidates.filter(c => !c.isBackground && c.status !== 'error');
  const willAdd       = visible.filter(c => c.status === 'new'      && c.checked).length;
  const willOverwrite = visible.filter(c => c.status === 'conflict' && c.checked).length;
  const willSkip      = visible.filter(c => !c.checked).length;
  // Global header checkbox tracks visible New rows only
  const newRows        = visible.filter(c => c.status === 'new');
  const allNewChecked  = newRows.length > 0 && newRows.every(c => c.checked);
  const someNewChecked = newRows.some(c => c.checked);

  // Overlay styles
  const overlay = {
    position: "fixed", inset: 0, zIndex: 1000,
    background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center",
  };
  const modal = {
    background: "#fff", borderRadius: 10, boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
    width: "min(1200px, 98vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
    overflow: "hidden",
  };
  const hdr = {
    padding: "16px 20px", borderBottom: "1px solid #dde", display: "flex",
    alignItems: "center", justifyContent: "space-between",
  };
  const footer = {
    padding: "12px 20px", borderTop: "1px solid #dde", background: "#f8f9ff",
    display: "flex", alignItems: "center", gap: 12,
  };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>

        {/* Header */}
        <div style={hdr}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Import devices from .cfg</span>
            <span style={{ marginLeft: 10, fontSize: 12, color: "#888" }}>{file.name}</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20,
              cursor: "pointer", color: "#888", lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>

          {stage === "parsing" && (
            <div style={{ textAlign: "center", color: "#668", padding: "40px 0", fontSize: 14 }}>
              Parsing .cfg file…
            </div>
          )}

          {stage === "confirming" && (
            <div style={{ textAlign: "center", color: "#668", padding: "40px 0", fontSize: 14 }}>
              Saving to catalogue…
            </div>
          )}

          {stage === "done" && result && (
            <div style={{ padding: "24px 0", textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Import complete</div>
              <div style={{ fontSize: 13, color: "#555" }}>
                {result.added} added &nbsp;·&nbsp; {result.overwritten} overwritten &nbsp;·&nbsp; {result.skipped} skipped
              </div>
            </div>
          )}

          {(stage === "preview") && (
            <>
              {parseErr && (
                <div style={{ background: "#ffeaea", border: "1px solid #faa", borderRadius: 6,
                    padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#a00" }}>
                  {parseErr}
                </div>
              )}
              {warning && (
                <div style={{ background: "#fffbe6", border: "1px solid #f5c518", borderRadius: 6,
                    padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "#7a5500" }}>
                  ⚠ {warning}
                </div>
              )}

              {candidates.length === 0 && !parseErr && (
                <div style={{ color: "#888", textAlign: "center", padding: "32px 0" }}>
                  No importable devices found.
                </div>
              )}

              {candidates.length > 0 && (
                <>
                <div style={{ display: "flex", gap: 14, marginBottom: 10, fontSize: 11, color: "#555", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>Family:</span>
                  <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#ccd", borderRadius: 2, marginRight: 4 }} />auto</span>
                  <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#16a34a", borderRadius: 2, marginRight: 4 }} />from cfg COMMENT</span>
                  <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#e57c00", borderRadius: 2, marginRight: 4 }} />unknown — edit</span>
                  <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#2255cc", borderRadius: 2, marginRight: 4 }} />manually edited</span>
                  <span style={{ color: "#888", marginLeft: 4 }}>Tip: <code style={{ fontSize: 10 }}>COMMENT, "family:ET200M"</code> in PCS7</span>
                </div>
                <CfgImportTable
                  candidates={candidates}
                  sigTypes={sigTypes}
                  allNewChecked={allNewChecked}
                  someNewChecked={someNewChecked}
                  onToggleAllNew={toggleAllNew}
                  onToggleGroupNew={toggleGroupNew}
                  onSetChecked={setChecked}
                  onSetFamily={setFamily}
                  onSetSignalType={setSignalType}
                />
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={footer}>
          {stage === "preview" && candidates.length > 0 && (
            <span style={{ fontSize: 12, flex: 1 }}>
              <span style={{ color: "#1a6a1a", fontWeight: 600 }}>{willAdd} will be added</span>
              {willOverwrite > 0 && <span style={{ color: "#b86f00", fontWeight: 600 }}> &nbsp;·&nbsp; {willOverwrite} will be overwritten</span>}
              <span style={{ color: "#888" }}> &nbsp;·&nbsp; {willSkip} will be skipped</span>
            </span>
          )}
          {stage === "done" && <div style={{ flex: 1 }} />}
          {(stage === "preview" || stage === "done") && (
            <button onClick={() => stage === "done" ? onDone() : onClose()}
              style={{ padding: "7px 16px", fontSize: 13, border: stage === "done" ? "none" : "1px solid #ccd",
                       borderRadius: 6, background: stage === "done" ? "#2255cc" : "#fff",
                       color: stage === "done" ? "#fff" : "#333", cursor: "pointer" }}>
              {stage === "done" ? "Done" : "Cancel"}
            </button>
          )}
          {stage === "preview" && candidates.length > 0 && (willAdd + willOverwrite) > 0 && (
            <button onClick={handleConfirm}
              style={{ padding: "7px 18px", fontSize: 13, fontWeight: 600,
                       background: "#2255cc", color: "#fff", border: "none",
                       borderRadius: 6, cursor: "pointer" }}>
              Import {willAdd + willOverwrite} device{willAdd + willOverwrite !== 1 ? "s" : ""}
            </button>
          )}
          {stage === "done" && (
            <button onClick={onDone}
              style={{ padding: "7px 18px", fontSize: 13, fontWeight: 600,
                       background: "#2255cc", color: "#fff", border: "none",
                       borderRadius: 6, cursor: "pointer", display: "none" }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Catalogue Delete Confirm Modal ────────────────────────────────────────────
function CatalogueDeleteModal({ target, onClose, onConfirm }) {
  const inUse = target.usage && target.usage.length > 0;

  // Group usage rows by import
  const byImport = {};
  for (const row of (target.usage || [])) {
    const key = row.hw_import_id;
    if (!byImport[key]) byImport[key] = { importId: key, excelName: row.excel_name, projectName: row.project_name, stations: {} };
    const stKey = row.station_address;
    if (!byImport[key].stations[stKey]) byImport[key].stations[stKey] = { address: row.station_address, name: row.station_name, slots: [] };
    byImport[key].stations[stKey].slots.push({ slot: row.slot, rowCount: row.row_count });
  }
  const imports = Object.values(byImport);

  const overlay = { position: "fixed", inset: 0, zIndex: 1100,
    background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" };
  const modal = { background: "#fff", borderRadius: 10, boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
    width: "min(600px, 96vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #dde",
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Delete from Catalogue</span>
          </div>
          <button onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#888", lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          <div style={{ marginBottom: 14 }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, background: "#f4f4f8",
                           border: "1px solid #dde", borderRadius: 4, padding: "2px 8px" }}>{target.order_no}</span>
            <span style={{ marginLeft: 10, fontWeight: 600, fontSize: 14 }}>{target.display_name}</span>
          </div>

          {inUse ? (
            <>
              <div style={{ background: "#fff8e1", border: "1px solid #f5c518", borderRadius: 6,
                            padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#7a5500" }}>
                ⚠ This device is currently used in <strong>{target.usage.length}</strong> slot{target.usage.length !== 1 ? "s" : ""} across the following station(s).
                You must remove it from all stations before deleting it from the catalogue.
              </div>

              {imports.map(imp => (
                <div key={imp.importId} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#446", textTransform: "uppercase",
                                letterSpacing: "0.04em", marginBottom: 6 }}>
                    {imp.projectName ? `${imp.projectName} — ` : ""}{imp.excelName || `Import #${imp.importId}`}
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f4f6fb" }}>
                        <th style={{ ...thStyle, padding: "4px 10px" }}>Station Addr</th>
                        <th style={{ ...thStyle, padding: "4px 10px" }}>Station Name</th>
                        <th style={{ ...thStyle, padding: "4px 10px", textAlign: "center" }}>Slot</th>
                        <th style={{ ...thStyle, padding: "4px 10px", textAlign: "center" }}>Signal Rows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.values(imp.stations).flatMap(st =>
                        st.slots.map((sl, i) => (
                          <tr key={`${st.address}-${sl.slot}`} style={{ background: i % 2 === 0 ? "#fff" : "#f7f9fc" }}>
                            <td style={{ ...tdStyle, padding: "4px 10px", fontFamily: "monospace", fontWeight: 700, color: "#226" }}>
                              {i === 0 ? st.address : ""}
                            </td>
                            <td style={{ ...tdStyle, padding: "4px 10px", color: "#224" }}>
                              {i === 0 ? (st.name || `Station_${st.address}`) : ""}
                            </td>
                            <td style={{ ...tdStyle, padding: "4px 10px", textAlign: "center", color: "#888" }}>{sl.slot}</td>
                            <td style={{ ...tdStyle, padding: "4px 10px", textAlign: "center" }}>{sl.rowCount}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          ) : (
            <div style={{ background: "#f0fff4", border: "1px solid #9dd", borderRadius: 6,
                          padding: "10px 14px", fontSize: 13, color: "#1a5a1a" }}>
              ✓ This device is not used in any station and can be safely deleted.
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #dde", background: "#f8f9ff",
                      display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose}
            style={{ padding: "7px 18px", fontSize: 13, border: "1px solid #ccd",
                     borderRadius: 6, background: "#fff", cursor: "pointer" }}>
            {inUse ? "Close" : "Cancel"}
          </button>
          {!inUse && (
            <button onClick={onConfirm}
              style={{ padding: "7px 18px", fontSize: 13, fontWeight: 600,
                       background: "#b00", color: "#fff", border: "none",
                       borderRadius: 6, cursor: "pointer" }}>
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── CFG Import Table — hierarchical checkbox design ───────────────────────────
// Checked meaning:
//   New      + checked → Add       (green row tint)
//   Conflict + checked → Overwrite (amber row tint, amber checkbox)
//   any      + unchecked → Skip    (row dimmed)
//
// Group header checkbox: hollow-green partial state when mixing checked-New +
// unchecked-Conflict (the typical first-open state). Never auto-checks Conflict
// rows — overwriting requires explicit per-row intent.
// Column definitions for CfgImportTable: key, label, defaultW (px), align, noResize flag
const IMPORT_COLS = [
  { key: "check",    label: null,        defaultW: 36,  align: "center" },
  { key: "slot",     label: "Slot",      defaultW: 80,  align: "left"   },
  { key: "category", label: "Category",  defaultW: 72,  align: "center" },
  { key: "orderNo",  label: "Order No",  defaultW: 280, align: "left"   },
  { key: "name",     label: "Name",      defaultW: 200, align: "left"   },
  { key: "family",   label: "Family",    defaultW: 112, align: "left"   },
  { key: "sig",      label: "Sig",       defaultW: 60,  align: "center" },
  { key: "in",       label: "In",        defaultW: 44,  align: "center" },
  { key: "out",      label: "Out",       defaultW: 44,  align: "center" },
  { key: "ver",      label: "Ver",       defaultW: 56,  align: "left"   },
  { key: "status",   label: "Status",    defaultW: 72,  align: "center" },
];

function CfgImportTable({ candidates, sigTypes, allNewChecked, someNewChecked, onToggleAllNew, onToggleGroupNew, onSetChecked, onSetFamily, onSetSignalType }) {
  const effectiveSigTypes = sigTypes && sigTypes.length ? sigTypes : SIG_TYPES;

  const [colWidths, setColWidths] = useState(() => IMPORT_COLS.map(c => c.defaultW));
  const dragRef = useRef(null);

  function startResize(e, colIdx) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidths[colIdx];
    const onMove = ev => {
      const newW = Math.max(36, startW + (ev.clientX - startX));
      setColWidths(prev => prev.map((w, i) => i === colIdx ? newW : w));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    dragRef.current = { colIdx, startX, startW };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Build ordered group list from visible (non-background) entries only,
  // but keep global indices intact so onSetChecked(i) maps to the right candidate.
  const visibleWithIdx = candidates.map((c, i) => ({ c, i })).filter(({ c }) => !c.isBackground);

  const groupOrder = [];
  const seen = new Set();
  for (const { c } of visibleWithIdx) {
    if (!seen.has(c.ioAddress)) { seen.add(c.ioAddress); groupOrder.push(c.ioAddress); }
  }

  // Within each ioAddress group, build a slot → subslots hierarchy.
  // Subslot entries are matched to parent slot by extracting the slot number from slotInfo.
  // e.g. "Slot 3 / Subslot 1" → parent is the entry with slotInfo "Slot 3"
  function buildSlotTree(groupEntries) {
    // Separate by category: station heads, plain slots, subslots
    const heads     = groupEntries.filter(({ c }) => c.hw_category === 'station');
    const slots     = groupEntries.filter(({ c }) => c.hw_category === 'slot');
    const subslots  = groupEntries.filter(({ c }) => c.hw_category === 'subslot');

    // Build a map: slot number string → list of subslot entries
    const subslotsBySlot = new Map();
    for (const entry of subslots) {
      const m = entry.c.slotInfo && entry.c.slotInfo.match(/^Slot\s+(\d+)/i);
      if (m) {
        const slotKey = m[1];
        if (!subslotsBySlot.has(slotKey)) subslotsBySlot.set(slotKey, []);
        subslotsBySlot.get(slotKey).push(entry);
      }
    }

    // Subslots with no matching slot parent (orphan) — render at end
    const orphanSubslots = subslots.filter(entry => {
      const m = entry.c.slotInfo && entry.c.slotInfo.match(/^Slot\s+(\d+)/i);
      if (!m) return true;
      const slotKey = m[1];
      return !slots.some(({ c }) => {
        const sm = c.slotInfo && c.slotInfo.match(/^Slot\s+(\d+)$/i);
        return sm && sm[1] === slotKey;
      });
    });

    // Ordered: heads → slots (each followed by their subslots) → orphan subslots
    const ordered = [];
    for (const head of heads) ordered.push({ ...head, isSubslotChild: false });
    for (const slot of slots) {
      ordered.push({ ...slot, isSubslotChild: false });
      const m = slot.c.slotInfo && slot.c.slotInfo.match(/^Slot\s+(\d+)$/i);
      if (m) {
        const children = subslotsBySlot.get(m[1]) || [];
        for (const child of children) ordered.push({ ...child, isSubslotChild: true });
      }
    }
    for (const orphan of orphanSubslots) ordered.push({ ...orphan, isSubslotChild: true });
    return ordered;
  }

  const totalW = colWidths.reduce((s, w) => s + w, 0);

  return (
    <div style={{ overflowX: "auto", width: "100%" }}>
    <table style={{ borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed", width: totalW }}>
      <colgroup>
        {IMPORT_COLS.map((col, i) => <col key={col.key} style={{ width: colWidths[i] }} />)}
      </colgroup>
      <thead>
        <tr style={{ background: "#f4f6fb" }}>
          {IMPORT_COLS.map((col, i) => (
            <th key={col.key} style={{
              ...thStyle,
              textAlign: col.align,
              position: "relative",
              userSelect: "none",
              overflow: "hidden",
              padding: "8px 16px 8px 8px",
            }}>
              {col.key === "check" ? (
                <HierarchyCheckbox
                  checked={allNewChecked}
                  partial={!allNewChecked && someNewChecked}
                  onChange={v => onToggleAllNew(v)}
                  title="Check/uncheck all New rows"
                />
              ) : (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                  {col.label}
                </span>
              )}
              {i < IMPORT_COLS.length - 1 && (
                <div
                  onMouseDown={e => startResize(e, i)}
                  style={{
                    position: "absolute", right: 0, top: 0, bottom: 0, width: 5,
                    cursor: "col-resize",
                    background: "transparent",
                  }}
                />
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groupOrder.map(ioAddr => {
          const groupEntries = visibleWithIdx.filter(({ c }) => c.ioAddress === ioAddr);
          const newInGroup      = groupEntries.filter(({ c }) => c.status === 'new');
          const allGroupNew     = newInGroup.length > 0 && newInGroup.every(({ c }) => c.checked);
          const someGroupNew    = newInGroup.some(({ c }) => c.checked);
          const hasConflict     = groupEntries.some(({ c }) => c.status === 'conflict');
          // Header checkbox: partial (hollow green) when New rows are checked but Conflict rows exist unchecked
          const groupPartial    = !allGroupNew && (someGroupNew || (allGroupNew && hasConflict));
          const headEntry       = groupEntries.find(({ c }) => c.slotInfo === 'Station head') || groupEntries[0];
          const headLabel       = headEntry ? headEntry.c.display_name : '';
          const showHeader      = groupEntries.length > 1;

          const orderedEntries = buildSlotTree(groupEntries);

          return (
            <React.Fragment key={ioAddr}>
              {showHeader && (
                <tr style={{ background: "#eef2fc" }}>
                  <td style={{ ...catTdStyle, textAlign: "center" }}>
                    {newInGroup.length > 0 && (
                      <HierarchyCheckbox
                        checked={allGroupNew}
                        partial={groupPartial}
                        onChange={v => onToggleGroupNew(ioAddr, v)}
                        title="Check/uncheck New rows in this station"
                      />
                    )}
                  </td>
                  <td colSpan={IMPORT_COLS.length - 1} style={{ ...catTdStyle, fontWeight: 600, fontSize: 11,
                      color: "#334", letterSpacing: "0.02em", paddingLeft: 8 }}>
                    IO Station {ioAddr}
                    {headLabel && <span style={{ fontWeight: 400, color: "#668", marginLeft: 8 }}>{headLabel}</span>}
                    <span style={{ fontWeight: 400, color: "#999", marginLeft: 8 }}>
                      — {groupEntries.length} module{groupEntries.length !== 1 ? 's' : ''}
                    </span>
                    {hasConflict && (
                      <span style={{ marginLeft: 10, fontSize: 10, color: "#b86f00", fontWeight: 400 }}>
                        ⚠ contains existing devices — check individually to overwrite
                      </span>
                    )}
                  </td>
                </tr>
              )}

              {orderedEntries.map(({ c, i, isSubslotChild }, rowIdx) => {
                const isErr      = c.status === 'error';
                const isConflict = c.status === 'conflict';
                const isChecked  = c.checked;

                // Row background: green tint = add, amber tint = overwrite, dimmed = skip
                let rowBg = rowIdx % 2 === 0 ? "#fff" : "#f7f9fc";
                if (isErr) rowBg = "#fff8f8";
                else if (isConflict && isChecked) rowBg = "#fffbe6";
                else if (!isConflict && isChecked) rowBg = "#f0fbf2";
                // Subslot children get a slightly different background to visually separate
                if (isSubslotChild && !isErr && !isChecked) rowBg = "#fafbfe";
                if (isSubslotChild && isChecked && !isConflict) rowBg = "#eaf7ec";
                if (isSubslotChild && isChecked && isConflict) rowBg = "#fffae0";

                const rowOpacity = (!isErr && !isChecked) ? 0.45 : 1;
                // Indentation levels: station group header → indent=1, subslot child → indent=2
                const indentLevel = isSubslotChild ? (showHeader ? 2 : 1) : (showHeader ? 1 : 0);
                const checkPL  = indentLevel === 2 ? 32 : indentLevel === 1 ? 20 : 6;
                const slotPL   = indentLevel === 2 ? 32 : indentLevel === 1 ? 20 : 8;

                return (
                  <tr key={c.order_no + i} style={{ background: rowBg, opacity: rowOpacity }}>
                    <td style={{ ...catTdStyle, textAlign: "center", paddingLeft: checkPL }}>
                      {!isErr && (
                        isConflict ? (
                          // Amber-tinted checkbox for Exists rows — visual cue that checking = overwrite
                          <input
                            type="checkbox"
                            checked={isChecked}
                            title="Check to overwrite existing catalogue entry"
                            onChange={e => onSetChecked(i, e.target.checked)}
                            style={{ accentColor: "#c07000", cursor: "pointer" }}
                          />
                        ) : (
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={e => onSetChecked(i, e.target.checked)}
                            style={{ cursor: "pointer" }}
                          />
                        )
                      )}
                    </td>
                    <td style={{ ...catTdStyle, color: "#668", fontSize: 11, whiteSpace: "nowrap",
                        paddingLeft: slotPL }}>
                      {isSubslotChild && <span style={{ color: "#aab", marginRight: 4 }}>↳</span>}
                      {c.slotInfo || "—"}
                    </td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>
                      <CategoryBadge category={c.hw_category} />
                    </td>
                    <td style={{ ...catTdStyle, fontFamily: "monospace", fontSize: 11 }} title={c.order_no}>
                      {c.order_no}
                    </td>
                    <td style={{ ...catTdStyle }} title={c.display_name}>
                      {isErr
                        ? <span style={{ color: "#c00" }}>⚠ {c.parseError || "Parse error"}</span>
                        : c.display_name}
                    </td>
                    <td style={{ ...catTdStyle, minWidth: 100 }}>
                      {isErr ? (
                        <span style={{ color: "#aaa" }}>—</span>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <input
                            value={c.family}
                            onChange={e => onSetFamily(i, e.target.value)}
                            style={{
                              width: "100%", fontSize: 11, padding: "2px 5px",
                              border: `1px solid ${
                                c.familySource === 'manual'  ? "#2255cc" :
                                c.familySource === 'comment' ? "#16a34a" :
                                c.familySource === 'unknown' ? "#e57c00" : "#ccd"
                              }`,
                              borderRadius: 3,
                              background: c.familySource === 'unknown' ? "#fff8f0" : "#fff",
                              boxSizing: "border-box",
                            }}
                          />
                          <span style={{
                            fontSize: 9, letterSpacing: "0.03em", textTransform: "uppercase",
                            color: c.familySource === 'manual'  ? "#2255cc" :
                                   c.familySource === 'comment' ? "#16a34a" :
                                   c.familySource === 'unknown' ? "#e57c00" : "#999",
                          }}>
                            {c.familySource === 'manual'  ? "edited" :
                             c.familySource === 'comment' ? "from cfg" :
                             c.familySource === 'unknown' ? "unknown — edit" : "auto"}
                          </span>
                        </div>
                      )}
                    </td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>
                      {isErr ? (
                        <span style={{ color: "#aaa" }}>—</span>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <select
                            value={c.signal_type || ''}
                            onChange={e => onSetSignalType(i, e.target.value)}
                            style={{
                              fontSize: 10, padding: "1px 3px", border: "1px solid #ccd",
                              borderRadius: 3, background: "#fff", cursor: "pointer",
                              fontWeight: 700, color: sigBadge(c.signal_type).color,
                            }}
                          >
                            {effectiveSigTypes.map(st => (
                              <option key={st} value={st}>{st}</option>
                            ))}
                          </select>
                          <span style={{ fontSize: 9, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                            sig type
                          </span>
                        </div>
                      )}
                    </td>
                    <td style={{ ...catTdStyle, textAlign: "center", fontFamily: "monospace" }}>{c.input_bytes || 0}</td>
                    <td style={{ ...catTdStyle, textAlign: "center", fontFamily: "monospace" }}>{c.output_bytes || 0}</td>
                    <td style={{ ...catTdStyle, color: "#888", fontSize: 11 }}>{c.version || "—"}</td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>
                      {isErr ? (
                        <span style={{ color: "#c00", fontSize: 11 }}>⚠ Error</span>
                      ) : isConflict ? (
                        isChecked
                          ? <span style={{ color: "#b86f00", fontSize: 11, fontWeight: 600 }}>⚠ Overwrite</span>
                          : <span style={{ color: "#b86f00", fontSize: 11 }}>⚠ Exists</span>
                      ) : (
                        isChecked
                          ? <span style={{ color: "#1a6a1a", fontSize: 11, fontWeight: 600 }}>Add</span>
                          : <span style={{ color: "#999",   fontSize: 11 }}>Skip</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

// Custom tri-state checkbox: checked (blue fill) | partial (hollow green check) | unchecked (empty)
function HierarchyCheckbox({ checked, partial, onChange, title }) {
  if (checked || !partial) {
    // Native checkbox handles checked/unchecked states
    return (
      <input
        type="checkbox"
        checked={checked}
        title={title}
        onChange={e => onChange(e.target.checked)}
        style={{ cursor: "pointer" }}
      />
    );
  }
  // Partial state: render a custom hollow-green box with a checkmark
  return (
    <span
      role="checkbox"
      aria-checked="mixed"
      title={title}
      onClick={() => onChange(true)}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 14, height: 14, border: "2px solid #16a34a", borderRadius: 3,
        cursor: "pointer", background: "#fff", flexShrink: 0,
      }}
    >
      <span style={{ color: "#16a34a", fontSize: 10, lineHeight: 1, fontWeight: 700 }}>✓</span>
    </span>
  );
}

// ── Configuration Panel ────────────────────────────────────────────────────────
function ConfigurationPanel({
  importId, baselineOk, baselineInfo, controllerTagName, stations, addrMap, templates, fieldbuses, cfgs, loading,
  addingStation, newStation, addingSlot, newSlot,
  editing, editVal,
  selectedAddrs, onToggleSelect, onToggleSelectAll, onClearSelection, onSetSelectedAddrs,
  onSetNewStation, onStartAddStation, onCancelAddStation, onCommitAddStation,
  onCopyStation, onDeleteStation,
  onBulkDelete, onBulkApprove,
  onOpenAddSlot, onCancelAddSlot, onModuleSelect, onSetNewSlot, onCommitAddSlot,
  onDeleteSlot, onSaveSlotPip, onSaveSlotPotentialGroup, onSaveSlotPaProfile, onSaveSlotSubslotProfile,
  onGenerate,
  isEditing, onStartEdit, onChangeEdit, onCommitEdit, onCancelEdit,
  onShowSymbolTable,
}) {
  const canGenerate = baselineOk && stations.some(s => s.slots.length > 0);
  const nSelected   = selectedAddrs.size;
  const allSelected = stations.length > 0 && selectedAddrs.size === stations.length;
  const [configureAddr, setConfigureAddr] = useState(null); // address of station open in modal
  const [genMenuOpen, setGenMenuOpen] = useState(false);

  // Always derive the live station object from current stations so the modal never shows stale slots
  const configureStation = configureAddr != null ? (stations.find(s => s.address === configureAddr) || null) : null;

  // Close modal if its station was deleted
  useEffect(() => {
    if (configureAddr != null && !stations.find(s => s.address === configureAddr)) {
      setConfigureAddr(null);
    }
  }, [stations]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {/* Toolbar — Generate / Download only */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }} />
        {/* Symbol Table button */}
        <button
          onClick={onShowSymbolTable}
          disabled={stations.length === 0 || !stations.some(s => s.slots && s.slots.length > 0)}
          style={{ ...btnStyle, opacity: (stations.length === 0 || !stations.some(s => s.slots && s.slots.length > 0)) ? 0.4 : 1 }}
          title="View all configured signals"
        >
          📋 Symbol Table
        </button>
        {/* Generate dropdown */}
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #2255cc" }}>
            <button
              onClick={() => { setGenMenuOpen(false); onGenerate(null); }}
              disabled={!canGenerate || !!loading}
              style={{ ...btnStyle, border: "none", borderRadius: 0, background: "#2255cc", color: "#fff",
                       opacity: canGenerate && !loading ? 1 : 0.4, fontSize: 14, padding: "9px 18px" }}
            >Generate CFG</button>
            <button
              onClick={() => setGenMenuOpen(o => !o)}
              disabled={!canGenerate || !!loading}
              style={{ ...btnStyle, border: "none", borderLeft: "1px solid #4477ee", borderRadius: 0,
                       background: "#2255cc", color: "#fff",
                       opacity: canGenerate && !loading ? 1 : 0.4, padding: "9px 10px", fontSize: 12 }}
              title="More generate options"
            >▾</button>
          </div>
          {genMenuOpen && (
            <div style={{
              position: "absolute", top: "100%", right: 0, zIndex: 100, marginTop: 4,
              background: "#fff", border: "1px solid #ccd", borderRadius: 6,
              boxShadow: "0 4px 16px rgba(0,0,40,.12)", minWidth: 220,
            }}
              onMouseLeave={() => setGenMenuOpen(false)}
            >
              {[
                ["all",      "Generate All Stations",      "#2255cc"],
                ["selected", "Generate Selected Stations", "#555"],
                ["approved", "Generate Approved Stations", "#1a6a1a"],
              ].map(([mode, label, color]) => (
                <button key={mode}
                  onClick={() => { setGenMenuOpen(false); onGenerate(mode === "all" ? null : mode); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "10px 16px", border: "none", background: "none",
                    cursor: "pointer", fontSize: 13, color,
                    borderBottom: mode !== "approved" ? "1px solid #eef" : "none",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#f0f4ff"}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}
                >{label}</button>
              ))}
            </div>
          )}
        </div>
        {cfgs.length > 0 && (
          <a
            href={hwCfgDownloadUrl(importId, cfgs[0].id)}
            download={`HW_Config_${cfgs[0].id}.cfg`}
            style={{ ...btnStyle, background: "#1a8a4a", color: "#fff",
                     textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            ⬇ Download CFG
            {cfgs[0].stats && (
              <span style={{ fontSize: 12, opacity: 0.85 }}>
                ({cfgs[0].stats.stations}S / {cfgs[0].stats.modules}M / {cfgs[0].stats.signals}Sig)
              </span>
            )}
          </a>
        )}
      </div>

      {/* Baseline CFG collapsible panel */}
      {baselineInfo && <BaselinePanel info={baselineInfo} controllerTagName={controllerTagName} />}

      {/* Add-station form */}
      {addingStation && (
        <div style={{ background: "#f0f6ff", border: "1px solid #c0d4f0", borderRadius: 8,
                      padding: "14px 16px", marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Device Type" width={320}>
            <select
              value={newStation.imOrderNo}
              onChange={e => {
                const tpl = templates.find(t => t.order_no === e.target.value);
                onSetNewStation(p => ({ ...p, imOrderNo: e.target.value, imName: tpl ? tpl.display_name : "" }));
              }}
              style={{ ...inputSx, width: "100%", fontFamily: "monospace", fontSize: 12 }}
            >
              <option value="">— select Interface Module —</option>
              {templates.filter(t => (
                // INFRA: ET200SP/CFU_PA heads — exclude old GSDML-path/SCALANCE entries that have no port_config
                (t.signal_type === "INFRA" && t.family !== 'SCALANCE' && t.family !== 'GSDML') ||
                // New-style Scalance: MLFB as order_no, port_config populated
                t.family === 'Scalance'
              ) && t.hw_category === 'station' && !t.order_no.startsWith("V1_1:")).map(t => (
                <option key={t.id} value={t.order_no}>
                  {t.order_no} — {t.display_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Address" width={80}>
            <input type="number" value={newStation.address}
              onChange={e => onSetNewStation(p => ({ ...p, address: e.target.value }))}
              style={inputSx} placeholder="e.g. 3" />
          </Field>
          <Field label="Station Name" width={180}>
            <input value={newStation.name}
              onChange={e => onSetNewStation(p => ({ ...p, name: e.target.value }))}
              style={inputSx} placeholder="e.g. AS01_ET01" />
          </Field>
          <Field label="IP Address" width={140}>
            <input value={newStation.ip}
              onChange={e => onSetNewStation(p => ({ ...p, ip: e.target.value }))}
              style={inputSx} placeholder="192.168.1.x" />
          </Field>
          <Field label="PN System No" width={200}>
            {fieldbuses.length > 0 ? (
              <select
                value={newStation.subsystemNo}
                onChange={e => onSetNewStation(p => ({ ...p, subsystemNo: e.target.value }))}
                style={{ ...inputSx, width: "100%" }}
              >
                {fieldbuses.map(fb => (
                  <option key={fb.INT_DP_Subsystem} value={fb.INT_DP_Subsystem}>
                    {fb.INT_DP_Subsystem} — {fb.T50_Fieldbus_Name}{fb.T15_IP_Address ? ` (${fb.T15_IP_Address})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input type="number" value={newStation.subsystemNo}
                onChange={e => onSetNewStation(p => ({ ...p, subsystemNo: e.target.value }))}
                style={inputSx} placeholder="100" />
            )}
          </Field>
          <button onClick={onCommitAddStation} style={{ ...btnStyle, background: "#2255cc", color: "#fff" }}>Add</button>
          <button onClick={onCancelAddStation} style={{ ...btnStyle }}>Cancel</button>
        </div>
      )}

      {/* Main area: station list */}
      <div style={{ overflowX: "auto" }}>

          {/* ── Table toolbar ──────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <button
              onClick={onStartAddStation}
              disabled={!baselineOk}
              style={{ ...btnStyle, opacity: baselineOk ? 1 : 0.4 }}
            >+ Add Station</button>
          </div>

          {/* Action bar — appears as soon as ≥1 row is checked in the grid */}
          {nSelected > 0 && (
            <div style={{
              display: "flex", gap: 10, alignItems: "center", marginBottom: 8,
              background: "#e8eeff",
              border: "2px solid #99b8f4",
              borderRadius: 8,
              padding: "8px 14px",
              flexWrap: "wrap",
              boxShadow: "0 2px 8px rgba(34,85,204,0.10)",
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                              fontSize: 13, fontWeight: 600, userSelect: "none", color: "#334" }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = nSelected > 0 && !allSelected; }}
                  onChange={onToggleSelectAll}
                  style={{ cursor: "pointer", width: 14, height: 14 }}
                  readOnly
                />
                {nSelected} of {stations.length} selected
              </label>
              <div style={{ height: 20, width: 1, background: "#b0bce0", margin: "0 2px" }} />
              <button
                onClick={() => onBulkApprove(true)}
                style={{ ...btnStyle, fontSize: 12, padding: "4px 14px", background: "#e8f5e9", color: "#1a6a1a", border: "1px solid #9dd" }}
              >✔ Approve</button>
              <button
                onClick={() => onBulkApprove(false)}
                style={{ ...btnStyle, fontSize: 12, padding: "4px 14px", background: "#fff8e1", color: "#b06000", border: "1px solid #e0c060" }}
              >✘ Unapprove</button>
              <div style={{ height: 20, width: 1, background: "#b0bce0", margin: "0 2px" }} />
              <button
                onClick={onBulkDelete}
                style={{
                  ...btnStyle, fontSize: 12, padding: "4px 14px", border: "2px solid",
                  background:  allSelected ? "#b00"   : "#fff0f0",
                  color:       allSelected ? "#fff"   : "#b00",
                  borderColor: allSelected ? "#900"   : "#e88",
                  fontWeight:  allSelected ? 700      : 600,
                }}
                title={allSelected ? "This will permanently delete ALL stations — no recovery possible" : "Delete selected stations"}
              >{allSelected ? "⚠ Delete ALL Stations — Permanent" : `Delete ${nSelected} Station${nSelected !== 1 ? "s" : ""}`}</button>
            </div>
          )}

          {stations.length === 0 ? (
            <div style={{ padding: "40px 24px", textAlign: "center", color: "#aaa", fontSize: 13, border: "1px dashed #dde", borderRadius: 8 }}>
              No stations yet.<br />Upload an Excel IO list or click "+ Add Station".
            </div>
          ) : (
            <HwConfigGrid
              stations={stations}
              templates={templates}
              fieldbuses={fieldbuses}
              configureAddr={configureAddr}
              onConfigure={(addr) => setConfigureAddr(configureAddr === addr ? null : addr)}
              onSelectionChanged={(addrs) => onSetSelectedAddrs(addrs)}
            />
          )}
      </div>

      {cfgs.length > 0 && (
        <div style={{ fontSize: 12, color: "#888", marginTop: 12 }}>
          Last generated: {cfgs[0].generated_at} ·
          Stations: {cfgs[0].stats?.stations ?? "?"} ·
          Modules: {cfgs[0].stats?.modules ?? "?"} ·
          Signals: {cfgs[0].stats?.signals ?? "?"}
        </div>
      )}

      {/* ── Slot Config Modal ── */}
      {configureStation && (
        <SlotConfigModal
          importId={importId}
          station={configureStation}
          templates={templates}
          addrMap={addrMap}
          pipMappings={baselineInfo?.pipMappings || []}
          addingSlot={addingSlot}
          newSlot={newSlot}
          editing={editing}
          editVal={editVal}
          onCopyStation={onCopyStation}
          onDeleteStation={onDeleteStation}
          onOpenAddSlot={onOpenAddSlot}
          onCancelAddSlot={onCancelAddSlot}
          onModuleSelect={onModuleSelect}
          onSetNewSlot={onSetNewSlot}
          onCommitAddSlot={onCommitAddSlot}
          onDeleteSlot={onDeleteSlot}
          onSaveSlotPip={onSaveSlotPip}
          onSaveSlotPotentialGroup={onSaveSlotPotentialGroup}
          onSaveSlotPaProfile={onSaveSlotPaProfile}
          onSaveSlotSubslotProfile={onSaveSlotSubslotProfile}
          isEditing={isEditing}
          onStartEdit={onStartEdit}
          onChangeEdit={onChangeEdit}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onClose={() => setConfigureAddr(null)}
        />
      )}

    </div>
  );
}

// ── Station Detail Panel ───────────────────────────────────────────────────────
function StationDetailPanel({
  station, templates, addrMap, pipMappings, addingSlot, newSlot, editing, editVal, activeSlot,
  onSlotClick, onCopyStation, onDeleteStation,
  onOpenAddSlot, onCancelAddSlot, onModuleSelect, onSetNewSlot, onCommitAddSlot,
  onDeleteSlot, onSaveSlotPip, onSaveSlotPotentialGroup, onSaveSlotPaProfile, onSaveSlotSubslotProfile,
  isEditing, onStartEdit, onChangeEdit, onCommitEdit, onCancelEdit,
}) {
  const [autoSlotConfig, setAutoSlotConfig] = React.useState(null);
  const addSlotRow = addingSlot === station.address;
  const allRows    = station.slots.length > 0 ? station.slots : [null];

  // Load auto-slot config for this station if it exists (for ET200SP port display)
  React.useEffect(() => {
    const imSlot = station.slots.find(s => s.slot === 0);
    if (imSlot && imSlot.orderNo) {
      fetch(`/api/hw-config/station-auto-slots/${encodeURIComponent(imSlot.orderNo)}`)
        .then(r => r.json())
        .then(data => setAutoSlotConfig(data.config))
        .catch(() => setAutoSlotConfig(null));
    }
  }, [station]);

  // Determine station family by looking up the IM (slot 0) template.
  const imSlot = station.slots.find(s => s.slot === 0);
  let imTpl = imSlot ? templates.find(t => t.order_no === imSlot.orderNo) : null;

  // Fallback: station was created with GSDML path as order_no (e.g. pre-refactor or imported from CFG directly).
  // Detect by pattern and try to find a matching Scalance template by gsdml_file.
  const isGsdmlOrderNo = imSlot && imSlot.orderNo && /^GSDML-.*\.xml<DAP/.test(imSlot.orderNo);
  if (isGsdmlOrderNo && (!imTpl || imTpl.family !== 'Scalance')) {
    const gsdmlFile = imSlot.orderNo.replace(/<DAP[\s\S]*/, '').trim(); // "GSDML-V2.42-....xml"
    const byGsdml = templates.find(t => t.family === 'Scalance' && t.gsdml_file === gsdmlFile);
    if (byGsdml) imTpl = byGsdml;
  }

  const stationFamily    = imTpl ? imTpl.family : (isGsdmlOrderNo ? 'Scalance' : null);
  const isEt200Station   = stationFamily ? stationFamily.startsWith("ET200") : false;
  const isCfuPaStation   = stationFamily === 'CFU_PA';
  // isGsdmlOrderNo covers old stations created before MLFB refactor (slot 0 order_no is a GSDML path).
  // 'SCALANCE' (uppercase) comes from old FAMILY_RULES — treat it the same as the new 'Scalance'.
  const isScalanceStation = isGsdmlOrderNo || stationFamily === 'Scalance' || stationFamily === 'SCALANCE';

  // Parse port_config for Scalance stations
  let scalancePorts = [];
  if (isScalanceStation && imTpl && imTpl.port_config) {
    try { scalancePorts = JSON.parse(imTpl.port_config); } catch (_) {}
  }

  // Get ports from auto-slot configuration only (no fallbacks to template)
  let imPorts = [];
  if (autoSlotConfig && autoSlotConfig.slots) {
    const slot0 = autoSlotConfig.slots.find(s => s.slot === 0);
    if (slot0 && slot0.subslots && Array.isArray(slot0.subslots)) {
      imPorts = slot0.subslots.map(ss => ({
        subslot: ss.subslot,
        label: ss.port_label || ss.label,
        orderNo: ss.order_no,
      }));
    }
  }

  return (
    <div style={{ flex: 1, minWidth: 0, border: "1px solid #c8d4f0", borderRadius: 8, overflow: "hidden", background: "#f8f9ff" }}>
      {/* Header */}
      <div style={{
        background: "#dde8ff", padding: "10px 16px",
        borderBottom: "1px solid #c8d4f0",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#224" }}>
              <EditableCell
                value={station.name}
                editing={isEditing(station.address, "station_name")}
                editVal={editVal}
                onEdit={() => onStartEdit(station.address, "station_name", station.name)}
                onChange={onChangeEdit}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
              />
            </span>
            <span style={{ fontSize: 12, color: "#669", fontFamily: "monospace" }}>
              Addr&nbsp;<strong>{station.address}</strong>
            </span>
            <span style={{ fontSize: 12, color: "#669", fontFamily: "monospace" }}>
              IP&nbsp;
              <EditableCell
                value={station.ip || "—"}
                editing={isEditing(station.address, "ip_address")}
                editVal={editVal}
                onEdit={() => onStartEdit(station.address, "ip_address", station.ip || "")}
                onChange={onChangeEdit}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
                inputStyle={{ width: 120, fontFamily: "monospace" }}
              />
            </span>
            <span style={{ fontSize: 12, color: "#669" }}>
              PN&nbsp;
              <EditableCell
                value={station.subsystemNo ?? ""}
                editing={isEditing(station.address, "subsystem_no")}
                editVal={editVal}
                onEdit={() => onStartEdit(station.address, "subsystem_no", station.subsystemNo ?? "")}
                onChange={onChangeEdit}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
                inputStyle={{ width: 48, textAlign: "center" }}
              />
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {!addSlotRow && (
            <button onClick={() => onOpenAddSlot(station.address)}
              style={{ ...btnStyle, fontSize: 12, padding: "4px 12px", color: "#2255cc" }}>
              + Add Slot
            </button>
          )}
          <button onClick={() => onCopyStation(station.address)}
            title="Duplicate with next address and incremented IP"
            style={{ ...btnStyle, fontSize: 12, padding: "4px 12px", color: "#1a6a1a" }}>
            ⎘ Copy
          </button>
          <button onClick={() => onDeleteStation(station.address)}
            style={{ ...btnStyle, fontSize: 12, padding: "4px 12px", color: "#b00" }}>
            Delete
          </button>
        </div>
      </div>

      {/* GSDML/Scalance station view — PCS7-style, data-driven from actual station slots + auto-slot config */}
      {isScalanceStation && (
        <div style={{ padding: "12px 16px" }}>
          <table style={{ ...tableStyle, fontSize: 13 }}>
            <thead>
              <tr>
                {["Module", "Order Number", "I Address", "Q Address", "Diagnostic Address"].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Render every slot in the station (from hw_signals), plus slot 0 subslots from the auto-slot config */}
              {[...station.slots].sort((a, b) => a.slot - b.slot).flatMap((slot) => {
                const isHead = slot.slot === 0;
                const rows = [];
                // Slot main row
                rows.push(
                  <tr key={`slot-${slot.slot}`} style={{ background: isHead ? "#dde8ff" : "#eef3fb" }}>
                    <td style={{ ...tdStyle, fontWeight: isHead ? 700 : 600 }}>
                      {isHead ? (slot.name || (imTpl ? imTpl.display_name : "—"))
                              : `Slot ${slot.slot} — ${slot.name || slot.orderNo}`}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>{slot.orderNo || "—"}</td>
                    <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>—</td>
                    <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>—</td>
                    <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>—</td>
                  </tr>
                );
                // Subslots: for slot 0, pull from auto-slot config; for other slots, from config too
                const cfgSlot = autoSlotConfig && autoSlotConfig.slots
                  ? autoSlotConfig.slots.find(s => s.slot === slot.slot) : null;
                if (cfgSlot && Array.isArray(cfgSlot.subslots)) {
                  for (const ss of cfgSlot.subslots) {
                    rows.push(
                      <tr key={`slot-${slot.slot}-ss-${ss.subslot}`} style={{ background: "#fff" }}>
                        <td style={{ ...tdStyle, paddingLeft: 24 }}>
                          {ss.port_label || ss.label || `Subslot ${ss.subslot}`}
                          <span style={{ marginLeft: 6, fontSize: 9, color: "#aaa", background: "#f0f0f0",
                                         borderRadius: 3, padding: "1px 4px", verticalAlign: "middle" }}>AUTO</span>
                        </td>
                        <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>{ss.order_no || "—"}</td>
                        <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>—</td>
                        <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>—</td>
                        <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>—</td>
                      </tr>
                    );
                  }
                }
                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Slot table (ET200 / CFU_PA / other) */}
      {!isScalanceStation && <div style={{ padding: "12px 16px", overflowX: "auto" }}>
        <table style={{ ...tableStyle, fontSize: 13 }}>
          <thead>
            <tr>
              {["Slot", "Module Order No", "Module Name", "PIP", ...(isEt200Station ? ["Pot. Group"] : []), "Addr IN", "Addr OUT", "Signals", ""].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {allRows.flatMap((slot, sli) => {
              // CFU_PA: slots 0, 1, 2 are system-reserved — lock them (no delete, no click for 0/2)
              const cfuLocked = isCfuPaStation && slot && slot.slot <= 2;
              const cfuAutocreated = isCfuPaStation && slot && (slot.slot === 0 || slot.slot === 2);
              const isClickable = slot && slot.slot !== 0 && !(cfuAutocreated);

              // For CFU_PA PA device slots (≥3), look up signal_type to label subslots correctly
              const isPaDevSlot = isCfuPaStation && slot && slot.slot >= 3;
              const paSlotTpl = isPaDevSlot ? templates.find(t => t.order_no === slot.orderNo) : null;

              const mainRow = (
              <tr key={`slot-${slot ? slot.slot : sli}`}
                onClick={() => onSlotClick(station, slot)}
                style={{
                  background: slot && activeSlot &&
                    activeSlot.stationAddr === station.address && activeSlot.slot === slot.slot
                    ? "#EEEDFE"
                    : cfuAutocreated ? "#f5f7fa"
                    : sli % 2 === 0 ? "#fff" : "#f7f9fc",
                  cursor: isClickable ? "pointer" : "default",
                }}>
                {slot === null ? (
                  <td colSpan={isEt200Station ? 9 : 8} style={{ ...tdStyle, color: "#aaa", fontStyle: "italic" }}>
                    No modules yet
                  </td>
                ) : (
                  <>
                    <td style={{ ...tdStyle, textAlign: "center", color: "#888", fontWeight: 600 }}>
                      {slot.slot}
                      {cfuLocked && (
                        <span style={{ marginLeft: 4, fontSize: 9, color: "#888", fontWeight: 400,
                                       background: "#eee", borderRadius: 3, padding: "1px 4px",
                                       verticalAlign: "middle" }}>
                          {cfuAutocreated ? "AUTO" : "DIQ8"}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>
                      {cfuLocked ? (
                        <span style={{ color: "#667", fontFamily: "monospace", fontSize: 11 }}>{slot.orderNo}</span>
                      ) : (
                        <EditableCell
                          value={slot.orderNo}
                          editing={isEditing(station.address, "module_order_no", slot.slot)}
                          editVal={editVal}
                          onEdit={() => onStartEdit(station.address, "module_order_no", slot.orderNo, slot.slot)}
                          onChange={onChangeEdit}
                          onCommit={onCommitEdit}
                          onCancel={onCancelEdit}
                          inputStyle={{ width: 220, fontFamily: "monospace", fontSize: 11 }}
                        />
                      )}
                    </td>
                    <td style={tdStyle}>
                      {cfuLocked ? (
                        <span style={{ color: "#667" }}>{slot.name}</span>
                      ) : (
                        <EditableCell
                          value={slot.name}
                          editing={isEditing(station.address, "module_name", slot.slot)}
                          editVal={editVal}
                          onEdit={() => onStartEdit(station.address, "module_name", slot.name, slot.slot)}
                          onChange={onChangeEdit}
                          onCommit={onCommitEdit}
                          onCancel={onCancelEdit}
                        />
                      )}
                    </td>
                    <td style={{ ...tdStyle, padding: "3px 8px" }} onClick={e => e.stopPropagation()}>
                      {slot.slot === 0 || pipMappings.length === 0 || cfuAutocreated ? (
                        <span style={{ color: "#bbb", fontSize: 11 }}>—</span>
                      ) : (
                        <select
                          value={slot.pipNo != null ? slot.pipNo : ""}
                          onChange={e => {
                            const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
                            onSaveSlotPip(station.address, slot.slot, val);
                          }}
                          style={{ fontSize: 11, border: "1px solid #c8d4f0", borderRadius: 3,
                                   padding: "2px 4px", background: slot.pipNo != null ? "#eef0f8" : "#fff",
                                   color: slot.pipNo != null ? "#2255cc" : "#888", cursor: "pointer" }}
                        >
                          <option value="">OB1 (default)</option>
                          {pipMappings.map(p => (
                            <option key={p.pipNo} value={p.pipNo}>
                              PIP{p.pipNo} · OB{p.ob} · {p.executionTime} {p.timeScale}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    {isEt200Station && slot.slot !== 0 && (
                      <td style={{ ...tdStyle, padding: "3px 8px" }} onClick={e => e.stopPropagation()}>
                        <select
                          value={slot.potentialGroup || ""}
                          onChange={e => onSaveSlotPotentialGroup(station.address, slot.slot, e.target.value || null)}
                          style={{ fontSize: 11, border: "1px solid #c8d4f0", borderRadius: 3,
                                   padding: "2px 4px",
                                   background: slot.potentialGroup ? "#eef0f8" : "#fff",
                                   color: slot.potentialGroup ? "#2255cc" : "#888", cursor: "pointer" }}
                        >
                          <option value="">— not set —</option>
                          <option value="NEW_GROUP">New potential group</option>
                          <option value="LEFT_MODULE">Borrow from left module</option>
                        </select>
                      </td>
                    )}
                    {isEt200Station && slot.slot === 0 && (
                      <td style={{ ...tdStyle, textAlign: "center", color: "#bbb", fontSize: 11 }}>—</td>
                    )}
                    {(() => {
                      const addrs = addrMap && addrMap[`${station.address}:${slot.slot}`];
                      const addrCellStyle = { ...tdStyle, textAlign: "right", fontFamily: "monospace", fontSize: 11, minWidth: 52, paddingRight: 8 };
                      const dashStyle = { ...addrCellStyle, color: "#ccc", textAlign: "center" };
                      return (<>
                        <td style={addrs && addrs.inputAddr  != null ? { ...addrCellStyle, color: "#1a5c1a" } : dashStyle}>
                          {addrs && addrs.inputAddr  != null ? addrs.inputAddr  : "—"}
                        </td>
                        <td style={addrs && addrs.outputAddr != null ? { ...addrCellStyle, color: "#5c1a1a" } : dashStyle}>
                          {addrs && addrs.outputAddr != null ? addrs.outputAddr : "—"}
                        </td>
                      </>);
                    })()}
                    <td style={{ ...tdStyle, textAlign: "center", color: slot.signalCount > 0 ? "#226" : "#bbb" }}>
                      {slot.signalCount > 0 ? slot.signalCount : "—"}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      {slot.slot !== 0 && !cfuLocked && (
                        <button
                          onClick={e => { e.stopPropagation(); onDeleteSlot(station.address, slot.slot); }}
                          title="Remove slot"
                          style={miniBtn("#e44", "#fff")}
                        >✕</button>
                      )}
                      {cfuLocked && slot.slot !== 0 && (
                        <span title="System-reserved slot — cannot be removed"
                              style={{ fontSize: 11, color: "#bbb" }}>🔒</span>
                      )}
                    </td>
                  </>
                )}
              </tr>
              );

              // Append subslot rows from auto-slot configuration (if any exist for slot 0)
              if (slot && slot.slot === 0 && imPorts.length > 0) {
                const portSsTdBase = {
                  ...tdStyle, fontSize: 11, color: "#666",
                  paddingTop: 2, paddingBottom: 2,
                  borderTop: "1px dashed #ddd", background: "#f0f6ff",
                };
                const portRows = imPorts.map((port, pi) => (
                  <tr key={`im-port-${port.subslot}`} style={{ background: pi % 2 === 0 ? "#f0f6ff" : "#e8f0ff", cursor: "default" }}>
                    <td style={{ ...portSsTdBase, textAlign: "center", color: "#2255cc", fontWeight: 600 }}>
                      <span style={{ paddingLeft: 12 }}>↳ 0.{port.subslot}</span>
                    </td>
                    <td style={{ ...portSsTdBase, fontFamily: "monospace" }}>
                      <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3,
                                     background: "#dbeafe", color: "#1d4ed8", fontWeight: 600 }}>
                        {port.orderNo ? "SUBSLOT" : "—"}
                      </span>
                    </td>
                    <td style={{ ...portSsTdBase }}>
                      {port.label || "—"}
                    </td>
                    <td style={{ ...portSsTdBase, color: "#aaa" }}>—</td>
                    <td style={{ ...portSsTdBase, textAlign: "center", color: "#aaa" }}>—</td>
                    <td style={{ ...portSsTdBase, textAlign: "center", color: "#aaa" }}>—</td>
                    {isEt200Station && <td style={{ ...portSsTdBase, textAlign: "center", color: "#aaa" }}>—</td>}
                    <td style={{ ...portSsTdBase, textAlign: "center", color: "#aaa" }}>—</td>
                    <td style={{ ...portSsTdBase, textAlign: "center" }}></td>
                  </tr>
                ));
                return [mainRow, ...portRows];
              }

              // CFU_PA PA device slots (≥3): append function subslot rows + service row
              if (!isPaDevSlot || slot === null) return [mainRow];

              const ssRowStyle = {
                background: "#f3f0ff",
                cursor: "default",
                borderTop: "none",
              };
              const ssTdBase = {
                ...tdStyle,
                fontSize: 11,
                color: "#777",
                paddingTop: 2,
                paddingBottom: 2,
                borderTop: "1px dashed #ddd",
              };

              // Number of function subslots: from template channel_count (min 1)
              const funcCount = paSlotTpl && (paSlotTpl.channel_count || 0) > 1
                ? paSlotTpl.channel_count : 1;
              const serviceSubslotNo = funcCount + 1;

              // PA subslot profile options from catalogue
              const paSubslots = templates.filter(t => t.hw_category === 'subslot' && t.family === stationFamily);
              // Build per-subslot lookup: subslotNo → { paProfile }
              const subslotLookup = new Map((slot.subslots || []).map(ss => [ss.subslotNo, ss]));

              // Build function subslot rows — each SS has its own independent profile selector
              const slotAddrs = addrMap && addrMap[`${station.address}:${slot.slot}`];
              const ssAddrList = slotAddrs && slotAddrs.subslotAddrs ? slotAddrs.subslotAddrs : [];
              const ssAddrMap  = new Map(ssAddrList.map(a => [a.subslotNo, a]));

              const funcRows = Array.from({ length: funcCount }, (_, fi) => {
                const ssNo = fi + 1;
                const ssData = subslotLookup.get(ssNo);
                const ssProfile = ssData ? ssData.paProfile : null;
                const ssLocked = !!ssProfile;
                const ssProfileTpl = ssProfile ? paSubslots.find(t => t.order_no === ssProfile) : null;
                const ssAddr = ssAddrMap.get(ssNo);
                return (
                  <tr key={`ss${ssNo}-${slot.slot}`}
                    style={{ ...ssRowStyle, cursor: "pointer" }}
                    onClick={() => onSlotClick(station, slot)}>
                    <td style={{ ...ssTdBase, textAlign: "center", color: "#9979cc", fontWeight: 600 }}>
                      <span style={{ paddingLeft: 12 }}>↳ {slot.slot}.{ssNo}</span>
                    </td>
                    <td style={{ ...ssTdBase, fontFamily: "monospace" }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input
                          type="checkbox"
                          checked={ssLocked}
                          onChange={e => {
                            if (!e.target.checked) onSaveSlotSubslotProfile(station.address, slot.slot, ssNo, null);
                          }}
                          title={ssLocked ? "Uncheck to change profile" : "Select a profile first"}
                          style={{ cursor: "pointer", accentColor: "#9979cc", margin: 0, flexShrink: 0 }}
                        />
                        {ssLocked ? (
                          <span style={{ color: "#9979cc", fontFamily: "monospace", fontSize: 11 }}>{ssProfile}</span>
                        ) : (
                          <select
                            value=""
                            onChange={e => { if (e.target.value) onSaveSlotSubslotProfile(station.address, slot.slot, ssNo, e.target.value); }}
                            onClick={e => e.stopPropagation()}
                            title={`Select PA profile for ${slot.slot}.${ssNo}`}
                            style={{
                              fontSize: 11, border: "1px solid #c8a8f0", borderRadius: 3,
                              padding: "2px 4px", background: "#faf8ff",
                              color: "#9979cc", cursor: "pointer", fontFamily: "monospace",
                            }}
                          >
                            <option value="">— select —</option>
                            {paSubslots.map(t => (
                              <option key={t.order_no} value={t.order_no}>{t.order_no}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    </td>
                    <td style={{ ...ssTdBase }}>
                      {ssProfileTpl
                        ? <span style={{ color: "#9979cc", fontSize: 11 }}>{ssProfileTpl.display_name}</span>
                        : <span style={{ color: "#ccc", fontSize: 11 }}>—</span>
                      }
                    </td>
                    <td style={{ ...ssTdBase, color: "#9979cc" }}>Signal data (process image)</td>
                    <td style={{ ...ssTdBase, textAlign: "right", fontFamily: "monospace", paddingRight: 8,
                        color: ssAddr ? "#1a5c1a" : "#ccc" }}>
                      {ssAddr ? ssAddr.inputAddr : "—"}
                    </td>
                    <td style={{ ...ssTdBase, textAlign: "center", color: "#ccc" }}>—</td>
                    <td style={{ ...ssTdBase, textAlign: "center" }}></td>
                  </tr>
                );
              });

              const serviceRow = (
                <tr key={`ss${serviceSubslotNo}-${slot.slot}`} style={{ ...ssRowStyle, background: "#ede8ff" }}>
                  <td style={{ ...ssTdBase, textAlign: "center", color: "#7755aa", fontWeight: 600 }}>
                    <span style={{ paddingLeft: 12 }}>↳ {slot.slot}.{serviceSubslotNo}</span>
                  </td>
                  <td style={{ ...ssTdBase, fontFamily: "monospace" }}>
                    <span style={{ color: "#7755aa" }}>_S7H_NORM_PDM_BUB_MODULE_CT</span>
                  </td>
                  <td style={{ ...ssTdBase }}></td>
                  <td style={{ ...ssTdBase, color: "#7755aa" }}>Service (AUTOCREATED)</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}></td>
                </tr>
              );

              return [mainRow, ...funcRows, serviceRow];
            })}

            {/* Inline add-slot form */}
            {addSlotRow && (
              <tr style={{ background: "#f0f6ff" }}>
                <td style={{ ...tdStyle, textAlign: "center" }}>
                  <input type="number" value={newSlot.slot}
                    onChange={e => onSetNewSlot(p => ({ ...p, slot: e.target.value }))}
                    min={isCfuPaStation ? 3 : 1}
                    style={{ ...inputSx, width: 48, textAlign: "center" }} placeholder="#" />
                </td>
                <td style={{ ...tdStyle }}>
                  <select value={newSlot.moduleOrderNo} onChange={e => onModuleSelect(e.target.value)}
                    style={{ ...inputSx, width: "100%", fontFamily: "monospace", fontSize: 11 }}>
                    <option value="">— select module —</option>
                    {templates
                      .filter(t => {
                        if (t.order_no.startsWith("V1_1:") || t.order_no.includes("PLACEHOLDER")) return false;
                        // CFU_PA stations: show only PA slot-level profiles.
                        // Accept signal_type='PA' (newly parsed) OR META\ prefix (already-stored rows that
                        // were imported before the parser forced signal_type='PA').
                        if (isCfuPaStation) return t.family === 'CFU_PA' && t.hw_category === 'slot' &&
                          (t.signal_type === 'PA' || /^META[/\\]/i.test(t.order_no));
                        return true;
                      })
                      .map(t => (
                        <option key={t.id} value={t.order_no}>
                          {t.order_no} — {t.display_name}
                        </option>
                      ))
                    }
                  </select>
                </td>
                <td style={{ ...tdStyle }}>
                  <input
                    value={newSlot.moduleName}
                    onChange={e => onSetNewSlot(p => ({ ...p, moduleName: e.target.value }))}
                    style={{ ...inputSx, width: "100%", borderColor: newSlot.moduleName.trim() ? undefined : "#e88" }}
                    placeholder="module name *"
                  />
                </td>
                <td style={{ ...tdStyle, textAlign: "center", color: "#bbb" }}>—</td>
                {isEt200Station && (
                  <td style={{ ...tdStyle, textAlign: "center", color: "#bbb", fontSize: 11 }}>—</td>
                )}
                <td style={{ ...tdStyle, textAlign: "center", color: "#bbb" }}>—</td>
                <td style={{ ...tdStyle, textAlign: "center", color: "#bbb" }}>—</td>
                <td style={{ ...tdStyle, textAlign: "center", color: "#bbb" }}>—</td>
                <td style={{ ...tdStyle }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => onCommitAddSlot(station.address)} style={miniBtn("#2255cc", "#fff")}>✓</button>
                    <button onClick={onCancelAddSlot} style={miniBtn("#aaa", "#fff")}>✗</button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>}
    </div>
  );
}

// ── Baseline Info Panel ────────────────────────────────────────────────────────
function BaselinePanel({ info, controllerTagName }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 20, border: "1px solid #c8d8f0", borderRadius: 8,
                  background: "#f0f6ff", overflow: "hidden" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
                 cursor: "pointer", userSelect: "none", background: "#ddeeff" }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ fontSize: 16, fontWeight: 700, color: "#224" }}>
          {controllerTagName ? `${controllerTagName} - Controller` : `${info.stationType} "${info.stationName}"`}
        </span>
        <span style={{ fontSize: 12, color: "#669" }}>
          {info.subnets} subnet{info.subnets !== 1 ? "s" : ""}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#669" }}>{open ? "▲ hide" : "▼ show"}</span>
      </div>

      {open && (
        <div style={{ padding: "12px 16px", display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* Rack modules */}
          <div style={{ flex: 1, minWidth: 300 }}>
            {info.rackModules && info.rackModules.length > 0 ? (
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                <thead>
                  <tr>
                    {["Slot", "Subslot", "Name", "IP Address"].map(h => (
                      <th key={h} style={{ ...thStyle, padding: "4px 8px", fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {info.rackModules.map((m, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#f4f8ff" }}>
                      <td style={{ ...tdStyle, textAlign: "center", padding: "3px 8px" }}>{m.slot}</td>
                      <td style={{ ...tdStyle, textAlign: "center", padding: "3px 8px" }}>{m.subslot ?? "—"}</td>
                      <td style={{ ...tdStyle, padding: "3px 8px" }}>{m.name}</td>
                      <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11, padding: "3px 8px", color: m.ip ? "#1a6a1a" : "#bbb" }}>
                        {m.ip || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span style={{ color: "#999", fontSize: 13 }}>No rack modules found.</span>
            )}
          </div>

          {/* PIP Mapping Table */}
          {info.pipMappings && info.pipMappings.length > 0 && (
            <div style={{ minWidth: 260 }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: "#446", textTransform: "uppercase",
                            letterSpacing: "0.04em", marginBottom: 6 }}>
                Process Image Partitions
              </div>
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                <thead>
                  <tr>
                    {["PIP", "Cyclic Update OB", "Execution Time"].map(h => (
                      <th key={h} style={{ ...thStyle, padding: "4px 10px", fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {info.pipMappings.map((p, i) => (
                    <tr key={p.pipNo} style={{ background: i % 2 === 0 ? "#fff" : "#f4f8ff" }}>
                      <td style={{ ...tdStyle, fontWeight: 700, color: "#2255cc", padding: "3px 10px",
                                   fontFamily: "monospace" }}>
                        PIP{p.pipNo}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "monospace", padding: "3px 10px", color: "#446" }}>
                        OB{p.ob}
                      </td>
                      <td style={{ ...tdStyle, padding: "3px 10px", color: "#224" }}>
                        {p.executionTime} {p.timeScale}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────────
function Field({ label, width, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#446", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </label>
      <div style={{ width }}>{children}</div>
    </div>
  );
}

function InfoSection({ title, children }) {
  return (
    <div style={{ minWidth: 200 }}>
      <div style={{ fontWeight: 700, fontSize: 12, color: "#446", textTransform: "uppercase",
                    letterSpacing: "0.04em", marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function AddrBadge({ label, val }) {
  const display = val == null || val < 0 ? "—" : val;
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#226", fontFamily: "monospace" }}>{display}</div>
      <div style={{ fontSize: 11, color: "#778" }}>{label}</div>
    </div>
  );
}

function EditableCell({ value, editing, editVal, onEdit, onChange, onCommit, onCancel, inputStyle = {} }) {
  if (editing) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          autoFocus
          value={editVal}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onCommit(); if (e.key === "Escape") onCancel(); }}
          style={{ border: "1px solid #66a", borderRadius: 3, padding: "2px 5px", fontSize: "inherit",
                   fontFamily: "inherit", ...inputStyle }}
        />
        <button onClick={onCommit} style={miniBtn("#2255cc", "#fff")} title="Save">✓</button>
        <button onClick={onCancel} style={miniBtn("#aaa", "#fff")} title="Cancel">✗</button>
      </span>
    );
  }
  return (
    <span
      onClick={onEdit}
      title="Click to edit"
      style={{ cursor: "text", display: "inline-block", minWidth: 30, padding: "1px 2px",
               borderRadius: 3, borderBottom: "1px dashed transparent" }}
      onMouseEnter={e => { e.currentTarget.style.borderBottomColor = "#99b"; }}
      onMouseLeave={e => { e.currentTarget.style.borderBottomColor = "transparent"; }}
    >
      {value || <span style={{ color: "#bbb" }}>—</span>}
    </span>
  );
}

function UploadCard({ label, ok, okLabel, btnLabel, onBtn, accept, inputRef, onChange, disabled }) {
  return (
    <div style={{ flex: 1, minWidth: 260, background: "#f8f9ff", border: "1px solid #ccd",
                  borderRadius: 8, padding: "14px 16px" }}>
      <label style={{ fontWeight: 700, display: "block", marginBottom: 8, fontSize: 14 }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onBtn} style={{ ...btnStyle, opacity: disabled ? 0.5 : 1 }}>{btnLabel}</button>
        {ok && <span style={{ color: "#2a8", fontWeight: 700, fontSize: 13 }}>{okLabel}</span>}
        <input type="file" accept={accept} ref={inputRef} onChange={onChange} style={{ display: "none" }} />
      </div>
    </div>
  );
}

// ── Slot Config Modal ─────────────────────────────────────────────────────────
// Full-screen overlay: left half = StationDetailPanel, right half = SlotSignalPanel.
// Opens when user clicks "Configure" on a slot row. Closes via the × button.
function SlotConfigModal({
  importId, station, templates, addrMap, pipMappings,
  addingSlot, newSlot, editing, editVal,
  onCopyStation, onDeleteStation,
  onOpenAddSlot, onCancelAddSlot, onModuleSelect, onSetNewSlot, onCommitAddSlot,
  onDeleteSlot, onSaveSlotPip, onSaveSlotPotentialGroup, onSaveSlotPaProfile, onSaveSlotSubslotProfile,
  isEditing, onStartEdit, onChangeEdit, onCommitEdit, onCancelEdit,
  initialSlot, // { slot, orderNo, name } to open immediately
  onClose,
}) {
  const [activeSlot, setActiveSlot] = useState(initialSlot || null);

  const handleSlotClick = (st, slot) => {
    if (!slot || slot.slot === 0) return;
    const imSlot = st.slots.find(s => s.slot === 0);
    const imTpl  = imSlot ? templates.find(t => t.order_no === imSlot.orderNo) : null;
    if (imTpl && imTpl.family === 'CFU_PA' && slot.slot === 2) return;
    const key     = `${st.address}-${slot.slot}`;
    const activeKey = activeSlot ? `${activeSlot.stationAddr}-${activeSlot.slot}` : null;
    if (key === activeKey) { setActiveSlot(null); return; }
    setActiveSlot({ stationAddr: st.address, slot: slot.slot, orderNo: slot.orderNo, name: slot.name });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(20,30,60,0.45)",
      display: "flex", alignItems: "stretch",
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        margin: "auto",
        width: "95vw", height: "90vh",
        background: "#f0f4ff",
        borderRadius: 12,
        boxShadow: "0 8px 40px rgba(10,20,80,0.25)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Modal header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 18px",
          background: "#dde8ff", borderBottom: "1px solid #c8d4f0",
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#224", flex: 1 }}>
            Configure — {station.name || `Station_${station.address}`}
            <span style={{ fontWeight: 400, fontSize: 12, color: "#669", marginLeft: 12, fontFamily: "monospace" }}>
              Addr {station.address} · {station.ip || "—"}
            </span>
          </span>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
                     fontSize: 22, color: "#667", lineHeight: 1, padding: "0 4px" }}
            title="Close"
          >×</button>
        </div>

        {/* Body: two halves side-by-side */}
        <div style={{ flex: 1, display: "flex", gap: 0, overflow: "hidden" }}>

          {/* Left 70%: slot table */}
          <div style={{ flex: 7, minWidth: 0, overflowY: "auto", padding: 16,
                        borderRight: "1px solid #c8d4f0" }}>
            <StationDetailPanel
              station={station}
              templates={templates}
              addrMap={addrMap}
              pipMappings={pipMappings}
              addingSlot={addingSlot}
              newSlot={newSlot}
              editing={editing}
              editVal={editVal}
              activeSlot={activeSlot}
              onSlotClick={handleSlotClick}
              onCopyStation={onCopyStation}
              onDeleteStation={onDeleteStation}
              onOpenAddSlot={onOpenAddSlot}
              onCancelAddSlot={onCancelAddSlot}
              onModuleSelect={onModuleSelect}
              onSetNewSlot={onSetNewSlot}
              onCommitAddSlot={onCommitAddSlot}
              onDeleteSlot={onDeleteSlot}
              onSaveSlotPip={onSaveSlotPip}
              onSaveSlotPotentialGroup={onSaveSlotPotentialGroup}
              onSaveSlotPaProfile={onSaveSlotPaProfile}
              onSaveSlotSubslotProfile={onSaveSlotSubslotProfile}
              isEditing={isEditing}
              onStartEdit={onStartEdit}
              onChangeEdit={onChangeEdit}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          </div>

          {/* Right 30%: channel signal panel */}
          <div style={{ flex: 3, minWidth: 0, overflowY: "auto", background: "#f8f9ff" }}>
            {activeSlot ? (
              <SlotSignalPanel
                key={`${activeSlot.stationAddr}-${activeSlot.slot}`}
                importId={importId}
                stationAddr={activeSlot.stationAddr}
                slot={activeSlot.slot}
                slotName={activeSlot.name}
                orderNo={activeSlot.orderNo}
                templates={templates}
                onClose={() => setActiveSlot(null)}
              />
            ) : (
              <div style={{
                height: "100%", display: "flex", alignItems: "center",
                justifyContent: "center", color: "#aaa", fontSize: 13,
                flexDirection: "column", gap: 8,
              }}>
                <span style={{ fontSize: 32, opacity: 0.3 }}>↖</span>
                Click a slot row to assign signal names
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slot Signal Panel ─────────────────────────────────────────────────────────
function SlotSignalPanel({ importId, stationAddr, slot, slotName, orderNo, templates, onClose }) {
  const [channels, setChannels] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(null); // channel index being saved
  const [drafts,   setDrafts]   = useState({});   // { [ch]: { tag, description } }

  const tpl = templates.find(t => t.order_no === orderNo);
  const ioType      = tpl ? tpl.signal_type : null;
  const isPaSlot    = ioType === 'PA';
  const isMixed     = ioType === 'MIXED';
  // Multi-function PA profiles (Analyzer etc.): channel = 0-based function index, not PA bus address
  const funcCount   = tpl && (tpl.channel_count || 0) > 1 ? tpl.channel_count : 1;
  const isPaMulti   = isPaSlot && funcCount > 1;

  useEffect(() => {
    setLoading(true);
    getSlotChannels(importId, stationAddr, slot)
      .then(rows => {
        setChannels(rows);
        const d = {};
        rows.forEach(r => { d[r.channel] = { tag: r.tag || "", description: r.description || "", paAddr: r.channel }; });
        setDrafts(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [importId, stationAddr, slot]);

  const setDraft = (ch, field, val) =>
    setDrafts(prev => ({ ...prev, [ch]: { ...prev[ch], [field]: val } }));

  const save = async (ch) => {
    setSaving(ch);
    try {
      const d = drafts[ch] ?? {};
      // PA single-function: channel key = PA bus address (user-editable).
      // PA multi-function: channel key = function index (fixed, not a bus address).
      const newCh = (isPaSlot && !isPaMulti && d.paAddr != null) ? d.paAddr : ch;
      // For MIXED slots use the per-channel signal_type stored on the channel row
      const chRow = channels.find(r => r.channel === ch);
      const saveType = isMixed ? (chRow ? chRow.signal_type : null) : ioType;
      await patchSlotChannel(importId, stationAddr, slot, newCh, {
        tag: d.tag ?? "",
        description: d.description ?? "",
        signal_type: saveType,
      });
      // If the PA bus address changed (channel key changed), clear the old channel row
      if (isPaSlot && !isPaMulti && newCh !== ch) {
        await patchSlotChannel(importId, stationAddr, slot, ch, { tag: "", description: "", signal_type: saveType });
      }
      setChannels(prev => prev.map(r => r.channel === ch
        ? { ...r, channel: newCh, tag: d.tag ?? "", description: d.description ?? "" }
        : r
      ));
    } catch (e) { alert(e.message); }
    finally { setSaving(null); }
  };

  const ioDot = (type) => {
    const c = { DI: "#2e7d32", DO: "#e65100", AI: "#1565c0", AO: "#880e4f", PA: "#6a1b9a" }[type] || "#888";
    return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: c, marginRight: 6 }} />;
  };

  return (
    <div style={{
      width: "100%",
      border: "1px solid #c8d4f0", borderRadius: 8,
      background: "#f8f9ff", overflow: "hidden",
      height: "100%",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", background: "#dde8ff",
        borderBottom: "1px solid #c8d4f0",
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#224" }}>
            {ioDot(ioType)}{slotName}
          </div>
          <div style={{ fontSize: 11, color: "#669", fontFamily: "monospace", marginTop: 2 }}>{orderNo}</div>
          {isPaSlot && !isPaMulti && (
            <div style={{ fontSize: 10, color: "#6a1b9a", marginTop: 2 }}>
              PA Device — set PA bus address (0-126) as the channel number
            </div>
          )}
          {isPaMulti && (
            <div style={{ fontSize: 10, color: "#6a1b9a", marginTop: 2 }}>
              {funcCount} PA functions — assign signal tags per subslot
            </div>
          )}
        </div>
        <button onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#888", lineHeight: 1 }}>
          ×
        </button>
      </div>

      {/* Table */}
      <div style={{ overflowY: "auto", maxHeight: "70vh" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "#aaa", fontSize: 13 }}>Loading…</div>
        ) : channels.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#aaa", fontSize: 13 }}>No channels</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                {[isPaMulti ? "Function" : (isPaSlot ? "PA Addr" : "Ch"), "IO Type", "Signal Name", "Description", ""].map(h => (
                  <th key={h} style={{
                    padding: "6px 10px", fontSize: 11, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: "0.04em",
                    color: "#556", background: "#eef2ff",
                    borderBottom: "1px solid #c8d4f0", textAlign: "left",
                    whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const renderRow = (row, i) => {
                  const ch = row.channel;
                  const draft = drafts[ch] || { tag: "", description: "", paAddr: ch };
                  const dirty = draft.tag !== (row.tag || "") || draft.description !== (row.description || "")
                             || (isPaSlot && !isPaMulti && (draft.paAddr ?? ch) !== ch);
                  const displayType = isMixed ? row.signal_type : ioType;
                  return (
                    <tr key={ch} style={{ background: i % 2 === 0 ? "#fff" : "#f5f7ff" }}>
                      <td style={{ padding: "5px 10px", fontWeight: 700, color: "#446", textAlign: "center", whiteSpace: "nowrap" }}>
                        {isPaMulti ? (
                          <span style={{ color: "#6a1b9a", fontSize: 11, fontWeight: 600 }}>Fn {ch + 1}</span>
                        ) : isPaSlot ? (
                          <input
                            type="number"
                            min={0} max={126}
                            value={draft.paAddr ?? ch}
                            title="PA bus address (0-126)"
                            onChange={e => setDraft(ch, "paAddr", parseInt(e.target.value, 10) || 0)}
                            style={{ width: 48, textAlign: "center", padding: "2px 4px", fontSize: 12,
                                     border: "1px solid #c0ccf0", borderRadius: 3, fontFamily: "monospace" }}
                          />
                        ) : (isMixed ? (ch % 8) + 1 : ch + 1)}
                      </td>
                      <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                        {displayType ? (
                          <span style={{
                            background: sigBadge(displayType).background, color: sigBadge(displayType).color,
                            borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700,
                          }}>{displayType}</span>
                        ) : "—"}
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        <input
                          value={draft.tag}
                          onChange={e => setDraft(ch, "tag", e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") save(ch); }}
                          placeholder="e.g. AS01_DI_001"
                          style={{
                            width: "100%", padding: "3px 6px", fontSize: 12,
                            border: "1px solid #c0ccf0", borderRadius: 4,
                            background: "#fff", fontFamily: "monospace", boxSizing: "border-box",
                          }}
                        />
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        <input
                          value={draft.description}
                          onChange={e => setDraft(ch, "description", e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") save(ch); }}
                          placeholder="Description"
                          style={{
                            width: "100%", padding: "3px 6px", fontSize: 12,
                            border: "1px solid #c0ccf0", borderRadius: 4,
                            background: "#fff", boxSizing: "border-box",
                          }}
                        />
                      </td>
                      <td style={{ padding: "4px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                        {dirty && (
                          <button onClick={() => save(ch)} disabled={saving === ch}
                            style={{
                              fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                              border: "none", background: "#2255cc", color: "#fff", fontWeight: 600,
                              opacity: saving === ch ? 0.5 : 1,
                            }}>
                            {saving === ch ? "…" : "Save"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                };

                if (isMixed) {
                  const diRows = channels.filter(r => r.signal_type === 'DI');
                  const doRows = channels.filter(r => r.signal_type === 'DO');
                  const sectionHdr = (label, bg) => (
                    <tr key={label}>
                      <td colSpan={5} style={{
                        padding: "4px 10px", fontSize: 11, fontWeight: 700,
                        background: bg, color: "#444", letterSpacing: "0.04em",
                        borderTop: "1px solid #c8d4f0",
                      }}>{label}</td>
                    </tr>
                  );
                  return [
                    sectionHdr("DI Channels (1–8)", "#e8f5e9"),
                    ...diRows.map((row, i) => renderRow(row, i)),
                    sectionHdr("DO Channels (1–8)", "#fff3e0"),
                    ...doRows.map((row, i) => renderRow(row, i)),
                  ];
                }
                return channels.map((row, i) => renderRow(row, i));
              })()}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const btnStyle = {
  padding: "8px 18px", borderRadius: 6, border: "1px solid #ccd",
  background: "#f0f4ff", cursor: "pointer", fontWeight: 600, fontSize: 14, whiteSpace: "nowrap",
};

const inputSx = {
  padding: "5px 8px", border: "1px solid #ccd", borderRadius: 4,
  fontSize: 13, fontFamily: "inherit", background: "#fff",
};

function miniBtn(bg, color) {
  return {
    background: bg, color, border: "none", borderRadius: 3, padding: "2px 6px",
    cursor: "pointer", fontSize: 12, fontWeight: 700,
  };
}

function alertStyle(bg, border, color) {
  return { background: bg, border: `1px solid ${border}`, borderRadius: 6,
           padding: "10px 16px", marginBottom: 16, color };
}

function tagStyle(bg, color) {
  return { background: bg, color, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 };
}

function sigBadge(type) {
  const colors = {
    DI: ["#e8f5e9", "#2e7d32"], DO: ["#fff3e0", "#e65100"],
    AI: ["#e3f2fd", "#1565c0"], AO: ["#fce4ec", "#880e4f"],
    PA: ["#f3e5f5", "#6a1b9a"], INFRA: ["#f5f5f5", "#616161"],
    MIXED: ["#fffde7", "#f57f17"],
  };
  const [bg, fg] = colors[type] || ["#eee", "#333"];
  return { background: bg, color: fg, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 };
}

const tableStyle = { borderCollapse: "collapse", width: "100%", fontSize: 13, border: "1px solid #dde" };
const thStyle    = { background: "#eef0f8", border: "1px solid #ccd", padding: "8px 12px",
                     textAlign: "left", fontWeight: 700, whiteSpace: "nowrap" };
const tdStyle    = { border: "1px solid #dde", padding: "6px 12px", verticalAlign: "middle" };
const catTdStyle = { ...tdStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const listStyle  = { margin: 0, paddingLeft: 16, lineHeight: 1.7, fontSize: 13 };
