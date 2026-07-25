import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellStyle,
  GridApi,
} from "ag-grid-community";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
// @ts-ignore
import "./SymbolTableGrid.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Channel {
  channel: number;
  tag: string | null;
  signal_type: string | null;
  description: string | null;
}

export interface SymbolRow {
  rowNum: number;
  station: string;
  address: string;
  signalName: string;
  dataType: string;
  description: string;
}

interface SymbolTableGridProps {
  data: SymbolRow[];
  loading?: boolean;
}

// ── Data Type Badge Cell Renderer ─────────────────────────────────────────────

function DataTypeBadgeRenderer(props: { value: string }) {
  const badgeStyle: CellStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
    whiteSpace: "nowrap",
  };

  const colors: Record<string, [string, string]> = {
    BOOL: ["#DBEAFE", "#1D4ED8"],
    DI: ["#DBEAFE", "#1D4ED8"],
    DO: ["#FED7AA", "#EA580C"],
    AI: ["#D1FAE5", "#065F46"],
    AO: ["#FCA5A5", "#7F1D1D"],
    PA: ["#E9D5FF", "#6B21A8"],
    INFRA: ["#F3F4F6", "#374151"],
    MIXED: ["#FEF3C7", "#92400E"],
  };

  const [bg, fg] = colors[props.value] || ["#F3F4F6", "#6B7280"];

  return (
    <span style={{ ...badgeStyle, background: bg, color: fg }}>
      {props.value}
    </span>
  );
}

// ── SymbolTableGrid Component ─────────────────────────────────────────────────

export default function SymbolTableGrid({ data, loading = false }: SymbolTableGridProps) {
  const gridRef = useRef<AgGridReact<SymbolRow>>(null);
  const [gridApi, setGridApi] = useState<GridApi<SymbolRow> | null>(null);

  const theme = useMemo(
    () =>
      themeQuartz.withParams({
        fontSize: 12,
        headerHeight: 36,
        fontFamily: "system-ui, -apple-system, sans-serif",
        accentColor: "#2255cc",
        browserColorScheme: "light",
      }),
    []
  );

  const columns: ColDef<SymbolRow>[] = useMemo(() => [
    {
      field: "rowNum",
      headerName: "#",
      width: 50,
      sortable: false,
      filter: false,
      suppressMenu: true,
      floatingFilter: false,
      cellStyle: { textAlign: "center", color: "#999", fontSize: 12 },
    },
    {
      field: "station",
      headerName: "Station",
      width: 140,
      sortable: true,
      filter: "agTextColumnFilter",
      suppressMenu: true,
      floatingFilter: true,
    },
    {
      field: "address",
      headerName: "Address",
      width: 160,
      sortable: true,
      filter: "agTextColumnFilter",
      suppressMenu: true,
      floatingFilter: true,
      cellStyle: { fontFamily: "monospace", color: "#2255cc", fontWeight: 500 },
    },
    {
      field: "signalName",
      headerName: "Signal Name",
      flex: 1,
      minWidth: 250,
      sortable: true,
      filter: "agTextColumnFilter",
      suppressMenu: true,
      floatingFilter: true,
      cellStyle: { fontFamily: "monospace", color: "#1a1a1a" },
    },
    {
      field: "dataType",
      headerName: "Data Type",
      width: 130,
      sortable: true,
      filter: "agSetColumnFilter",
      suppressMenu: true,
      floatingFilter: true,
      cellRenderer: DataTypeBadgeRenderer,
    },
    {
      field: "description",
      headerName: "Description",
      flex: 1,
      minWidth: 250,
      sortable: true,
      filter: "agTextColumnFilter",
      suppressMenu: true,
      floatingFilter: true,
    },
  ], []);

  const defaultColDef: ColDef<SymbolRow> = useMemo(() => ({
    resizable: true,
    suppressMovable: false,
    suppressSizeToFit: false,
  }), []);

  const onGridReady = useCallback(({ api }: { api: GridApi<SymbolRow> }) => {
    setGridApi(api);
    setTimeout(() => {
      api.sizeColumnsToFit();
    }, 100);
  }, []);

  return (
    <div className="st-root">
      <div className="st-grid-wrap">
        {loading ? (
          <div className="st-loading">
            <div className="st-spinner">⟳</div>
            <span>Loading signals…</span>
          </div>
        ) : data.length === 0 ? (
          <div className="st-empty">
            <div className="st-empty-icon">◉</div>
            <div className="st-empty-title">No Signals Configured</div>
            <div className="st-empty-message">
              Configure hardware stations and assign signal names to see them here.
            </div>
          </div>
        ) : (
          <AgGridReact<SymbolRow>
            ref={gridRef}
            rowData={data}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            theme={theme}
            pagination={false}
            enableCellTextSelection={true}
            rowHeight={32}
            headerHeight={36}
            floatingFilterHeight={32}
            animateRows={false}
            rowBuffer={20}
            onGridReady={onGridReady}
            getRowId={({ data }) => `${data.address}-${data.signalName}`}
            domLayout="autoHeight"
          />
        )}
      </div>
      <div className="st-status">
        {data.length > 0 && (
          <span className="st-row-count">{data.length} signal{data.length !== 1 ? 's' : ''}</span>
        )}
      </div>
    </div>
  );
}
