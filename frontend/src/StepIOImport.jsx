// StepIOImport.jsx — Full IO List import pipeline
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  uploadIOList, reimportIOList, listIOImports, deleteIOImport,
  getIOHeaders, getIOTags, patchIOTag, approveAllIOTags, rejectIOTag,
  getIOColumnMaps, createIOColumnMap, updateIOColumnMap, deleteIOColumnMap, applyIOColumnMap,
  getIOFunctionMaps, createIOFunctionMap, deleteIOFunctionMap,
  getIOFunctionMapMappings, saveIOFunctionMapMappings,
  buildIOHierarchy, getIOHierarchy, getIOHierarchyLevels,
  runIOAssignment, getIOUnresolvedFunctions,
  getIOValidationReport, promoteIOImport, ioExportUrl,
} from './api.js';

// ── Shared primitives ──────────────────────────────────────────────────────────
function Btn({ onClick, primary, danger, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: primary ? 500 : 400,
        border: danger ? '1px solid #FCA5A5' : primary ? 'none' : '0.5px solid var(--color-border-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: danger ? '#FEE2E2' : primary ? 'var(--color-text-primary)' : 'transparent',
        color: danger ? '#991B1B' : primary ? 'var(--color-background-primary)' : 'var(--color-text-primary)',
        opacity: disabled ? 0.4 : 1, display: 'inline-flex', alignItems: 'center', gap: 5, ...style,
      }}>
      {children}
    </button>
  );
}

