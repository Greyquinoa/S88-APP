import { useCallback, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellStyle,
  CellValueChangedEvent,
  GetRowIdParams,
  GridApi,
  ISelectCellEditorParams,
  RowClickedEvent,
} from "ag-grid-community";
import type { CustomCellEditorProps } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
// @ts-ignore — Vite handles CSS imports; TS doesn't need to resolve them
import "./InstancesGrid.css";
import ReconciliationStatusRenderer from "./ReconciliationStatusRenderer";

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CmtProfile {
  id: string;
  cmType: string;
  libType: "ControlModule" | "EquipmentModule" | "EquipmentPhase";
  samplingTime?: string | null;
}

export interface InstanceRow {
  id: string;
  profileId: string;
  instanceName: string;
  samplingTime: string;
  userProject: string;
  hwControllerId: string;
  folderId: string;
  source?: "manual" | "imported";
}

export interface FolderOption {
  id: string;
  label: string;
}

export interface HwControllerOption {
  id: string;
  /** Controller tag name, e.g. "AS101" — falls back to "Controller #<id>" when blank. */
  name: string;
  /** User project this controller belongs to, or null/blank when unassigned. */
  userProject: string | null;
}

interface InstancesGridProps {
  libType: "ControlModule" | "EquipmentModule" | "EquipmentPhase";
  rowData: InstanceRow[];
  cmtProfiles: CmtProfile[];
  /** Hardware controllers for the active project. Instances pick a controller;
   *  the user project is derived from the controller's own assignment. */
  hwControllers: HwControllerOption[];
  folderOptions: FolderOption[];
  onRowUpdate: (id: string, field: keyof InstanceRow, value: string) => void;
  onRowDelete: (id: string) => void;
  /** Optional bulk delete for multi-select — one request for all ids instead
   *  of calling onRowDelete once per row. Falls back to looping onRowDelete
   *  when not provided. */
  onBulkDelete?: (ids: string[]) => void;
  onRowAdd: () => void;
  /** Called when a row is clicked — used by EM/EPH role pane */
  onRowSelect?: (id: string) => void;
  /** Currently selected row id — highlighted for EM/EPH role assignment */
  selectedId?: string | null;
  /** Called when the map-signals action is clicked — opens the signal mapping modal */
  onMapSignals?: (id: string) => void;
  /** Called when "View Exported Blocks" is clicked — opens export preview modal */
  onViewExportedBlocks?: (id: string) => void;
  /** Called when "Generate Connections" is clicked — reconciles dummy IOs to hardware.
   *  May return a Promise; the button shows a busy state until it resolves. */
  onGenerateConnections?: () => void | Promise<void>;
  /** Per-instance reconciliation summary keyed by instanceName. When provided, a
   *  "Connections" column shows how many dummy IOs are bound to hardware (real)
   *  out of the total. Omit to hide the column. */
  connStatusByInstance?: Record<string, { real: number; dummy: number; total: number }>;
  /** Per-instance reconciliation status keyed by instanceName. When provided, a
   *  "Status" column shows the reconciliation state (OK, IMPORTED_OK, DUMMY, etc.) */
  reconciliationDataByInstance?: Record<string, {
    status: 'OK' | 'IMPORTED_OK' | 'DUMMY' | 'DUMMY_ACCEPTED' | 'ERROR' | 'PENDING';
    isImported: boolean;
    isGenerated: boolean;
    acceptedAt?: string | null;
    acceptedBy?: string | null;
  }>;
  /** Called when "Add Composite" is clicked — opens the composite instance modal. */
  onAddComposite?: () => void;
  /** Called when "Run Reconciliation" is clicked — reconciles IO connections. */
  onRunReconciliation?: () => void;
  /** Called when "View Overview" is clicked — opens the reconciliation overview modal. */
  onViewOverview?: () => void;
}

// ── Delete button cell renderer ───────────────────────────────────────────────

