// StepIOImport.jsx — Full IO List import pipeline
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import {
  uploadIOList, reimportIOList, listIOImports, deleteIOImport,
  getIOHeaders, getIOPreview, getIOTags, patchIOTag, approveAllIOTags, rejectIOTag,
  getIOColumnMaps, createIOColumnMap, updateIOColumnMap, deleteIOColumnMap, applyIOColumnMap,
  setIOSourceColumnMap,
  getIOColumnPrefs, saveIOColumnPrefs,
  getIOFunctionMaps, createIOFunctionMap, deleteIOFunctionMap,
  getIOFunctionMapMappings, saveIOFunctionMapMappings,
  buildIOHierarchy, getIOHierarchy, getIOHierarchyLevels,
  runIOAssignment, getIOUnresolvedFunctions,
  getIOValidationReport, promoteIOImport, ioExportUrl, executeWorkflowStream,
} from './api.js';
import UnifiedColumnMappingScreen from './UnifiedColumnMappingScreen.jsx';
import './InstancesGrid.css';

ModuleRegistry.registerModules([AllCommunityModule]);

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
  { key: 'fnmap',    label: 'Function Mapping', icon: 'ti-arrow-right-circle' },
  { key: 'upload',   label: 'Upload',          icon: 'ti-upload' },
  { key: 'colmap',   label: 'Column Mapping',  icon: 'ti-columns' },
  { key: 'hierarchy',label: 'Hierarchy',        icon: 'ti-sitemap' },
  { key: 'review',   label: 'Review',           icon: 'ti-checklist' },
  { key: 'workflow', label: 'Auto Workflow',    icon: 'ti-rocket' },
];