function Tag({ text, color }) {
  const colors = {
    green:  { bg: '#D1FAE5', fg: '#065F46' },
    red:    { bg: '#FEE2E2', fg: '#991B1B' },
    yellow: { bg: '#FEF3C7', fg: '#92400E' },
    blue:   { bg: '#E6F1FB', fg: '#0C447C' },
    gray:   { bg: 'var(--color-background-secondary)', fg: 'var(--color-text-secondary)' },
    purple: { bg: '#F3E8FF', fg: '#6B21A8' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 8, fontWeight: 600,
      background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{text}</span>
  );
}

const STATUS_COLOR = {
  auto:            'green',
  approved:        'green',
  manual_override: 'blue',
  unresolved:      'yellow',
  pending:         'gray',
  rejected:        'red',
};

const inputSx = {
  padding: '4px 8px', border: '0.5px solid var(--color-border-secondary)',
  borderRadius: 6, fontSize: 12, fontFamily: 'var(--font-mono)',
  background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
  width: '100%',
};

function Switch({ checked, onChange }) {
  return (
    <div onClick={() => onChange(!checked)}
      style={{ width: 32, height: 18, borderRadius: 9, cursor: 'pointer', flexShrink: 0,
        background: checked ? '#6B7AFF' : 'var(--color-border-secondary)',
        position: 'relative', transition: 'background 0.15s' }}>
      <div style={{
        position: 'absolute', top: 2, left: checked ? 14 : 2,
        width: 14, height: 14, borderRadius: '50%', background: '#fff',
        transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      }} />
    </div>
  );
}

// ── Sub-tab bar ────────────────────────────────────────────────────────────────
const IO_TABS = [
  { key: 'upload',   label: 'Upload',          icon: 'ti-upload' },
  { key: 'colmap',   label: 'Column Mapping',  icon: 'ti-columns' },
  { key: 'hierarchy',label: 'Hierarchy',        icon: 'ti-sitemap' },
  { key: 'fnmap',    label: 'Function Mapping', icon: 'ti-arrow-right-circle' },
  { key: 'review',   label: 'Review',           icon: 'ti-checklist' },
];

function SubTabs({ tab, setTab, importReady }) {
  return (
    <div style={{ display: 'flex', borderBottom: '0.5px solid var(--color-border-tertiary)',
        marginBottom: 0, background: 'var(--color-background-secondary)' }}>
      {IO_TABS.map((t, i) => {
        const disabled = i > 0 && !importReady;
        const active   = tab === t.key;
        return (
          <button key={t.key} onClick={() => !disabled && setTab(t.key)} disabled={disabled}
            style={{ padding: '8px 16px', border: 'none', background: 'transparent',
              cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12,
              fontWeight: active ? 600 : 400,
              color: disabled ? 'var(--color-border-secondary)'
                   : active   ? 'var(--color-text-primary)'
                              : 'var(--color-text-secondary)',
              borderBottom: active ? '2px solid var(--color-text-primary)' : '2px solid transparent',
              marginBottom: -1, display: 'flex', alignItems: 'center', gap: 5 }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 13 }} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 — UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════
function TabUpload({ projectId, imports, onImported, onSelectImport, onDeleteImport,
    selectedImportId, columnMaps, allHeaders, activeHeaders, onActiveHeadersChange, setError }) {
  const fileRef          = useRef();
  const reimportRef      = useRef();
  const [busy, setBusy]  = useState(false);
  const [reimportId, setReimportId] = useState(null);  // import being replaced
  const [preview, setPreview] = useState(null);
  const [selSheet, setSelSheet]   = useState('');
  const [selColMap, setSelColMap] = useState('');

  async function handleFile(f) {
    if (!f) return;
    setPreview(null);
    setBusy(true);
    try {
      const r = await uploadIOList(projectId, f, selSheet || null, selColMap || null);
      setPreview(r);
      onImported(r.importId);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleReimport(f) {
    if (!f || !reimportId) return;
    setBusy(true);
    setPreview(null);
    try {
      const r = await reimportIOList(reimportId, f);
      setPreview(r);
      onImported(reimportId, { preserveHeaders: true });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); setReimportId(null); reimportRef.current.value = ''; }
  }

  // Use allHeaders from props (loaded by main component); fall back to preview headers if not yet propagated
  const headers = allHeaders.length > 0 ? allHeaders : (preview?.headers || []);

  function toggleHeader(h) {
    const next = new Set(activeHeaders ?? new Set(headers));
    if (next.has(h)) next.delete(h); else next.add(h);
    onActiveHeadersChange(next);
  }

  function toggleAll(on) {
    onActiveHeadersChange(on ? new Set(headers) : new Set());
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      {/* Left: existing imports list */}
      <div style={{ width: 260, flexShrink: 0, borderRight: '0.5px solid var(--color-border-tertiary)',
          display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'var(--color-text-secondary)',
            borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
          Imports
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {imports.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              No imports yet.
            </div>
          )}
          {imports.map(imp => (
            <div key={imp.id} onClick={() => onSelectImport(imp.id)}
              style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '0.5px solid var(--color-border-tertiary)',
                background: imp.id === selectedImportId ? '#EEEDFE' : 'transparent',
                display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-mono)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {imp.file_name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2, display: 'flex', gap: 8 }}>
                  <span>{imp.total_tags ?? imp.total_rows ?? '?'} tags</span>
                  <Tag text={imp.status} color={imp.status === 'promoted' ? 'green' : 'gray'} />
                </div>
              </div>
              <button
                onClick={e => {
                  e.stopPropagation();
                  setReimportId(imp.id);
                  onSelectImport(imp.id);
                  reimportRef.current.value = '';
                  reimportRef.current.click();
                }}
                title="Reimport — replace with new file"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px',
                  color: 'var(--color-text-secondary)', flexShrink: 0, lineHeight: 1 }}>
                <i className="ti ti-refresh" style={{ fontSize: 13 }} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDeleteImport(imp.id, imp.file_name); }}
                title="Delete import"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px',
                  color: 'var(--color-text-secondary)', flexShrink: 0, lineHeight: 1 }}>
                <i className="ti ti-trash" style={{ fontSize: 13 }} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Right: upload form + preview */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
        {/* Options row */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Column mapping config</div>
            <select value={selColMap} onChange={e => setSelColMap(e.target.value)} style={{ ...inputSx, width: 200 }}>
              <option value="">(auto-detect)</option>
              {columnMaps.map(cm => <option key={cm.id} value={cm.id}>{cm.name}</option>)}
            </select>
          </div>
        </div>

        {/* Drop zone */}
        <div
          style={{ border: '1.5px dashed var(--color-border-secondary)', borderRadius: 8,
            padding: '2rem', textAlign: 'center', cursor: 'pointer',
            background: busy ? 'var(--color-background-secondary)' : 'transparent' }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
          <i className="ti ti-file-spreadsheet" style={{ fontSize: 32, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 500 }}>
            {busy ? 'Parsing…' : 'Drop IO List Excel here (.xlsx / .xls)'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            or click to browse · All customer columns are preserved
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files[0])} />
        <input ref={reimportRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => handleReimport(e.target.files[0])} />

        {/* Column picker — shown whenever an import is selected (persists across tab switches) */}
        {headers.length > 0 && (
          <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, overflow: 'hidden' }}>

            {/* Column picker panel */}
            <div style={{ width: 240, flexShrink: 0, border: '0.5px solid var(--color-border-tertiary)',
                borderRadius: 6, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '6px 10px', background: 'var(--color-background-secondary)',
                  borderBottom: '0.5px solid var(--color-border-tertiary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
                  Columns
                </span>
                <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                  {(activeHeaders?.size ?? headers.length)}/{headers.length}
                </span>
              </div>
              <div style={{ padding: '5px 10px', borderBottom: '0.5px solid var(--color-border-tertiary)',
                  display: 'flex', gap: 12, flexShrink: 0 }}>
                <button onClick={() => toggleAll(true)}
                  style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--color-text-secondary)', padding: 0, textDecoration: 'underline' }}>
                  All
                </button>
                <button onClick={() => toggleAll(false)}
                  style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--color-text-secondary)', padding: 0, textDecoration: 'underline' }}>
                  None
                </button>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {headers.map(h => {
                  const on = activeHeaders ? activeHeaders.has(h) : true;
                  const suggested = preview?.suggestions?.[h];
                  return (
                    <div key={h} onClick={() => toggleHeader(h)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                        cursor: 'pointer', borderBottom: '0.5px solid var(--color-border-tertiary)',
                        opacity: on ? 1 : 0.45 }}>
                      <Switch checked={on} onChange={() => toggleHeader(h)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: on ? 500 : 400,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {h}
                        </div>
                        {suggested && (
                          <div style={{ fontSize: 10, color: '#0C447C' }}>
                            → {INTERNAL_FIELD_LABELS[suggested] ?? suggested}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Data preview table — only shown right after upload */}
            {preview ? (
              <div style={{ flex: 1, overflow: 'auto', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-background-secondary)', position: 'sticky', top: 0 }}>
                      {headers.filter(h => activeHeaders ? activeHeaders.has(h) : true).map(h => (
                        <th key={h} style={{ padding: '4px 8px', textAlign: 'left', whiteSpace: 'nowrap',
                            fontWeight: 500, borderBottom: '0.5px solid var(--color-border-tertiary)',
                            color: preview.suggestions?.[h] ? '#0C447C' : 'var(--color-text-secondary)' }}>
                          {h}
                          {preview.suggestions?.[h] && (
                            <span style={{ marginLeft: 4, fontSize: 9, color: '#0C447C' }}>
                              →{INTERNAL_FIELD_LABELS[preview.suggestions[h]] ?? preview.suggestions[h]}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.preview || []).map((row, i) => (
                      <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                        {headers.filter(h => activeHeaders ? activeHeaders.has(h) : true).map(h => (
                          <td key={h} style={{ padding: '3px 8px', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                            {row[h] != null ? String(row[h]) : ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--color-text-secondary)',
                    borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                  Showing first 20 of {preview.totalRows} rows
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6,
                  color: 'var(--color-text-secondary)', fontSize: 12 }}>
                Upload a new file to see a data preview.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 — COLUMN MAPPING
// ═══════════════════════════════════════════════════════════════════════════════
const INTERNAL_FIELDS = [
  '', 'instrument_tag', 'function_val', 'hierarchy', 'assignment',
];
const INTERNAL_FIELD_LABELS = {
  '':              '— skip column —',
  instrument_tag:  'Instrument Tag',
  function_val:    'Function',
  hierarchy:       'Hierarchy',
  assignment:      'AS Assignment',
};

function TabColumnMap({ importId, columnMaps, onColumnMapsChange, cmtProfiles, activeHeaders, onTabChange, setError }) {
  const [selected, setSelected]     = useState(null);
  const [draft, setDraft]           = useState(null);      // { name, description, mappings: {} }
  const [detectedHeaders, setHeaders] = useState([]);
  const [busy, setBusy]             = useState(false);
  const [applied, setApplied]       = useState(null);

  // Load column headers from the import's raw row data
  useEffect(() => {
    if (!importId) return;
    getIOHeaders(importId)
      .then(r => setHeaders(r.headers || []))
      .catch(() => {});
  }, [importId]);

  function selectConfig(cm) {
    setSelected(cm.id);
    setDraft({ name: cm.name, description: cm.description || '', mappings: JSON.parse(cm.mappings || '{}') });
    setApplied(null);
  }

  function newConfig() {
    setSelected(null);
    setDraft({ name: 'New Config', description: '', mappings: {} });
    setApplied(false);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      if (selected) {
        await updateIOColumnMap(selected, draft);
      } else {
        const r = await createIOColumnMap(draft);
        setSelected(r.id);
      }
      await onColumnMapsChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!selected || !importId) return;
    setBusy(true);
    try {
      const r = await applyIOColumnMap(importId, selected);
      setApplied(r);
      // Switch to Hierarchy tab so the user sees the result immediately
      onTabChange?.('hierarchy');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function del(id) {
    if (!confirm('Delete this column mapping config?')) return;
    await deleteIOColumnMap(id);
    if (selected === id) { setSelected(null); setDraft(null); }
    await onColumnMapsChange();
  }

  const setMapping = (header, field) => {
    setDraft(d => ({ ...d, mappings: { ...d.mappings, [header]: field || undefined } }));
  };

  // Only show columns the user selected on the Upload tab
  const visibleHeaders = activeHeaders
    ? detectedHeaders.filter(h => activeHeaders.has(h))
    : detectedHeaders;

  return (
    <div style={{ display: 'flex', gap: 0, height: '100%' }}>
      {/* Config list */}
      <div style={{ width: 220, flexShrink: 0, borderRight: '0.5px solid var(--color-border-tertiary)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>Configs</span>
          <Btn onClick={newConfig}><i className="ti ti-plus" /></Btn>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {columnMaps.map(cm => (
            <div key={cm.id} onClick={() => selectConfig(cm)}
              style={{ padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                borderBottom: '0.5px solid var(--color-border-tertiary)',
                background: selected === cm.id ? '#EEEDFE' : 'transparent' }}>
              <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{cm.name}</span>
              <button onClick={e => { e.stopPropagation(); del(cm.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                <i className="ti ti-trash" />
              </button>
            </div>
          ))}
          {columnMaps.length === 0 && <div style={{ padding: 10, fontSize: 12, color: 'var(--color-text-secondary)' }}>No configs yet.</div>}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, padding: '12px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!draft ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 20 }}>
            Select a config or create a new one.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Config name</div>
                <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} style={inputSx} />
              </div>
              <div style={{ flex: 2, minWidth: 200 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Description</div>
                <input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} style={inputSx} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                Column Mappings
              </div>
              {activeHeaders && detectedHeaders.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {visibleHeaders.length} of {detectedHeaders.length} columns selected
                  {' · '}
                  <span style={{ color: '#6B7AFF' }}>change in Upload tab</span>
                </span>
              )}
            </div>
            <div style={{ border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '5px 10px',
                  background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>Customer Column</div>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>Internal Field</div>
              </div>
              {visibleHeaders.length === 0 && (
                <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {detectedHeaders.length === 0
                    ? 'Upload a file first to see detected columns.'
                    : 'No columns selected. Enable columns on the Upload tab.'}
                </div>
              )}
              {visibleHeaders.map(h => (
                <div key={h} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '4px 10px',
                    alignItems: 'center', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{h}</span>
                  <select value={draft.mappings[h] || ''} onChange={e => setMapping(h, e.target.value)} style={{ ...inputSx }}>
                    {INTERNAL_FIELDS.map(f => (
                      <option key={f} value={f}>{INTERNAL_FIELD_LABELS[f] ?? f}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
              {applied && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11,
                    color: 'var(--color-text-secondary)', marginRight: 'auto' }}>
                  <Tag text="Applied ✓" color="green" />
                  {applied.hierarchyStats && Object.entries(applied.hierarchyStats.levels || {}).map(([lvl, cnt]) => (
                    <span key={lvl}>{lvl}: <strong>{cnt}</strong></span>
                  ))}
                  {applied.validation && (
                    <>
                      {applied.validation.error > 0 && <Tag text={`${applied.validation.error} errors`} color="red" />}
                      {applied.validation.warning > 0 && <Tag text={`${applied.validation.warning} warnings`} color="yellow" />}
                    </>
                  )}
                </div>
              )}
              {importId && selected && (
                <Btn onClick={apply} disabled={busy}>
                  <i className="ti ti-player-play" /> {busy ? 'Applying…' : 'Apply to import'}
                </Btn>
              )}
              <Btn primary onClick={save} disabled={busy || !draft.name.trim()}>
                <i className="ti ti-device-floppy" /> Save config
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3 — HIERARCHY
// ═══════════════════════════════════════════════════════════════════════════════
function HierarchyTree({ nodes, depth = 0 }) {
  const icons = { Area: 'ti-map-pin', ProcessCell: 'ti-building-factory', Unit: 'ti-box', EquipmentModule: 'ti-components', ControlModule: 'ti-cpu' };
  const colors = { Area: '#7F77DD', ProcessCell: '#0C447C', Unit: '#065F46', EquipmentModule: '#6B21A8', ControlModule: 'var(--color-text-secondary)' };
  return (
    <div>
      {nodes.map(n => (
        <div key={n.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0',
              paddingLeft: depth * 18 }}>
            <i className={`ti ${icons[n.level] || 'ti-folder'}`}
              style={{ fontSize: 13, color: colors[n.level] || 'var(--color-text-secondary)', flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{n.name}</span>
            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginLeft: 4 }}>{n.level}</span>
            {n.tag_count > 0 && (
              <Tag text={`${n.tag_count} tags`} color="gray" />
            )}
          </div>
          {n.children?.length > 0 && (
            <HierarchyTree nodes={n.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}

const LEVEL_COLORS = {
  ProcessCell:     '#0C447C',
  Unit:            '#065F46',
  Standard:        'var(--color-text-secondary)',
  EquipmentModule: '#6B21A8',
  ControlModule:   'var(--color-text-secondary)',
};
const LEVEL_ICONS = {
  ProcessCell:     'ti-building-factory',
  Unit:            'ti-box',
  Standard:        'ti-folder',
  EquipmentModule: 'ti-components',
  ControlModule:   'ti-cpu',
};
const LEVEL_LABELS = {
  ProcessCell:     'ProcessCell',
  Unit:            'Unit',
  Standard:        'Standard (plain folder)',
  EquipmentModule: 'Equipment Module (EMOD)',
};
const ALL_LEVELS = ['ProcessCell', 'Unit', 'Standard', 'EquipmentModule'];

function TabHierarchy({ importId, projectId, onPromoted, setError }) {
  const [tree, setTree]       = useState([]);
  const [busy, setBusy]       = useState(false);
  const [stats, setStats]     = useState(null);
  // levelMap: ordered array of ISA-88 levels assigned to each slash-segment
  // e.g. ['ProcessCell','Unit'] means segment[0]=ProcessCell, segment[1]=Unit
  const [levelMap, setLevelMap] = useState(['ProcessCell', 'Unit']);

  async function rebuild() {
    setBusy(true);
    try {
      const r = await buildIOHierarchy(importId, levelMap);
      setStats(r);
      if (r.effectiveLevelMap) setLevelMap(r.effectiveLevelMap);
      const resp = await getIOHierarchy(importId);
      setTree(resp.tree ?? resp);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function promote() {
    if (!confirm('Promote to Instances and Hierarchy tabs?')) return;
    setBusy(true);
    try {
      const r = await promoteIOImport(importId, projectId);
      alert(`Promoted ${r.instances} instances, ${r.folders} hierarchy folders${r.userProjects ? `, ${r.userProjects} AS assignments` : ''}.`);
      onPromoted();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // Load existing tree on mount; restore saved levelMap; auto-build if nothing exists yet
  useEffect(() => {
    if (!importId) return;
    setBusy(true);
    getIOHierarchy(importId)
      .then(resp => {
        const t  = resp.tree ?? resp;
        const lm = resp.levelMap;
        if (lm?.length) setLevelMap(lm);
        if (t.length > 0) {
          setTree(t);
          setBusy(false);
        } else {
          // Nothing built yet — auto-build with current/restored levelMap
          const mapToUse = lm?.length ? lm : levelMap;
          return buildIOHierarchy(importId, mapToUse)
            .then(r => {
              setStats(r);
              if (r.effectiveLevelMap) setLevelMap(r.effectiveLevelMap);
              return getIOHierarchy(importId);
            })
            .then(r => setTree(r.tree ?? r));
        }
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  }, [importId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setSegmentLevel(idx, level) {
    setLevelMap(prev => {
      const next = [...prev];
      next[idx] = level;
      return next;
    });
  }
  function addSegment() {
    setLevelMap(prev => {
      const used = new Set(prev);
      const next = ALL_LEVELS.find(l => !used.has(l));
      return next ? [...prev, next] : prev;
    });
  }
  function removeSegment(idx) {
    setLevelMap(prev => prev.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%' }}>

      {/* Left: level config */}
      <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8,
          borderRight: '0.5px solid var(--color-border-tertiary)', paddingRight: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Path Segment → ISA-88 Level
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          Map each <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--color-background-secondary)', padding: '0 3px', borderRadius: 3 }}>/</code>-separated
          segment in your Hierarchy column to an ISA-88 level.
        </div>

        {levelMap.map((level, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-mono)', width: 20, textAlign: 'right', flexShrink: 0 }}>
              [{idx}]
            </span>
            <select value={level}
              onChange={e => setSegmentLevel(idx, e.target.value)}
              style={{ ...inputSx, flex: 1 }}>
              {ALL_LEVELS.map(l => (
                <option key={l} value={l}>{LEVEL_LABELS[l]}</option>
              ))}
            </select>
            <button onClick={() => removeSegment(idx)}
              style={{ background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--color-text-secondary)', fontSize: 13, flexShrink: 0 }}>
              <i className="ti ti-x" />
            </button>
          </div>
        ))}

        {levelMap.length < ALL_LEVELS.length && (
          <Btn onClick={addSegment} style={{ alignSelf: 'flex-start' }}>
            <i className="ti ti-plus" /> Add level
          </Btn>
        )}

        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Btn primary onClick={rebuild} disabled={busy || !importId || levelMap.length === 0}>
            <i className="ti ti-refresh" /> {busy ? 'Building…' : 'Build / Rebuild'}
          </Btn>
          {stats && (
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(stats.levels || {}).map(([lvl, cnt]) => (
                <span key={lvl} style={{ color: LEVEL_COLORS[lvl] || 'inherit' }}>
                  {lvl}: <strong>{cnt}</strong>
                </span>
              ))}
            </div>
          )}
          <Btn onClick={promote} disabled={busy || tree.length === 0}>
            <i className="ti ti-arrow-right" /> Promote to Project →
          </Btn>
        </div>
      </div>

      {/* Right: tree */}
      <div style={{ flex: 1, overflowY: 'auto', border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 6, padding: '8px 12px' }}>
        {tree.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', padding: 12, textAlign: 'center' }}>
            Configure levels on the left and click Build.
          </div>
        ) : (
          <HierarchyTree nodes={tree} />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4 — FUNCTION MAPPING
// ═══════════════════════════════════════════════════════════════════════════════
function TabFunctionMap({ importId, functionMaps, onFunctionMapsChange, cmtProfiles, compositeCmTypes, setError }) {
  const [selected, setSelected]   = useState(null);
  const [mappings, setMappings]   = useState([]);   // { function_value, cm_type_name, match_mode, priority }
  const [unresolved, setUnresolved] = useState([]);
  const [busy, setBusy]           = useState(false);
  const [assigned, setAssigned]   = useState(null);

  async function selectConfig(id) {
    setSelected(id);
    setAssigned(null);
    try {
      const m = await getIOFunctionMapMappings(id);
      setMappings(m.map(r => ({ ...r })));
    } catch (e) { setError(e.message); }
  }

  async function createNew() {
    setBusy(true);
    try {
      const r = await createIOFunctionMap({ name: `Function Map ${functionMaps.length + 1}`, description: '' });
      await onFunctionMapsChange();
      selectConfig(r.id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function saveMappings() {
    if (!selected) return;
    setBusy(true);
    try {
      await saveIOFunctionMapMappings(selected, mappings);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function runAssign() {
    if (!selected || !importId) return;
    await saveMappings();
    setBusy(true);
    try {
      const r = await runIOAssignment(importId, selected);
      setAssigned(r);
      const u = await getIOUnresolvedFunctions(importId);
      setUnresolved(u);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (importId) getIOUnresolvedFunctions(importId).then(setUnresolved).catch(() => {});
  }, [importId]);

  function addRow() {
    setMappings(m => [...m, { function_value: '', cm_type_name: '', match_mode: 'exact', priority: 0 }]);
  }
  function updateRow(i, key, val) {
    setMappings(m => m.map((r, idx) => idx === i ? { ...r, [key]: val } : r));
  }
  function removeRow(i) {
    setMappings(m => m.filter((_, idx) => idx !== i));
  }

  // Quick-add from unresolved list
  function quickAdd(fnVal) {
    if (mappings.find(m => m.function_value === fnVal)) return;
    setMappings(m => [...m, { function_value: fnVal, cm_type_name: '', match_mode: 'exact', priority: 0 }]);
  }

  return (
    <div style={{ display: 'flex', gap: 0, height: '100%' }}>
      {/* Config list */}
      <div style={{ width: 220, flexShrink: 0, borderRight: '0.5px solid var(--color-border-tertiary)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>Configs</span>
          <Btn onClick={createNew} disabled={busy}><i className="ti ti-plus" /></Btn>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {functionMaps.map(fm => (
            <div key={fm.id} onClick={() => selectConfig(fm.id)}
              style={{ padding: '7px 10px', cursor: 'pointer', borderBottom: '0.5px solid var(--color-border-tertiary)',
                background: selected === fm.id ? '#EEEDFE' : 'transparent' }}>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{fm.name}</div>
            </div>
          ))}
          {functionMaps.length === 0 && <div style={{ padding: 10, fontSize: 12, color: 'var(--color-text-secondary)' }}>No configs yet.</div>}
        </div>

        {/* Unresolved quick-add */}
        {unresolved.length > 0 && (
          <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '6px 10px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#92400E', marginBottom: 4 }}>
              Unresolved ({unresolved.length})
            </div>
            {unresolved.map(u => (
              <div key={u.function_val} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '2px 0', fontSize: 11 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>{u.function_val}</span>
                <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{u.tag_count}</span>
                {selected && (
                  <button onClick={() => quickAdd(u.function_val)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#0C447C', padding: '0 2px' }}>
                    +
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mapping table */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '10px 14px', gap: 10 }}>
        {!selected ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 20 }}>Select or create a function mapping config.</div>
        ) : (
          <>
            {assigned && (
              <div style={{ display: 'flex', gap: 10, padding: '6px 10px', background: '#D1FAE5',
                  border: '1px solid #86EFAC', borderRadius: 6, fontSize: 12 }}>
                <Tag text={`${assigned.auto} auto-assigned`} color="green" />
                <Tag text={`${assigned.unresolved} unresolved`} color="yellow" />
                <Tag text={`${assigned.skipped} skipped (manual)`} color="gray" />
              </div>
            )}

            <div style={{ flex: 1, overflowY: 'auto', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--color-background-secondary)' }}>
                    {['Function Value', 'CM Type', 'Match Mode', 'Priority', ''].map(h => (
                      <th key={h} style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 500, fontSize: 11,
                          color: 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-secondary)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '3px 6px' }}>
                        <input value={m.function_value} onChange={e => updateRow(i, 'function_value', e.target.value.toUpperCase())}
                          placeholder="e.g. MOTOR" style={{ ...inputSx, width: 130, fontFamily: 'var(--font-mono)' }} />
                      </td>
                      <td style={{ padding: '3px 6px' }}>
                        <select value={m.cm_type_name} onChange={e => updateRow(i, 'cm_type_name', e.target.value)}
                          style={{ ...inputSx, width: 200 }}>
                          <option value="">— pick type —</option>
                          {(compositeCmTypes || []).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '3px 6px' }}>
                        <select value={m.match_mode || 'exact'} onChange={e => updateRow(i, 'match_mode', e.target.value)}
                          style={{ ...inputSx, width: 100 }}>
                          {['exact', 'prefix', 'contains', 'regex'].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '3px 6px' }}>
                        <input type="number" value={m.priority || 0} onChange={e => updateRow(i, 'priority', parseInt(e.target.value))}
                          style={{ ...inputSx, width: 60 }} />
                      </td>
                      <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                        <button onClick={() => removeRow(i)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
                          <i className="ti ti-x" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <Btn onClick={addRow}><i className="ti ti-plus" /> Add mapping</Btn>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn onClick={saveMappings} disabled={busy}>
                  <i className="ti ti-device-floppy" /> Save
                </Btn>
                <Btn primary onClick={runAssign} disabled={busy || !importId}>
                  <i className="ti ti-player-play" /> Run Assignment
                </Btn>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 5 — REVIEW
// ═══════════════════════════════════════════════════════════════════════════════
function TabReview({ importId, projectId, cmtProfiles, onPromoted, setError }) {
  const [data, setData]         = useState({ tags: [], total: 0, page: 1, perPage: 100, pages: 1 });
  const [filter, setFilter]     = useState('all');
  const [search, setSearch]     = useState('');
  const [busy, setBusy]         = useState(false);
  const [editId, setEditId]     = useState(null);

  const load = useCallback(async (page = 1) => {
    if (!importId) return;
    setBusy(true);
    try {
      const params = { page, per: 100 };
      if (filter !== 'all') params.status = filter;
      if (search) params.search = search;
      const r = await getIOTags(importId, params);
      setData(r);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, [importId, filter, search]);

  useEffect(() => { load(1); }, [load]);

  async function override(tag, field, value) {
    try {
      const body = field === 'assigned_cm_type'
        ? { assigned_cm_type: value, assignment_status: 'manual_override' }
        : { assignment_status: value };
      await patchIOTag(importId, tag.id, body);
      setEditId(null);
      load(data.page);
    } catch (e) { setError(e.message); }
  }

  async function reject(tag) {
    try {
      await rejectIOTag(importId, tag.id);
      setEditId(null);
      load(data.page);
    } catch (e) { setError(e.message); }
  }

  async function approveAll() {
    setBusy(true);
    try { await approveAllIOTags(importId); load(1); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function promote() {
    if (!confirm('Promote all approved/auto-assigned tags to project instances?')) return;
    setBusy(true);
    try {
      const r = await promoteIOImport(importId, projectId);
      alert(`Promoted ${r.instances} instances, ${r.folders} hierarchy folders${r.userProjects ? `, ${r.userProjects} AS assignments` : ''}.`);
      onPromoted();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const statCounts = {
    all:             data.total,
    auto:            data.tags.filter(t => t.assignment_status === 'auto').length,
    unresolved:      data.tags.filter(t => t.assignment_status === 'unresolved').length,
    manual_override: data.tags.filter(t => t.assignment_status === 'manual_override').length,
    approved:        data.tags.filter(t => t.assignment_status === 'approved').length,
  };

  const colGrid = '36px 1fr 140px 160px 80px 48px 100px';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
        {/* Status filter pills */}
        {[
          { key: 'all',             label: 'All' },
          { key: 'auto',            label: 'Auto', color: 'green' },
          { key: 'approved',        label: 'Approved', color: 'green' },
          { key: 'manual_override', label: 'Manual', color: 'blue' },
          { key: 'unresolved',      label: 'Unresolved', color: 'yellow' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            style={{ padding: '3px 12px', borderRadius: 14, border: '1px solid var(--color-border-secondary)',
              fontSize: 11, cursor: 'pointer', fontWeight: filter === f.key ? 600 : 400,
              background: filter === f.key ? 'var(--color-text-primary)' : 'transparent',
              color: filter === f.key ? 'var(--color-background-primary)' : 'var(--color-text-secondary)' }}>
            {f.label}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search instrument or hierarchy…"
          style={{ ...inputSx, width: 200 }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn onClick={approveAll} disabled={busy}>
            <i className="ti ti-checks" /> Approve all auto
          </Btn>
          <Btn primary onClick={promote} disabled={busy || !importId}>
            <i className="ti ti-arrow-right" /> Promote to Project →
          </Btn>
          <a href={ioExportUrl(importId)} download style={{ textDecoration: 'none' }}>
            <Btn><i className="ti ti-download" /> Export CSV</Btn>
          </a>
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'hidden', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6 }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: colGrid, padding: '5px 10px',
            background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
          {['#', 'Instrument', 'Assigned Type', 'Hierarchy', 'Assignment', 'IO', 'Status'].map(h => (
            <div key={h} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        <div style={{ overflowY: 'auto', height: 'calc(100% - 32px)' }}>
          {busy && data.tags.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--color-text-secondary)' }}>Loading…</div>
          )}
          {data.tags.map((tag, idx) => {
            const isEdit = editId === tag.id;
            return (
              <div key={tag.id}
                style={{ display: 'grid', gridTemplateColumns: colGrid, padding: '5px 10px',
                  alignItems: 'center', borderBottom: '0.5px solid var(--color-border-tertiary)',
                  background: isEdit ? '#EEEDFE' : tag.assignment_status === 'unresolved' ? '#FFFBEB' : 'transparent',
                  cursor: 'pointer' }}
                onClick={() => setEditId(isEdit ? null : tag.id)}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {tag.row_number}
                </div>
                <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tag.identity || <span style={{ color: 'var(--color-text-secondary)' }}>(empty)</span>}
                </div>
                <div onClick={e => e.stopPropagation()}>
                  {isEdit ? (
                    <select value={tag.assigned_cm_type || ''}
                      onChange={e => override(tag, 'assigned_cm_type', e.target.value)}
                      style={{ ...inputSx, width: '100%', fontSize: 11 }}>
                      <option value="">— unassigned —</option>
                      {cmtProfiles.map(p => <option key={p.id} value={p.id}>{p.cmType}</option>)}
                    </select>
                  ) : (
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)',
                        color: tag.assigned_cm_type ? 'var(--color-text-primary)' : '#92400E' }}>
                      {tag.assigned_cm_type || '—'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-secondary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tag.node_name || tag.hierarchy || ''}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-secondary)',
                    fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tag.assignment || '—'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                  {tag.io_count ?? 1}
                </div>
                <div onClick={e => e.stopPropagation()}>
                  {isEdit ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button title="Approve" onClick={() => override(tag, 'assignment_status', 'approved')}
                        style={{ background: '#D1FAE5', border: 'none', borderRadius: 4, padding: '2px 7px',
                          cursor: 'pointer', fontSize: 11, color: '#065F46' }}>✓</button>
                      <button title="Reject & remove from project" onClick={() => reject(tag)}
                        style={{ background: '#FEE2E2', border: 'none', borderRadius: 4, padding: '2px 7px',
                          cursor: 'pointer', fontSize: 11, color: '#991B1B' }}>✕</button>
                    </div>
                  ) : (
                    <Tag text={tag.assignment_status || 'pending'} color={STATUS_COLOR[tag.assignment_status] || 'gray'} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <Btn onClick={() => load(data.page - 1)} disabled={data.page <= 1 || busy}>‹ Prev</Btn>
        <span>Page {data.page} of {data.pages} · {data.total} total tags</span>
        <Btn onClick={() => load(data.page + 1)} disabled={data.page >= data.pages || busy}>Next ›</Btn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function StepIOImport({ savedProjectId, cmtProfiles, compositeCmTypes, onPromoted, setError }) {
  const [tab, setTab]                   = useState('upload');
  const [imports, setImports]           = useState([]);
  const [selectedImportId, setSelectedImportId] = useState(null);
  const [allHeaders, setAllHeaders]     = useState([]);      // all columns from the selected import
  const [activeHeaders, setActiveHeaders] = useState(null); // Set of user-selected column names
  const [columnMaps, setColumnMaps]     = useState([]);
  const [functionMaps, setFunctionMaps] = useState([]);

  const loadImports = useCallback(async () => {
    if (!savedProjectId) return;
    try { setImports(await listIOImports(savedProjectId)); } catch (_) {}
  }, [savedProjectId]);

  // Reload headers whenever the selected import changes
  useEffect(() => {
    if (!selectedImportId) { setAllHeaders([]); setActiveHeaders(null); return; }
    getIOHeaders(selectedImportId)
      .then(r => {
        const headers = r.headers || [];
        setAllHeaders(headers);
        // Only reset selection if we don't already have one for this import
        setActiveHeaders(prev => prev === null ? new Set(headers) : prev);
      })
      .catch(() => {});
  }, [selectedImportId]);

  const loadColumnMaps = useCallback(async () => {
    try { setColumnMaps(await getIOColumnMaps()); } catch (_) {}
  }, []);

  const loadFunctionMaps = useCallback(async () => {
    try { setFunctionMaps(await getIOFunctionMaps()); } catch (_) {}
  }, []);

  useEffect(() => {
    loadImports();
    loadColumnMaps();
    loadFunctionMaps();
  }, [loadImports, loadColumnMaps, loadFunctionMaps]);

  function handleImported(id, { preserveHeaders = false } = {}) {
    if (!preserveHeaders) setActiveHeaders(null);
    setSelectedImportId(id);
    loadImports();
  }

  async function handleDeleteImport(id, fileName) {
    if (!confirm(`Delete import "${fileName}" and all its data?`)) return;
    try {
      await deleteIOImport(id);
      if (selectedImportId === id) {
        setSelectedImportId(null);
        setActiveHeaders(null);
      }
      loadImports();
    } catch (e) { setError(e.message); }
  }

  if (!savedProjectId) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
        Select or create a project first (Step 1 — Projects).
      </div>
    );
  }

  const tabProps = {
    importId: selectedImportId,
    projectId: savedProjectId,
    cmtProfiles,
    compositeCmTypes: compositeCmTypes || [],
    columnMaps,
    functionMaps,
    allHeaders,
    activeHeaders,
    onActiveHeadersChange: setActiveHeaders,
    onTabChange: setTab,
    setError,
    onColumnMapsChange: loadColumnMaps,
    onFunctionMapsChange: loadFunctionMaps,
    onPromoted: () => { loadImports(); onPromoted(); },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)', minHeight: 400 }}>
      {/* Sub-tab bar */}
      <SubTabs tab={tab} setTab={setTab} importReady={!!selectedImportId} />

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', border: '0.5px solid var(--color-border-tertiary)',
          borderTop: 'none', borderRadius: '0 0 8px 8px', padding: 12 }}>
        {tab === 'upload' && (
          <TabUpload {...tabProps} imports={imports}
            onImported={handleImported}
            onSelectImport={id => { setSelectedImportId(id); }}
            onDeleteImport={handleDeleteImport}
            selectedImportId={selectedImportId} />
        )}
        {tab === 'colmap' && (
          <TabColumnMap {...tabProps} />
        )}
        {tab === 'hierarchy' && (
          <TabHierarchy {...tabProps} />
        )}
        {tab === 'fnmap' && (
          <TabFunctionMap {...tabProps} />
        )}
        {tab === 'review' && (
          <TabReview {...tabProps} />
        )}
      </div>
    </div>
  );
}
