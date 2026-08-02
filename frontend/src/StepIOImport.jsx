// StepIOImport.jsx — Full IO List import pipeline
import { useState, useEffect, useRef, useCallback, useMemo, memo, useLayoutEffect, Fragment } from 'react';
import { AgGridReact } from 'ag-grid-react';

// Register crystal-loader web component immediately.
//
// customElements.define() is one-shot per page: a name can never be redefined,
// and calling define() twice throws. That makes a naive
// `if (!customElements.get(name)) define(...)` guard invisible poison under
// Vite HMR — the first definition a tab ever sees is pinned for the life of
// that tab, and every later edit to the markup is silently skipped. You end up
// staring at old graphics that no longer exist anywhere in the source.
//
// Fix: keep define() one-shot, but have the element read its markup from this
// module-level global at render time. HMR reassigns the global, and we re-render
// live instances, so edits below actually show up without a hard reload.
const CRYSTAL_LOADER_MARKUP = `
    <style>
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--crystal-loader-size, 200px);
        height: var(--crystal-loader-size, 200px);
        background: var(--crystal-loader-bg, #17afbd);
        border-radius: var(--crystal-loader-radius, 16px);
      }
      svg { width: 100%; height: 100%; }

      @keyframes bounce { 0%, 100% { translate: 0px 36px; } 50% { translate: 0px 46px; } }
      @keyframes bounce2 { 0%, 100% { translate: 0px 46px; } 50% { translate: 0px 56px; } }
      @keyframes umbral {
        0% { stop-color: #10bcd32e; }
        50% { stop-color: #2fcad8; }
        100% { stop-color: #10d3982e; }
      }
      @keyframes partciles { 0%, 100% { translate: 0px 16px; } 50% { translate: 0px 6px; } }

      #particles { animation: partciles 4s ease-in-out infinite; }
      #animatedStop { animation: umbral 4s infinite; }
      #bounce { animation: bounce 4s ease-in-out infinite; translate: 0px 36px; }
      #bounce2 {
        animation: bounce2 4s ease-in-out infinite;
        translate: 0px 46px;
        animation-delay: 0.5s;
      }
    </style>

    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <g>
        <polygon transform="rotate(45 100 100)" stroke-width="1" stroke="#17afbd" fill="none" points="70,70 148,50 130,130 50,150" id="bounce"></polygon>
        <polygon transform="rotate(45 100 100)" stroke-width="1" stroke="#07e7fca4" fill="none" points="70,70 148,50 130,130 50,150" id="bounce2"></polygon>
        <polygon transform="rotate(45 100 100)" stroke-width="2" fill="#414750" points="70,70 150,50 130,130 50,150"></polygon>
        <polygon stroke-width="2" fill="url(#gradiente)" points="100,70 150,100 100,130 50,100"></polygon>
        <defs>
          <linearGradient y2="100%" x2="10%" y1="0%" x1="0%" id="gradiente">
            <stop style="stop-color:#1e2026;stop-opacity:1" offset="20%"></stop>
            <stop style="stop-color:#414750;stop-opacity:1" offset="60%"></stop>
          </linearGradient>
        </defs>
        <polygon transform="translate(20, 31)" stroke-width="2" fill="#227f8b" points="80,50 80,75 80,99 40,75"></polygon>
        <polygon transform="translate(20, 31)" stroke-width="2" fill="url(#gradiente2)" points="40,-40 80,-40 80,99 40,75"></polygon>
        <defs>
          <linearGradient y2="100%" x2="0%" y1="-17%" x1="10%" id="gradiente2">
            <stop style="stop-color:#1f474400;stop-opacity:1" offset="20%"></stop>
            <stop style="stop-color:#10c6d354;stop-opacity:1" offset="100%" id="animatedStop"></stop>
          </linearGradient>
        </defs>
        <polygon transform="rotate(180 100 100) translate(20, 20)" stroke-width="2" fill="#17afbd" points="80,50 80,75 80,99 40,75"></polygon>
        <polygon transform="rotate(0 100 100) translate(60, 20)" stroke-width="2" fill="url(#gradiente3)" points="40,-40 80,-40 80,85 40,110.2"></polygon>
        <defs>
          <linearGradient y2="100%" x2="10%" y1="0%" x1="0%" id="gradiente3">
            <stop style="stop-color:#10ccd300;stop-opacity:1" offset="20%"></stop>
            <stop style="stop-color:#d3a51054;stop-opacity:1" offset="100%" id="animatedStop"></stop>
          </linearGradient>
        </defs>
        <polygon transform="rotate(45 100 100) translate(80, 95)" stroke-width="2" fill="#ffffff" points="5,0 5,5 0,5 0,0" id="particles"></polygon>
        <polygon transform="rotate(45 100 100) translate(80, 55)" stroke-width="2" fill="#17afbd" points="6,0 6,6 0,6 0,0" id="particles"></polygon>
        <polygon transform="rotate(45 100 100) translate(70, 80)" stroke-width="2" fill="#17afbd" points="2,0 2,2 0,2 0,0" id="particles"></polygon>
        <polygon stroke-width="2" fill="#292d34" points="29.5,99.8 100,142 100,172 29.5,130"></polygon>
        <polygon transform="translate(50, 92)" stroke-width="2" fill="#1f2127" points="50,50 120.5,8 120.5,35 50,80"></polygon>
      </g>
    </svg>
`;