function DeleteCellRenderer(props: { data: InstanceRow; context: { onDelete: (id: string) => void } }) {
  return (
    <button
      className="ig-delete-btn"
      title="Delete row"
      onClick={(e) => {
        e.stopPropagation();
        props.context.onDelete(props.data.id);
      }}
    >
      {/* Tabler trash icon via class — falls back to unicode if icon font absent */}
      <i className="ti ti-trash" aria-hidden="true" />
      <span className="ig-delete-sr">Delete</span>
    </button>
  );
}

// ── Connection-status cell renderer ──────────────────────────────────────────
// Shows how many of an instance's dummy IO signals were matched to hardware by
// "Generate Connections": green = all bound, amber = some, orange = none, "—" =
// the instance has no IO rules (nothing to reconcile).
// Clicking on this badge opens the Parameters modal.
function ConnStatusCellRenderer(props: {
  data: InstanceRow;
  context: { connStatusByInstance?: Record<string, { real: number; dummy: number; total: number }>; onMapSignals?: (id: string) => void };
}) {
  const st = props.context.connStatusByInstance?.[props.data.instanceName];
  const hasConnections = st && st.total > 0;

  if (!hasConnections) {
    // No IO connections, but user can still open Parameters to view static variables
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.context.onMapSignals?.(props.data.id);
        }}
        title="View parameters (no IO connections)"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: "transparent", border: "none", cursor: "pointer",
          color: "#6B7280", fontSize: 14, padding: "2px 4px",
        }}
      >
        <i className="ti ti-settings" aria-hidden="true" />
      </button>
    );
  }

  const allReal = st.real === st.total;
  const noneReal = st.real === 0;
  const bg = allReal ? "#DCFCE7" : noneReal ? "#FFEDD5" : "#FEF9C3";
  const fg = allReal ? "#166534" : noneReal ? "#9A3412" : "#854D0E";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        props.context.onMapSignals?.(props.data.id);
      }}
      title={`${st.real} of ${st.total} IO signal(s) bound to hardware · ${st.dummy} unmatched · Click to open Parameters`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        background: bg, color: fg, fontSize: 11, fontWeight: 600,
        padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap",
        border: "none", cursor: "pointer", fontFamily: "inherit",
      }}
    >
      <i className={`ti ${allReal ? "ti-plug-connected" : "ti-plug-connected-x"}`} aria-hidden="true" />
      {st.real}/{st.total}
    </button>
  );
}

// ── Export preview cell renderer ────────────────────────────────────────────────
// Button to view exported blocks for an instance.
function ExportPreviewCellRenderer(props: {
  data: InstanceRow;
  context: { onViewExportedBlocks?: (id: string) => void };
}) {
  if (!props.context.onViewExportedBlocks) return null;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        props.context.onViewExportedBlocks!(props.data.id);
      }}
      title="View exported blocks"
      style={{
        border: "none", background: "transparent", cursor: "pointer",
        color: "#059669", fontSize: 14, padding: "2px 4px", display: "flex",
        alignItems: "center", justifyContent: "center"
      }}
    >
      <i className="ti ti-layout-list" aria-hidden="true" />
    </button>
  );
}

// ── Reconciliation-status cell renderer ──────────────────────────────────────
// Stable top-level reference (matching the other cell renderers below) instead
// of an inline arrow function in columnDefs — an inline function there gets
// treated as a new component type on re-render, which makes AG Grid remount
// the cell (and its DOM) for every visible row instead of reusing it. That
// was the main cause of laggy scrolling once the grid held a few thousand rows.
function ReconciliationStatusCellRenderer(props: {
  data: InstanceRow;
  context: { reconciliationDataByInstance?: Record<string, any> };
}) {
  return (
    <ReconciliationStatusRenderer
      reconData={props.context.reconciliationDataByInstance}
      instanceName={props.data.instanceName}
    />
  );
}

