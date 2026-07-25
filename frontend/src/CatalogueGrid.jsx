import React, { useCallback, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
import StationAutoSlotsEditor from "./StationAutoSlotsEditor.jsx";
import { getModuleParametersGrouped, updateModuleChannelParameter, updateModuleLevelParameter, updateModuleParameterVisibility } from "./api.js";
import "./InstancesGrid.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Local badge helpers (duplicated from StepHWConfig.jsx to avoid a circular import) ──

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

const SIG_TYPES = ['DI', 'DO', 'AI', 'AO', 'PA', 'INFRA', 'MIXED'];

// Postgres returns is_visible as a boolean (true/false); older SQLite data used
// integers (1/0). A parameter is hidden only when the value is explicitly falsy
// (false, 0). NULL/undefined defaults to visible.
function paramVisible(p) {
  return p.is_visible !== 0 && p.is_visible !== false;
}

// ── Sig Type cell renderer — always-visible colored <select> with "+ Add new…" ──

function SigTypeCell({ data, allSigTypes, onPatchTemplate, onAddSigType }) {
  const [adding, setAdding]   = useState(false);
  const [newSig, setNewSig]   = useState("");
  const t = data;

  const commitNew = () => {
    const val = newSig.trim().toUpperCase();
    if (!val) return;
    onAddSigType(val);
    onPatchTemplate(t, { signal_type: val });
    setAdding(false); setNewSig("");
  };

  if (adding) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <input
          autoFocus
          value={newSig}
          onChange={e => setNewSig(e.target.value.toUpperCase())}
          onKeyDown={e => {
            if (e.key === "Enter") commitNew();
            if (e.key === "Escape") { setAdding(false); setNewSig(""); }
          }}
          placeholder="e.g. PID"
          style={{ width: 52, fontSize: 11, padding: "2px 4px",
            border: "1px solid #2255cc", borderRadius: 4, fontWeight: 700, textTransform: "uppercase" }}
        />
        <button onClick={commitNew} style={{ fontSize: 11, padding: "1px 5px", cursor: "pointer",
          background: "#2255cc", color: "#fff", border: "none", borderRadius: 3 }}>✓</button>
        <button onClick={() => { setAdding(false); setNewSig(""); }}
          style={{ fontSize: 11, padding: "1px 5px", cursor: "pointer",
            background: "#eee", color: "#555", border: "none", borderRadius: 3 }}>✕</button>
      </div>
    );
  }

  return (
    <select
      value={t.signal_type || ''}
      onChange={e => {
        if (e.target.value === '__add_new__') { setNewSig(""); setAdding(true); }
        else onPatchTemplate(t, { signal_type: e.target.value });
      }}
      title="Change signal type"
      style={{ fontSize: 11, padding: "2px 4px",
        border: `1px solid ${sigBadge(t.signal_type).color}`,
        borderRadius: 4, background: sigBadge(t.signal_type).background,
        color: sigBadge(t.signal_type).color, fontWeight: 700, cursor: "pointer" }}
    >
      {allSigTypes.map(st => <option key={st} value={st}>{st}</option>)}
      <option disabled style={{ color: "#aaa" }}>──────</option>
      <option value="__add_new__">+ Add new…</option>
    </select>
  );
}

// ── SYMBOL identifier cell (In/Out) — small inline text editor ──
// Blank = inherit the signal-type default at generation time (I/Q/IW/QW).

function IdentCell({ data, field, onPatchTemplate }) {
  const t = data;
  const [val, setVal] = useState(t[field] ?? "");

  const commit = () => {
    const next = val.trim().toUpperCase();
    if (next === (t[field] ?? "")) return;
    onPatchTemplate(t, { [field]: next || null });
  };

  return (
    <input
      data-ident={`${t.id}:${field}`}
      value={val}
      onChange={e => setVal(e.target.value.toUpperCase())}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") { commit(); e.target.blur(); }
        if (e.key === "Escape") { setVal(t[field] ?? ""); e.target.blur(); }
      }}
      placeholder="auto"
      title="SYMBOL-line address identifier (e.g. I, Q, IW, QW). Blank = inherit signal-type default."
      style={{ width: 52, fontSize: 11, padding: "2px 4px", textAlign: "center",
        border: "1px solid #ccd", borderRadius: 4, fontFamily: "ui-monospace, monospace",
        textTransform: "uppercase" }}
    />
  );
}

// ── Configure cell renderer (opens modal with details) ──

function ConfigureCell({ data, onConfigure, onAutoSlotConfig, templates, compatBySlot, compatBySubslot, onAssign, onPatchTemplate }) {
  return (
    <button
      className="ig-btn ig-btn-primary"
      style={{ height: 26, padding: "0 12px", fontSize: 12 }}
      onClick={(e) => {
        e.stopPropagation();
        onConfigure(data);
      }}
      title="Configure module details"
    >
      ⚙ Configure
    </button>
  );
}

// ── Subslots / Assign cell renderer ──