if (typeof window !== 'undefined') {
  // Latest markup always wins, even though the class below is defined once.
  window.__crystalLoaderMarkup = CRYSTAL_LOADER_MARKUP;

  if (!customElements.get('crystal-loader')) {
    class CrystalLoader extends HTMLElement {
      connectedCallback() {
        if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
        this.render();
      }
      render() {
        if (this.shadowRoot) this.shadowRoot.innerHTML = window.__crystalLoaderMarkup;
      }
    }
    customElements.define('crystal-loader', CrystalLoader);
  } else {
    // Already defined by an earlier version of this module in this tab:
    // repaint any live instances with the new markup.
    document.querySelectorAll('crystal-loader').forEach(el => el.render?.());
  }
}
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import {
  uploadIOList, reimportIOList, listIOImports, deleteIOImport,
  getIOHeaders, getIOPreview, getIOTags, patchIOTag, approveAllIOTags, rejectIOTag,
  getIOColumnMaps, createIOColumnMap, updateIOColumnMap, deleteIOColumnMap, applyIOColumnMap,
  setIOSourceColumnMap,
  getIOColumnPrefs, saveIOColumnPrefs,
  getIOFunctionMaps, createIOFunctionMap, updateIOFunctionMap, deleteIOFunctionMap,
  getIOFunctionMapMappings, saveIOFunctionMapMappings,
  buildIOHierarchy, getIOHierarchy, getIOHierarchyLevels,
  runIOAssignment, getIOUnresolvedFunctions,
  getIOValidationReport, promoteIOImport, ioExportUrl, executeWorkflowStream,
} from './api.js';
import UnifiedColumnMappingScreen from './UnifiedColumnMappingScreen.jsx';
import './InstancesGrid.css';

// Presentational primitives and the glass-radio CSS live in ImportUIKit so the
// EPH/EM import can render the same surface without duplicating them.
import {
  GLIDER_FALLBACK_H, GLIDER_GAP,
  Btn, SLabel, PanelHeading, EmptyState, Callout, StatTile, Tag, Switch,
  panelSx, glassPanelSx, panelHeaderSx, glassPanelHeaderSx,
  ROW_SELECTED_BG, CALLOUT_TONES, STATUS_COLOR,
  inputSx, textInputSx, eyebrowLabelSx,
} from './ImportUIKit.jsx';

