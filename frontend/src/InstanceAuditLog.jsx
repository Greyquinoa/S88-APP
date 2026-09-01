// InstanceAuditLog.jsx — change feed for project instances.
//
// Deliberately the same shape as LibraryAuditLog.jsx so the two audit views read
// identically. The differences are the data source, an Instance column keyed on
// entity_key (instance_name is the only identity that survives a project save —
// see services/instanceAudit.js), and an instance-name filter.
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { getInstanceAuditLog } from "./api.js";

ModuleRegistry.registerModules([AllCommunityModule]);

const ACTION_CONFIG = {
  CREATE: { color: "#DCFCE7", textColor: "#166534", label: "Created" },
  UPDATE: { color: "#DBEAFE", textColor: "#1D4ED8", label: "Updated" },
  DELETE: { color: "#FEE2E2", textColor: "#991B1B", label: "Deleted" },
};

// One line per changed field. Labels and display strings are pre-rendered
// server-side (enrichChanges), so nothing is re-derived here.
function renderFieldChanges(fieldChanges) {
  if (!fieldChanges || !fieldChanges.length) return null;
  return fieldChanges
    .map(fc => `${fc.label || fc.field}: ${fc.oldDisplay ?? "(none)"} → ${fc.newDisplay ?? "(none)"}`)
    .join("\n");
}

const ACTION_FILTERS = ["all", "CREATE", "UPDATE", "DELETE"];

const inputStyle = {
  fontSize: 12, padding: "5px 10px", borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-secondary)", background: "transparent",
  color: "var(--color-text-primary)",
};

function InstanceAuditLog({ projectId }) {
  const gridRef = useRef(null);
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [actionFilter, setActionFilter]     = useState("all");
  const [instanceFilter, setInstanceFilter] = useState("");
  const [userFilter, setUserFilter]         = useState("");
  const [fromFilter, setFromFilter]         = useState("");
  const [toFilter, setToFilter]             = useState("");

  const limit = 100;
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    if (!projectId) { setEntries([]); setTotal(0); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await getInstanceAuditLog(projectId, {
        limit, offset,
        action: actionFilter === "all" ? undefined : actionFilter,
        instance: instanceFilter || undefined,
        user: userFilter || undefined,
        from: fromFilter || undefined,
        to: toFilter || undefined,
      });
      setEntries(result.entries || []);
      setTotal(result.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, offset, actionFilter, instanceFilter, userFilter, fromFilter, toFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setOffset(0); }, [actionFilter, instanceFilter, userFilter, fromFilter, toFilter]);

  const theme = useMemo(() => themeQuartz.withParams({
    fontSize: 12, rowHeight: 36, headerHeight: 36,
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    accentColor: '#0C447C', browserColorScheme: 'light',
  }), []);

  const defaultColDef = useMemo(() => ({
    sortable: true, resizable: true, suppressMovable: false,
  }), []);

  const columnDefs = useMemo(() => [
    {
      headerName: 'Date/Time', field: 'changed_at',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 1,
      valueFormatter: p => p.value ? new Date(p.value).toLocaleString() : '',
      sort: 'desc',
      cellStyle: { fontSize: 11, color: 'var(--color-text-secondary)' },
    },
    {
      headerName: 'User', field: 'changed_by',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 100, flex: 0.7,
      cellStyle: { fontSize: 12 },
    },
    {
      headerName: 'Record', field: 'action',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 100, flex: 0.7,
      cellRenderer: p => {
        const config = ACTION_CONFIG[p.value] || {};
        return (
          <span style={{
            display: "inline-flex", alignItems: "center",
            padding: "2px 8px", borderRadius: "var(--border-radius-md)",
            background: config.color, color: config.textColor,
            fontSize: 11, fontWeight: 600, whiteSpace: "nowrap"
          }}>
            {config.label || p.value}
          </span>
        );
      },
    },
    {
      headerName: 'Source', field: 'location',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 1,
      valueFormatter: p => p.value || '—',
      cellStyle: { fontSize: 12, color: 'var(--color-text-secondary)' },
    },
    {
      headerName: 'Instance', field: 'entity_key',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 1,
      valueFormatter: p => p.value || '—',
      cellStyle: { fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)', fontWeight: 500 },
    },
    {
      headerName: 'CM Type', field: 'context_cm_type',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 140, flex: 0.9,
      valueFormatter: p => p.value || '—',
      cellStyle: { fontSize: 12, fontFamily: 'var(--font-mono)' },
    },
    {
      headerName: 'Change', field: 'field_changes',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 260, flex: 2,
      autoHeight: true,
      // CREATE/DELETE carry no field diff — fall back to the prose description.
      valueGetter: p => renderFieldChanges(p.data.field_changes) || p.data.description,
      cellRenderer: p => (
        <div style={{ whiteSpace: 'pre-line', fontSize: 12, padding: '6px 0', lineHeight: 1.5 }}>
          {p.value}
        </div>
      ),
    },
  ], []);

  const getRowId = useCallback(p => String(p.data.id), []);

  return (
    <div style={{ padding: 14, overflow: 'auto', minHeight: 0, flex: 1 }}>
      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {ACTION_FILTERS.map(a => (
            <button
              key={a}
              onClick={() => setActionFilter(a)}
              style={{
                padding: "4px 10px", fontSize: 11, fontWeight: actionFilter === a ? 600 : 400,
                border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)",
                background: actionFilter === a ? "var(--color-background-secondary)" : "transparent",
                color: "var(--color-text-primary)", cursor: "pointer"
              }}>
              {a === "all" ? "All" : ACTION_CONFIG[a]?.label}
            </button>
          ))}
        </div>

        <input
          type="text" placeholder="Filter by instance…"
          value={instanceFilter} onChange={e => setInstanceFilter(e.target.value)}
          style={{ ...inputStyle, width: 170, fontFamily: 'var(--font-mono)' }}
        />
        <input
          type="text" placeholder="Filter by user…"
          value={userFilter} onChange={e => setUserFilter(e.target.value)}
          style={{ ...inputStyle, width: 150 }}
        />
        <input
          type="date" value={fromFilter} onChange={e => setFromFilter(e.target.value)}
          style={inputStyle}
        />
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>to</span>
        <input
          type="date" value={toFilter} onChange={e => setToFilter(e.target.value)}
          style={inputStyle}
        />
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "#991B1B", marginBottom: 10 }}>
          Failed to load audit log: {error}
        </div>
      )}

      <div className="ig-root" style={{ width: '100%', background: '#FFFFFF' }}>
        <AgGridReact
          ref={gridRef}
          theme={theme}
          domLayout="autoHeight"
          rowData={entries}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          animateRows={false}
          loading={loading}
          overlayNoRowsTemplate="No instance changes recorded yet."
        />
      </div>

      {/* Pagination */}
      {total > limit && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 14 }}>
          <button
            onClick={() => setOffset(o => Math.max(0, o - limit))}
            disabled={offset === 0}
            style={{
              fontSize: 12, padding: "4px 12px", border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-md)", background: "transparent",
              color: "var(--color-text-primary)", cursor: offset === 0 ? "not-allowed" : "pointer",
              opacity: offset === 0 ? 0.5 : 1
            }}>
            Previous
          </button>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => setOffset(o => o + limit)}
            disabled={offset + limit >= total}
            style={{
              fontSize: 12, padding: "4px 12px", border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-md)", background: "transparent",
              color: "var(--color-text-primary)", cursor: offset + limit >= total ? "not-allowed" : "pointer",
              opacity: offset + limit >= total ? 0.5 : 1
            }}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export default InstanceAuditLog;