function SubslotsCell({ data, templates, compatBySlot, compatBySubslot, onAssign }) {
  const t = data;
  const isSlot    = t.hw_category === 'slot';
  const isStation = t.hw_category === 'station';
  const isSubslot = t.hw_category === 'subslot';

  const assignedSubslots = compatBySlot[t.order_no] || new Set();
  const usedBySlots      = compatBySubslot[t.order_no] || new Set();
  const candidateCategory = isStation ? 'slot' : 'subslot';
  const candidateCount = templates.filter(s => s.hw_category === candidateCategory && s.family === t.family).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, alignItems: "flex-start", padding: "6px 0", minHeight: 24, width: "100%" }}>
      {(isSlot || isStation) && candidateCount > 0 && (
        <>
          {/* Row 1: the Assign/Edit button — always visible */}
          <button
            onClick={() => onAssign(t)}
            title={isStation ? "Assign compatible slots" : "Assign compatible subslots"}
            style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer", borderRadius: 4,
              background: "#f0f6ff", color: "#2255cc",
              border: "1px solid #c8d4f0", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {assignedSubslots.size > 0 ? "✏ Edit" : "+ Assign"}
          </button>
          {/* Row 2+: the assigned chips, wrapping below the button */}
          {assignedSubslots.size > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
              {[...assignedSubslots].map(sno => {
                const s = templates.find(x => x.order_no === sno);
                return (
                  <span key={sno} title={sno} style={{
                    fontSize: 10, padding: "1px 6px", borderRadius: 10,
                    background: "#e0f2fe", color: "#0369a1", fontWeight: 600, whiteSpace: "nowrap",
                  }}>
                    {s ? s.display_name : sno.slice(0, 16)}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
      {isSubslot && usedBySlots.size > 0 && (
        <span style={{ fontSize: 10, color: "#666" }}>
          Used by {usedBySlots.size} slot{usedBySlots.size !== 1 ? "s" : ""}
        </span>
      )}
      {t.family === 'Scalance' && t.port_config && (() => {
        let ports = [];
        try { ports = JSON.parse(t.port_config); } catch (_) {}
        const portList = ports.filter(p => p.type === 'port');
        const rj45 = portList.filter(p => p.medium === 'RJ45').length;
        const fo   = portList.filter(p => p.medium === 'FO').length;
        return (
          <span style={{ fontSize: 10, color: '#0369a1' }}>
            {portList.length} port{portList.length !== 1 ? 's' : ''}
            {rj45 ? ` · ${rj45}×RJ45` : ''}
            {fo   ? ` · ${fo}×FO`   : ''}
          </span>
        );
      })()}
    </div>
  );
}

// ── Delete cell renderer ──

function AutoSlotConfigCell({ data, onAutoSlotConfig }) {
  // Only show for station category modules
  if (data.hw_category !== 'station') return null;

  const handleClick = (e) => {
    e.stopPropagation();
    console.log('Auto-slot config clicked for:', data.order_no);
    if (onAutoSlotConfig) {
      onAutoSlotConfig(data);
    } else {
      console.warn('onAutoSlotConfig handler is undefined');
    }
  };

  return (
    <button
      title="Configure auto-slot assignments for this station module"
      onClick={handleClick}
      style={{
        background: '#8B4513',
        color: '#fff',
        border: 'none',
        borderRadius: 3,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      }}
    >
      ⚙ Slots
    </button>
  );
}

function DeleteCell({ data, onDeleteTemplate }) {
  return (
    <button
      className="ig-delete-btn"
      title="Delete from catalogue (only if not used in any station)"
      onClick={(e) => { e.stopPropagation(); onDeleteTemplate(data); }}
    >
      <i className="ti ti-trash" aria-hidden="true" />
      <span className="ig-delete-sr">Delete</span>
    </button>
  );
}

// ── Assignment modal ──

function CatalogueAssignModal({ target, templates, compatBySlot, onAddCompat, onRemoveCompat, onClose }) {
  if (!target) return null;
  const isStation = target.hw_category === 'station';
  const candidateCategory = isStation ? 'slot' : 'subslot';
  const candidates = templates.filter(s => s.hw_category === candidateCategory && s.family === target.family);
  const assigned = compatBySlot[target.order_no] || new Set();

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 12, padding: "20px 24px", width: "min(640px, 92vw)",
          maxHeight: "80vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1e40af" }}>
            Compatible {isStation ? 'slots' : 'subslots'} for {isStation ? 'station' : 'slot'}{" "}
            <span style={{ fontFamily: "monospace" }}>{target.display_name}</span>
          </div>
          <button onClick={onClose}
            style={{ fontSize: 16, lineHeight: 1, cursor: "pointer", border: "none", background: "none", color: "#666" }}>
            ✕
          </button>
        </div>

        {candidates.length === 0 ? (
          <p style={{ color: "#999", fontSize: 13 }}>
            No {isStation ? 'slots' : 'subslots'} available in this family.
          </p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {candidates.map(s => {
              const checked = assigned.has(s.order_no);
              return (
                <label key={s.order_no} style={{
                  display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                  padding: "4px 10px", borderRadius: 6,
                  background: checked ? "#dbeafe" : "#fff",
                  border: `1px solid ${checked ? "#93c5fd" : "#ccd"}`,
                  fontSize: 12,
                }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => {
                      if (e.target.checked) onAddCompat(target.order_no, s.order_no);
                      else onRemoveCompat(target.order_no, s.order_no);
                    }}
                    style={{ accentColor: "#2255cc", cursor: "pointer" }}
                  />
                  <span style={{ fontWeight: checked ? 600 : 400, color: checked ? "#1e40af" : "#333" }}>
                    {s.display_name}
                  </span>
                  <span style={{ fontSize: 10, color: "#888", fontFamily: "monospace" }}>
                    {s.order_no.length > 20 ? s.order_no.slice(0, 18) + "…" : s.order_no}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button className="ig-btn ig-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Main grid ──

export default function CatalogueGrid({
  templates,
  slotCompat,
  sigTypes,
  onPatchTemplate,
  onAddSigType,
  onAddCompat,
  onRemoveCompat,
  onDeleteTemplate,
  onAutoSlotConfig,
  onImportClick,
}) {
  const gridRef = useRef(null);
  const [quickFilter, setQuickFilter] = useState("");
  const [assignTarget, setAssignTarget] = useState(null);
  const [configureTarget, setConfigureTarget] = useState(null);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'family'

  const allSigTypes = sigTypes && sigTypes.length ? sigTypes : SIG_TYPES;

  // Build fast lookup sets from slotCompat (parent order_no → Set of child order_no)
  const { compatBySlot, compatBySubslot } = useMemo(() => {
    const bySlot = {};
    const bySub  = {};
    for (const row of (slotCompat || [])) {
      if (!bySlot[row.slot_order_no]) bySlot[row.slot_order_no] = new Set();
      bySlot[row.slot_order_no].add(row.subslot_order_no);
      if (!bySub[row.subslot_order_no]) bySub[row.subslot_order_no] = new Set();
      bySub[row.subslot_order_no].add(row.slot_order_no);
    }
    return { compatBySlot: bySlot, compatBySubslot: bySub };
  }, [slotCompat]);

  const theme = useMemo(
    () =>
      themeQuartz.withParams({
        fontSize: 12,
        rowHeight: 36,
        headerHeight: 36,
        fontFamily: "system-ui, -apple-system, sans-serif",
        accentColor: "#0C447C",
        browserColorScheme: "light",
      }),
    []
  );

  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    suppressMovable: false,
  }), []);

  const columnDefs = useMemo(() => [
    {
      headerName: "#",
      colId: "rowNumber",
      width: 50,
      maxWidth: 50,
      pinned: "left",
      sortable: false,
      filter: false,
      resizable: false,
      valueGetter: (params) => params.node.rowIndex + 1,
      cellStyle: { textAlign: 'center', fontWeight: 500, color: '#6b7280' }
    },
    {
      headerName: "Family",
      field: "family",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 120,
      flex: 1,
    },
    {
      headerName: "Order No",
      field: "order_no",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 180,
      flex: 1.6,
      cellStyle: { fontFamily: "ui-monospace, monospace", fontSize: 11 },
    },
    {
      headerName: "Display Name",
      field: "display_name",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 160,
      flex: 2,
      editable: true,
      cellStyle: { cursor: 'pointer' },
      onCellValueChanged: (params) => {
        if (params.newValue !== params.oldValue && params.newValue?.trim()) {
          onPatchTemplate(params.data, { display_name: params.newValue.trim() });
        }
      }
    },
    {
      headerName: "Category",
      field: "hw_category",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 110,
      cellStyle: { display: "flex", alignItems: "center" },
      cellRenderer: (p) => <CategoryBadge category={p.value} />,
    },
    {
      headerName: "Sig Type",
      field: "signal_type",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 110,
      cellStyle: { display: "flex", alignItems: "center" },
      cellRenderer: (p) => (
        <SigTypeCell
          data={p.data}
          allSigTypes={allSigTypes}
          onPatchTemplate={onPatchTemplate}
          onAddSigType={onAddSigType}
        />
      ),
    },
    {
      headerName: "",
      colId: "configure",
      sortable: false,
      filter: false,
      resizable: false,
      width: 110,
      maxWidth: 110,
      pinned: "right",
      cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
      cellRenderer: (p) => <ConfigureCell data={p.data} onConfigure={setConfigureTarget} onAutoSlotConfig={onAutoSlotConfig} templates={templates} compatBySlot={compatBySlot} compatBySubslot={compatBySubslot} onAssign={setAssignTarget} onPatchTemplate={onPatchTemplate} />,
    },
    {
      headerName: "",
      colId: "actions",
      sortable: false,
      filter: false,
      resizable: false,
      width: 56,
      maxWidth: 56,
      pinned: "right",
      cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
      cellRenderer: (p) => <DeleteCell data={p.data} onDeleteTemplate={onDeleteTemplate} />,
    },
  ], [allSigTypes, templates, compatBySlot, compatBySubslot, onPatchTemplate, onAddSigType, onAutoSlotConfig, onDeleteTemplate]);

  const getRowId = useCallback((params) => String(params.data.id), []);

  const onQuickFilterChange = useCallback((e) => setQuickFilter(e.target.value), []);

  return (
    <div className="ig-root">
      {/* Toolbar */}
      <div className="ig-toolbar">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* Toggle Switch */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            background: '#e5e7eb',
            borderRadius: '24px',
            padding: '3px',
            width: '120px',
            height: '36px',
            cursor: 'pointer',
            position: 'relative',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            {/* Sliding background */}
            <div style={{
              position: 'absolute',
              left: viewMode === 'grid' ? '3px' : '60px',
              width: '57px',
              height: '30px',
              background: '#0C447C',
              borderRadius: '20px',
              transition: 'left 0.3s ease',
              zIndex: 0
            }} />

            {/* Grid button */}
            <button
              onClick={() => setViewMode('grid')}
              title="Grid view"
              style={{
                position: 'relative',
                zIndex: 1,
                flex: 1,
                fontSize: '11px',
                fontWeight: 600,
                border: 'none',
                background: 'transparent',
                color: viewMode === 'grid' ? '#fff' : '#6b7280',
                cursor: 'pointer',
                padding: '6px 0',
                transition: 'color 0.3s ease'
              }}
            >
              Grid
            </button>

            {/* Family button */}
            <button
              onClick={() => setViewMode('family')}
              title="Family view"
              style={{
                position: 'relative',
                zIndex: 1,
                flex: 1,
                fontSize: '11px',
                fontWeight: 600,
                border: 'none',
                background: 'transparent',
                color: viewMode === 'family' ? '#fff' : '#6b7280',
                cursor: 'pointer',
                padding: '6px 0',
                transition: 'color 0.3s ease'
              }}
            >
              Family
            </button>
          </div>
        </div>

        <div className="ig-search-wrap">
          <i className="ti ti-search ig-search-icon" aria-hidden="true" />
          <input
            className="ig-search"
            type="text"
            placeholder="Search order no, name, signal type…"
            value={quickFilter}
            onChange={onQuickFilterChange}
          />
          {quickFilter && (
            <button className="ig-search-clear" onClick={() => setQuickFilter("")} title="Clear search">×</button>
          )}
        </div>

        <div className="ig-toolbar-right">
          <span className="ig-count">
            {templates.length} module{templates.length !== 1 ? "s" : ""}
          </span>
          <button className="ig-btn ig-btn-primary" onClick={onImportClick}>
            Import from .cfg
          </button>
        </div>
      </div>

      {/* Grid or Family View */}
      {viewMode === 'grid' ? (
        <div className="ig-grid-wrap">
          <AgGridReact
            ref={gridRef}
            theme={theme}
            rowData={templates}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            quickFilterText={quickFilter}
            animateRows={false}
            pagination={false}
            domLayout="autoHeight"
          />
        </div>
      ) : (
        <FamilyView
          templates={templates}
          quickFilter={quickFilter}
          onConfigure={setConfigureTarget}
          onAutoSlotConfig={onAutoSlotConfig}
          onAssign={setAssignTarget}
          onDeleteTemplate={onDeleteTemplate}
          allSigTypes={allSigTypes}
          compatBySlot={compatBySlot}
          compatBySubslot={compatBySubslot}
          onPatchTemplate={onPatchTemplate}
          onAddSigType={onAddSigType}
        />
      )}

      <CatalogueAssignModal
        target={assignTarget}
        templates={templates}
        compatBySlot={compatBySlot}
        onAddCompat={onAddCompat}
        onRemoveCompat={onRemoveCompat}
        onClose={() => setAssignTarget(null)}
      />

      {configureTarget && (
        <ConfigureModal
          data={templates.find(t => t.id === configureTarget.id) || configureTarget}
          templates={templates}
          compatBySlot={compatBySlot}
          compatBySubslot={compatBySubslot}
          onAssign={setAssignTarget}
          onAutoSlotConfig={onAutoSlotConfig}
          onPatchTemplate={onPatchTemplate}
          onAddCompat={onAddCompat}
          onRemoveCompat={onRemoveCompat}
          onClose={() => setConfigureTarget(null)}
        />
      )}
    </div>
  );
}

// ── Configure Modal ──────────────────────────────────────────────────────────

function ConfigureModal({ data, templates, compatBySlot, compatBySubslot, onAssign, onAutoSlotConfig, onPatchTemplate, onClose, onAddCompat, onRemoveCompat }) {
  const [activeTab, setActiveTab] = React.useState('details');
  const [assignTarget, setAssignTarget] = React.useState(null);
  const [params, setParams] = React.useState(null);
  const [paramsLoading, setParamsLoading] = React.useState(false);
  const [paramEdits, setParamEdits] = React.useState({});  // { "PARAM_NAME:CHANNEL_TYPE": newValue }
  const [paramSaving, setParamSaving] = React.useState(null);  // param being saved
  const [showVisibilityPicker, setShowVisibilityPicker] = React.useState(false);

  // Editable fields state
  const [channelCount, setChannelCount] = React.useState(data.channel_count || 0);
  const [inputBytes, setInputBytes] = React.useState(data.input_bytes || 0);
  const [outputBytes, setOutputBytes] = React.useState(data.output_bytes || 0);
  const [inIdentifier, setInIdentifier] = React.useState(data.in_identifier || '');
  const [outIdentifier, setOutIdentifier] = React.useState(data.out_identifier || '');

  const isStation = data.hw_category === 'station';
  const isSlot = data.hw_category === 'slot';
  const isSubslot = data.hw_category === 'subslot';
  const isIOCard = ['DI', 'DO', 'AI', 'AO'].includes(data.signal_type);

  // Load parameters when modal opens or data changes
  React.useEffect(() => {
    if (!data.id || !isIOCard) {
      setParams(null);
      return;
    }
    setParamsLoading(true);
    getModuleParametersGrouped(data.id)
      .then(p => setParams(p))
      .catch(e => { console.warn("Failed to load parameters:", e); setParams(null); })
      .finally(() => setParamsLoading(false));
  }, [data.id, isIOCard]);

  // Handle field changes and save to database
  const handleFieldChange = (field, value) => {
    const patch = {};

    // Validate numeric fields
    if (field === 'channel_count' || field === 'input_bytes' || field === 'output_bytes') {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 0) return;
      patch[field] = numValue;
    } else {
      patch[field] = value.trim().toUpperCase() || null;
    }

    // Save to database
    onPatchTemplate(data, patch);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: '#fff',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 9999
    }}>
      {/* Header */}
      <div style={{
        padding: '20px',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: '#f9fafb'
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>
            {data.display_name}
            {data.version && <span style={{ fontSize: '14px', fontWeight: 400, color: '#6b7280', marginLeft: '12px' }}>v{data.version}</span>}
          </h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280' }}>{data.order_no}</p>
        </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              color: '#9ca3af'
            }}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        {(isStation || isIOCard) && (
          <div style={{
            display: 'flex',
            gap: 0,
            borderBottom: '1px solid #e5e7eb',
            padding: '0 20px',
            background: '#f9fafb'
          }}>
            <button
              onClick={() => setActiveTab('details')}
              style={{
                padding: '12px 16px',
                border: 'none',
                background: activeTab === 'details' ? 'white' : 'transparent',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: activeTab === 'details' ? 600 : 500,
                color: activeTab === 'details' ? '#0C447C' : '#6b7280',
                borderBottom: activeTab === 'details' ? '2px solid #0C447C' : 'none'
              }}
            >
              Overview
            </button>
            {isIOCard && (
              <button
                onClick={() => setActiveTab('parameters')}
                style={{
                  padding: '12px 16px',
                  border: 'none',
                  background: activeTab === 'parameters' ? 'white' : 'transparent',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: activeTab === 'parameters' ? 600 : 500,
                  color: activeTab === 'parameters' ? '#0C447C' : '#6b7280',
                  borderBottom: activeTab === 'parameters' ? '2px solid #0C447C' : 'none'
                }}
              >
                Parameters
              </button>
            )}
            {isStation && (
              <button
                onClick={() => setActiveTab('autoSlot')}
                style={{
                  padding: '12px 16px',
                  border: 'none',
                  background: activeTab === 'autoSlot' ? 'white' : 'transparent',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: activeTab === 'autoSlot' ? 600 : 500,
                  color: activeTab === 'autoSlot' ? '#0C447C' : '#6b7280',
                  borderBottom: activeTab === 'autoSlot' ? '2px solid #0C447C' : 'none'
                }}
              >
                Auto-Slots Config
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '20px',
          display: 'grid',
          gridTemplateColumns: (activeTab === 'details' && isStation) ? '1fr 1.5fr' : '1fr',
          gap: '30px'
        }}>
          {activeTab === 'details' && (
            <>
              {/* Module Details (left side or full width) — Inline Editable */}
              <div>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: 600, color: '#111' }}>Module Details</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
                  {/* Row 1: Channels (full width) */}
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '6px' }}>Channels</label>
                    <input
                      type="number"
                      min="0"
                      value={channelCount}
                      onChange={e => setChannelCount(e.target.value)}
                      onBlur={e => handleFieldChange('channel_count', e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleFieldChange('channel_count', e.target.value);
                        if (e.key === 'Escape') setChannelCount(data.channel_count || 0);
                      }}
                      style={{
                        width: '100%',
                        padding: '8px 8px',
                        fontSize: '14px',
                        border: '1px solid #d1d5db',
                        borderRadius: '6px',
                        fontWeight: 500,
                      }}
                    />
                  </div>

                  {/* Row 2: Input Bytes & Output Bytes (2 columns) */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '6px' }}>Input Bytes</label>
                      <input
                        type="number"
                        min="0"
                        value={inputBytes}
                        onChange={e => setInputBytes(e.target.value)}
                        onBlur={e => handleFieldChange('input_bytes', e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleFieldChange('input_bytes', e.target.value);
                          if (e.key === 'Escape') setInputBytes(data.input_bytes || 0);
                        }}
                        style={{
                          width: '100%',
                          padding: '8px 8px',
                          fontSize: '14px',
                          fontFamily: 'monospace',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          fontWeight: 500,
                        }}
                      />
                    </div>

                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '6px' }}>Output Bytes</label>
                      <input
                        type="number"
                        min="0"
                        value={outputBytes}
                        onChange={e => setOutputBytes(e.target.value)}
                        onBlur={e => handleFieldChange('output_bytes', e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleFieldChange('output_bytes', e.target.value);
                          if (e.key === 'Escape') setOutputBytes(data.output_bytes || 0);
                        }}
                        style={{
                          width: '100%',
                          padding: '8px 8px',
                          fontSize: '14px',
                          fontFamily: 'monospace',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          fontWeight: 500,
                        }}
                      />
                    </div>
                  </div>

                  {/* Row 3: Output Identifier & Input Identifier (2 columns) */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '6px' }}>Output Identifier</label>
                      <input
                        type="text"
                        maxLength="4"
                        value={outIdentifier}
                        onChange={e => setOutIdentifier(e.target.value.toUpperCase())}
                        onBlur={e => handleFieldChange('out_identifier', e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleFieldChange('out_identifier', e.target.value);
                          if (e.key === 'Escape') setOutIdentifier(data.out_identifier || '');
                        }}
                        placeholder="auto"
                        title="SYMBOL-line output identifier (e.g. Q, QW). Blank = inherit signal-type default."
                        style={{
                          width: '100%',
                          padding: '8px 8px',
                          fontSize: '14px',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          fontWeight: 500,
                          textTransform: 'uppercase',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      />
                    </div>

                    <div>
                      <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '6px' }}>Input Identifier</label>
                      <input
                        type="text"
                        maxLength="4"
                        value={inIdentifier}
                        onChange={e => setInIdentifier(e.target.value.toUpperCase())}
                        onBlur={e => handleFieldChange('in_identifier', e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleFieldChange('in_identifier', e.target.value);
                          if (e.key === 'Escape') setInIdentifier(data.in_identifier || '');
                        }}
                        placeholder="auto"
                        title="SYMBOL-line input identifier (e.g. I, IW). Blank = inherit signal-type default."
                        style={{
                          width: '100%',
                          padding: '8px 8px',
                          fontSize: '14px',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          fontWeight: 500,
                          textTransform: 'uppercase',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Slots (right side, for stations/slots) */}
              {(isStation || isSlot) && (
                <div>
                  <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: 600, color: '#111' }}>Slot Assignments</h3>
                  <SubslotsCell
                    data={data}
                    templates={templates}
                    compatBySlot={compatBySlot}
                    compatBySubslot={compatBySubslot}
                    onAssign={setAssignTarget}
                  />
                </div>
              )}
            </>
          )}

          {activeTab === 'autoSlot' && (
            <StationAutoSlotsEditor
              station={{ orderNo: data.order_no }}
              catalogue={templates}
              onClose={() => {}}
              inlineMode={true}
            />
          )}

          {activeTab === 'parameters' && isIOCard && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 16px 0' }}>
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#111' }}>
                  Module Parameters
                </h3>
                {params && (params.moduleLevel?.length > 0 || params.channelLevel?.length > 0) && (
                  <button
                    onClick={() => setShowVisibilityPicker(true)}
                    style={{
                      padding: '6px 14px', fontSize: 12, fontWeight: 600,
                      color: '#1e40af', background: '#eff6ff',
                      border: '1px solid #bfdbfe', borderRadius: 6, cursor: 'pointer'
                    }}
                  >
                    ⚙ Select Parameters
                  </button>
                )}
              </div>
              {paramsLoading ? (
                <div style={{ color: '#999', fontSize: 13, fontStyle: 'italic' }}>Loading parameters…</div>
              ) : !params || (!params.moduleLevel?.length && !params.channelLevel?.length) ? (
                <div style={{ color: '#999', fontSize: 13 }}>No parameters configured for this module</div>
              ) : (
                <div style={{ display: 'grid', gap: 24 }}>
                  {/* Module-level parameters (editable, filtered by visibility) */}
                  {params.moduleLevel && params.moduleLevel.filter(paramVisible).length > 0 && (
                    <div>
                      <h4 style={{ margin: '0 0 12px 0', fontSize: 12, fontWeight: 700, color: '#333', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Module-Level Parameters
                      </h4>
                      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))' }}>
                        {params.moduleLevel.filter(paramVisible).map(p => {
                          const modKey = `module:${p.parameter_name}`;
                          const isEditing = paramSaving === modKey;
                          const editValue = paramEdits[modKey];
                          const displayValue = editValue !== undefined ? editValue : (p.parameter_value || '');

                          const handleModSave = async () => {
                            if (editValue === undefined || editValue === (p.parameter_value || '')) {
                              setParamEdits(prev => { const next = { ...prev }; delete next[modKey]; return next; });
                              return;
                            }
                            setParamSaving(modKey);
                            try {
                              await updateModuleLevelParameter(data.id, p.parameter_name, editValue);
                              const updated = await getModuleParametersGrouped(data.id);
                              setParams(updated);
                              setParamEdits(prev => { const next = { ...prev }; delete next[modKey]; return next; });
                            } catch (e) {
                              console.warn('Failed to save module parameter:', e);
                            } finally {
                              setParamSaving(null);
                            }
                          };

                          return (
                            <div key={p.id} style={{
                              padding: '10px 12px', background: '#f9fafb', borderRadius: 6,
                              border: '1px solid #e5e7eb'
                            }}>
                              <div style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', fontWeight: 600, color: '#111', marginBottom: 6 }}>
                                {p.parameter_name}
                              </div>
                              <input
                                type="text"
                                value={displayValue}
                                onChange={e => setParamEdits(prev => ({ ...prev, [modKey]: e.target.value }))}
                                onBlur={handleModSave}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleModSave();
                                  if (e.key === 'Escape') {
                                    setParamEdits(prev => { const next = { ...prev }; delete next[modKey]; return next; });
                                  }
                                }}
                                placeholder="Enter value…"
                                disabled={isEditing}
                                style={{
                                  width: '100%', padding: '6px 8px', fontSize: 12,
                                  border: `1px solid ${editValue !== undefined ? '#3b82f6' : '#d1d5db'}`,
                                  borderRadius: 4, boxSizing: 'border-box',
                                  fontFamily: 'ui-monospace, monospace',
                                  background: editValue !== undefined ? '#eff6ff' : '#fff',
                                  color: '#333', cursor: isEditing ? 'not-allowed' : 'text'
                                }}
                              />
                              {isEditing && <div style={{ fontSize: 9, color: '#999', marginTop: 4, fontStyle: 'italic' }}>Saving…</div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Channel-level parameters - grouped by parameter name (filtered by visibility) */}
                  {params.channelLevel && params.channelLevel.filter(paramVisible).length > 0 && (() => {
                    // Group channel-level parameters by name, showing unique parameter types
                    const groupedByName = new Map();
                    params.channelLevel.filter(paramVisible).forEach(p => {
                      if (!groupedByName.has(p.parameter_name)) {
                        groupedByName.set(p.parameter_name, p); // Store first occurrence as representative
                      }
                    });

                    return (
                      <div>
                        <h4 style={{ margin: '0 0 12px 0', fontSize: 12, fontWeight: 700, color: '#333', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Channel-Level Parameters
                        </h4>
                        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))' }}>
                          {Array.from(groupedByName.values()).map(p => {
                            const paramKey = `${p.parameter_name}:${p.channel_type}`;
                            const editDynamic = paramEdits[`${paramKey}:dynamic`];
                            const isDynamic = editDynamic !== undefined ? editDynamic : (p.is_dynamic || false);
                            const isEditing = paramSaving === paramKey;
                            const editValue = paramEdits[paramKey];
                            const editSpareValue = paramEdits[`${paramKey}:spare`];

                            const displayValue = editValue !== undefined ? editValue : (p.parameter_value || '');
                            const displaySpareValue = editSpareValue !== undefined ? editSpareValue : (p.spare_value || '');

                            const handleSave = async () => {
                              const dynamicChanged = editDynamic !== undefined && editDynamic !== p.is_dynamic;
                              const valueChanged = editValue !== undefined && editValue !== p.parameter_value;
                              const spareValueChanged = editSpareValue !== undefined && editSpareValue !== p.spare_value;
                              const hasChanges = dynamicChanged || valueChanged || spareValueChanged;

                              if (!hasChanges) {
                                setParamEdits(prev => {
                                  const next = { ...prev };
                                  delete next[paramKey];
                                  delete next[`${paramKey}:spare`];
                                  delete next[`${paramKey}:dynamic`];
                                  return next;
                                });
                                return;
                              }

                              setParamSaving(paramKey);
                              try {
                                await updateModuleChannelParameter(
                                  data.id,
                                  p.parameter_name,
                                  p.channel_type,
                                  editValue !== undefined ? editValue : p.parameter_value,
                                  editSpareValue !== undefined ? editSpareValue : p.spare_value,
                                  isDynamic
                                );
                                // Reload parameters to show updated values
                                const updated = await getModuleParametersGrouped(data.id);
                                setParams(updated);
                                setParamEdits(prev => {
                                  const next = { ...prev };
                                  delete next[paramKey];
                                  delete next[`${paramKey}:spare`];
                                  delete next[`${paramKey}:dynamic`];
                                  return next;
                                });
                              } catch (e) {
                                alert(`Failed to save parameter: ${e.message}`);
                              } finally {
                                setParamSaving(null);
                              }
                            };

                            return (
                              <div key={paramKey} style={{
                                padding: '12px', background: '#f9fafb', borderRadius: 6,
                                border: `1px solid ${(editValue !== undefined || editSpareValue !== undefined) ? '#3b82f6' : '#e5e7eb'}`
                              }}>
                                <div style={{
                                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                                  marginBottom: 8
                                }}>
                                  <label style={{
                                    fontSize: 12, fontWeight: 600, color: '#333',
                                    fontFamily: 'ui-monospace, monospace',
                                    flex: 1
                                  }}>
                                    {p.parameter_name}
                                  </label>
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <span style={{
                                      fontSize: 10, color: '#999', fontWeight: 500
                                    }}>
                                      {p.channel_type} (all)
                                    </span>
                                    <label style={{
                                      display: 'flex', alignItems: 'center', gap: 4, fontSize: 10,
                                      cursor: 'pointer', color: isDynamic ? '#2563eb' : '#666',
                                      userSelect: 'none'
                                    }}>
                                      <input
                                        type="checkbox"
                                        checked={isDynamic}
                                        onChange={async (e) => {
                                          setParamEdits(prev => ({
                                            ...prev,
                                            [`${paramKey}:dynamic`]: e.target.checked
                                          }));
                                          // Save immediately after toggling
                                          setParamSaving(paramKey);
                                          try {
                                            await updateModuleChannelParameter(
                                              data.id,
                                              p.parameter_name,
                                              p.channel_type,
                                              p.parameter_value,
                                              p.spare_value,
                                              e.target.checked
                                            );
                                            const updated = await getModuleParametersGrouped(data.id);
                                            setParams(updated);
                                            setParamEdits(prev => {
                                              const next = { ...prev };
                                              delete next[`${paramKey}:dynamic`];
                                              return next;
                                            });
                                          } catch (err) {
                                            alert(`Failed to toggle dynamic: ${err.message}`);
                                          } finally {
                                            setParamSaving(null);
                                          }
                                        }}
                                        disabled={isEditing}
                                        style={{ cursor: isEditing ? 'not-allowed' : 'pointer' }}
                                      />
                                      Dynamic
                                    </label>
                                  </div>
                                </div>

                                {isDynamic ? (
                                  // Dynamic parameter: show Default and Spare fields
                                  <div style={{ display: 'grid', gap: 8 }}>
                                    <div>
                                      <div style={{ fontSize: 10, fontWeight: 600, color: '#666', marginBottom: 4 }}>Default (assigned channels)</div>
                                      <input
                                        type="text"
                                        value={displayValue}
                                        onChange={e => setParamEdits(prev => ({ ...prev, [paramKey]: e.target.value }))}
                                        onBlur={handleSave}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') handleSave();
                                          if (e.key === 'Escape') {
                                            setParamEdits(prev => {
                                              const next = { ...prev };
                                              delete next[paramKey];
                                              return next;
                                            });
                                          }
                                        }}
                                        placeholder="Enter default value…"
                                        disabled={isEditing}
                                        style={{
                                          width: '100%', padding: '6px', fontSize: 11,
                                          border: `1px solid ${editValue !== undefined ? '#3b82f6' : '#d1d5db'}`,
                                          borderRadius: 3,
                                          fontFamily: 'ui-monospace, monospace',
                                          background: editValue !== undefined ? '#eff6ff' : '#fff',
                                          color: '#333',
                                          cursor: isEditing ? 'not-allowed' : 'text'
                                        }}
                                      />
                                    </div>
                                    <div>
                                      <div style={{ fontSize: 10, fontWeight: 600, color: '#666', marginBottom: 4 }}>Spare (unassigned channels)</div>
                                      <input
                                        type="text"
                                        value={displaySpareValue}
                                        onChange={e => setParamEdits(prev => ({ ...prev, [`${paramKey}:spare`]: e.target.value }))}
                                        onBlur={handleSave}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') handleSave();
                                          if (e.key === 'Escape') {
                                            setParamEdits(prev => {
                                              const next = { ...prev };
                                              delete next[`${paramKey}:spare`];
                                              return next;
                                            });
                                          }
                                        }}
                                        placeholder="Enter spare value…"
                                        disabled={isEditing}
                                        style={{
                                          width: '100%', padding: '6px', fontSize: 11,
                                          border: `1px solid ${editSpareValue !== undefined ? '#3b82f6' : '#d1d5db'}`,
                                          borderRadius: 3,
                                          fontFamily: 'ui-monospace, monospace',
                                          background: editSpareValue !== undefined ? '#eff6ff' : '#fff',
                                          color: '#333',
                                          cursor: isEditing ? 'not-allowed' : 'text'
                                        }}
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  // Static parameter: show single field
                                  <input
                                    type="text"
                                    value={displayValue}
                                    onChange={e => setParamEdits(prev => ({ ...prev, [paramKey]: e.target.value }))}
                                    onBlur={handleSave}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') handleSave();
                                      if (e.key === 'Escape') {
                                        setParamEdits(prev => {
                                          const next = { ...prev };
                                          delete next[paramKey];
                                          return next;
                                        });
                                      }
                                    }}
                                    placeholder="Enter value…"
                                    disabled={isEditing}
                                    style={{
                                      width: '100%', padding: '8px', fontSize: 12,
                                      border: `1px solid ${editValue !== undefined ? '#3b82f6' : '#d1d5db'}`,
                                      borderRadius: 4,
                                      fontFamily: 'ui-monospace, monospace',
                                      background: editValue !== undefined ? '#eff6ff' : '#fff',
                                      color: '#333',
                                      cursor: isEditing ? 'not-allowed' : 'text'
                                    }}
                                  />
                                )}

                                <div style={{
                                  fontSize: 9, color: '#999', marginTop: 6,
                                  fontStyle: 'italic'
                                }}>
                                  {isEditing ? 'Saving…' : isDynamic ? 'Default applied to assigned channels, Spare to unassigned' : `Applies to all ${p.channel_type} channels (0-${data.channel_count - 1})`}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 20px',
          textAlign: 'right',
          background: '#f9fafb'
        }}>
          <button
            onClick={onClose}
            className="ig-btn ig-btn-ghost"
          >
            Close
          </button>
        </div>

        {/* Nested Assignment Modal */}
        {assignTarget && (
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000
          }}>
            <div style={{
              background: '#fff',
              borderRadius: '12px',
              padding: '20px 24px',
              width: 'min(640px, 92vw)',
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 12px 40px rgba(0,0,0,0.25)'
            }}
            onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1e40af' }}>
                  Compatible {assignTarget.hw_category === 'station' ? 'slots' : 'subslots'} for {assignTarget.hw_category === 'station' ? 'station' : 'slot'}{" "}
                  <span style={{ fontFamily: 'monospace' }}>{assignTarget.display_name}</span>
                </div>
                <button
                  onClick={() => setAssignTarget(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    cursor: 'pointer',
                    color: '#9ca3af'
                  }}
                >
                  ×
                </button>
              </div>
              <CatalogueAssignModal
                target={assignTarget}
                templates={templates}
                compatBySlot={compatBySlot}
                onAddCompat={onAddCompat}
                onRemoveCompat={onRemoveCompat}
                onClose={() => setAssignTarget(null)}
              />
            </div>
          </div>
        )}

        {/* Parameter Visibility Picker */}
        {showVisibilityPicker && params && (
          <ParameterVisibilityPicker
            params={params}
            onCancel={() => setShowVisibilityPicker(false)}
            onApply={async (updates) => {
              try {
                if (updates.length > 0) {
                  await updateModuleParameterVisibility(data.id, updates);
                  const updated = await getModuleParametersGrouped(data.id);
                  setParams(updated);
                }
              } catch (e) {
                console.warn('Failed to update parameter visibility:', e);
              } finally {
                setShowVisibilityPicker(false);
              }
            }}
          />
        )}
    </div>
  );
}

// ── Parameter Visibility Picker ───────────────────────────────────────────────
// Popup to select which parameters are visible (both module- and channel-level).
// Channel-level parameters are grouped by name (one checkbox per parameter name).

function ParameterVisibilityPicker({ params, onCancel, onApply }) {
  // Build the list of selectable parameters: module-level (individual) +
  // channel-level (grouped by name). Track each by parameter_name.
  const items = React.useMemo(() => {
    const list = [];
    const seen = new Set();
    (params.moduleLevel || []).forEach(p => {
      if (!seen.has(p.parameter_name)) {
        seen.add(p.parameter_name);
        list.push({ name: p.parameter_name, group: 'module', is_visible: paramVisible(p) });
      }
    });
    (params.channelLevel || []).forEach(p => {
      if (!seen.has(p.parameter_name)) {
        seen.add(p.parameter_name);
        list.push({ name: p.parameter_name, group: 'channel', channel_type: p.channel_type, is_visible: paramVisible(p) });
      }
    });
    return list;
  }, [params]);

  // Draft check state keyed by parameter_name
  const [checked, setChecked] = React.useState(() => {
    const m = {};
    items.forEach(it => { m[it.name] = it.is_visible; });
    return m;
  });

  const moduleItems = items.filter(it => it.group === 'module');
  const channelItems = items.filter(it => it.group === 'channel');

  const toggle = (name) => setChecked(prev => ({ ...prev, [name]: !prev[name] }));
  const setAll = (val) => {
    setChecked(() => {
      const m = {};
      items.forEach(it => { m[it.name] = val; });
      return m;
    });
  };

  const handleApply = () => {
    // Only send parameters whose visibility changed
    const updates = items
      .filter(it => (checked[it.name] ? 1 : 0) !== (it.is_visible ? 1 : 0))
      .map(it => ({ parameter_name: it.name, is_visible: checked[it.name] ? 1 : 0 }));
    console.log('[VisibilityPicker] Apply:', { items: items.length, checked, updates });
    onApply(updates);
  };

  const renderRow = (it) => (
    <label key={it.name} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
      background: checked[it.name] ? '#eff6ff' : '#f9fafb',
      border: `1px solid ${checked[it.name] ? '#bfdbfe' : '#e5e7eb'}`
    }}>
      <input
        type="checkbox"
        checked={!!checked[it.name]}
        onChange={() => toggle(it.name)}
        style={{ width: 16, height: 16, cursor: 'pointer' }}
      />
      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#111', fontWeight: 600 }}>
        {it.name}
      </span>
      {it.channel_type && (
        <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 'auto' }}>{it.channel_type}</span>
      )}
    </label>
  );

  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10000
    }}
    onClick={onCancel}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: '20px 24px',
        width: 'min(720px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 12px 40px rgba(0,0,0,0.25)'
      }}
      onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>Select Parameters to Display</div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button onClick={() => setAll(true)} style={{ padding: '4px 10px', fontSize: 11, border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>Select All</button>
          <button onClick={() => setAll(false)} style={{ padding: '4px 10px', fontSize: 11, border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>Deselect All</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, display: 'grid', gap: 20 }}>
          {moduleItems.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#333', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Module-Level Parameters
              </div>
              <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {moduleItems.map(renderRow)}
              </div>
            </div>
          )}
          {channelItems.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#333', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Channel-Level Parameters
              </div>
              <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {channelItems.map(renderRow)}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
          <button onClick={onCancel} className="ig-btn ig-btn-ghost">Cancel</button>
          <button
            onClick={handleApply}
            style={{ padding: '8px 18px', fontSize: 13, fontWeight: 600, color: '#fff', background: '#2563eb', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Family View ──────────────────────────────────────────────────────────────

function FamilyView({ templates, quickFilter, onConfigure, onAutoSlotConfig, onAssign, onDeleteTemplate, allSigTypes, compatBySlot, compatBySubslot, onPatchTemplate, onAddSigType }) {
  const [collapsedFamilies, setCollapsedFamilies] = useState(() => {
    try {
      const saved = localStorage.getItem('catalogue-family-collapsed');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggleFamilyCollapse = (family) => {
    setCollapsedFamilies(prev => {
      const next = new Set(prev);
      next.has(family) ? next.delete(family) : next.add(family);
      // Save to localStorage
      localStorage.setItem('catalogue-family-collapsed', JSON.stringify([...next]));
      return next;
    });
  };

  const theme = useMemo(
    () =>
      themeQuartz.withParams({
        fontSize: 12,
        rowHeight: 36,
        headerHeight: 36,
        fontFamily: "system-ui, -apple-system, sans-serif",
        accentColor: "#0C447C",
        browserColorScheme: "light",
      }),
    []
  );

  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    suppressMovable: false,
  }), []);

  const columnDefs = useMemo(() => [
    {
      headerName: "#",
      colId: "rowNumber",
      width: 50,
      maxWidth: 50,
      pinned: "left",
      sortable: false,
      filter: false,
      resizable: false,
      valueGetter: (params) => params.node.rowIndex + 1,
      cellStyle: { textAlign: 'center', fontWeight: 500, color: '#6b7280' }
    },
    {
      headerName: "Order No",
      field: "order_no",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 180,
      flex: 1.6,
      cellStyle: { fontFamily: "ui-monospace, monospace", fontSize: 11 },
    },
    {
      headerName: "Display Name",
      field: "display_name",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 160,
      flex: 2,
      editable: true,
      cellStyle: { cursor: 'pointer' },
      onCellValueChanged: (params) => {
        if (params.newValue !== params.oldValue && params.newValue?.trim()) {
          onPatchTemplate(params.data, { display_name: params.newValue.trim() });
        }
      }
    },
    {
      headerName: "Category",
      field: "hw_category",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 110,
      cellStyle: { display: "flex", alignItems: "center" },
      cellRenderer: (p) => <CategoryBadge category={p.value} />,
    },
    {
      headerName: "Sig Type",
      field: "signal_type",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 110,
      cellStyle: { display: "flex", alignItems: "center" },
      cellRenderer: (p) => (
        <SigTypeCell
          data={p.data}
          allSigTypes={allSigTypes}
          onPatchTemplate={onPatchTemplate}
          onAddSigType={onAddSigType}
        />
      ),
    },
    {
      headerName: "",
      colId: "configure",
      sortable: false,
      filter: false,
      resizable: false,
      width: 110,
      maxWidth: 110,
      pinned: "right",
      cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
      cellRenderer: (p) => <ConfigureCell data={p.data} onConfigure={onConfigure} onAutoSlotConfig={onAutoSlotConfig} templates={templates} compatBySlot={compatBySlot} compatBySubslot={compatBySubslot} onAssign={onAssign} onPatchTemplate={onPatchTemplate} />,
    },
    {
      headerName: "",
      colId: "actions",
      sortable: false,
      filter: false,
      resizable: false,
      width: 56,
      maxWidth: 56,
      pinned: "right",
      cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
      cellRenderer: (p) => <DeleteCell data={p.data} onDeleteTemplate={onDeleteTemplate} />,
    },
  ], [allSigTypes, templates, compatBySlot, compatBySubslot, onPatchTemplate, onAddSigType, onAutoSlotConfig, onDeleteTemplate, onConfigure]);

  const getRowId = useCallback((params) => String(params.data.id), []);

  // Group templates by family
  const groupedByFamily = useMemo(() => {
    const groups = {};
    templates.forEach(t => {
      if (!groups[t.family]) groups[t.family] = [];
      groups[t.family].push(t);
    });
    return groups;
  }, [templates]);

  // Filter groups by quickFilter
  const filteredGroups = useMemo(() => {
    if (!quickFilter.toLowerCase()) return groupedByFamily;

    const filtered = {};
    Object.entries(groupedByFamily).forEach(([family, items]) => {
      const matchingItems = items.filter(t =>
        t.order_no.toLowerCase().includes(quickFilter.toLowerCase()) ||
        t.display_name.toLowerCase().includes(quickFilter.toLowerCase()) ||
        (t.signal_type || '').toLowerCase().includes(quickFilter.toLowerCase())
      );
      if (matchingItems.length > 0) {
        filtered[family] = matchingItems;
      }
    });
    return filtered;
  }, [groupedByFamily, quickFilter]);

  return (
    <div style={{ background: '#f9fafb', padding: '20px 0' }}>
      {Object.entries(filteredGroups).map(([family, items]) => {
        const isCollapsed = collapsedFamilies.has(family);
        return (
          <div key={family} style={{ marginBottom: '20px' }}>
            {/* Family Header */}
            <div
              onClick={() => toggleFamilyCollapse(family)}
              style={{
                padding: '12px 20px',
                background: '#e5e7eb',
                fontWeight: '600',
                fontSize: '13px',
                color: '#1f2937',
                borderLeft: '4px solid #0C447C',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'background 0.15s'
              }}
              onMouseEnter={(e) => e.target.style.background = '#d1d5db'}
              onMouseLeave={(e) => e.target.style.background = '#e5e7eb'}
            >
              <span style={{ fontSize: '16px', transition: 'transform 0.2s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                ▼
              </span>
              <span>{family} ({items.length})</span>
            </div>

            {/* Family Grid - Using AG Grid */}
            {!isCollapsed && (
              <div className="ig-grid-wrap" style={{ margin: '0 20px', borderRadius: '4px', overflow: 'hidden', border: '1px solid #e5e7eb' }}>
                <AgGridReact
                  key={family}
                  theme={theme}
                  rowData={items}
                  columnDefs={columnDefs}
                  defaultColDef={defaultColDef}
                  getRowId={getRowId}
                  animateRows={false}
                  pagination={false}
                  domLayout="autoHeight"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