function SubTabs({ tab, setTab, importReady }) {
  return (
    <div style={{ display: 'flex', gap: '1.5rem', paddingBottom: '1.25rem', paddingX: '1.5rem',
        borderBottom: '1px solid #E5E7EB', background: '#FAFAFA', paddingTop: '1.25rem' }}>
      {IO_TABS.map((t, i) => {
        // Upload (index 1) and Function Mapping (index 0) are always enabled
        // Other tabs require an import to be ready
        const disabled = !['fnmap', 'upload'].includes(t.key) && !importReady;
        const active   = tab === t.key;
        return (
          <button key={t.key} onClick={() => !disabled && setTab(t.key)} disabled={disabled}
            style={{
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: active ? 600 : 500,
              color: disabled ? '#D1D5DB'
                   : active   ? '#4F46E5'
                              : '#6B7280',
              borderBottom: active ? '2px solid #4F46E5' : '2px solid transparent',
              paddingBottom: '0.5rem',
              display: 'flex',
              alignItems: 'center',
              transition: 'all 0.2s ease',
              fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
            }}>
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
  const [availSheets, setAvailSheets] = useState([]);  // sheets from current file
  const [selSheet, setSelSheet]   = useState('');
  const [selColMap, setSelColMap] = useState('');

  // Load preview data when an import is selected from the list
  useEffect(() => {
    if (!selectedImportId) {
      setPreview(null);
      return;
    }
    (async () => {
      try {
        const headerResp = await getIOHeaders(selectedImportId);
        const headers_ = headerResp.headers || [];
        const previewResp = await getIOPreview(selectedImportId);
        setPreview({
          importId: selectedImportId,
          headers: headers_,
          preview: previewResp.preview || [],
          totalRows: previewResp.totalRows || 0,
        });
      } catch (_) {
        setPreview(null);
      }
    })();
  }, [selectedImportId]);

  async function handleFile(f) {
    if (!f) return;
    setPreview(null);
    setBusy(true);
    try {
      const r = await uploadIOList(projectId, f, selSheet || null, selColMap || null);
      setAvailSheets(r.sheets || []);
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
    <div style={{ display: 'flex', gap: '1.5rem', height: '100%', padding: '1.5rem' }}>
      {/* Left: existing imports list */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0 0 1rem 0', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: '#6B7280', marginBottom: '0.5rem' }}>
          Recent Imports
        </div>
        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {imports.length === 0 && (
            <div style={{ padding: '1rem', fontSize: '0.875rem', color: '#9CA3AF', textAlign: 'center', backgroundColor: '#F9FAFB', borderRadius: '0.75rem', border: '1px solid #E5E7EB' }}>
              No imports yet.
            </div>
          )}
          {imports.map(imp => (
            <div key={imp.id} onClick={() => onSelectImport(imp.id)}
              style={{
                padding: '1rem',
                cursor: 'pointer',
                background: imp.id === selectedImportId ? '#EEF2FF' : '#FFFFFF',
                border: imp.id === selectedImportId ? '1px solid #4F46E5' : '1px solid #E5E7EB',
                borderRadius: '0.75rem',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                transition: 'all 0.2s ease',
                boxShadow: imp.id === selectedImportId ? '0 1px 3px rgba(0,0,0,0.1)' : '0 1px 2px rgba(0,0,0,0.05)'
              }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 500, fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#111827' }}>
                  {imp.file_name}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#6B7280', marginTop: '0.375rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span>{imp.total_tags ?? imp.total_rows ?? '?'} tags</span>
                  <Tag text={imp.status} color={imp.status === 'promoted' ? 'green' : 'gray'} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    setReimportId(imp.id);
                    onSelectImport(imp.id);
                    reimportRef.current.value = '';
                    reimportRef.current.click();
                  }}
                  title="Reimport — replace with new file"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0.375rem',
                    color: '#9CA3AF',
                    flexShrink: 0,
                    lineHeight: 1,
                    transition: 'color 0.2s ease',
                    fontSize: '1rem'
                  }}
                  onMouseEnter={(e) => e.target.style.color = '#4F46E5'}
                  onMouseLeave={(e) => e.target.style.color = '#9CA3AF'}>
                  <i className="ti ti-refresh" />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onDeleteImport(imp.id, imp.file_name); }}
                  title="Delete import"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0.375rem',
                    color: '#9CA3AF',
                    flexShrink: 0,
                    lineHeight: 1,
                    transition: 'color 0.2s ease',
                    fontSize: '1rem'
                  }}
                  onMouseEnter={(e) => e.target.style.color = '#EF4444'}
                  onMouseLeave={(e) => e.target.style.color = '#9CA3AF'}>
                  <i className="ti ti-trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: upload form + preview */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.5rem', overflowY: 'auto' }}>
        {/* Options row */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: '0.75rem', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6B7280', display: 'block', marginBottom: '0.5rem' }}>Column mapping config</label>
            <select value={selColMap} onChange={e => setSelColMap(e.target.value)} style={{
              padding: '0.625rem 0.75rem',
              borderRadius: '0.5rem',
              fontSize: '0.875rem',
              fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
              background: '#FFFFFF',
              color: '#111827',
              border: '1px solid #D1D5DB',
              width: '200px',
              cursor: 'pointer',
              appearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236B7280' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 0.75rem center',
              paddingRight: '2rem',
              transition: 'border-color 0.2s ease'
            }}
            onFocus={(e) => e.target.style.borderColor = '#4F46E5'}
            onBlur={(e) => e.target.style.borderColor = '#D1D5DB'}>
              <option value="">(auto-detect)</option>
              {columnMaps.map(cm => <option key={cm.id} value={cm.id}>{cm.name}</option>)}
            </select>
          </div>
          {availSheets.length > 1 && (
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6B7280', display: 'block', marginBottom: '0.5rem' }}>Sheet to import</label>
              <select value={selSheet} onChange={e => setSelSheet(e.target.value)} style={{
                padding: '0.625rem 0.75rem',
                borderRadius: '0.5rem',
                fontSize: '0.875rem',
                fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                background: '#FFFFFF',
                color: '#111827',
                border: '1px solid #D1D5DB',
                width: '200px',
                cursor: 'pointer',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236B7280' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 0.75rem center',
                paddingRight: '2rem',
                transition: 'border-color 0.2s ease'
              }}
              onFocus={(e) => e.target.style.borderColor = '#4F46E5'}
              onBlur={(e) => e.target.style.borderColor = '#D1D5DB'}>
                <option value="">(first sheet)</option>
                {availSheets.map(sheet => (
                  <option key={sheet} value={sheet}>{sheet}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Drop zone */}
        <div
          style={{
            border: '2px dashed #C7D2FE',
            borderRadius: '1rem',
            padding: '3rem 2rem',
            textAlign: 'center',
            cursor: 'pointer',
            background: busy ? '#F0F4FF' : '#FAFAFA',
            transition: 'all 0.2s ease'
          }}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.style.background = '#EEF2FF';
            e.currentTarget.style.borderColor = '#4F46E5';
          }}
          onDragLeave={(e) => {
            e.currentTarget.style.background = busy ? '#F0F4FF' : '#FAFAFA';
            e.currentTarget.style.borderColor = '#C7D2FE';
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.style.background = busy ? '#F0F4FF' : '#FAFAFA';
            e.currentTarget.style.borderColor = '#C7D2FE';
            handleFile(e.dataTransfer.files[0]);
          }}>
          <div style={{
            width: '3.5rem',
            height: '3.5rem',
            background: '#EEF2FF',
            borderRadius: '0.75rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem auto'
          }}>
            <i className="ti ti-file-spreadsheet" style={{ fontSize: '1.75rem', color: '#4F46E5' }} />
          </div>
          <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827' }}>
            {busy ? 'Parsing…' : 'Drop IO List Excel here'}
          </div>
          <div style={{ fontSize: '0.875rem', color: '#6B7280', marginTop: '0.5rem' }}>
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
                  Showing all {preview.totalRows} rows
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
const INTERNAL_FIELDS = ['instrument_tag', 'function_val', 'hierarchy', 'assignment'];
const INTERNAL_FIELD_LABELS = {
  instrument_tag:  'Instrument Tag',
  function_val:    'Function',
  hierarchy:       'Hierarchy',
  assignment:      'AS Assignment',
};
const INTERNAL_FIELD_DESCRIPTIONS = {
  instrument_tag:  'CM identity — groups IO rows into one instance',
  function_val:    'Maps to CM type for instance creation',
  hierarchy:       'Full path (e.g., Area/Cell/Unit) — determines folder structure',
  assignment:      'AS assignment (e.g., AS01) — maps to user_project',
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
    // Auto-suggest mappings for new config if headers exist
    const suggestions = {};
    if (detectedHeaders.length > 0) {
      detectedHeaders.forEach(h => {
        const suggested = suggestColumnMapping(h);
        if (suggested) suggestions[h] = suggested;
      });
    }
    setDraft({ name: 'New Config', description: '', mappings: suggestions });
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

  const setMapping = (field, header) => {
    // Update mapping: remove old column for this field, add new one if specified
    const newMappings = { ...draft.mappings };

    // Remove old mapping for this field (find and delete the column that mapped to this field)
    for (const [col, f] of Object.entries(newMappings)) {
      if (f === field) {
        delete newMappings[col];
        break;
      }
    }

    // Add new mapping if a column was selected
    if (header) {
      newMappings[header] = field;
    }

    setDraft(d => ({ ...d, mappings: newMappings }));
  };

  // Only show columns the user selected on the Upload tab
  const visibleHeaders = activeHeaders
    ? detectedHeaders.filter(h => activeHeaders.has(h))
    : detectedHeaders;

  // Invert mappings for display: field → column
  const fieldToColumn = draft ? {} : {};
  if (draft) {
    for (const [col, field] of Object.entries(draft.mappings)) {
      fieldToColumn[field] = col;
    }
  }

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

            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
              Map Internal Fields to Columns
            </div>

            {/* New layout: internal fields on left (fixed), columns on right (dropdown) */}
            <div style={{ border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
                  background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                <div style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                  Internal Field
                </div>
                <div style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-secondary)', borderLeft: '0.5px solid var(--color-border-tertiary)' }}>
                  Customer Column
                </div>
              </div>

              {INTERNAL_FIELDS.map((field, idx) => (
                <div key={field} style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr',
                  borderBottom: idx < INTERNAL_FIELDS.length - 1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
                  minHeight: 80 }}>

                  {/* Left: internal field info (fixed) */}
                  <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4, borderRight: '0.5px solid var(--color-border-tertiary)' }}>
                    <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                      {field}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
                      {INTERNAL_FIELD_DESCRIPTIONS[field]}
                    </div>
                  </div>

                  {/* Right: dropdown to select column */}
                  <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center' }}>
                    <select
                      value={fieldToColumn[field] || ''}
                      onChange={e => setMapping(field, e.target.value || null)}
                      style={{ ...inputSx, flex: 1 }}>
                      <option value="">— select column —</option>
                      {visibleHeaders.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}

              {visibleHeaders.length === 0 && (
                <div style={{ padding: '12px', fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                  {detectedHeaders.length === 0
                    ? 'Upload a file first to see detected columns.'
                    : 'No columns selected. Enable columns on the Upload tab.'}
                </div>
              )}
            </div>

            {/* Show unmapped columns as info */}
            {visibleHeaders.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '8px 12px', background: 'var(--color-background-secondary)', borderRadius: 6 }}>
                <strong>Unmapped columns:</strong> {visibleHeaders.filter(h => !Object.values(fieldToColumn).includes(h)).join(', ') || '(all mapped)'}
              </div>
            )}

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

// Helper: fuzzy-match column name to internal field using similarity scoring
function suggestColumnMapping(columnName) {
  const ALIASES = {
    instrument_tag: ['instrument', 'instrumenttag', 'instrument_tag', 'cm_tag', 'cmtag', 'device', 'device_tag', 'tag_id', 'kks', 'tag', 'tagname'],
    function_val:   ['function', 'func', 'type', 'instrument_type', 'iotype', 'category'],
    hierarchy:      ['hierarchy', 'path', 'location', 'hierarchy_path', 'plant_path', 'structure', 'plant_structure', 'plant_hierarchy'],
    assignment:     ['assignment', 'as', 'as_assignment', 'controller', 'plc', 'cpu', 'station', 'as01', 'as_station'],
  };

  const norm = columnName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let bestField = null, bestScore = 0;

  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const aliasNorm = alias.replace(/[^a-z0-9]/g, '');
      const score = diceSimilarity(norm, aliasNorm);
      if (score > bestScore && score >= 0.6) {
        bestScore = score;
        bestField = field;
      }
    }
  }
  return bestField;
}

function diceSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aGrams) {
    if (bGrams.has(bg)) intersection += Math.min(count, bGrams.get(bg));
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
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

function TabHierarchy({ importId, projectId, functionMaps, onPromoted, setError }) {
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
    if (!confirm('Run Assignment and Promote to Instances and Hierarchy tabs?')) return;
    setBusy(true);
    try {
      // Run assignment for all function map configs
      for (const fm of (functionMaps || [])) {
        try {
          await runIOAssignment(importId, fm.id);
        } catch (e) {
          console.warn(`Assignment for config ${fm.id} failed:`, e);
        }
      }
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

  async function selectConfig(id) {
    setSelected(id);
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

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start', alignItems: 'center', flexShrink: 0 }}>
              <Btn onClick={addRow}><i className="ti ti-plus" /> Add mapping</Btn>
              <Btn onClick={saveMappings} disabled={busy}>
                <i className="ti ti-device-floppy" /> Save
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 5 — REVIEW  (AG Grid — mirrors the catalogue grid structure)
// ═══════════════════════════════════════════════════════════════════════════════

// Assigned Type cell — always-visible dropdown of composite CM types (same list
// the Function Mapping tab offers). Assignments store the composite *name*.
function AssignedTypeCell({ data, compositeCmTypes, onOverride }) {
  const current = data.assigned_cm_type || '';
  const isKnown = current === '' || (compositeCmTypes || []).some(c => c.name === current);
  return (
    <select
      value={current}
      onChange={e => onOverride(data, 'assigned_cm_type', e.target.value)}
      title="Assign composite CM type"
      style={{ width: '100%', fontSize: 11, padding: '2px 4px', fontFamily: 'var(--font-mono)',
        border: `1px solid ${current ? '#c8d4f0' : '#f0c88a'}`, borderRadius: 4,
        background: current ? 'var(--color-background-primary)' : '#FFFBEB',
        color: current ? 'var(--color-text-primary)' : '#92400E', cursor: 'pointer' }}
    >
      <option value="">— unassigned —</option>
      {!isKnown && <option value={current}>{current}</option>}
      {(compositeCmTypes || []).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
    </select>
  );
}

// Actions cell — approve / reject buttons, always visible.
function ReviewActionsCell({ data, onOverride, onReject }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}>
      <button title="Approve" onClick={e => { e.stopPropagation(); onOverride(data, 'assignment_status', 'approved'); }}
        style={{ background: '#D1FAE5', border: 'none', borderRadius: 4, padding: '2px 7px',
          cursor: 'pointer', fontSize: 11, color: '#065F46' }}>✓</button>
      <button title="Reject & remove from project" onClick={e => { e.stopPropagation(); onReject(data); }}
        style={{ background: '#FEE2E2', border: 'none', borderRadius: 4, padding: '2px 7px',
          cursor: 'pointer', fontSize: 11, color: '#991B1B' }}>✕</button>
    </div>
  );
}

function TabReview({ importId, projectId, cmtProfiles, compositeCmTypes = [], onPromoted, setError }) {
  const gridRef = useRef(null);
  const [data, setData]         = useState({ tags: [], total: 0, page: 1, perPage: 100, pages: 1 });
  const [filter, setFilter]     = useState('all');
  const [search, setSearch]     = useState('');
  const [busy, setBusy]         = useState(false);

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

  const override = useCallback(async (tag, field, value) => {
    try {
      const body = field === 'assigned_cm_type'
        ? { assigned_cm_type: value, assignment_status: 'manual_override' }
        : { assignment_status: value };
      await patchIOTag(importId, tag.id, body);
      load(data.page);
    } catch (e) { setError(e.message); }
  }, [importId, data.page, load, setError]);

  const reject = useCallback(async (tag) => {
    try {
      await rejectIOTag(importId, tag.id);
      load(data.page);
    } catch (e) { setError(e.message); }
  }, [importId, data.page, load, setError]);

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

  const theme = useMemo(
    () => themeQuartz.withParams({
      fontSize: 12, rowHeight: 36, headerHeight: 36,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      accentColor: '#0C447C', browserColorScheme: 'light',
    }),
    []
  );

  const defaultColDef = useMemo(() => ({
    sortable: true, resizable: true, suppressMovable: false,
  }), []);

  const columnDefs = useMemo(() => [
    {
      headerName: '#', colId: 'rowNumber', width: 60, maxWidth: 60, pinned: 'left',
      sortable: false, filter: false, resizable: false,
      valueGetter: p => p.data.row_number ?? (p.node.rowIndex + 1),
      cellStyle: { textAlign: 'center', fontWeight: 500, color: '#6b7280', fontFamily: 'ui-monospace, monospace' },
    },
    {
      headerName: 'Instrument', field: 'identity',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 2,
      cellStyle: { fontFamily: 'ui-monospace, monospace', fontWeight: 500 },
      valueGetter: p => p.data.identity || '',
    },
    {
      headerName: 'Assigned Type', field: 'assigned_cm_type',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 1.5,
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: p => (
        <AssignedTypeCell data={p.data} compositeCmTypes={compositeCmTypes} onOverride={override} />
      ),
    },
    {
      headerName: 'Hierarchy', field: 'hierarchy',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 140, flex: 1.5,
      cellStyle: { color: 'var(--color-text-secondary)' },
      // Prefer the raw imported hierarchy path; fall back to the built node name.
      valueGetter: p => p.data.hierarchy || p.data.node_name || '',
    },
    {
      headerName: 'Assignment', field: 'assignment',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 110, flex: 1,
      cellStyle: { color: 'var(--color-text-secondary)', fontFamily: 'ui-monospace, monospace' },
      valueGetter: p => p.data.assignment || '',
    },
    {
      headerName: 'IO', field: 'io_count',
      filter: 'agNumberColumnFilter', floatingFilter: true, width: 80, maxWidth: 90,
      cellStyle: { textAlign: 'center', color: 'var(--color-text-secondary)' },
      valueGetter: p => p.data.io_count ?? 1,
    },
    {
      headerName: 'Status', field: 'assignment_status',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 110, flex: 1,
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: p => (
        <Tag text={p.value || 'pending'} color={STATUS_COLOR[p.value] || 'gray'} />
      ),
    },
    {
      headerName: '', colId: 'actions', sortable: false, filter: false, resizable: false,
      width: 90, maxWidth: 90, pinned: 'right',
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
      cellRenderer: p => (
        <ReviewActionsCell data={p.data} onOverride={override} onReject={reject} />
      ),
    },
  ], [compositeCmTypes, override, reject]);

  const getRowId = useCallback(p => String(p.data.id), []);

  const getRowStyle = useCallback(p =>
    p.data.assignment_status === 'unresolved' ? { background: '#FFFBEB' } : undefined,
  []);

  return (
    <div className="ig-root" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div className="ig-toolbar">
        {/* Status filter pills */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {[
            { key: 'all',             label: 'All' },
            { key: 'auto',            label: 'Auto' },
            { key: 'approved',        label: 'Approved' },
            { key: 'manual_override', label: 'Manual' },
            { key: 'unresolved',      label: 'Unresolved' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ padding: '3px 12px', borderRadius: 14, border: '1px solid var(--color-border-secondary)',
                fontSize: 11, cursor: 'pointer', fontWeight: filter === f.key ? 600 : 400,
                background: filter === f.key ? 'var(--color-text-primary)' : 'transparent',
                color: filter === f.key ? 'var(--color-background-primary)' : 'var(--color-text-secondary)' }}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="ig-search-wrap">
          <i className="ti ti-search ig-search-icon" aria-hidden="true" />
          <input
            className="ig-search"
            type="text"
            placeholder="Search instrument or hierarchy…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="ig-search-clear" onClick={() => setSearch('')} title="Clear search">×</button>
          )}
        </div>

        <div className="ig-toolbar-right">
          <span className="ig-count">{data.total} tag{data.total !== 1 ? 's' : ''}</span>
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

      {/* Grid */}
      <div className="ig-grid-wrap" style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact
          ref={gridRef}
          theme={theme}
          rowData={data.tags}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          getRowStyle={getRowStyle}
          quickFilterText={search}
          animateRows={false}
          pagination={false}
        />
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, fontSize: 12,
          color: 'var(--color-text-secondary)', padding: '8px 4px' }}>
        <Btn onClick={() => load(data.page - 1)} disabled={data.page <= 1 || busy}>‹ Prev</Btn>
        <span>Page {data.page} of {data.pages} · {data.total} total tags</span>
        <Btn onClick={() => load(data.page + 1)} disabled={data.page >= data.pages || busy}>Next ›</Btn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 6 — WORKFLOW (Automated single-click workflow)
// ═══════════════════════════════════════════════════════════════════════════════

function TabWorkflow({ importId, projectId, functionMaps, columnMaps, currentImport, setError, onPromoted, onColumnMapApplied }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [selectedFnMap, setSelectedFnMap] = useState('');
  const [selectedColumnMap, setSelectedColumnMap] = useState('');
  const [applyingColumnMap, setApplyingColumnMap] = useState(false);

  // Pre-flight: the workflow's Gate 1 hard-fails with a raw backend error if no
  // column map has been applied to this import yet (column_map_id is only set by
  // "Import Instances" or the Upload dropdown — just viewing a saved config in the
  // sidebar does not apply it). Surface that as an actionable step here instead.
  const needsColumnMap = !currentImport?.column_map_id;

  // Auto-select the applied column map when the import changes
  useEffect(() => {
    if (currentImport?.column_map_id && !selectedColumnMap) {
      setSelectedColumnMap(String(currentImport.column_map_id));
    }
  }, [currentImport?.column_map_id, selectedColumnMap]);

  async function handleApplyColumnMap() {
    if (!selectedColumnMap) {
      setError('Select a column mapping config first');
      return;
    }
    setApplyingColumnMap(true);
    try {
      await applyIOColumnMap(importId, parseInt(selectedColumnMap, 10));
      // Keep the selected column map visible after applying
      // selectedColumnMap state is preserved automatically
      if (onColumnMapApplied) await onColumnMapApplied();
    } catch (err) {
      setError(err.message);
    } finally {
      setApplyingColumnMap(false);
    }
  }

  async function handleStartWorkflow() {
    if (!selectedFnMap) {
      setError('Select a function mapping first');
      return;
    }
    setBusy(true);
    setProgress(null);
    setResult(null);
    try {
      const res = await executeWorkflowStream(
        { importId, projectId, functionMapId: parseInt(selectedFnMap, 10) },
        (prog) => setProgress(prog)
      );
      if (res.error) {
        setError(res.error);
      } else {
        setResult(res);
        onPromoted();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '12px 0' }}>
      {/* Introduction */}
      {!result && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, background: '#E6F1FB', color: '#0C447C', fontSize: 13,
          borderLeft: '3px solid #0C447C',
        }}>
          <strong>Automated Workflow:</strong> Chain all steps together (column mapping → hierarchy → assignment → promotion → XML generation) with a single click.
          The workflow validates each step and rolls back automatically if anything fails.
        </div>
      )}

      {/* Column map selector — always visible when not running */}
      {!progress && !result && (
        <div style={{
          padding: '12px 16px', borderRadius: 8,
          background: needsColumnMap ? '#FEF3C7' : '#D1FAE5',
          color: needsColumnMap ? '#92400E' : '#065F46',
          fontSize: 13,
          borderLeft: `3px solid ${needsColumnMap ? '#D97706' : '#059669'}`,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div>
            <strong>Column Mapping:</strong> {needsColumnMap ? 'Not applied yet.' : '✓ Applied.'} {needsColumnMap && 'Select a saved config below and apply it (equivalent to "Import Instances") before starting the workflow.'}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={selectedColumnMap}
              onChange={e => setSelectedColumnMap(e.target.value)}
              style={{ ...inputSx, flex: 1, maxWidth: 300 }}
              disabled={applyingColumnMap}
            >
              <option value="">(select a column mapping config...)</option>
              {(columnMaps || []).filter(c => !String(c.name || '').startsWith('__io_instances_')).map(cm => (
                <option key={cm.id} value={cm.id}>{cm.name}</option>
              ))}
            </select>
            {needsColumnMap ? (
              <Btn
                primary
                disabled={!selectedColumnMap || applyingColumnMap}
                onClick={handleApplyColumnMap}
              >
                <i className="ti ti-check" /> {applyingColumnMap ? 'Applying…' : 'Apply Column Map'}
              </Btn>
            ) : (
              <Btn
                disabled={!selectedColumnMap || applyingColumnMap}
                onClick={handleApplyColumnMap}
              >
                <i className="ti ti-refresh" /> {applyingColumnMap ? 'Reapplying…' : 'Reapply'}
              </Btn>
            )}
          </div>
        </div>
      )}

      {/* Function map selector */}
      {!needsColumnMap && !progress && !result && (
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-secondary)' }}>
            Select Function Mapping:
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={selectedFnMap}
              onChange={e => setSelectedFnMap(e.target.value)}
              style={{ ...inputSx, flex: 1, maxWidth: 300 }}
              disabled={busy}
            >
              <option value="">(select a function mapping...)</option>
              {functionMaps.map(fm => (
                <option key={fm.id} value={fm.id}>{fm.name}</option>
              ))}
            </select>
            <Btn
              primary
              disabled={!selectedFnMap || busy}
              onClick={handleStartWorkflow}
              style={{ marginTop: 0 }}
            >
              <i className="ti ti-rocket" /> Start Workflow
            </Btn>
          </div>
        </div>
      )}

      {/* Progress indicator */}
      {progress && !result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{progress.phase}: {progress.msg}</span>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{progress.pct || 0}%</span>
            </div>
            <div style={{
              width: '100%', height: 24, borderRadius: 8, background: 'var(--color-background-secondary)',
              overflow: 'hidden', position: 'relative',
            }}>
              <div style={{
                height: '100%', width: `${progress.pct || 0}%`, background: '#6B7AFF',
                transition: 'width 0.2s ease', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 600, color: 'white',
              }}>
                {(progress.pct || 0) > 10 && `${progress.pct || 0}%`}
              </div>
            </div>
          </div>

          {/* Phase labels */}
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {[
              { name: 'validation', label: 'Validating', range: '0–10%' },
              { name: 'promoting', label: 'Promoting', range: '10–30%' },
              { name: 'hardware', label: 'Hardware & Connections', range: '30–42%' },
              { name: 'resolving', label: 'Resolving', range: '40–85%' },
              { name: 'building', label: 'Building', range: '85–95%' },
              { name: 'finalizing', label: 'Finalizing', range: '95–100%' },
            ].map(phase => (
              <div key={phase.name} style={{
                padding: '4px 8px', borderRadius: 4,
                background: progress.phase === phase.name ? '#D1FAE5' : 'transparent',
                color: progress.phase === phase.name ? '#065F46' : 'var(--color-text-secondary)',
                fontWeight: progress.phase === phase.name ? 600 : 400,
              }}>
                {phase.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Success result */}
      {result && !result.error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{
            padding: '12px 16px', borderRadius: 8, background: '#D1FAE5', color: '#065F46',
            borderLeft: '3px solid #059669', fontSize: 13, fontWeight: 500,
          }}>
            ✓ Workflow completed successfully!
          </div>

          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {result.stats && [
              { label: 'Blocks', value: result.stats.blocks },
              { label: 'Variables', value: result.stats.vars },
              { label: 'Messages', value: result.stats.msgs },
              { label: 'Links', value: result.stats.links },
              { label: 'File Size', value: `${result.stats.sizeKb} KB` },
            ].map(stat => (
              <div key={stat.label} style={{
                padding: '8px 12px', borderRadius: 6, background: 'var(--color-background-secondary)',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  {stat.label}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          {/* XML + CFG downloads */}
          {(result.xml || result.cfg) && (
            <div style={{ display: 'flex', gap: 8 }}>
              {result.xml && (
                <button
                  onClick={() => {
                    const blob = new Blob([result.xml], { type: 'application/xml' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `project_${result.auditId}.xml`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  }}
                  style={{
                    padding: '8px 16px', borderRadius: 6, background: '#059669', color: 'white',
                    border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <i className="ti ti-download" /> Download XML
                </button>
              )}
              {result.cfg && (
                <button
                  onClick={() => {
                    const blob = new Blob([result.cfg.text], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `hardware_${result.auditId}.cfg`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  }}
                  style={{
                    padding: '8px 16px', borderRadius: 6, background: '#0C447C', color: 'white',
                    border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <i className="ti ti-download" /> Download CFG
                </button>
              )}
            </div>
          )}

          {/* Hardware sync log */}
          {result.hwLog && (
            <div style={{ border: '0.5px solid var(--color-border-secondary)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{
                padding: '8px 12px', background: 'var(--color-background-secondary)', fontSize: 12, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>Hardware Sync Log</span>
                <button
                  onClick={() => {
                    const lines = [
                      `Hardware Sync Log — ${new Date().toISOString()}`,
                      `Imported (new): ${result.hwLog.imported}`,
                      `Unchanged: ${result.hwLog.unchanged}`,
                      `Skipped (modified — kept existing value): ${result.hwLog.skippedModified.length}`,
                      ...result.hwLog.skippedModified.map(s =>
                        `  station=${s.station} slot=${s.slot} tag=${s.tag || ''} changed=[${s.changedFields.join(', ')}]`),
                      `Skipped (missing — kept existing row): ${result.hwLog.skippedMissing.length}`,
                      ...result.hwLog.skippedMissing.map(s =>
                        `  station=${s.station} slot=${s.slot} tag=${s.tag || ''}`),
                    ];
                    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `hardware_sync_log_${result.auditId}.txt`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  }}
                  style={{
                    background: 'none', border: '0.5px solid var(--color-border-secondary)', borderRadius: 4,
                    padding: '2px 8px', cursor: 'pointer', fontSize: 11, color: 'var(--color-text-secondary)',
                  }}
                >
                  <i className="ti ti-download" /> Download Log
                </button>
              </div>
              <div style={{ padding: '10px 12px', fontSize: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ color: '#065F46' }}>✓ {result.hwLog.imported} imported</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{result.hwLog.unchanged} unchanged</span>
                {result.hwLog.skippedModified.length > 0 && (
                  <span style={{ color: '#92400E' }}>⚠ {result.hwLog.skippedModified.length} modified skipped (kept existing)</span>
                )}
                {result.hwLog.skippedMissing.length > 0 && (
                  <span style={{ color: '#92400E' }}>⚠ {result.hwLog.skippedMissing.length} missing skipped (kept existing)</span>
                )}
              </div>
              {(result.hwLog.skippedModified.length > 0 || result.hwLog.skippedMissing.length > 0) && (
                <div style={{ padding: '0 12px 10px', fontSize: 11, color: 'var(--color-text-secondary)', maxHeight: 140, overflowY: 'auto' }}>
                  {result.hwLog.skippedModified.map((s, i) => (
                    <div key={`m${i}`} style={{ fontFamily: 'ui-monospace, monospace', padding: '2px 0' }}>
                      modified: station {s.station} slot {s.slot} {s.tag ? `(${s.tag})` : ''} — changed: {s.changedFields.join(', ')}
                    </div>
                  ))}
                  {result.hwLog.skippedMissing.map((s, i) => (
                    <div key={`x${i}`} style={{ fontFamily: 'ui-monospace, monospace', padding: '2px 0' }}>
                      missing: station {s.station} slot {s.slot} {s.tag ? `(${s.tag})` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Connections (dummy ↔ hardware reconciliation) */}
          {result.connections && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, border: '0.5px solid var(--color-border-secondary)',
              fontSize: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center',
            }}>
              <span style={{ fontWeight: 600 }}>Connections</span>
              <span style={{ color: '#065F46' }}>✓ {result.connections.real} real</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>{result.connections.dummy} dummy</span>
              {result.connections.conflicts?.length > 0 && (
                <span style={{ color: '#991B1B' }}>⚠ {result.connections.conflicts.length} conflicts</span>
              )}
            </div>
          )}

          {/* Audit ID */}
          {result.auditId && (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Audit ID: <code style={{ fontFamily: 'ui-monospace, monospace' }}>{result.auditId}</code>
            </div>
          )}

          {/* Start new workflow button */}
          <Btn primary onClick={() => { setResult(null); setProgress(null); setSelectedFnMap(''); }}>
            <i className="ti ti-arrow-left" /> Start Another Workflow
          </Btn>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function StepIOImport({ savedProjectId, cmtProfiles, compositeCmTypes, onPromoted, setError, onImportHardware }) {
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
    (async () => {
      try {
        const r = await getIOHeaders(selectedImportId);
        const headers = r.headers || [];
        setAllHeaders(headers);
        // Load saved column preferences for this import
        try {
          const prefs = await getIOColumnPrefs(selectedImportId);
          if (prefs?.activeColumns?.length > 0) {
            setActiveHeaders(new Set(prefs.activeColumns));
            return;
          }
        } catch (_) {}
        // Fall back to all headers if no saved preferences
        setActiveHeaders(new Set(headers));
      } catch (_) {}
    })();
  }, [selectedImportId]);

  const loadColumnMaps = useCallback(async () => {
    try { setColumnMaps(await getIOColumnMaps()); } catch (_) {}
  }, []);

  const loadFunctionMaps = useCallback(async () => {
    try { setFunctionMaps(await getIOFunctionMaps()); } catch (_) {}
  }, []);

  const handleActiveHeadersChange = useCallback((next) => {
    setActiveHeaders(next);
    // Save to database if import selected
    if (selectedImportId && next instanceof Set) {
      saveIOColumnPrefs(selectedImportId, Array.from(next)).catch(err => {
        console.error('Failed to save column preferences:', err);
      });
    }
  }, [selectedImportId]);

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

  // Import Instances — apply the instance-panel mappings to the current IO import,
  // then build hierarchy and jump to the Hierarchy tab. Uses the existing
  // applyIOColumnMap flow. `instanceMappings` is { column: internal_field }.
  async function handleImportInstances(instanceMappings) {
    if (!selectedImportId) { setError('Upload an IO List first.'); return; }
    // Persist a lightweight column-map config to satisfy the apply endpoint,
    // then apply it. We create a transient config named for this import.
    const cfgName = `__io_instances_${selectedImportId}`;
    let cfgId;
    const existing = (columnMaps || []).find(c => c.name === cfgName);
    // Send mappings as a plain OBJECT — createIOColumnMap/updateIOColumnMap
    // JSON.stringify it themselves. Pre-stringifying double-encodes it, so
    // apply-column-map's JSON.parse yields a string and applyMapping writes
    // every field (hierarchy included) as null → no hierarchy is built.
    const payload = { name: cfgName, description: 'Auto-created by unified mapping', mappings: instanceMappings };
    if (existing) {
      await updateIOColumnMap(existing.id, payload);
      cfgId = existing.id;
    } else {
      const r = await createIOColumnMap(payload);
      cfgId = r.id;
    }
    await loadColumnMaps();
    await applyIOColumnMap(selectedImportId, cfgId);
    setTab('hierarchy');
  }

  // Import Hardware — hand the hardware-panel mappings up to the parent so the
  // Hardware system (StepHWConfig) can consume the same sheet. The parent wires
  // this to the HW import flow. `hardwareMappings` is { column: hw_field }.
  // `configId` is the just-saved column-map config backing this mapping — record it
  // as the import's source_column_map_id so the automated workflow can find the
  // hardware mapping later, even after "Import Instances" overwrites column_map_id.
  async function handleImportHardware(hardwareMappings, configId) {
    if (configId && selectedImportId) {
      try { await setIOSourceColumnMap(selectedImportId, configId); }
      catch (e) { setError(e.message); return; }
    }
    if (typeof onImportHardware === 'function') {
      await onImportHardware(selectedImportId, hardwareMappings);
    } else {
      setError('Hardware import handoff is not configured in this screen.');
    }
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
    onActiveHeadersChange: handleActiveHeadersChange,
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
          <UnifiedColumnMappingScreen
            projectId={savedProjectId}
            importId={selectedImportId}
            excelHeaders={activeHeaders ? allHeaders.filter(h => activeHeaders.has(h)) : allHeaders}
            onImportInstances={handleImportInstances}
            onImportHardware={handleImportHardware}
            setError={setError}
            setLoading={() => {}}
            loading={false}
          />
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
        {tab === 'workflow' && (
          <TabWorkflow
            importId={selectedImportId}
            projectId={savedProjectId}
            functionMaps={functionMaps}
            columnMaps={columnMaps}
            currentImport={imports.find(i => i.id === selectedImportId)}
            setError={setError}
            onPromoted={() => { loadImports(); onPromoted(); }}
            onColumnMapApplied={loadImports}
          />
        )}
      </div>
    </div>
  );
}
