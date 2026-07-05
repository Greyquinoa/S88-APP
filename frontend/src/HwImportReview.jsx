import { useState, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { applyHwIoList } from './api';

// ── Colour palette per status ─────────────────────────────────────────────────
const STATUS_STYLE = {
  new:       { bg: '#dcfce7', color: '#166534', label: 'New'       },
  modified:  { bg: '#fef9c3', color: '#854d0e', label: 'Modified'  },
  missing:   { bg: '#fee2e2', color: '#991b1b', label: 'Missing'   },
  unchanged: { bg: '#f3f4f6', color: '#6b7280', label: 'Unchanged' },
};

function StatusBadge({ value }) {
  const s = STATUS_STYLE[value] || STATUS_STYLE.unchanged;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      fontSize: 11, fontWeight: 700, background: s.bg, color: s.color,
    }}>{s.label}</span>
  );
}

function CheckboxCell({ value, node, onToggle }) {
  return (
    <input type="checkbox" checked={value} style={{ cursor: 'pointer' }}
      onChange={() => onToggle(node.data.key)} />
  );
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCsv(items) {
  const headers = ['Status','Station Addr','Station Name','IP Address','Subsystem No',
    'Slot','Module Order No','Module Name','Channel','Tag','Signal Type','Description',
    'Property Changed','App Value','Imported Value'];
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const rows = [];
  for (const item of items) {
    const src = item.status === 'missing' ? item.current : (item.incoming || item.current || {});
    const base = [
      item.status,
      src.station_address ?? '', src.station_name ?? '', src.ip_address ?? '',
      src.subsystem_no ?? '', src.slot ?? '', src.module_order_no ?? '',
      src.module_name ?? '', src.channel ?? '', src.tag ?? '',
      src.signal_type ?? '', src.description ?? '',
    ];
    if (item.changes && item.changes.length > 0) {
      for (const c of item.changes) {
        rows.push([...base, c.property, c.currentValue ?? '', c.importedValue ?? ''].map(escape).join(','));
      }
    } else {
      rows.push([...base, '', '', ''].map(escape).join(','));
    }
  }

  const csv = [headers.map(escape).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'hw_import_review.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Summary card ──────────────────────────────────────────────────────────────
function SummaryCard({ label, count, status, active, onClick }) {
  const s = STATUS_STYLE[status];
  return (
    <div onClick={onClick} style={{
      cursor: 'pointer', userSelect: 'none',
      padding: '10px 18px', borderRadius: 8, minWidth: 90, textAlign: 'center',
      background: active ? s.bg : '#fff',
      border: `2px solid ${active ? s.color : '#e5e7eb'}`,
      color: active ? s.color : '#374151',
      transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{count}</div>
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ── Resolution stats banner (Tier 1 vs Tier 2) ────────────────────────────────
function ResolutionStatsBanner({ stats }) {
  if (!stats || !stats.total) return null;
  const { tier1 = 0, tier2Resolved = 0, tier2Unresolved = 0 } = stats;
  if (tier2Resolved === 0 && tier2Unresolved === 0) return null; // pure Tier 1 import — nothing to call out

  return (
    <div style={{
      display: 'flex', gap: 16, padding: '10px 20px', background: '#eff6ff',
      borderBottom: '1px solid #dbeafe', flexShrink: 0, alignItems: 'center', fontSize: 12,
    }}>
      <span style={{ fontWeight: 700, color: '#1e40af' }}>Hardware Resolution:</span>
      <span style={{ color: '#374151' }}>Tier 1 (direct MLFB): <strong>{tier1}</strong></span>
      <span style={{ color: '#166534' }}>Tier 2 (Protocol+SignalType): <strong>{tier2Resolved}</strong></span>
      {tier2Unresolved > 0 && (
        <span style={{
          color: '#991b1b', fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: '#fee2e2',
        }}>
          ⚠ Unresolved (needs manual fix): {tier2Unresolved}
        </span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HwImportReview({ importId, summary, items, parsedRows, fileName, resolutionStats, onApplied, onClose }) {
  const [filter, setFilter]   = useState('all');
  const [selected, setSelected] = useState(() => {
    // Pre-select all non-unchanged rows
    const s = new Set();
    for (const it of items) if (it.status !== 'unchanged') s.add(it.key);
    return s;
  });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);

  // Expand rows for modified items (one row per property change, or one row if no changes)
  const flatItems = useMemo(() => {
    const out = [];
    for (const item of items) {
      if (item.status === 'modified' && item.changes.length > 1) {
        // First row carries the full data; extra rows only show extra property diffs
        out.push({ ...item, _changeIdx: 0, _changeOf: item.changes.length,
                   propertyChanged: item.changes[0].property,
                   appValue: String(item.changes[0].currentValue ?? ''),
                   importedValue: String(item.changes[0].importedValue ?? '') });
        for (let i = 1; i < item.changes.length; i++) {
          out.push({ key: item.key + '__' + i, status: item.status,
                     objectName: '', station_address: '', station_name: '',
                     slot: '', channel: '', tag: '', signal_type: '',
                     _extra: true, _changeIdx: i, _changeOf: item.changes.length,
                     propertyChanged: item.changes[i].property,
                     appValue: String(item.changes[i].currentValue ?? ''),
                     importedValue: String(item.changes[i].importedValue ?? '') });
        }
      } else {
        const c = item.changes[0];
        out.push({ ...item,
                   propertyChanged: c ? c.property : '',
                   appValue: c ? String(c.currentValue ?? '') : '',
                   importedValue: c ? String(c.importedValue ?? '') : '' });
      }
    }
    return out;
  }, [items]);

  const filtered = useMemo(() => {
    if (filter === 'all') return flatItems;
    return flatItems.filter(r => !r._extra && r.status === filter ||
                                  r._extra && flatItems.find(x => x.key === r.key.split('__')[0])?.status === filter);
  }, [flatItems, filter]);

  const toggleKey = useCallback((key) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const acceptAll  = () => setSelected(new Set(items.filter(i => i.status !== 'unchanged').map(i => i.key)));
  const rejectAll  = () => setSelected(new Set());
  const acceptSelected = () => {}; // grid selection handled per-row via checkbox
  const rejectSelected = () => {};

  const missingKeys = useMemo(() => items.filter(i => i.status === 'missing').map(i => i.key), [items]);

  const handleApply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await applyHwIoList(importId, [...selected], parsedRows, fileName, missingKeys);
      onApplied();
    } catch (e) {
      setApplyError(e.message);
      setApplying(false);
    }
  };

  // AG Grid column defs
  const colDefs = useMemo(() => [
    {
      headerName: '', width: 40, pinned: 'left',
      cellRenderer: (p) => {
        if (p.data._extra) return null;
        return <CheckboxCell value={selected.has(p.data.key)} node={p} onToggle={toggleKey} />;
      },
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
    },
    {
      headerName: 'Status', field: 'status', width: 100, pinned: 'left',
      cellRenderer: (p) => p.data._extra ? null : <StatusBadge value={p.value} />,
      cellStyle: { display: 'flex', alignItems: 'center' },
    },
    { headerName: 'Addr',    field: 'incoming.station_address', width: 60,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.station_address ?? p.data.current?.station_address ?? '') },
    { headerName: 'Station', field: 'station_name', width: 160,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.station_name ?? p.data.current?.station_name ?? '') },
    { headerName: 'Slot',    width: 55,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.slot ?? p.data.current?.slot ?? '') },
    { headerName: 'Ch',      width: 50,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.channel ?? p.data.current?.channel ?? '') },
    { headerName: 'Tag',     width: 130,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.tag ?? p.data.current?.tag ?? '') },
    { headerName: 'Signal Type', width: 100,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.signal_type ?? p.data.current?.signal_type ?? '') },
    { headerName: 'Module', width: 200,
      valueGetter: p => p.data._extra ? '' : (p.data.incoming?.module_order_no ?? p.data.current?.module_order_no ?? ''),
      cellRenderer: (p) => {
        if (p.data._extra) return null;
        const value = p.data.incoming?.module_order_no ?? p.data.current?.module_order_no ?? '';
        if (p.data.unresolved) {
          return (
            <span style={{ color: '#991b1b', fontWeight: 600 }} title="Tier 2 lookup failed — select the correct module manually">
              ⚠ {value}
            </span>
          );
        }
        if (p.data.resolvedByTier2) {
          return (
            <span style={{ color: '#166534' }} title="Resolved via Protocol + Signal Type lookup (Tier 2)">
              {value} <span style={{ fontSize: 10, opacity: 0.8 }}>(Tier 2)</span>
            </span>
          );
        }
        return value;
      },
    },
    { headerName: 'Property Changed', field: 'propertyChanged', width: 150,
      cellStyle: p => p.data._extra ? { color: '#6b7280', fontStyle: 'italic' } : {} },
    { headerName: 'App Value',      field: 'appValue',      width: 140,
      cellStyle: { color: '#991b1b' } },
    { headerName: 'Imported Value', field: 'importedValue', width: 140,
      cellStyle: { color: '#166534' } },
  ], [selected, toggleKey]);

  const getRowStyle = useCallback((p) => {
    if (p.data._extra) return { background: '#fafafa' };
    const s = STATUS_STYLE[p.data.status];
    return { background: s?.bg || '#fff' };
  }, []);

  const selectedCount = selected.size;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'stretch',
    }}>
      <div style={{
        margin: 'auto', width: '96vw', maxWidth: 1400, height: '92vh',
        background: '#fff', borderRadius: 12, display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.35)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', background: '#1e40af', color: '#fff', flexShrink: 0,
        }}>
          <div>
            <span style={{ fontSize: 18, fontWeight: 700 }}>Import Review &amp; Validation</span>
            <span style={{ marginLeft: 12, fontSize: 13, opacity: 0.8 }}>{fileName}</span>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#fff', fontSize: 22,
            cursor: 'pointer', lineHeight: 1, padding: '0 4px',
          }}>✕</button>
        </div>

        {/* Tier 1 / Tier 2 resolution stats */}
        <ResolutionStatsBanner stats={resolutionStats} />

        {/* Summary cards */}
        <div style={{
          display: 'flex', gap: 12, padding: '14px 20px', background: '#f8fafc',
          borderBottom: '1px solid #e5e7eb', flexShrink: 0, flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <SummaryCard label="New"       count={summary.new}       status="new"       active={filter==='new'}       onClick={() => setFilter(f => f==='new'       ? 'all' : 'new')}       />
          <SummaryCard label="Modified"  count={summary.modified}  status="modified"  active={filter==='modified'}  onClick={() => setFilter(f => f==='modified'  ? 'all' : 'modified')}  />
          <SummaryCard label="Missing"   count={summary.missing}   status="missing"   active={filter==='missing'}   onClick={() => setFilter(f => f==='missing'   ? 'all' : 'missing')}   />
          <SummaryCard label="Unchanged" count={summary.unchanged} status="unchanged" active={filter==='unchanged'} onClick={() => setFilter(f => f==='unchanged' ? 'all' : 'unchanged')} />
          <div style={{ marginLeft: 'auto', fontSize: 13, color: '#6b7280' }}>
            {summary.total} objects analysed &nbsp;·&nbsp; {selectedCount} selected for import
          </div>
        </div>

        {/* Filter chips */}
        <div style={{
          display: 'flex', gap: 8, padding: '8px 20px', background: '#fff',
          borderBottom: '1px solid #e5e7eb', flexShrink: 0,
        }}>
          {['all','new','modified','missing','unchanged'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '4px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              border: '1px solid',
              borderColor: filter === f ? '#1e40af' : '#d1d5db',
              background: filter === f ? '#1e40af' : '#fff',
              color: filter === f ? '#fff' : '#374151',
              cursor: 'pointer', textTransform: 'capitalize',
            }}>{f === 'all' ? `All (${summary.total})` : f}</button>
          ))}
        </div>

        {/* Grid */}
        <div className="ag-theme-alpine" style={{ flex: 1, overflow: 'hidden' }}>
          <AgGridReact
            rowData={filtered}
            columnDefs={colDefs}
            getRowStyle={getRowStyle}
            rowHeight={32}
            headerHeight={36}
            suppressMovableColumns
            suppressCellFocus
            defaultColDef={{ resizable: true, sortable: true }}
          />
        </div>

        {/* Action bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px', borderTop: '1px solid #e5e7eb', background: '#f8fafc',
          flexShrink: 0, gap: 10, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => exportCsv(items)} style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db',
              background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>⬇ Export Report</button>
          </div>

          {applyError && (
            <span style={{ color: '#991b1b', fontSize: 13 }}>Error: {applyError}</span>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={rejectAll} style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db',
              background: '#fff', cursor: 'pointer', fontSize: 13,
            }}>Deselect All</button>
            <button onClick={acceptAll} style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db',
              background: '#fff', cursor: 'pointer', fontSize: 13,
            }}>Select All Changes</button>
            <button
              onClick={handleApply}
              disabled={applying || selectedCount === 0}
              style={{
                padding: '6px 18px', borderRadius: 6, border: 'none',
                background: applying || selectedCount === 0 ? '#9ca3af' : '#1e40af',
                color: '#fff', cursor: applying || selectedCount === 0 ? 'default' : 'pointer',
                fontSize: 13, fontWeight: 700,
              }}
            >{applying ? 'Applying…' : `Apply ${selectedCount} Change${selectedCount !== 1 ? 's' : ''}`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
