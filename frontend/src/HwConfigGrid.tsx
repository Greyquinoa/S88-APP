import { useCallback, useMemo, useRef, useEffect } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellStyle,
  GetRowIdParams,
  SelectionChangedEvent,
  IRowNode,
} from "ag-grid-community";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
// @ts-ignore
import "./InstancesGrid.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HwSlot {
  slot: number;
  orderNo: string;
}

export interface HwStation {
  address: number;
  name: string;
  ip: string | null;
  subsystemNo: number | null;
  slots: HwSlot[];
  approved?: boolean;
  orderNo?: string | null;
  family?: string | null;
}

export interface HwModuleTemplate {
  order_no: string;
  display_name: string;
  family: string;
}

export interface HwFieldbus {
  INT_DP_Subsystem: number | string;
  T50_Fieldbus_Name: string;
  T15_IP_Address?: string;
}

interface HwConfigGridProps {
  stations: HwStation[];
  templates: HwModuleTemplate[];
  fieldbuses: HwFieldbus[];
  configureAddr: number | null;
  onConfigure: (address: number) => void;
  onSelectionChanged: (addrs: Set<number>) => void;
}

// ── Configure button cell renderer ────────────────────────────────────────────

function ConfigureCellRenderer(props: {
  data: HwStation;
  context: { configureAddr: number | null; onConfigure: (a: number) => void };
}) {
  const isActive = props.context.configureAddr === props.data.address;
  return (
    <button
      className={`ig-btn ${isActive ? "ig-btn-primary" : "ig-btn-ghost"}`}
      style={{ height: 26, padding: "0 12px", fontSize: 12 }}
      onClick={(e) => {
        e.stopPropagation();
        props.context.onConfigure(props.data.address);
      }}
    >
      {isActive ? "Close" : "Configure"}
    </button>
  );
}

// ── Approved badge cell renderer ──────────────────────────────────────────────