// ── Imported checkbox cell renderer ──────────────────────────────────────────

function ImportedCheckboxRenderer(props: { data: InstanceRow }) {
  const isImported = props.data.source === "imported";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
      }}
    >
      <i
        className={isImported ? "ti ti-checkbox" : "ti ti-square"}
        style={{
          fontSize: 18,
          color: isImported ? "#16A34A" : "#D1D5DB",
        }}
        aria-hidden="true"
      />
    </div>
  );
}

// ── Numeric-only cell editor ──────────────────────────────────────────────────

function NumericCellEditor({ value: initialValue, onValueChange }: CustomCellEditorProps) {
  const [value, setValue] = useState<string>(String(initialValue ?? ""));

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "" || /^\d+$/.test(raw)) {
      setValue(raw);
      onValueChange(raw);
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      onChange={handleChange}
      className="ig-numeric-editor"
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InstancesGrid({
  libType,
  rowData,
  cmtProfiles,
  hwControllers = [],
  folderOptions,
  onRowUpdate,
  onRowDelete,
  onBulkDelete,
  onRowAdd,
  onRowSelect,
  selectedId,
  onMapSignals,
  onViewExportedBlocks,
  onGenerateConnections,
  connStatusByInstance,
  reconciliationDataByInstance,
  onAddComposite,
  onRunReconciliation,
  onViewOverview,
}: InstancesGridProps) {
  const gridRef = useRef<AgGridReact<InstanceRow>>(null);
  const [quickFilter, setQuickFilter] = useState("");
  const [genConn, setGenConn] = useState(false);
  const [selectedRows, setSelectedRows] = useState<InstanceRow[]>([]);

  const handleGenerateConnections = async () => {
    if (!onGenerateConnections || genConn) return;
    setGenConn(true);
    try { await onGenerateConnections(); }
    finally { setGenConn(false); }
  };

  const handleSelectionChanged = useCallback(() => {
    const selected = gridRef.current?.api?.getSelectedRows() || [];
    setSelectedRows(selected);
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (selectedRows.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${selectedRows.length} instance${selectedRows.length !== 1 ? 's' : ''}?`
    );
    if (!confirmed) return;
    // One bulk request beats firing onRowDelete once per row — that loop is
    // what made deleting a couple thousand instances take 15+ seconds.
    if (onBulkDelete) {
      onBulkDelete(selectedRows.map(row => row.id));
    } else {
      selectedRows.forEach(row => onRowDelete(row.id));
    }
    setSelectedRows([]);
  }, [selectedRows, onRowDelete, onBulkDelete]);

  // Profiles filtered to matching libType
  const filteredProfiles = useMemo(
    () => cmtProfiles.filter((p) => p.libType === libType),
    [cmtProfiles, libType]
  );

  const typeValues = useMemo(
    () => filteredProfiles.map((p) => p.id),
    [filteredProfiles]
  );

  const folderValues = useMemo(
    () => ["", ...folderOptions.map((f) => f.id)],
    [folderOptions]
  );

  const folderLabels = useMemo(() => {
    const m: Record<string, string> = { "": "— pick —" };
    folderOptions.forEach((f) => (m[f.id] = f.label));
    return m;
  }, [folderOptions]);

  // Controllers sorted by user project (grouped), then by name, so the dropdown
  // reads as "S88xTest: AS101, AS102 / Prod: AS103" instead of raw insertion order.
  const sortedControllers = useMemo(() => {
    const list = hwControllers || [];
    return [...list].sort((a, b) => {
      const groupCmp = (a.userProject || "￿").localeCompare(b.userProject || "￿");
      if (groupCmp !== 0) return groupCmp;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [hwControllers]);

  const hwControllerValues = useMemo(
    () => ["", ...sortedControllers.map((c) => c.id)],
    [sortedControllers]
  );

  const hwControllerLabels = useMemo(() => {
    const m: Record<string, string> = { "": "— pick —" };
    sortedControllers.forEach((c) => {
      const group = c.userProject ? `${c.userProject}: ` : "";
      m[c.id] = `${group}${c.name || `Controller #${c.id}`}`;
    });
    return m;
  }, [sortedControllers]);

  const userProjectByControllerId = useMemo(() => {
    const m: Record<string, string> = {};
    sortedControllers.forEach((c) => { m[c.id] = c.userProject || ""; });
    return m;
  }, [sortedControllers]);

  // AG Grid theme — light Quartz with CSS-variable overrides applied via class
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

  // Column definitions
  const columnDefs = useMemo<ColDef<InstanceRow>[]>(
    () => [
      {
        headerName: "#",
        valueGetter: (p) => (p.node?.rowIndex ?? 0) + 1,
        sortable: false,
        filter: false,
        resizable: false,
        editable: false,
        width: 52,
        maxWidth: 52,
        pinned: "left" as const,
        suppressHeaderMenuButton: true,
        cellStyle: {
          color: "var(--color-text-secondary, #6b7280)",
          fontSize: 11,
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          textAlign: "right",
          paddingRight: 8,
        } as CellStyle,
        headerClass: "ig-header-number",
      },
      {
        headerName: "Type",
        field: "profileId",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: typeValues,
        } as ISelectCellEditorParams,
        valueFormatter: (p) => {
          const profile = cmtProfiles.find((x) => x.id === p.value);
          return profile ? profile.cmType : p.value ?? "";
        },
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        minWidth: 160,
        flex: 1.5,
      },
      {
        headerName: "Instance Name",
        field: "instanceName",
        editable: true,
        cellEditor: "agTextCellEditor",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        minWidth: 160,
        flex: 2,
        cellStyle: (p) => {
          // Highlight duplicates
          const isDuplicate =
            p.context?.duplicateNames?.has(p.value) ?? false;
          return isDuplicate
            ? { background: "#FEF2F2", color: "#DC2626", border: "1px solid #FCA5A5" }
            : null;
        },
      },
      {
        headerName: "Sample MS",
        field: "samplingTime",
        editable: true,
        cellEditor: NumericCellEditor,
        filter: "agNumberColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        minWidth: 110,
        flex: 0.8,
        valueParser: (p) => {
          const n = parseInt(p.newValue, 10);
          return isNaN(n) ? p.oldValue : String(n);
        },
      },
      {
        headerName: "Controller (AS)",
        field: "hwControllerId",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: hwControllerValues,
        } as ISelectCellEditorParams,
        valueFormatter: (p) => hwControllerLabels[p.value ?? ""] ?? p.value ?? "",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        minWidth: 160,
        flex: 1.5,
        cellStyle: (p) =>
          !p.value
            ? { background: "#FEF3C7", color: "#92400E" }
            : null,
      },
      {
        headerName: "User Project",
        colId: "userProjectDerived",
        editable: false,
        sortable: true,
        filter: "agTextColumnFilter",
        floatingFilter: true,
        resizable: true,
        minWidth: 120,
        flex: 1,
        valueGetter: (p) => userProjectByControllerId[p.data?.hwControllerId ?? ""] ?? "",
        cellStyle: { color: "var(--color-text-secondary, #6b7280)" },
      },
      {
        headerName: "Folder",
        field: "folderId",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: folderValues,
        } as ISelectCellEditorParams,
        valueFormatter: (p) => folderLabels[p.value ?? ""] ?? p.value ?? "",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        minWidth: 140,
        flex: 1.5,
        cellStyle: (p) =>
          folderOptions.length > 0 && !p.value
            ? { background: "#FEF3C7", color: "#92400E" }
            : null,
      },
      {
        headerName: "Status",
        colId: "reconStatus",
        editable: false,
        sortable: true,
        filter: "agSetColumnFilter",
        floatingFilter: false,
        resizable: true,
        minWidth: 120,
        flex: 0.8,
        cellRenderer: ReconciliationStatusCellRenderer,
        cellStyle: { display: "flex", alignItems: "center", justifyContent: "center" },
        suppressHeaderMenuButton: true,
      },
      {
        headerName: "Connections",
        colId: "connStatus",
        editable: false,
        sortable: false,
        filter: false,
        floatingFilter: false,
        resizable: true,
        minWidth: 110,
        flex: 0.8,
        hide: !connStatusByInstance,
        cellRenderer: ConnStatusCellRenderer,
        cellStyle: { display: "flex", alignItems: "center", justifyContent: "center" },
        suppressHeaderMenuButton: true,
      },
      {
        headerName: "Blocks",
        colId: "exportPreview",
        sortable: false,
        filter: false,
        floatingFilter: false,
        resizable: true,
        editable: false,
        minWidth: 80,
        flex: 0.6,
        cellRenderer: ExportPreviewCellRenderer,
        cellStyle: { display: "flex", alignItems: "center", justifyContent: "center" },
        suppressHeaderMenuButton: true,
      },
      {
        headerName: "",
        field: "id",
        sortable: false,
        filter: false,
        resizable: false,
        editable: false,
        width: 48,
        maxWidth: 48,
        pinned: "right" as const,
        cellRenderer: DeleteCellRenderer,
        cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
        suppressHeaderMenuButton: true,
      },
    ],
    [typeValues, hwControllerValues, hwControllerLabels, userProjectByControllerId, folderValues, folderLabels, cmtProfiles, folderOptions.length, onMapSignals, onViewExportedBlocks, folderLabels, connStatusByInstance, reconciliationDataByInstance]
  );

  // Detect duplicate instance names for cell styling
  const duplicateNames = useMemo(() => {
    const counts: Record<string, number> = {};
    rowData.forEach((r) => {
      counts[r.instanceName] = (counts[r.instanceName] || 0) + 1;
    });
    return new Set(Object.keys(counts).filter((n) => counts[n] > 1));
  }, [rowData]);

  const onRowClicked = useCallback(
    (e: RowClickedEvent<InstanceRow>) => {
      if (onRowSelect && e.data) onRowSelect(e.data.id);
    },
    [onRowSelect]
  );

  const getRowStyle = useCallback(
    (params: { data?: InstanceRow }) =>
      params.data?.id === selectedId
        ? { background: "#EEEDFE" }
        : undefined,
    [selectedId]
  );

  const context = useMemo(
    () => ({ onDelete: onRowDelete, duplicateNames, onMapSignals, onViewExportedBlocks, connStatusByInstance, reconciliationDataByInstance }),
    [onRowDelete, duplicateNames, onMapSignals, onViewExportedBlocks, connStatusByInstance, reconciliationDataByInstance]
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      suppressMovable: false,
    }),
    []
  );

  const getRowId = useCallback(
    (params: GetRowIdParams<InstanceRow>) => params.data.id,
    []
  );

  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent<InstanceRow>) => {
      if (e.colDef.field && e.colDef.field !== "id") {
        onRowUpdate(e.data.id, e.colDef.field as keyof InstanceRow, e.newValue ?? "");
      }
    },
    [onRowUpdate]
  );

  const onQuickFilterChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuickFilter(e.target.value);
    },
    []
  );

  const handleExportCsv = useCallback(() => {
    (gridRef.current?.api as GridApi | undefined)?.exportDataAsCsv();
  }, []);

  const libLabel: Record<string, string> = {
    ControlModule: "CM",
    EquipmentModule: "EM",
    EquipmentPhase: "EPH",
  };

  return (
    <div className="ig-root">
      {/* Toolbar */}
      <div className="ig-toolbar">
        <div className="ig-search-wrap">
          <i className="ti ti-search ig-search-icon" aria-hidden="true" />
          <input
            className="ig-search"
            type="text"
            placeholder="Search all columns…"
            value={quickFilter}
            onChange={onQuickFilterChange}
          />
          {quickFilter && (
            <button
              className="ig-search-clear"
              onClick={() => setQuickFilter("")}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="ig-toolbar-right">
          <span className="ig-count">
            {selectedRows.length > 0
              ? `${selectedRows.length} of ${rowData.length} selected`
              : `${rowData.length} ${libLabel[libType] ?? libType} instance${rowData.length !== 1 ? "s" : ""}`}
          </span>
          {selectedRows.length > 0 && (
            <button className="ig-btn ig-btn-danger" onClick={handleDeleteSelected} title="Delete selected instances">
              <i className="ti ti-trash" aria-hidden="true" /> Delete {selectedRows.length}
            </button>
          )}
          <button className="ig-btn ig-btn-ghost" onClick={handleExportCsv} title="Export CSV">
            <i className="ti ti-download" aria-hidden="true" /> Export CSV
          </button>
          {onGenerateConnections && (
            <button
              className="ig-btn ig-btn-ghost"
              onClick={handleGenerateConnections}
              disabled={genConn}
              title="Match each dummy IO signal to a hardware symbol by exact name. Matched → real connection; unmatched → stays dummy."
            >
              <i className={`ti ${genConn ? "ti-loader-2" : "ti-plug-connected"}`} aria-hidden="true" />{" "}
              {genConn ? "Generating…" : "Generate Connections"}
            </button>
          )}
          {onRunReconciliation && (
            <button className="ig-btn ig-btn-ghost" onClick={onRunReconciliation} title="Reconcile IO connections">
              <i className="ti ti-refresh" aria-hidden="true" /> Run Reconciliation
            </button>
          )}
          {onViewOverview && (
            <button className="ig-btn ig-btn-ghost" onClick={onViewOverview} title="View reconciliation overview">
              <i className="ti ti-list-check" aria-hidden="true" /> View Overview
            </button>
          )}
          {onAddComposite && (
            <button className="ig-btn ig-btn-primary" onClick={onAddComposite} title="Add composite CM instances">
              <i className="ti ti-layout-grid" aria-hidden="true" /> Add Composite
            </button>
          )}
        </div>
      </div>

      {/* Duplicate name warning */}
      {duplicateNames.size > 0 && (
        <div className="ig-warning">
          <i className="ti ti-alert-triangle" aria-hidden="true" />
          Duplicate instance names: {[...duplicateNames].join(", ")} — each name must be unique.
        </div>
      )}

      {/* Grid */}
      <div className="ig-grid-wrap">
        <AgGridReact<InstanceRow>
          ref={gridRef}
          theme={theme}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          context={context}
          quickFilterText={quickFilter}
          onCellValueChanged={onCellValueChanged}
          onRowClicked={onRowClicked}
          onSelectionChanged={handleSelectionChanged}
          getRowStyle={getRowStyle}
          stopEditingWhenCellsLoseFocus
          singleClickEdit={false}
          rowSelection={{ mode: "multiRow", checkboxes: true }}
          suppressRowClickSelection={false}
          suppressCellFocus={false}
          animateRows={false}
          rowBuffer={20}
          suppressColumnVirtualisation={false}
          pagination={false}
          // "normal" (the default) virtualizes rows — only visible rows exist
          // in the DOM, scrolled via .ig-grid-wrap's own scrollbar (it's
          // already a bounded flex child with overflow-y: auto, exactly what
          // this needs). The previous "autoHeight" renders every row to the
          // DOM at once to size the grid to its content — harmless at a few
          // dozen rows, but at a few thousand it means thousands of live DOM
          // rows/cell-renderers scrolling via the *page's* scrollbar instead
          // of the grid's own virtualized one. That was the main cause of
          // laggy scrolling once instance counts got into the thousands.
        />
      </div>
    </div>
  );
}