ModuleRegistry.registerModules([AllCommunityModule]);


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
    <div style={{ display: 'flex', borderBottom: '0.5px solid var(--color-border-tertiary)',
        marginBottom: '1rem', flexShrink: 0 }}>
      {IO_TABS.map(t => {
        const disabled = !['fnmap', 'upload'].includes(t.key) && !importReady;
        const active   = tab === t.key;
        return (
          <button key={t.key} onClick={() => !disabled && setTab(t.key)} disabled={disabled}
            title={disabled ? 'Select or upload an IO list first' : undefined}
            style={{
              padding: '7px 18px', border: 'none', background: 'transparent',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: '1rem', fontWeight: active ? 600 : 400,
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              opacity: disabled ? 0.4 : 1,
              borderBottom: active ? '2px solid var(--color-text-primary)' : '2px solid transparent',
              marginBottom: -1,
            }}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Preview table. Memoized because it can render thousands of rows — without this
// every column toggle rebuilds the whole grid and blocks the paint for seconds.
const PreviewTable = memo(function PreviewTable({ preview, visibleHeaders }) {
  return (
    <div style={{ ...panelSx, flex: 1 }}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
          <thead>
            <tr style={{ background: '#FBF8F0', position: 'sticky', top: 0, zIndex: 1 }}>
              {visibleHeaders.map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', whiteSpace: 'nowrap',
                    fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                    borderBottom: '1px solid rgba(28,27,25,0.08)',
                    color: preview.suggestions?.[h] ? '#0C447C' : '#6B6862' }}>
                  {h}
                  {preview.suggestions?.[h] && (
                    <span style={{ marginLeft: 4, fontSize: 9, color: '#0C447C', textTransform: 'none' }}>
                      →{INTERNAL_FIELD_LABELS[preview.suggestions[h]] ?? preview.suggestions[h]}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(preview.preview || []).map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(28,27,25,0.08)' }}>
                {visibleHeaders.map(h => (
                  <td key={h} style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)',
                      whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }}>
                    {row[h] != null ? String(row[h]) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--color-text-secondary)',
          borderTop: '1px solid rgba(28,27,25,0.08)',
          background: '#FBF8F0', flexShrink: 0 }}>
        Showing all {preview.totalRows} rows
      </div>
    </div>
  );
});

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

  // Sliding-highlight geometry for the imports list
  const rowRef = useRef(null);
  const [rowH, setRowH] = useState(GLIDER_FALLBACK_H);
  const selectedIdx = imports.findIndex(imp => imp.id === selectedImportId);
  useLayoutEffect(() => {
    const h = rowRef.current?.offsetHeight;
    if (h) setRowH(h);
  }, [imports, selectedImportId]);

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

  // Filter once per change instead of once per rendered row.
  const visibleHeaders = useMemo(
    () => (activeHeaders ? headers.filter(h => activeHeaders.has(h)) : headers),
    [headers, activeHeaders],
  );

  function toggleHeader(h) {
    const next = new Set(activeHeaders ?? new Set(headers));
    if (next.has(h)) next.delete(h); else next.add(h);
    onActiveHeadersChange(next);
  }

  function toggleAll(on) {
    onActiveHeadersChange(on ? new Set(headers) : new Set());
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      {busy && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
            <crystal-loader style={{ '--crystal-loader-size': '160px', '--crystal-loader-bg': 'transparent' }}></crystal-loader>
            <div style={{ fontSize: 16, fontWeight: 500, color: '#FFFFFF' }}>Parsing...</div>
          </div>
        </div>
      )}

      <PanelHeading
        title=""
        subtitle="Import a customer IO list, then select the relevant columns for import and further processing." />

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>

        {/* Imports list panel — doubles as the drag-and-drop target for new IO
            lists now that the dashed drop zone is gone. Feedback is applied on
            drag-over only, so the panel renders unchanged at rest. Matches the
            glassPanelSx style of Function Mapping and Column Mapping sidebars. */}
        <div style={glassPanelSx}
          onDragOver={e => {
            if (busy) return;
            e.preventDefault();
            e.currentTarget.style.outline = '1.5px dashed var(--color-accent)';
            e.currentTarget.style.outlineOffset = '-3px';
          }}
          onDragLeave={e => {
            e.currentTarget.style.outline = 'none';
          }}
          onDrop={e => {
            e.preventDefault();
            e.currentTarget.style.outline = 'none';
            if (busy) return;
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}>
          <div style={panelHeaderSx}>
            <Btn primary disabled={busy} onClick={() => { fileRef.current.value = ''; fileRef.current.click(); }}
              style={{ width: '100%' }}>
              <i className="ti ti-plus" /> {busy ? 'Parsing…' : 'Upload IO List'}
            </Btn>
          </div>
          <div className="glass-radio-group-vertical" style={{ flex: 1, overflowY: 'auto' }}>
            {imports.length === 0 ? (
              <div style={{ padding: '1rem', fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                No imports yet
              </div>
            ) : (
              <>
                {/* Sliding highlight. Rendered first so it paints beneath the rows. */}
                {selectedIdx >= 0 && (
                  <div className="glass-glider-vertical" style={{
                    height: rowH,
                    transform: `translateY(${selectedIdx * (rowH + GLIDER_GAP)}px)`,
                  }} />
                )}
                {imports.map(imp => (
                  <Fragment key={imp.id}>
                    <input
                      type="radio"
                      id={`upload-${imp.id}`}
                      name="upload-import"
                      checked={selectedImportId === imp.id}
                      onChange={() => onSelectImport(imp.id)} />
                    <label ref={imp.id === imports[0].id ? rowRef : undefined}
                      htmlFor={`upload-${imp.id}`}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-sans)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selectedImportId === imp.id ? '#FFFFFF' : '#1C1B19' }}>
                          {imp.file_name}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexShrink: 0, gap: 2 }}>
                        <button
                          onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setReimportId(imp.id);
                            onSelectImport(imp.id);
                            reimportRef.current.value = '';
                            reimportRef.current.click();
                          }}
                          title="Reimport — replace with new file"
                          className="io-import-icon-btn io-import-icon-refresh"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                            padding: '2px 4px',
                            color: selectedImportId === imp.id ? '#FFFFFF' : '#6B6862',
                            fontSize: 13, lineHeight: 1,
                            transition: 'color 0.15s ease' }}
                          onMouseEnter={e => e.currentTarget.style.color = selectedImportId === imp.id ? '#CCCCCC' : '#1C1B19'}
                          onMouseLeave={e => e.currentTarget.style.color = selectedImportId === imp.id ? '#FFFFFF' : '#6B6862'}>
                          <i className="ti ti-refresh" />
                        </button>
                        <button
                          onClick={e => { e.preventDefault(); e.stopPropagation(); onDeleteImport(imp.id, imp.file_name); }}
                          title="Delete import"
                          className="io-import-icon-btn io-import-icon-delete"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                            padding: '2px 4px',
                            color: selectedImportId === imp.id ? '#FFFFFF' : '#6B6862',
                            fontSize: 13, lineHeight: 1,
                            transition: 'color 0.15s ease' }}
                          onMouseEnter={e => e.currentTarget.style.color = selectedImportId === imp.id ? '#FF4444' : '#DC2626'}
                          onMouseLeave={e => e.currentTarget.style.color = selectedImportId === imp.id ? '#FFFFFF' : '#6B6862'}>
                          <i className="ti ti-trash" />
                        </button>
                      </div>
                    </label>
                  </Fragment>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Right: source options, drop zone, column picker + preview */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>

          <div style={{ ...panelSx, flexShrink: 0 }}>
            <div style={{ ...panelHeaderSx, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'center', position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'absolute', left: 0 }}>
                <label style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Column map</label>
                <select value={selColMap} onChange={e => setSelColMap(e.target.value)}
                  className="io-upload-select" style={{ ...inputSx, width: 190, cursor: 'pointer' }}>
                  <option value="">(auto-detect)</option>
                  {columnMaps.map(cm => <option key={cm.id} value={cm.id}>{cm.name}</option>)}
                </select>
              </div>
              {selectedImportId && (() => {
                const selectedImport = imports.find(imp => imp.id === selectedImportId);
                const recordCount = selectedImport?.total_tags ?? selectedImport?.total_rows ?? '?';
                return (
                  <>
                    <div style={{ fontSize: 24, color: 'var(--color-text-primary)', fontWeight: 600,
                        textAlign: 'center', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {selectedImport?.file_name || ''}
                      </span>
                      <span style={{ fontSize: 18, fontWeight: 500, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>({recordCount} records)</span>
                    </div>
                    <div style={{ position: 'absolute', right: 0 }}>
                      <Tag text={selectedImport?.status} color={selectedImport?.status === 'promoted' ? 'green' : 'gray'} />
                    </div>
                  </>
                );
              })()}
              {availSheets.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'absolute', right: 0 }}>
                  <label style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Sheet</label>
                  <select value={selSheet} onChange={e => setSelSheet(e.target.value)}
                    className="io-upload-select" style={{ ...inputSx, width: 160, cursor: 'pointer' }}>
                    <option value="">(first sheet)</option>
                    {availSheets.map(sheet => <option key={sheet} value={sheet}>{sheet}</option>)}
                  </select>
                </div>
              )}
            </div>

          </div>

          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])} />
          <input ref={reimportRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => handleReimport(e.target.files[0])} />

          {/* Column picker + preview — persists across tab switches */}
          {headers.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 260 }}>

              <div style={panelSx}>
                <div style={{ ...panelHeaderSx, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Columns</span>
                  <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                    {(activeHeaders?.size ?? headers.length)}/{headers.length}
                  </span>
                </div>
                <div style={{ padding: '5px 10px', borderBottom: '0.5px solid var(--color-border-tertiary)',
                    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => toggleAll(true)}
                    style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--color-text-secondary)', padding: 0 }}>Select all</button>
                  <span style={{ fontSize: 11, color: 'var(--color-border-secondary)' }}>·</span>
                  <button onClick={() => toggleAll(false)}
                    style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--color-text-secondary)', padding: 0 }}>Clear</button>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {headers.map(h => {
                    const on = activeHeaders ? activeHeaders.has(h) : true;
                    const suggested = preview?.suggestions?.[h];
                    return (
                      <div key={h} onClick={() => toggleHeader(h)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                          cursor: 'pointer', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                        <Switch checked={on} onChange={() => toggleHeader(h)} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 500,
                              color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {h}
                          </div>
                          {suggested && (
                            <div style={{ fontSize: 10, color: '#0C447C', marginTop: 1 }}>
                              → {INTERNAL_FIELD_LABELS[suggested] ?? suggested}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {preview ? (
                <PreviewTable preview={preview} visibleHeaders={visibleHeaders} />
              ) : (
                <div style={{ ...panelSx, alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                    Upload a new file to see a data preview
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeading
        title="Column mapping"
        subtitle="Tell the importer which customer column holds each internal field. Saved configs can be reused across imports." />

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>

        {/* Config list panel */}
        <div style={glassPanelSx}>
          <div style={glassPanelHeaderSx}>
            <Btn primary onClick={newConfig} style={{ width: '100%' }}>
              <i className="ti ti-plus" /> New config
            </Btn>
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {columnMaps.length === 0 ? (
              <div style={{ padding: '1rem', fontSize: 12, color: '#888', textAlign: 'center' }}>
                No configs yet
              </div>
            ) : columnMaps.map(cm => (
              <div key={cm.id} onClick={() => selectConfig(cm)}
                style={{ padding: '10px 12px', cursor: 'pointer',
                  borderBottom: '1px solid rgba(0,0,0,0.08)',
                  background: selected === cm.id ? 'rgba(0,0,0,0.06)' : 'transparent',
                  display: 'flex', alignItems: 'center', gap: 4,
                  transition: 'background 0.2s ease' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-sans)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1a1a1a' }}>
                    {cm.name}
                  </div>
                  {cm.description && (
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cm.description}
                    </div>
                  )}
                </div>
                <button onClick={e => { e.stopPropagation(); del(cm.id); }}
                  title="Delete config"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                    padding: '2px 4px', color: '#6b7280', fontSize: 13, lineHeight: 1,
                    transition: 'color 0.15s ease' }}
                  onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                  onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}>
                  <i className="ti ti-trash" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Editor panel */}
        <div style={{ ...panelSx, overflowY: 'auto', padding: !draft ? 0 : '1rem 1.25rem' }}>
          {!draft ? (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, paddingTop: '2rem', textAlign: 'center' }}>
              Select a config or create a new one
            </div>
          ) : (
            <>
              {/* Header fields */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: '1.25rem' }}>
                <div>
                  <label style={eyebrowLabelSx}>Name *</label>
                  <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                    placeholder="e.g. Customer A layout" style={textInputSx} />
                </div>
                <div>
                  <label style={eyebrowLabelSx}>Description</label>
                  <input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                    placeholder="Optional description" style={textInputSx} />
                </div>
              </div>

              {/* Field → column mapping table */}
              <SLabel text="Field mapping" />
              <div style={{ border: '1px solid rgba(28,27,25,0.08)',
                  borderRadius: '12px', overflow: 'hidden', marginBottom: '1rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                    padding: '12px 16px', gap: 10, background: '#FBF8F0',
                    borderBottom: '1px solid rgba(28,27,25,0.08)' }}>
                  {['Internal field', 'Customer column'].map(h => (
                    <div key={h} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                        letterSpacing: '0.04em', color: '#6B6862' }}>{h}</div>
                  ))}
                </div>

                {INTERNAL_FIELDS.map((field, idx) => (
                  <div key={field} style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
                      padding: '12px 16px', alignItems: 'center',
                      borderBottom: idx < INTERNAL_FIELDS.length - 1 ? '1px solid rgba(28,27,25,0.08)' : 'none',
                      background: idx % 2 === 0 ? '#FFFFFF' : '#FBF8F0' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>
                        {INTERNAL_FIELD_LABELS[field] ?? field}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1, lineHeight: 1.45 }}>
                        {INTERNAL_FIELD_DESCRIPTIONS[field]}
                      </div>
                    </div>
                    <select
                      value={fieldToColumn[field] || ''}
                      onChange={e => setMapping(field, e.target.value || null)}
                      style={{ ...inputSx, cursor: 'pointer' }}>
                      <option value="">— select column —</option>
                      {visibleHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}

                {visibleHeaders.length === 0 && (
                  <div style={{ padding: '10px', fontSize: 12, color: 'var(--color-text-secondary)',
                      textAlign: 'center', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                    {detectedHeaders.length === 0
                      ? 'Upload a file first to see detected columns.'
                      : 'No columns selected — enable columns on the Upload tab.'}
                  </div>
                )}
              </div>

              {/* Unmapped columns */}
              {visibleHeaders.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '8px 10px',
                    background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)',
                    marginBottom: '1rem', lineHeight: 1.5 }}>
                  <strong style={{ fontWeight: 600 }}>Unmapped columns:</strong>{' '}
                  {visibleHeaders.filter(h => !Object.values(fieldToColumn).includes(h)).join(', ') || '(all mapped)'}
                </div>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center',
                  flexWrap: 'wrap', paddingTop: 4 }}>
                {applied && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11,
                      color: 'var(--color-text-secondary)', marginRight: 'auto' }}>
                    <Tag text="Applied" color="green" />
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
            <span style={{ fontSize: 12, fontFamily: 'var(--font-sans)' }}>{n.name}</span>
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

  async function buildAndPromote() {
    if (!confirm('Build hierarchy and promote to project?')) return;
    setBusy(true);
    try {
      const r = await buildIOHierarchy(importId, levelMap);
      setStats(r);
      if (r.effectiveLevelMap) setLevelMap(r.effectiveLevelMap);
      const resp = await getIOHierarchy(importId);
      setTree(resp.tree ?? resp);

      await promote();
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeading
        title="Hierarchy"
        subtitle="Map each slash-separated segment of the Hierarchy column to an ISA-88 level, then build the folder tree." />

      <div style={{ display: 'grid', gridTemplateColumns: '40% 60%', gap: 12, flex: 1, minHeight: 0 }}>

        {/* Level config panel */}
        <div style={panelSx}>
          <div style={panelHeaderSx}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
              Path segments
            </span>
          </div>

          <div style={{ overflowY: 'auto', flex: 1, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
              Each{' '}
              <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--color-background-secondary)',
                  padding: '0 3px', borderRadius: 3 }}>/</code>
              {' '}segment becomes one level, in order.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {levelMap.map((level, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)',
                      fontFamily: 'var(--font-mono)', width: 20, textAlign: 'right', flexShrink: 0 }}>
                    [{idx}]
                  </span>
                  <select value={level} onChange={e => setSegmentLevel(idx, e.target.value)}
                    style={{ ...inputSx, flex: 1, cursor: 'pointer' }}>
                    {ALL_LEVELS.map(l => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                  </select>
                  <button onClick={() => removeSegment(idx)} title="Remove level"
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                      padding: '2px 4px', color: 'var(--color-text-secondary)', fontSize: 13,
                      lineHeight: 1, flexShrink: 0 }}>
                    <i className="ti ti-x" />
                  </button>
                </div>
              ))}
            </div>

            {levelMap.length < ALL_LEVELS.length && (
              <Btn onClick={addSegment} style={{ marginTop: 10, fontSize: 11, padding: '5px 12px' }}>
                <i className="ti ti-plus" /> Add level
              </Btn>
            )}

            {stats && (
              <>
                <SLabel text="Result" top />
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)',
                    display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.entries(stats.levels || {}).map(([lvl, cnt]) => (
                    <span key={lvl} style={{ color: LEVEL_COLORS[lvl] || 'inherit' }}>
                      {lvl}: <strong>{cnt}</strong>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={{ padding: 8, borderTop: '0.5px solid var(--color-border-tertiary)',
              background: 'var(--color-background-secondary)', flexShrink: 0,
              display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Btn primary onClick={buildAndPromote} disabled={busy || !importId || levelMap.length === 0}
              style={{ width: '100%' }}>
              <i className="ti ti-refresh" /> {busy ? 'Building…' : 'Build & Promote'}
            </Btn>
          </div>
        </div>

        {/* Tree panel */}
        <div style={panelSx}>
          <div style={{ ...panelHeaderSx, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
              Folder tree
            </span>
            {tree.length > 0 && (
              <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {tree.length} root{tree.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: tree.length === 0 ? 0 : '10px 14px' }}>
            {tree.length === 0 ? (
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 13,
                  paddingTop: '2rem', textAlign: 'center' }}>
                Configure levels on the left, then click Build
              </div>
            ) : (
              <HierarchyTree nodes={tree} />
            )}
          </div>
        </div>
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
  // Draft of the selected config's name while the field has focus. The parent
  // owns `functionMaps`, so we edit locally and push on blur.
  const [nameDraft, setNameDraft] = useState(null);

  // Sliding-highlight geometry. The row height is measured rather than assumed:
  // rows size to their own font/padding, so a hard-coded value drifts the
  // highlight further off with every row down the list.
  const rowRef = useRef(null);
  const [rowH, setRowH] = useState(GLIDER_FALLBACK_H);
  const selectedIdx = functionMaps.findIndex(fm => fm.id === selected);
  useLayoutEffect(() => {
    const h = rowRef.current?.offsetHeight;
    if (h) setRowH(h);
  }, [functionMaps, selected]);

  async function selectConfig(id) {
    setSelected(id);
    setNameDraft(null);
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
      const fm = functionMaps.find(m => m.id === selected);
      if (fm && fm.name) {
        await updateIOFunctionMap(selected, { name: fm.name });
      }
      await saveIOFunctionMapMappings(selected, mappings);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function deleteConfig() {
    if (!selected) return;
    setBusy(true);
    try {
      await deleteIOFunctionMap(selected);
      setSelected(null);
      setMappings([]);
      await onFunctionMapsChange();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function saveFunctionMapName(id) {
    if (nameDraft === null) return;                 // never focused / already committed
    const fm = functionMaps.find(m => m.id === id);
    const next = nameDraft.trim();
    if (!fm || !next || next === fm.name) { setNameDraft(null); return; }
    try {
      await updateIOFunctionMap(id, { name: next });
      await onFunctionMapsChange();                 // refresh the list so the rename shows
    } catch (e) { setError(e.message); }
    finally { setNameDraft(null); }
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

  const MAP_COLS = '1fr 180px 110px 80px 40px';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeading
        title=""
        subtitle="Map the function to a composite CM type." />

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>

        {/* Config list panel */}
        <div style={glassPanelSx}>
          <div style={glassPanelHeaderSx}>
            <Btn primary onClick={createNew} disabled={busy} style={{ width: '100%' }}>
              <i className="ti ti-plus" /> New config
            </Btn>
          </div>
          <div className="glass-radio-group-vertical" style={{ flex: 1, overflowY: 'auto' }}>
            {functionMaps.length === 0 ? (
              <div style={{ padding: '1rem', fontSize: 12, color: '#888', textAlign: 'center' }}>
                No configs yet
              </div>
            ) : (
              <>
                {/* Sliding highlight. Rendered first so it paints beneath the rows,
                    and positioned from the measured row height (the rows are not a
                    fixed 56px — they size to their own padding and font). */}
                {selectedIdx >= 0 && (
                  <div className="glass-glider-vertical" style={{
                    height: rowH,
                    transform: `translateY(${selectedIdx * (rowH + GLIDER_GAP)}px)`,
                  }} />
                )}
                {functionMaps.map(fm => (
                  <Fragment key={fm.id}>
                    <input
                      type="radio"
                      id={`fnmap-${fm.id}`}
                      name="function-map"
                      checked={selected === fm.id}
                      onChange={() => selectConfig(fm.id)} />
                    <label ref={fm.id === functionMaps[0].id ? rowRef : undefined}
                      htmlFor={`fnmap-${fm.id}`}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="glass-label-text" title={fm.name}>
                        {fm.name}
                      </div>
                      {selected === fm.id && (
                        <span onClick={e => { e.preventDefault(); e.stopPropagation(); deleteConfig(); }}
                          className="io-import-icon-delete" title="Delete this configuration"
                          style={{ cursor: busy ? 'not-allowed' : 'pointer', padding: '2px 4px',
                            color: '#6b7280', fontSize: 13, lineHeight: 1, flexShrink: 0,
                            transition: 'color 0.15s ease' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                          onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}>
                          <i className="ti ti-trash" />
                        </span>
                      )}
                    </label>
                  </Fragment>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Editor panel */}
        <div style={{ ...panelSx, padding: !selected ? 0 : '1rem 1.25rem', overflowY: 'auto' }}>
          {!selected ? (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13,
                paddingTop: '2rem', textAlign: 'center' }}>
              Select a config or create a new one
            </div>
          ) : (
            <>
              {/* Function Map Name - Editable */}
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                    color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Config name</label>
                <input value={nameDraft ?? (functionMaps.find(m => m.id === selected)?.name || '')}
                  onChange={e => setNameDraft(e.target.value)}
                  onBlur={() => saveFunctionMapName(selected)}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  e.target.blur();
                    if (e.key === 'Escape') { setNameDraft(null); e.target.blur(); }
                  }}
                  placeholder="Function Map name"
                  style={{ width: '100%', padding: '6px 8px', border: '1px solid rgba(28,27,25,0.08)',
                    borderRadius: '8px', fontSize: 13, fontFamily: 'var(--font-sans)',
                    background: '#FFFFFF', color: '#1C1B19', outline: 'none' }} />
              </div>

              <SLabel text={`Mappings (${mappings.length})`}>
                <Btn onClick={addRow} style={{ fontSize: 11, padding: '5px 12px' }}>
                  <i className="ti ti-plus" /> Add mapping
                </Btn>
              </SLabel>

              {mappings.length === 0 ? (
                <EmptyState style={{ marginBottom: '1rem' }}>
                  No mappings yet — click “Add mapping” to start
                </EmptyState>
              ) : (
                <div style={{ border: '1px solid rgba(28,27,25,0.08)', borderRadius: '12px', overflow: 'hidden', background: '#FBFAF7', boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)', marginBottom: '1rem' }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 40px', gap: 12,
                    padding: '10px 16px', background: '#FBF8F0',
                    borderBottom: '1px solid rgba(28,27,25,0.08)',
                  }}>
                    {['FUNCTION VALUE', 'CM TYPE', 'MATCH MODE', 'PRIORITY', ''].map((h, i) => (
                      <div key={i} style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                          color: '#6B6862', paddingRight: i < 4 ? '12px' : '0', borderRight: i < 4 ? '1px solid rgba(28,27,25,0.08)' : 'none' }}>{h}</div>
                    ))}
                  </div>

                  {mappings.map((m, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 40px', gap: 12,
                        padding: '10px 16px', alignItems: 'center',
                        borderBottom: '1px solid rgba(28,27,25,0.08)',
                        background: '#FFFFFF' }}>
                      <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                        <input value={m.function_value}
                          onChange={e => updateRow(i, 'function_value', e.target.value.toUpperCase())}
                          placeholder="e.g. MOTOR" style={{ ...inputSx, padding: '6px 8px', flex: 1 }} />
                      </div>
                      <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                        <select value={m.cm_type_name} onChange={e => updateRow(i, 'cm_type_name', e.target.value)}
                          style={{ ...inputSx, padding: '6px 8px', cursor: 'pointer', flex: 1 }}>
                          <option value="">- pick type -</option>
                          {(compositeCmTypes || []).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                        </select>
                      </div>
                      <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                        <select value={m.match_mode || 'exact'} onChange={e => updateRow(i, 'match_mode', e.target.value)}
                          style={{ ...inputSx, padding: '6px 8px', cursor: 'pointer', flex: 1 }}>
                          {['exact', 'prefix', 'contains', 'regex'].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                      <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                        <input type="number" value={m.priority || 0}
                          onChange={e => updateRow(i, 'priority', parseInt(e.target.value))}
                          style={{ ...inputSx, padding: '6px 8px', flex: 1 }} />
                      </div>
                      <button onClick={() => removeRow(i)} title="Remove mapping"
                        className="io-import-icon-delete"
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                          padding: '2px 4px', color: 'var(--color-text-secondary)',
                          fontSize: 13, lineHeight: 1, justifySelf: 'center' }}
                        onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--color-text-secondary)'}>
                        <i className="ti ti-x" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Unresolved function values from the current import */}
              {unresolved.length > 0 && (
                <>
                  <SLabel text={`Unresolved in this import (${unresolved.length})`} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: '1rem' }}>
                    {unresolved.map(u => {
                      const val   = u.function_val ?? u.function_value ?? u;
                      const added = mappings.some(m => m.function_value === val);
                      return (
                        <button key={val} onClick={() => quickAdd(val)} disabled={added}
                          title={added ? 'Already mapped' : 'Add a mapping for this value'}
                          style={{ fontSize: 11, fontFamily: 'var(--font-mono)',
                            padding: '2px 8px', borderRadius: 8,
                            border: '0.5px solid var(--color-border-secondary)',
                            background: added ? 'var(--color-background-secondary)' : 'transparent',
                            color: added ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
                            cursor: added ? 'default' : 'pointer', opacity: added ? 0.6 : 1 }}>
                          {added ? '✓ ' : '+ '}{val}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
                <Btn primary onClick={saveMappings} disabled={busy}>
                  <i className="ti ti-device-floppy" /> {busy ? 'Saving…' : 'Save mappings'}
                </Btn>
              </div>
            </>
          )}
        </div>
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
        style={{ background: '#ECFDF5', border: 'none', borderRadius: 4, padding: '2px 7px',
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeading
        title="Review assignments"
        subtitle="Check the CM type assigned to each instrument, override where needed, then promote to the project." />

      <div className="ig-root" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
          border: '1px solid rgba(28,27,25,0.08)', borderRadius: '22px',
          overflow: 'hidden', background: '#FFFFFF', boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)' }}>
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
          ].map(f => {
            const on = filter === f.key;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)}
                style={{ padding: '3px 12px', borderRadius: 14,
                  border: `0.5px solid ${on ? 'var(--color-text-primary)' : 'var(--color-border-secondary)'}`,
                  fontSize: 11, cursor: 'pointer', fontWeight: on ? 500 : 400,
                  background: on ? 'var(--color-text-primary)' : 'transparent',
                  color: on ? 'var(--color-background-primary)' : 'var(--color-text-secondary)' }}>
                {f.label}
              </button>
            );
          })}
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
          <a href={ioExportUrl(importId)} download style={{ textDecoration: 'none' }}>
            <Btn><i className="ti ti-download" /> Export CSV</Btn>
          </a>
          <Btn primary onClick={promote} disabled={busy || !importId}>
            <i className="ti ti-arrow-right" /> Promote to project
          </Btn>
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
          color: 'var(--color-text-secondary)', padding: '6px 10px',
          borderTop: '0.5px solid var(--color-border-tertiary)',
          background: 'var(--color-background-secondary)' }}>
        <Btn onClick={() => load(data.page - 1)} disabled={data.page <= 1 || busy}
          style={{ fontSize: 11, padding: '4px 10px' }}>‹ Prev</Btn>
        <span>Page {data.page} of {data.pages} · {data.total} total tags</span>
        <Btn onClick={() => load(data.page + 1)} disabled={data.page >= data.pages || busy}
          style={{ fontSize: 11, padding: '4px 10px' }}>Next ›</Btn>
      </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeading
        title="Automated workflow"
        subtitle="Run column mapping, hierarchy, assignment, promotion and XML generation in one pass. Each step is validated and rolls back on failure." />

      <div style={{ ...panelSx, flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', gap: 16 }}>

      {/* Step 1 — column map */}
      {!progress && !result && (
        <div>
          <SLabel text="Step 1 · Column mapping" />
          <Callout tone={needsColumnMap ? 'warning' : 'success'} style={{ marginBottom: 10 }}>
            {needsColumnMap
              ? 'Not applied yet. Pick a saved config and apply it before starting the workflow.'
              : 'Applied — this import is ready for the workflow.'}
          </Callout>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={selectedColumnMap}
              onChange={e => setSelectedColumnMap(e.target.value)}
              style={{ ...inputSx, flex: 1, maxWidth: 300, cursor: 'pointer' }}
              disabled={applyingColumnMap}
            >
              <option value="">(select a column mapping config…)</option>
              {(columnMaps || []).filter(c => !String(c.name || '').startsWith('__io_instances_')).map(cm => (
                <option key={cm.id} value={cm.id}>{cm.name}</option>
              ))}
            </select>
            {needsColumnMap ? (
              <Btn primary disabled={!selectedColumnMap || applyingColumnMap} onClick={handleApplyColumnMap}>
                <i className="ti ti-check" /> {applyingColumnMap ? 'Applying…' : 'Apply column map'}
              </Btn>
            ) : (
              <Btn disabled={!selectedColumnMap || applyingColumnMap} onClick={handleApplyColumnMap}>
                <i className="ti ti-refresh" /> {applyingColumnMap ? 'Reapplying…' : 'Reapply'}
              </Btn>
            )}
          </div>
        </div>
      )}

      {/* Step 2 — function map + start */}
      {!needsColumnMap && !progress && !result && (
        <div>
          <SLabel text="Step 2 · Function mapping" top />
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={selectedFnMap}
              onChange={e => setSelectedFnMap(e.target.value)}
              style={{ ...inputSx, flex: 1, maxWidth: 300, cursor: 'pointer' }}
              disabled={busy}
            >
              <option value="">(select a function mapping…)</option>
              {functionMaps.map(fm => (
                <option key={fm.id} value={fm.id}>{fm.name}</option>
              ))}
            </select>
            <Btn primary disabled={!selectedFnMap || busy} onClick={handleStartWorkflow}>
              <i className="ti ti-rocket" /> Start workflow
            </Btn>
          </div>
        </div>
      )}

      {/* Progress indicator */}
      {progress && !result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, display: 'flex',
                justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{progress.phase}: {progress.msg}</span>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{progress.pct || 0}%</span>
            </div>
            <div style={{
              width: '100%', height: 8, borderRadius: 4, background: 'var(--color-background-secondary)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${progress.pct || 0}%`, background: 'var(--color-accent)',
                transition: 'width 0.2s ease',
              }} />
            </div>
          </div>

          {/* Phase labels */}
          <div style={{ display: 'flex', gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
            {[
              { name: 'validation', label: 'Validating' },
              { name: 'promoting',  label: 'Promoting' },
              { name: 'hardware',   label: 'Hardware & connections' },
              { name: 'resolving',  label: 'Resolving' },
              { name: 'building',   label: 'Building' },
              { name: 'finalizing', label: 'Finalizing' },
            ].map(phase => {
              const active = progress.phase === phase.name;
              return (
                <div key={phase.name} style={{
                  padding: '2px 8px', borderRadius: 8,
                  background: active ? 'var(--color-accent-light)' : 'var(--color-background-secondary)',
                  color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}>
                  {phase.label}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Success result */}
      {result && !result.error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Callout tone="success">✓ Workflow completed successfully</Callout>

          {/* Stats */}
          {result.stats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
              {[
                { label: 'Blocks',    value: result.stats.blocks },
                { label: 'Variables', value: result.stats.vars },
                { label: 'Messages',  value: result.stats.msgs },
                { label: 'Links',     value: result.stats.links },
                { label: 'File size', value: `${result.stats.sizeKb} KB` },
              ].map(stat => <StatTile key={stat.label} label={stat.label} value={stat.value} />)}
            </div>
          )}

          {/* XML + CFG downloads */}
          {(result.xml || result.cfg) && (
            <div style={{ display: 'flex', gap: 8 }}>
              {result.xml && (
                <Btn primary
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
                  }}>
                  <i className="ti ti-download" /> Download XML
                </Btn>
              )}
              {result.cfg && (
                <Btn
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
                  }}>
                  <i className="ti ti-download" /> Download CFG
                </Btn>
              )}
            </div>
          )}

          {/* Hardware sync log */}
          {result.hwLog && (
            <div style={{ border: '1px solid rgba(28,27,25,0.08)',
                borderRadius: '12px', overflow: 'hidden' }}>
              <div style={{ ...panelHeaderSx, display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', padding: '6px 10px' }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
                  Hardware sync log
                </span>
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
                  style={{ background: 'none', border: '0.5px solid var(--color-border-secondary)',
                    borderRadius: 'var(--border-radius-md)', padding: '2px 8px', cursor: 'pointer',
                    fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  <i className="ti ti-download" /> Download log
                </button>
              </div>
              <div style={{ padding: '8px 10px', fontSize: 12, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ color: '#166534' }}>✓ {result.hwLog.imported} imported</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{result.hwLog.unchanged} unchanged</span>
                {result.hwLog.skippedModified.length > 0 && (
                  <span style={{ color: '#92400E' }}>⚠ {result.hwLog.skippedModified.length} modified skipped</span>
                )}
                {result.hwLog.skippedMissing.length > 0 && (
                  <span style={{ color: '#92400E' }}>⚠ {result.hwLog.skippedMissing.length} missing skipped</span>
                )}
              </div>
              {(result.hwLog.skippedModified.length > 0 || result.hwLog.skippedMissing.length > 0) && (
                <div style={{ padding: '0 10px 8px', fontSize: 11, color: 'var(--color-text-secondary)',
                    maxHeight: 140, overflowY: 'auto' }}>
                  {result.hwLog.skippedModified.map((s, i) => (
                    <div key={`m${i}`} style={{ fontFamily: 'var(--font-mono)', padding: '2px 0' }}>
                      modified: station {s.station} slot {s.slot} {s.tag ? `(${s.tag})` : ''} — changed: {s.changedFields.join(', ')}
                    </div>
                  ))}
                  {result.hwLog.skippedMissing.map((s, i) => (
                    <div key={`x${i}`} style={{ fontFamily: 'var(--font-mono)', padding: '2px 0' }}>
                      missing: station {s.station} slot {s.slot} {s.tag ? `(${s.tag})` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Connections (dummy ↔ hardware reconciliation) */}
          {result.connections && (
            <div style={{ padding: '12px 16px', borderRadius: '12px',
                border: '1px solid rgba(28,27,25,0.08)', fontSize: 12,
                display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Connections</span>
              <span style={{ color: '#166534' }}>✓ {result.connections.real} real</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>{result.connections.dummy} dummy</span>
              {result.connections.conflicts?.length > 0 && (
                <span style={{ color: '#991B1B' }}>⚠ {result.connections.conflicts.length} conflicts</span>
              )}
            </div>
          )}

          {/* Audit ID */}
          {result.auditId && (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Audit ID: <code style={{ fontFamily: 'var(--font-mono)' }}>{result.auditId}</code>
            </div>
          )}

          <div>
            <Btn onClick={() => { setResult(null); setProgress(null); setSelectedFnMap(''); }}>
              <i className="ti ti-arrow-left" /> Start another workflow
            </Btn>
          </div>
        </div>
      )}
      </div>
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

  const savePrefsTimer = useRef(null);
  const handleActiveHeadersChange = useCallback((next) => {
    setActiveHeaders(next);
    // Debounce the DB write — a burst of toggles should cost one request, not one each.
    if (selectedImportId && next instanceof Set) {
      clearTimeout(savePrefsTimer.current);
      const snapshot = Array.from(next);
      savePrefsTimer.current = setTimeout(() => {
        saveIOColumnPrefs(selectedImportId, snapshot).catch(err => {
          console.error('Failed to save column preferences:', err);
        });
      }, 400);
    }
  }, [selectedImportId]);

  useEffect(() => () => clearTimeout(savePrefsTimer.current), []);

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
      <EmptyState style={{ padding: '2.5rem' }}>
        No project selected — create or open one in Step 1 first.
      </EmptyState>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Sub-tab bar */}
      <SubTabs tab={tab} setTab={setTab} importReady={!!selectedImportId} />

      {/* Tab content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
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
