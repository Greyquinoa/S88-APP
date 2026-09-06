import React, { useState, useEffect } from 'react';
import './InstancesGrid.css';
import './StationAutoSlotsEditor.css';
import { getSlotDefaultSubslots, saveSlotDefaultSubslots } from './api';

/**
 * Flat editor for a slot-category catalogue device's own default subslot tree
 * (e.g. a CFU PA-profile slot's AI function position(s) + trailing Service module).
 * Single level — no nested slot→subslot tree, no "Auto-attach Server Module" checkbox
 * (that mechanism is station-only; see StationAutoSlotsEditor). Rows with is_autocreated
 * render locked, matching the app-wide "AUTOCREATED ⇒ fixed" convention.
 */
export default function SlotDefaultSubslotsEditor({ orderNo, onClose, inlineMode = true }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (orderNo) loadConfig(orderNo);
  }, [orderNo]);

  async function loadConfig(ord) {
    try {
      setLoading(true);
      const data = await getSlotDefaultSubslots(ord);
      setRows((data.subslots || []).map(s => ({
        position: s.position,
        child_order_no: s.child_order_no || '',
        label: s.label || '',
        is_autocreated: !!s.is_autocreated,
      })));
      setError('');
    } catch (err) {
      setError(`Error loading config: ${err.message}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  function addRow() {
    setRows(prev => {
      const list = prev || [];
      const nextPos = list.length === 0 ? 1 : Math.max(...list.map(r => r.position || 0)) + 1;
      return [...list, { position: nextPos, child_order_no: '', label: '', is_autocreated: false }];
    });
  }

  function deleteRow(position) {
    setRows(prev => (prev || []).filter(r => r.position !== position));
  }

  function updateRow(position, field, value) {
    setRows(prev => (prev || []).map(r => (r.position === position ? { ...r, [field]: value } : r)));
  }

  async function saveConfig() {
    if (!orderNo || !rows) return;
    try {
      setLoading(true);
      await saveSlotDefaultSubslots(orderNo, rows);
      setSuccess('Configuration saved successfully!');
      setTimeout(() => setSuccess(''), 3000);
      setError('');
    } catch (err) {
      setError(`Error saving config: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (!rows) {
    return <div style={{ padding: '20px', color: '#6b7280' }}>Loading configuration...</div>;
  }

  const content = (
    <div style={{ display: 'flex', gap: '20px', flexDirection: 'column' }} className="ig-cfg-editor">
      {error && <div style={{ padding: '12px 16px', background: '#fde2e4', color: '#842029', borderLeft: '4px solid #dc3545' }}>{error}</div>}
      {success && <div style={{ padding: '12px 16px', background: '#d1e7dd', color: '#0f5132', borderLeft: '4px solid #198754' }}>{success}</div>}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ig-toolbar">
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)' }}>
            Slot Configuration
          </span>
          <div className="ig-toolbar-right">
            <span className="ig-count">
              {rows.length} subslot{rows.length !== 1 ? 's' : ''}
            </span>
            <button className="ig-btn ig-btn-primary" onClick={addRow} disabled={loading}>
              + Add Subslot
            </button>
          </div>
        </div>

        <div className="ig-cfg-table">
          <div className="ig-cfg-row ig-cfg-head">
            <div>Subslot</div>
            <div>Order Number</div>
            <div>Label</div>
            <div style={{ textAlign: 'center' }}>Fixed</div>
            <div style={{ textAlign: 'center' }}>Action</div>
          </div>

          {rows.map((r) => (
            <div key={`subslot-${r.position}`} className="ig-cfg-row ig-cfg-subslot">
              <div style={{ fontWeight: 600 }}>{r.position}</div>
              <div>
                {r.is_autocreated ? (
                  <span className="ig-cfg-mono">{r.child_order_no || '—'}</span>
                ) : (
                  <input
                    type="text"
                    value={r.child_order_no}
                    onChange={(e) => updateRow(r.position, 'child_order_no', e.target.value)}
                    placeholder="order_no"
                    style={{ width: '100%', padding: '3px 6px', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }}
                  />
                )}
              </div>
              <div>
                {r.is_autocreated ? (
                  r.label || '—'
                ) : (
                  <input
                    type="text"
                    value={r.label}
                    onChange={(e) => updateRow(r.position, 'label', e.target.value)}
                    placeholder="label"
                    style={{ width: '100%', padding: '3px 6px', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }}
                  />
                )}
              </div>
              <div style={{ textAlign: 'center' }}>{r.is_autocreated ? '🔒' : ''}</div>
              <div className="ig-cfg-actions">
                {!r.is_autocreated && (
                  <button
                    className="ig-cfg-iconbtn ig-cfg-del"
                    onClick={() => deleteRow(r.position)}
                    title="Delete subslot"
                  >
                    <i className="ti ti-trash" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: '4px', textAlign: 'right', paddingRight: '4px' }}>
        <button
          className="ig-btn ig-btn-primary"
          onClick={saveConfig}
          disabled={loading}
          style={{ height: '32px', padding: '0 16px', fontSize: '13px' }}
        >
          Save
        </button>
      </div>
    </div>
  );

  if (inlineMode) return content;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
      background: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 2000,
    }}>
      <div style={{
        background: 'var(--bg-secondary, #fff)', borderRadius: 8, width: '90%', maxWidth: 1000,
        maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)', padding: '20px',
      }}>
        {content}
        {onClose && (
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <button className="ig-btn ig-btn-ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