function ApprovedCellRenderer(props: { value: boolean }) {
  return props.value ? (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: "#D1FAE5", color: "#065F46",
      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
    }}>
      ✔ Approved
    </span>
  ) : (
    <span style={{
      display: "inline-flex", alignItems: "center",
      background: "var(--color-background-secondary, #f5f5f5)",
      color: "var(--color-text-secondary, #6b7280)",
      fontSize: 11, padding: "2px 8px", borderRadius: 10,
    }}>
      Pending
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HwConfigGrid({
  stations,
  templates,
  fieldbuses,
  configureAddr,
  onConfigure,
  onSelectionChanged,
}: HwConfigGridProps) {
  const gridRef = useRef<AgGridReact<HwStation>>(null);

  const theme = useMemo(
    () =>
      themeQuartz.withParams({
        fontSize: 12,
        rowHeight: 36,
        headerHeight: 36,
        fontFamily: "system-ui, -apple-system, sans-serif",
        accentColor: "#2255cc",
        browserColorScheme: "light",
      }),
    []
  );

  const context = useMemo(
    () => ({ configureAddr, onConfigure, templates, fieldbuses }),
    [configureAddr, onConfigure, templates, fieldbuses]
  );

  const columnDefs = useMemo<ColDef<HwStation>[]>(
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
      },
      {
        headerName: "Device Number",
        field: "address",
        filter: "agNumberColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        width: 140,
        cellStyle: {
          fontWeight: 700,
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          textAlign: "center",
          color: "#226",
        } as CellStyle,
      },
      {
        headerName: "Device Name",
        field: "name",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        flex: 2,
        minWidth: 160,
        valueFormatter: (p) => p.value || `Station_${p.data?.address ?? ""}`,
        cellStyle: { fontWeight: 600, color: "#224" } as CellStyle,
      },
      {
        headerName: "Device Family",
        colId: "family",
        valueGetter: (p) => {
          // Backend sets family from catalogue; fall back to client-side lookup for manually-added stations
          if (p.data?.family) return p.data.family;
          const imSlot = p.data?.slots.find((s) => s.slot === 0);
          const tpl = p.context?.templates?.find(
            (t: HwModuleTemplate) => t.order_no === imSlot?.orderNo
          );
          return tpl?.family ?? "";
        },
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        width: 140,
        cellRenderer: (p: { value: string }) =>
          p.value ? (
            <span style={{
              background: "#eef0f8", color: "#446", borderRadius: 4,
              padding: "2px 8px", fontSize: 11, fontWeight: 600,
            }}>
              {p.value}
            </span>
          ) : (
            <span style={{ color: "var(--color-text-secondary, #6b7280)" }}>—</span>
          ),
      },
      {
        headerName: "Order Number",
        colId: "orderNo",
        valueGetter: (p) => {
          if (p.data?.orderNo) return p.data.orderNo;
          const imSlot = p.data?.slots.find((s) => s.slot === 0);
          return imSlot?.orderNo ?? "—";
        },
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        flex: 1.5,
        minWidth: 140,
        cellStyle: {
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 11,
          color: "#556",
        } as CellStyle,
      },
      {
        headerName: "IP Address",
        field: "ip",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        width: 140,
        valueFormatter: (p) => p.value ?? "—",
        cellStyle: {
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 12,
          color: "#447",
        } as CellStyle,
      },
      {
        headerName: "Node",
        field: "subsystemNo",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        flex: 2,
        minWidth: 180,
        valueGetter: (p) => {
          const no = p.data?.subsystemNo;
          if (no == null) return "—";
          const fb = p.context?.fieldbuses?.find(
            (f: HwFieldbus) => String(f.INT_DP_Subsystem) === String(no)
          );
          return fb
            ? `${fb.T50_Fieldbus_Name}: PROFINET IO system (${no})`
            : `PROFINET IO system (${no})`;
        },
        cellStyle: { color: "#669" } as CellStyle,
      },
      {
        headerName: "Status",
        field: "approved",
        filter: "agTextColumnFilter",
        floatingFilter: true,
        sortable: true,
        resizable: true,
        width: 120,
        cellRenderer: ApprovedCellRenderer,
        valueFormatter: (p) => (p.value ? "Approved" : "Pending"),
      },
      {
        headerName: "",
        colId: "actions",
        sortable: false,
        filter: false,
        resizable: false,
        editable: false,
        width: 110,
        maxWidth: 110,
        pinned: "right" as const,
        suppressHeaderMenuButton: true,
        cellRenderer: ConfigureCellRenderer,
        cellStyle: { display: "flex", alignItems: "center", justifyContent: "center", padding: 4 } as CellStyle,
      },
    ],
    []
  );

  const defaultColDef = useMemo<ColDef>(() => ({ suppressMovable: false }), []);

  const getRowId = useCallback(
    (p: GetRowIdParams<HwStation>) => String(p.data.address),
    []
  );

  const getRowStyle = useCallback(
    (params: { data?: HwStation }) =>
      params.data?.address === configureAddr
        ? { background: "#EEEDFE", borderLeft: "3px solid #2255cc" }
        : undefined,
    [configureAddr]
  );

  const handleSelectionChanged = useCallback(
    (e: SelectionChangedEvent<HwStation>) => {
      const selected = e.api
        .getSelectedNodes()
        .map((n: IRowNode<HwStation>) => n.data?.address)
        .filter((a): a is number => a != null);
      onSelectionChanged(new Set(selected));
    },
    [onSelectionChanged]
  );

  // Refresh row styles when configureAddr changes so the highlight updates
  useEffect(() => {
    gridRef.current?.api?.redrawRows();
  }, [configureAddr]);

  return (
    <div className="ig-grid-wrap" style={{ borderRadius: "var(--border-radius-lg, 12px)" }}>
      <AgGridReact<HwStation>
        ref={gridRef}
        theme={theme}
        rowData={stations}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={getRowId}
        context={context}
        getRowStyle={getRowStyle}
        onSelectionChanged={handleSelectionChanged}
        rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true }}
        suppressCellFocus={false}
        animateRows={false}
        rowBuffer={20}
        domLayout="autoHeight"
      />
    </div>
  );
}
