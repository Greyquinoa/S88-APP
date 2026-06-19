import React, { useState, useEffect, useRef } from "react";
import {
  listHwImports, uploadHwBaseline, uploadHwIoList,
  getHwStations, getHwAddressPreview, generateHwCfg, listHwCfgs, hwCfgDownloadUrl,
  updateHwStation, updateHwSlot,
  listHwModuleTemplates,
  addHwStation, deleteHwStation, addHwSlot, deleteHwSlot,
  listHwControllers, listHwFieldbuses,
  getSlotChannels, patchSlotChannel, patchSlotPip, patchSlotPotentialGroup,
  copyHwStation,
  bulkDeleteHwStations, bulkApproveHwStations,
  parseCfgForCatalogue, bulkUpsertCatalogueTemplates,
  deleteHwModuleTemplate, getHwModuleTemplateUsage,
} from "./api.js";

import StepController from "./StepController.jsx";


export default function StepHWConfig({ projectId }) {
  const [hwTab,        setHwTab]        = useState("import");
  const [importId,     setImportId]     = useState(null);
  const [baselineOk,   setBaselineOk]   = useState(false);
  const [baselineInfo, setBaselineInfo] = useState(null);
  const [ioListOk,     setIoListOk]     = useState(false);
  const [ioListInfo,   setIoListInfo]   = useState(null);
  const [controllers,  setControllers]  = useState([]);
  const [selectedId,   setSelectedId]   = useState(null);
  const [stations,     setStations]     = useState([]);
  const [addrMap,      setAddrMap]      = useState({});   // { "<stationAddr>:<slot>": { inputAddr, outputAddr } }
  const [templates,    setTemplates]    = useState([]);
  const [fieldbuses,   setFieldbuses]   = useState([]);
  const [cfgs,         setCfgs]         = useState([]);
  const [loading,      setLoading]      = useState("");
  const [error,        setError]        = useState("");

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

  const baselineRef = useRef();
  const ioListRef   = useRef();

  useEffect(() => {
    listHwModuleTemplates().then(setTemplates).catch(() => {});
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
    setLoading("Parsing HW IO list…");
    setError("");
    try {
      const result = await uploadHwIoList(importId, file);
      setIoListOk(true);
      setIoListInfo({ stationCount: result.stationCount, signalCount: result.signalCount });
      await loadStations(importId);
      await loadCfgs(importId);
      setHwTab("config");
    } catch (err) { setError(err.message); }
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
    try {
      await generateHwCfg(importId, opts);
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
    setLoading("Adding slot…");
    setError("");
    try {
      await addHwSlot(importId, stationAddr, {
        slot: parseInt(newSlot.slot, 10),
        moduleOrderNo: newSlot.moduleOrderNo,
        moduleName: newSlot.moduleName,
      });
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

        {/* Import */}
        {hwTab === "import" && (
          <ImportPanel
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
          />
        )}

        {/* Catalogue */}
        {hwTab === "catalogue" && (
          <CataloguePanel
            templates={templates}
            onTemplatesChanged={() => listHwModuleTemplates().then(setTemplates).catch(() => {})}
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
        {(hwTab === "controller" || hwTab === "config") && (
          <>
            {/* Sub-tab bar */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #dde" }}>
              {[["controller", "Controller"], ["config", "Configuration"]].map(([id, label]) => (
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
                onSetNewStation={setNewStation}
                onStartAddStation={() => { if (!importId) { setError("Upload a baseline CFG first."); return; } setAddingStation(true); }}
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
                onGenerate={handleGenerate}
                isEditing={isEditing}
                editVal={editVal}
                onStartEdit={startEdit}
                onChangeEdit={setEditVal}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

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
        {navBtn("import", "⬆ Import")}
        {navBtn("catalogue", "📋 Catalogue")}
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
          const isActive = isSelected && (hwTab === "controller" || hwTab === "config");
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

// ── Import Panel ───────────────────────────────────────────────────────────────
function ImportPanel({
  baselineOk, baselineInfo, ioListOk, ioListInfo, importId,
  baselineRef, ioListRef,
  onBaselineChange, onIoListChange, onBaselineBtn, onIoListBtn,
}) {
  return (
    <div>
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

      {ioListInfo && (
        <div style={{ marginBottom: 20, fontSize: 13, color: "#444",
                      background: "#f5fff5", border: "1px solid #9d9", borderRadius: 6, padding: "8px 14px" }}>
          IO List imported — <strong>{ioListInfo.stationCount}</strong> station{ioListInfo.stationCount !== 1 ? "s" : ""},{" "}
          <strong>{ioListInfo.signalCount}</strong> signal rows.{" "}
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
const CATALOGUE_COLS = [
  { header: "Order No",     width: "18%", align: "left"   },
  { header: "Display Name", width: "26%", align: "left"   },
  { header: "Category",     width: "9%",  align: "center" },
  { header: "Sig Type",     width: "7%",  align: "center" },
  { header: "Channels",     width: "7%",  align: "center" },
  { header: "In bytes",     width: "7%",  align: "center" },
  { header: "Out bytes",    width: "7%",  align: "center" },
  { header: "Version",      width: "11%", align: "left"   },
  { header: "",             width: "8%",  align: "center" },
];

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

function CataloguePanel({ templates, onTemplatesChanged, onDeleteTemplate }) {
  const [search,       setSearch]       = useState("");
  const [familyFilter, setFamilyFilter] = useState("ALL");
  const [showImport,   setShowImport]   = useState(false);
  const cfgImportRef = useRef();

  const families = ["ALL", ...Array.from(new Set(templates.map(t => t.family))).sort()];

  const filtered = templates.filter(t => {
    if (familyFilter !== "ALL" && t.family !== familyFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (t.order_no || "").toLowerCase().includes(q) ||
           (t.display_name || "").toLowerCase().includes(q) ||
           (t.signal_type || "").toLowerCase().includes(q);
  });

  const grouped = {};
  for (const t of filtered) {
    if (!grouped[t.family]) grouped[t.family] = [];
    grouped[t.family].push(t);
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
        <input
          placeholder="Search order no, name, signal type…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, padding: "7px 12px", border: "1px solid #ccd", borderRadius: 6, fontSize: 13 }}
        />
        <select
          value={familyFilter}
          onChange={e => setFamilyFilter(e.target.value)}
          style={{ padding: "7px 10px", border: "1px solid #ccd", borderRadius: 6, fontSize: 13 }}
        >
          {families.map(f => <option key={f} value={f}>{f === "ALL" ? "All families" : f}</option>)}
        </select>
        <input type="file" accept=".cfg" ref={cfgImportRef} style={{ display: "none" }}
          onChange={e => { if (e.target.files[0]) setShowImport(e.target.files[0]); e.target.value = ""; }} />
        <button
          onClick={() => cfgImportRef.current.click()}
          style={{ padding: "7px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer",
                   background: "#2255cc", color: "#fff", border: "none", borderRadius: 6,
                   whiteSpace: "nowrap" }}>
          ⬆ Import from .cfg
        </button>
      </div>

      {/* Table */}
      {Object.keys(grouped).sort().map(family => (
        <div key={family} style={{ marginBottom: 28 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#446", textTransform: "uppercase",
                        letterSpacing: "0.04em", marginBottom: 6, paddingBottom: 4,
                        borderBottom: "1px solid #ccd" }}>
            {family}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...tableStyle, tableLayout: "fixed" }}>
              <colgroup>
                {CATALOGUE_COLS.map(col => (
                  <col key={col.header} style={{ width: col.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {CATALOGUE_COLS.map(col => (
                    <th key={col.header} style={{ ...thStyle, textAlign: col.align }}>{col.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped[family].map((t, i) => (
                  <tr key={t.id} style={{ background: i % 2 === 0 ? "#fff" : "#f7f9fc" }}>
                    <td style={{ ...catTdStyle, fontFamily: "monospace", fontSize: 11, textAlign: "left" }} title={t.order_no}>{t.order_no}</td>
                    <td style={{ ...catTdStyle, textAlign: "left" }} title={t.display_name}>{t.display_name}</td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}><CategoryBadge category={t.hw_category} /></td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>
                      {t.signal_type && <span style={sigBadge(t.signal_type)}>{t.signal_type}</span>}
                    </td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>{t.channel_count || "—"}</td>
                    <td style={{ ...catTdStyle, textAlign: "center", fontFamily: "monospace" }}>{t.input_bytes || 0}</td>
                    <td style={{ ...catTdStyle, textAlign: "center", fontFamily: "monospace" }}>{t.output_bytes || 0}</td>
                    <td style={{ ...catTdStyle, color: "#888", fontSize: 12, textAlign: "left" }} title={t.version || ""}>{t.version || "—"}</td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>
                      <button
                        onClick={() => onDeleteTemplate(t)}
                        title="Delete from catalogue (only if not used in any station)"
                        style={miniBtn("#e44", "#fff")}
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <p style={{ color: "#999", textAlign: "center", marginTop: 40 }}>No modules match your search.</p>
      )}

      {/* Import modal */}
      {showImport && (
        <CfgImportModal
          file={showImport}
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); onTemplatesChanged?.(); }}
        />
      )}
    </div>
  );
}

// ── CFG Import Modal ───────────────────────────────────────────────────────────
const ACTION_LABELS = { new: "Add", conflict: "Skip", skip: "Skip", error: "—" };

function CfgImportModal({ file, onClose, onDone }) {
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
        // Propagate to background subslots in the same station
        if (c.isBackground && c.ioAddress === ioAddress) return { ...c, family, familySource: 'manual' };
        return c;
      });
    });
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
        gsdml_file: null, dap_id: null,
        hw_category: c.hw_category || null,
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
    width: "min(900px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
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
                  allNewChecked={allNewChecked}
                  someNewChecked={someNewChecked}
                  onToggleAllNew={toggleAllNew}
                  onToggleGroupNew={toggleGroupNew}
                  onSetChecked={setChecked}
                  onSetFamily={setFamily}
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
            <button onClick={onClose}
              style={{ padding: "7px 16px", fontSize: 13, border: "1px solid #ccd",
                       borderRadius: 6, background: "#fff", cursor: "pointer" }}>
              {stage === "done" ? "Close" : "Cancel"}
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
                       borderRadius: 6, cursor: "pointer" }}>
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
function CfgImportTable({ candidates, allNewChecked, someNewChecked, onToggleAllNew, onToggleGroupNew, onSetChecked, onSetFamily }) {
  // Build ordered group list from visible (non-background) entries only,
  // but keep global indices intact so onSetChecked(i) maps to the right candidate.
  const visibleWithIdx = candidates.map((c, i) => ({ c, i })).filter(({ c }) => !c.isBackground);

  const groupOrder = [];
  const seen = new Set();
  for (const { c } of visibleWithIdx) {
    if (!seen.has(c.ioAddress)) { seen.add(c.ioAddress); groupOrder.push(c.ioAddress); }
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ background: "#f4f6fb" }}>
          <th style={{ ...thStyle, width: 28, textAlign: "center" }}>
            {/* Global header: controls New rows only; hollow-green when mixed */}
            <HierarchyCheckbox
              checked={allNewChecked}
              partial={!allNewChecked && someNewChecked}
              onChange={v => onToggleAllNew(v)}
              title="Check/uncheck all New rows"
            />
          </th>
          <th style={{ ...thStyle, textAlign: "left" }}>Slot</th>
          <th style={{ ...thStyle, textAlign: "center" }}>Category</th>
          <th style={{ ...thStyle, textAlign: "left" }}>Order No</th>
          <th style={{ ...thStyle, textAlign: "left" }}>Name</th>
          <th style={{ ...thStyle, textAlign: "left" }}>Family</th>
          <th style={{ ...thStyle, textAlign: "center" }}>Sig</th>
          <th style={{ ...thStyle, textAlign: "center" }}>In</th>
          <th style={{ ...thStyle, textAlign: "center" }}>Out</th>
          <th style={{ ...thStyle, textAlign: "left" }}>Ver</th>
          <th style={{ ...thStyle, textAlign: "center" }}>Status</th>
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
                  <td colSpan={10} style={{ ...catTdStyle, fontWeight: 600, fontSize: 11,
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

              {groupEntries.map(({ c, i }, rowIdx) => {
                const isErr      = c.status === 'error';
                const isConflict = c.status === 'conflict';
                const isChecked  = c.checked;

                // Row background: green tint = add, amber tint = overwrite, dimmed = skip
                let rowBg = rowIdx % 2 === 0 ? "#fff" : "#f7f9fc";
                if (isErr) rowBg = "#fff8f8";
                else if (isConflict && isChecked) rowBg = "#fffbe6";
                else if (!isConflict && isChecked) rowBg = "#f0fbf2";

                const rowOpacity = (!isErr && !isChecked) ? 0.45 : 1;
                const indent     = showHeader;

                return (
                  <tr key={c.order_no + i} style={{ background: rowBg, opacity: rowOpacity }}>
                    <td style={{ ...catTdStyle, textAlign: "center", paddingLeft: indent ? 20 : 6 }}>
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
                        paddingLeft: indent ? 20 : 8 }}>
                      {c.slotInfo || "—"}
                    </td>
                    <td style={{ ...catTdStyle, textAlign: "center" }}>
                      <CategoryBadge category={c.hw_category} />
                    </td>
                    <td style={{ ...catTdStyle, fontFamily: "monospace", fontSize: 11 }} title={c.order_no}>
                      {c.order_no.length > 28 ? c.order_no.slice(0, 26) + "…" : c.order_no}
                    </td>
                    <td style={{ ...catTdStyle }}>
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
                      {c.signal_type && <span style={sigBadge(c.signal_type)}>{c.signal_type}</span>}
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
  selectedAddrs, onToggleSelect, onToggleSelectAll, onClearSelection,
  onSetNewStation, onStartAddStation, onCancelAddStation, onCommitAddStation,
  onCopyStation, onDeleteStation,
  onBulkDelete, onBulkApprove,
  onOpenAddSlot, onCancelAddSlot, onModuleSelect, onSetNewSlot, onCommitAddSlot,
  onDeleteSlot, onSaveSlotPip, onSaveSlotPotentialGroup,
  onGenerate,
  isEditing, onStartEdit, onChangeEdit, onCommitEdit, onCancelEdit,
}) {
  const canGenerate = baselineOk && stations.some(s => s.slots.length > 0);
  const nSelected   = selectedAddrs.size;
  const allSelected = stations.length > 0 && selectedAddrs.size === stations.length;
  const [selectedStationAddr, setSelectedStationAddr] = useState(null);
  const [activeSlot, setActiveSlot] = useState(null);
  const [genMenuOpen, setGenMenuOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false); // drives Mode A / B / C

  const selectedStation = stations.find(s => s.address === selectedStationAddr) || null;

  // Clear slot panel when switching stations
  useEffect(() => { setActiveSlot(null); }, [selectedStationAddr]);

  // Keep selection valid if stations reload
  useEffect(() => {
    if (selectedStationAddr != null && !stations.find(s => s.address === selectedStationAddr)) {
      setSelectedStationAddr(null);
    }
  }, [stations]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSlotClick = (station, slot) => {
    if (!slot || slot.slot === 0) return;
    // For CFU_PA stations, slot 2 (PA Master) is AUTOCREATED with no user signals — skip it
    const imSlot  = station.slots.find(s => s.slot === 0);
    const imTpl   = imSlot ? templates.find(t => t.order_no === imSlot.orderNo) : null;
    const isCfuPa = imTpl && imTpl.family === 'CFU_PA';
    if (isCfuPa && slot.slot === 2) return;
    const key = `${station.address}-${slot.slot}`;
    const activeKey = activeSlot ? `${activeSlot.stationAddr}-${activeSlot.slot}` : null;
    if (key === activeKey) { setActiveSlot(null); return; }
    setActiveSlot({ stationAddr: station.address, slot: slot.slot, orderNo: slot.orderNo, name: slot.name });
  };

  return (
    <div>
      {/* Toolbar — Generate / Download only */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }} />
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
          <Field label="IM Type — Slot 0" width={320}>
            <select
              value={newStation.imOrderNo}
              onChange={e => {
                const tpl = templates.find(t => t.order_no === e.target.value);
                onSetNewStation(p => ({ ...p, imOrderNo: e.target.value, imName: tpl ? tpl.display_name : "" }));
              }}
              style={{ ...inputSx, width: "100%", fontFamily: "monospace", fontSize: 12 }}
            >
              <option value="">— select Interface Module —</option>
              {templates.filter(t => t.signal_type === "INFRA" && !t.order_no.startsWith("V1_1:")).map(t => (
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

      {/* Main area: station list + detail + signal panels */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

        {/* Station list table — fixed natural width, never shrinks when detail panel opens */}
        <div style={{ flex: "0 0 auto", minWidth: 0, overflowX: "auto" }}>

          {/* ── Table toolbar: Mode A / B / C ─────────────────────────── */}
          {/* Row 1: always visible */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <button
              onClick={onStartAddStation}
              disabled={!baselineOk}
              style={{ ...btnStyle, opacity: baselineOk ? 1 : 0.4 }}
            >+ Add Station</button>

            {/* Mode A — [Select] */}
            {!selectMode && stations.length > 0 && (
              <button
                onClick={() => setSelectMode(true)}
                style={{ ...btnStyle, color: "#2255cc", background: "#f0f4ff", border: "1px solid #99b8f4" }}
              >Select</button>
            )}

            {/* Mode B/C — [Select All] [Cancel] */}
            {selectMode && (
              <>
                <button
                  onClick={onToggleSelectAll}
                  style={{ ...btnStyle, fontSize: 13, color: "#2255cc", background: "#f0f4ff", border: "1px solid #99b8f4" }}
                >Select All</button>
                <button
                  onClick={() => { setSelectMode(false); onClearSelection(); }}
                  style={{ ...btnStyle, fontSize: 13, color: "#555", background: "#fff", border: "1px solid #ccd" }}
                >Cancel</button>
              </>
            )}
          </div>

          {/* Row 2: Mode C action bar — only when ≥1 row checked */}
          {selectMode && nSelected > 0 && (
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
              <button
                onClick={onClearSelection}
                style={{ ...btnStyle, fontSize: 12, padding: "3px 12px", color: "#555", background: "#fff", border: "1px solid #c4cce8" }}
              >Clear</button>
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
            <table style={{ ...tableStyle }}>
              <thead>
                <tr>
                  {selectMode && <th style={{ ...thStyle, width: 32, textAlign: "center", padding: "6px 8px" }}></th>}
                  <th style={{ ...thStyle, textAlign: "center", padding: "6px 12px" }}>Device Number</th>
                  <th style={{ ...thStyle, padding: "6px 12px" }}>Device Name</th>
                  <th style={{ ...thStyle, padding: "6px 12px" }}>Device Family</th>
                  <th style={{ ...thStyle, padding: "6px 12px" }}>Order Number</th>
                  <th style={{ ...thStyle, padding: "6px 12px" }}>IP Address</th>
                  <th style={{ ...thStyle, textAlign: "center", padding: "6px 12px" }}>Node</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((station, si) => {
                  const isSelected = selectedAddrs.has(station.address);
                  const isOpen = station.address === selectedStationAddr;
                  const imSlot = station.slots.find(s => s.slot === 0);
                  const imOrderNo = imSlot ? imSlot.orderNo : "—";
                  const imTpl = templates.find(t => t.order_no === (imSlot ? imSlot.orderNo : null));
                  const deviceFamily = imTpl ? imTpl.family : "—";
                  return (
                    <tr
                      key={station.address}
                      onClick={() => setSelectedStationAddr(isOpen ? null : station.address)}
                      style={{
                        cursor: "pointer",
                        background: isOpen ? "#EEEDFE" : isSelected ? "#f0f4ff" : si % 2 === 0 ? "#fff" : "#f7f9fc",
                        borderLeft: isOpen ? "3px solid #2255cc" : "3px solid transparent",
                      }}
                    >
                      {selectMode && (
                        <td style={{ ...tdStyle, textAlign: "center", padding: "5px 8px" }}
                            onClick={e => { e.stopPropagation(); onToggleSelect(station.address); }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onToggleSelect(station.address)}
                            onClick={e => e.stopPropagation()}
                            style={{ cursor: "pointer" }}
                          />
                        </td>
                      )}
                      <td style={{ ...tdStyle, textAlign: "center", fontWeight: 700, fontFamily: "monospace",
                                   color: isOpen ? "#2255cc" : "#226", padding: "5px 12px" }}>
                        {station.address}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 600, color: isOpen ? "#2255cc" : "#224", padding: "5px 12px" }}>
                        {station.name || `Station_${station.address}`}
                      </td>
                      <td style={{ ...tdStyle, padding: "5px 12px" }}>
                        {deviceFamily !== "—" ? (
                          <span style={{ background: "#eef0f8", color: "#446", borderRadius: 4,
                                         padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>
                            {deviceFamily}
                          </span>
                        ) : "—"}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11, color: "#556", padding: "5px 12px" }}>
                        {imOrderNo}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 12, color: "#447", padding: "5px 12px" }}>
                        {station.ip || "—"}
                      </td>
                      <td style={{ ...tdStyle, color: "#669", padding: "5px 12px" }}>
                        {(() => {
                          const no = station.subsystemNo;
                          if (no == null) return "—";
                          const fb = fieldbuses.find(f => String(f.INT_DP_Subsystem) === String(no));
                          return fb
                            ? `${fb.T50_Fieldbus_Name}: PROFINET IO system (${no})`
                            : `PROFINET IO system (${no})`;
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Right pane: detail + signal panels — always occupies the remaining whitespace */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 16, alignItems: "flex-start" }}>
          {selectedStation && (
            <StationDetailPanel
              station={selectedStation}
              templates={templates}
              addrMap={addrMap}
              pipMappings={baselineInfo?.pipMappings || []}
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
              isEditing={isEditing}
              onStartEdit={onStartEdit}
              onChangeEdit={onChangeEdit}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          )}

          {activeSlot && (
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
          )}
        </div>
      </div>

      {cfgs.length > 0 && (
        <div style={{ fontSize: 12, color: "#888", marginTop: 12 }}>
          Last generated: {cfgs[0].generated_at} ·
          Stations: {cfgs[0].stats?.stations ?? "?"} ·
          Modules: {cfgs[0].stats?.modules ?? "?"} ·
          Signals: {cfgs[0].stats?.signals ?? "?"}
        </div>
      )}
    </div>
  );
}

// ── Station Detail Panel ───────────────────────────────────────────────────────
function StationDetailPanel({
  station, templates, addrMap, pipMappings, addingSlot, newSlot, editing, editVal, activeSlot,
  onSlotClick, onCopyStation, onDeleteStation,
  onOpenAddSlot, onCancelAddSlot, onModuleSelect, onSetNewSlot, onCommitAddSlot,
  onDeleteSlot, onSaveSlotPip, onSaveSlotPotentialGroup,
  isEditing, onStartEdit, onChangeEdit, onCommitEdit, onCancelEdit,
}) {
  const addSlotRow = addingSlot === station.address;
  const allRows    = station.slots.length > 0 ? station.slots : [null];

  // Determine station family by looking up the IM (slot 0) template.
  const imSlot = station.slots.find(s => s.slot === 0);
  const imTpl  = imSlot ? templates.find(t => t.order_no === imSlot.orderNo) : null;
  const stationFamily  = imTpl ? imTpl.family : null;
  const isEt200Station = stationFamily ? stationFamily.startsWith("ET200") : false;
  const isCfuPaStation = stationFamily === 'CFU_PA';

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

      {/* Slot table */}
      <div style={{ padding: "12px 16px", overflowX: "auto" }}>
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
              const paSignalType = paSlotTpl ? (paSlotTpl.signal_type || 'AI').toUpperCase() : 'AI';
              const ss1Label = paSignalType === 'AO' ? 'SP (short)' : 'Analog Input (AI)short';

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

              // CFU_PA PA device slots (≥3): append two read-only subslot rows
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

              const subslot1 = (
                <tr key={`ss1-${slot.slot}`} style={ssRowStyle}>
                  <td style={{ ...ssTdBase, textAlign: "center", color: "#9979cc", fontWeight: 600 }}>
                    <span style={{ paddingLeft: 12 }}>↳ SS1</span>
                  </td>
                  <td style={{ ...ssTdBase, fontFamily: "monospace" }}>
                    <span style={{ color: "#9979cc" }}>{ss1Label}</span>
                  </td>
                  <td style={{ ...ssTdBase, color: "#9979cc" }}>Signal data (process image)</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}></td>
                </tr>
              );

              const subslot2 = (
                <tr key={`ss2-${slot.slot}`} style={{ ...ssRowStyle, background: "#ede8ff" }}>
                  <td style={{ ...ssTdBase, textAlign: "center", color: "#7755aa", fontWeight: 600 }}>
                    <span style={{ paddingLeft: 12 }}>↳ SS2</span>
                  </td>
                  <td style={{ ...ssTdBase, fontFamily: "monospace" }}>
                    <span style={{ color: "#7755aa" }}>_S7H_NORM_PDM_BUB_MODULE_CT</span>
                  </td>
                  <td style={{ ...ssTdBase, color: "#7755aa" }}>Service (AUTOCREATED)</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}>—</td>
                  <td style={{ ...ssTdBase, textAlign: "center" }}></td>
                </tr>
              );

              return [mainRow, subslot1, subslot2];
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
                <td style={{ ...tdStyle }} colSpan={2}>
                  <select value={newSlot.moduleOrderNo} onChange={e => onModuleSelect(e.target.value)}
                    style={{ ...inputSx, width: "100%", fontFamily: "monospace", fontSize: 11 }}>
                    <option value="">— select module —</option>
                    {templates
                      .filter(t => {
                        if (t.order_no.startsWith("V1_1:") || t.order_no.includes("PLACEHOLDER")) return false;
                        // CFU_PA stations: show only PA slot-level profiles
                        if (isCfuPaStation) return t.family === 'CFU_PA' && t.hw_category === 'slot' && t.signal_type === 'PA';
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
      </div>
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

// ── Slot Signal Panel ─────────────────────────────────────────────────────────
function SlotSignalPanel({ importId, stationAddr, slot, slotName, orderNo, templates, onClose }) {
  const [channels, setChannels] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(null); // channel index being saved
  const [drafts,   setDrafts]   = useState({});   // { [ch]: { tag, description } }

  const tpl = templates.find(t => t.order_no === orderNo);
  const ioType    = tpl ? tpl.signal_type : null;
  const isPaSlot  = ioType === 'PA';
  const isMixed   = ioType === 'MIXED';

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
      const newCh = isPaSlot && d.paAddr != null ? d.paAddr : ch;
      // For MIXED slots use the per-channel signal_type stored on the channel row
      const chRow = channels.find(r => r.channel === ch);
      const saveType = isMixed ? (chRow ? chRow.signal_type : null) : ioType;
      await patchSlotChannel(importId, stationAddr, slot, newCh, {
        tag: d.tag ?? "",
        description: d.description ?? "",
        signal_type: saveType,
      });
      // If the PA bus address changed (channel key changed), delete the old channel row
      if (isPaSlot && newCh !== ch) {
        // The backend upsert creates a new row at newCh; old row at ch has no data
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
      width: 380, flexShrink: 0,
      border: "1px solid #c8d4f0", borderRadius: 8,
      background: "#f8f9ff", overflow: "hidden",
      alignSelf: "flex-start", position: "sticky", top: 0,
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
          {isPaSlot && (
            <div style={{ fontSize: 10, color: "#6a1b9a", marginTop: 2 }}>
              PA Device — set PA bus address (0-126) as the channel number
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
                {[isPaSlot ? "PA Addr" : "Ch", "IO Type", "Signal Name", "Description", ""].map(h => (
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
                             || (isPaSlot && (draft.paAddr ?? ch) !== ch);
                  const displayType = isMixed ? row.signal_type : ioType;
                  return (
                    <tr key={ch} style={{ background: i % 2 === 0 ? "#fff" : "#f5f7ff" }}>
                      <td style={{ padding: "5px 10px", fontWeight: 700, color: "#446", textAlign: "center", whiteSpace: "nowrap" }}>
                        {isPaSlot ? (
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
