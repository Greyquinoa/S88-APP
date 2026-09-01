import { useState, useEffect, useMemo, useRef } from 'react';
import { Btn } from './ImportUIKit.jsx';

// Rows are uniform height so the list can be windowed by arithmetic instead of
// measurement — an import can carry several thousand changes and mounting a DOM
// node per change is what makes the modal crawl.
const ROW_H = 30;
const OVERSCAN = 12;

function fieldLabel(field) {
  if (field === 'cm_type') return 'CM Type';
  if (field === 'hw_controller_id') return 'Controller';
  if (field.startsWith('derived:')) return field.slice('derived:'.length);
  return field;
}

export default function IoConflictModal({ conflictData, onApply, onCancel, applying }) {
  const { unchanged = 0, conflicts = [], newInstances = [] } = conflictData;

  const [query, setQuery]   = useState('');
  const [scrollTop, setScroll] = useState(0);
  const [viewportH, setViewportH] = useState(420);
  const scrollerRef = useRef(null);

  // Flatten to one row per change: the grid is the unit of reading here, not the
  // instance card — a hundred collapsed cards is not something you can scan.
  const allRows = useMemo(() => {
    const rows = [];
    for (const c of conflicts) {
      c.changes.forEach((ch, i) => {
        rows.push({
          key: `${c.instanceName}|${ch.field}`,
          instanceName: c.instanceName,
          cmType: c.cmType,
          firstOfInstance: i === 0,
          field: ch.field,
          label: fieldLabel(ch.field),
          oldValue: ch.oldValue,
          newValue: ch.newValue,
        });
      });
    }
    return rows;
  }, [conflicts]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(r =>
      r.instanceName.toLowerCase().includes(q) ||
      r.label.toLowerCase().includes(q)
    );
  }, [allRows, query]);

  useEffect(() => {
    if (applying) return;
    const handler = e => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [applying, onCancel]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const start   = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visible = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
  const slice   = rows.slice(start, start + visible);

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 24,
      }}
      onClick={applying ? undefined : e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        backgroundColor: 'var(--color-bg-primary, #fff)',
        borderRadius: 8,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        height: '100%', maxHeight: 720,
        width: '100%', maxWidth: 900,
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid var(--color-border-tertiary, #e0e0e0)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Review IO Import Changes</h2>
            {!applying && (
              <button onClick={onCancel} title="Cancel — nothing is written"
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                         fontSize: 18, color: 'var(--color-fg-secondary, #666)', lineHeight: 1 }}>✕</button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat n={newInstances.length} label="to create" tone="green" />
            <Stat n={conflicts.length} label="to update" tone="amber" />
            <Stat n={allRows.length} label={allRows.length === 1 ? 'field change' : 'field changes'} tone="plain" />
            <Stat n={unchanged} label="unchanged" tone="plain" />
          </div>

          <input
            value={query}
            onChange={e => { setQuery(e.target.value); if (scrollerRef.current) scrollerRef.current.scrollTop = 0; }}
            placeholder="Filter by instance or field…"
            disabled={applying}
            style={{
              width: '100%', padding: '7px 10px', fontSize: 13,
              border: '1px solid var(--color-border-secondary, #ccc)',
              borderRadius: 5, boxSizing: 'border-box',
              background: 'var(--color-bg-primary, #fff)',
              color: 'var(--color-fg-primary, #333)',
            }}
          />
        </div>

        {/* Column header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '7px 22px', flexShrink: 0,
          borderBottom: '1px solid var(--color-border-tertiary, #e0e0e0)',
          background: 'var(--color-bg-secondary, #f7f7f7)',
          fontSize: 11, fontWeight: 500, color: 'var(--color-fg-tertiary, #999)',
        }}>
          <span style={{ width: '26%' }}>Instance</span>
          <span style={{ width: '22%' }}>Field</span>
          <span style={{ flex: 1 }}>Current</span>
          <span style={{ width: 18 }} />
          <span style={{ flex: 1 }}>Incoming</span>
        </div>

        {/* Windowed rows */}
        <div
          ref={scrollerRef}
          onScroll={e => setScroll(e.currentTarget.scrollTop)}
          style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
        >
          {rows.length === 0 ? (
            <div style={{ padding: '28px 22px', fontSize: 13, color: 'var(--color-fg-tertiary, #999)' }}>
              {allRows.length === 0
                ? 'No field changes — only new instances will be created.'
                : 'No changes match this filter.'}
            </div>
          ) : (
            <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
              <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
                {slice.map(r => (
                  <div key={r.key} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    height: ROW_H, padding: '0 22px', boxSizing: 'border-box',
                    fontSize: 12.5,
                    borderTop: r.firstOfInstance ? '1px solid var(--color-border-tertiary, #eee)' : 'none',
                  }}>
                    <span style={{
                      width: '26%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontWeight: r.firstOfInstance ? 600 : 400,
                      color: r.firstOfInstance
                        ? 'var(--color-fg-primary, #333)'
                        : 'var(--color-fg-tertiary, #bbb)',
                    }} title={`${r.instanceName} · ${r.cmType}`}>
                      {r.firstOfInstance ? r.instanceName : '↳'}
                    </span>
                    <span style={{
                      width: '22%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: 'var(--color-fg-primary, #333)',
                    }} title={r.label}>{r.label}</span>
                    <code style={{
                      flex: 1, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: 'var(--color-fg-secondary, #777)',
                    }} title={r.oldValue}>{r.oldValue}</code>
                    <span style={{ width: 18, textAlign: 'center', color: 'var(--color-fg-tertiary, #bbb)' }}>→</span>
                    <code style={{
                      flex: 1, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: '#15803d', fontWeight: 600,
                    }} title={r.newValue}>{r.newValue}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '14px 22px',
          borderTop: '1px solid var(--color-border-tertiary, #e0e0e0)', flexShrink: 0,
        }}>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--color-fg-tertiary, #999)' }}>
            {query
              ? `${rows.length} of ${allRows.length} shown`
              : 'Apply writes every change above. Cancel writes nothing.'}
          </span>
          <Btn onClick={onCancel} disabled={applying}>Cancel</Btn>
          <Btn primary onClick={onApply} disabled={applying}>
            {applying ? 'Applying…' : 'Apply'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, label, tone }) {
  const tones = {
    green: { bg: '#dcfce7', fg: '#166534' },
    amber: { bg: '#fef3c7', fg: '#92400e' },
    plain: { bg: 'var(--color-bg-secondary, #f0f0f0)', fg: 'var(--color-fg-secondary, #666)' },
  };
  const t = tones[tone] || tones.plain;
  return (
    <span style={{
      fontSize: 12, padding: '3px 9px', borderRadius: 11,
      background: t.bg, color: t.fg,
    }}>
      <strong>{n}</strong> {label}
    </span>
  );
}
