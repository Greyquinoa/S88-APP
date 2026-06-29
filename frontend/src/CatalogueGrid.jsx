import { useCallback, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
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
  onImportClick,
}) {
  const gridRef = useRef(null);
  const [quickFilter, setQuickFilter] = useState("");
  const [assignTarget, setAssignTarget] = useState(null);

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
      headerName: "Channels",
      field: "channel_count",
      filter: "agNumberColumnFilter",
      floatingFilter: true,
      minWidth: 100,
      type: "rightAligned",
      valueFormatter: (p) => p.value || "—",
    },
    {
      headerName: "In bytes",
      field: "input_bytes",
      filter: "agNumberColumnFilter",
      floatingFilter: true,
      minWidth: 100,
      type: "rightAligned",
      cellStyle: { fontFamily: "ui-monospace, monospace" },
      valueFormatter: (p) => p.value || 0,
    },
    {
      headerName: "Out bytes",
      field: "output_bytes",
      filter: "agNumberColumnFilter",
      floatingFilter: true,
      minWidth: 100,
      type: "rightAligned",
      cellStyle: { fontFamily: "ui-monospace, monospace" },
      valueFormatter: (p) => p.value || 0,
    },
    {
      headerName: "In Ident",
      field: "in_identifier",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 90,
      headerTooltip: "SYMBOL identifier for input channels (e.g. I, IW). Blank = signal-type default.",
      cellStyle: { display: "flex", alignItems: "center" },
      cellRenderer: (p) => (
        <IdentCell data={p.data} field="in_identifier" onPatchTemplate={onPatchTemplate} />
      ),
    },
    {
      headerName: "Out Ident",
      field: "out_identifier",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 90,
      headerTooltip: "SYMBOL identifier for output channels (e.g. Q, QW). Blank = signal-type default.",
      cellStyle: { display: "flex", alignItems: "center" },
      cellRenderer: (p) => (
        <IdentCell data={p.data} field="out_identifier" onPatchTemplate={onPatchTemplate} />
      ),
    },
    {
      headerName: "Version",
      field: "version",
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 100,
      valueFormatter: (p) => p.value || "—",
    },
    {
      headerName: "Subslots",
      colId: "subslots",
      sortable: false,
      filter: false,
      minWidth: 200,
      flex: 1.6,
      autoHeight: true,
      cellStyle: { display: "flex", alignItems: "flex-start", lineHeight: 1.4 },
      cellRenderer: (p) => (
        <SubslotsCell
          data={p.data}
          templates={templates}
          compatBySlot={compatBySlot}
          compatBySubslot={compatBySubslot}
          onAssign={setAssignTarget}
        />
      ),
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
  ], [allSigTypes, templates, compatBySlot, compatBySubslot, onPatchTemplate, onAddSigType, onDeleteTemplate]);

  const getRowId = useCallback((params) => String(params.data.id), []);

  const onQuickFilterChange = useCallback((e) => setQuickFilter(e.target.value), []);

  return (
    <div className="ig-root">
      {/* Toolbar */}
      <div className="ig-toolbar">
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
            ⬆ Import from .cfg
          </button>
        </div>
      </div>

      {/* Grid */}
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

      <CatalogueAssignModal
        target={assignTarget}
        templates={templates}
        compatBySlot={compatBySlot}
        onAddCompat={onAddCompat}
        onRemoveCompat={onRemoveCompat}
        onClose={() => setAssignTarget(null)}
      />
    </div>
  );
}
