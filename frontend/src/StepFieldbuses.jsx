// StepFieldbuses.jsx — Fieldbuses tab (migrated from App2, App1 inline-style)
import React, { useState, useEffect, useCallback } from 'react';
import {
  listHwControllers,
  listHwFieldbuses, createHwFieldbus, updateHwFieldbus, deleteHwFieldbus,
} from './api.js';

const S = {
  input: {
    width: '100%', padding: '6px 10px',
    border: '0.5px solid var(--color-border-secondary)',
    borderRadius: 'var(--border-radius-md)', fontSize: 13,
    background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
    boxSizing: 'border-box',
  },
  cellInput: {
    width: '100%', border: '1px solid #93c5fd',
    borderRadius: 4, padding: '2px 6px', fontSize: '0.8125rem',
    background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
    boxSizing: 'border-box',
  },
  th: {
    padding: '6px 10px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: 'var(--color-text-secondary)',
    borderBottom: '0.5px solid var(--color-border-tertiary)',
    background: 'var(--color-background-secondary)', textAlign: 'left',
  },
  td: {
    padding: '6px 10px', fontSize: 13, borderBottom: '0.5px solid var(--color-border-tertiary)',
    color: 'var(--color-text-primary)',
  },
};

export default function StepFieldbuses({ projectId }) {
  const [controllers, setControllers]   = useState([]);
  const [controllerId, setControllerId] = useState(null);
  const [rows, setRows]                 = useState([]);
  const [loading, setLoading]           = useState(false);
  const [editingId, setEditingId]       = useState(null);
  const [draft, setDraft]               = useState({});
  const [error, setError]               = useState('');

  // Load controller list for project
  useEffect(() => {
    if (!projectId) return;
    listHwControllers(projectId).then(data => {
      setControllers(data);
      if (data.length > 0 && !controllerId) setControllerId(data[0].id);
    }).catch(e => setError(e.message));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!controllerId) { setRows([]); return; }
    setLoading(true);
    try {
      const data = await listHwFieldbuses(controllerId);
      setRows(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [controllerId]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (row) => { setEditingId(row.id); setDraft({ ...row }); };
  const startNew = () => {
    setEditingId('new');
    setDraft({ hw_controller_id: controllerId, INT_DP_Subsystem: '', INT_Bus_DP_Address: '', T50_Fieldbus_Name: '' });
  };
  const cancel = () => { setEditingId(null); setDraft({}); };

  const save = async () => {
    try {
      if (editingId === 'new') {
        await createHwFieldbus(draft);
      } else {
        await updateHwFieldbus(editingId, draft);
      }
      cancel();
      await load();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this fieldbus? Stations that reference it will be unaffected but orphaned.')) return;
    try {
      await deleteHwFieldbus(id);
      await load();
    } catch (e) { setError(e.message); }
  };

  if (!projectId) {
    return (
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, paddingTop: '2rem', textAlign: 'center' }}>
        Select or create a project first.
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Fieldbuses</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Define PROFIBUS-DP fieldbuses for each controller. Stations are assigned to a fieldbus.
        </div>
      </div>

      {error && (
        <div style={{ background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 'var(--border-radius-md)',
            padding: '8px 12px', marginBottom: '1rem', fontSize: 13, color: '#991B1B' }}>
          {error}
        </div>
      )}

      {/* Controller selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
        <label style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--color-text-secondary)' }}>
          Controller
        </label>
        {controllers.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            No controllers — create one on the Controller tab first.
          </span>
        ) : (
          <select value={controllerId || ''} onChange={e => setControllerId(Number(e.target.value))}
            style={{ ...S.input, width: 'auto', minWidth: 200 }}>
            {controllers.map(c => (
              <option key={c.id} value={c.id}>
                {c.T16_Controller_TagName || `Controller #${c.id}`}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Fieldbus table */}
      <div style={{ border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)', overflow: 'hidden',
          background: 'var(--color-background-primary)' }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px', borderBottom: '0.5px solid var(--color-border-tertiary)',
            background: 'var(--color-background-secondary)' }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Fieldbuses</span>
          <button onClick={startNew} disabled={!controllerId || controllers.length === 0}
            style={{ fontSize: 13, color: '#2563EB', background: 'transparent', border: 'none',
                cursor: controllerId ? 'pointer' : 'default', fontWeight: 500 }}>
            + Add fieldbus
          </button>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Subsystem No.', 'DP Address', 'Name', 'Driver', 'IP Address', ''].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {editingId === 'new' && (
              <EditRow draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} />
            )}
            {rows.map(row =>
              editingId === row.id ? (
                <EditRow key={row.id} draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} />
              ) : (
                <tr key={row.id}>
                  <td style={S.td}>{row.INT_DP_Subsystem ?? '—'}</td>
                  <td style={S.td}>{row.INT_Bus_DP_Address ?? '—'}</td>
                  <td style={S.td}>
                    {row.T50_Fieldbus_Name
                      ? `${row.T50_Fieldbus_Name}: PROFINET IO system (${row.INT_DP_Subsystem ?? '?'})`
                      : '—'}
                  </td>
                  <td style={S.td}>{row.LINT_T_Driver ?? '—'}</td>
                  <td style={S.td}>{row.T15_IP_Address || '—'}</td>
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEdit(row)}
                      style={{ fontSize: 12, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', marginRight: 12 }}>
                      Edit
                    </button>
                    <button onClick={() => remove(row.id)}
                      style={{ fontSize: 12, color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              )
            )}
            {!loading && rows.length === 0 && editingId !== 'new' && (
              <tr>
                <td colSpan={6} style={{ ...S.td, textAlign: 'center', color: 'var(--color-text-secondary)', padding: '2rem' }}>
                  {controllers.length === 0
                    ? 'Create a controller first, then add fieldbuses.'
                    : 'No fieldbuses yet for this controller.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditRow({ draft, setDraft, onSave, onCancel }) {
  const set = (field, value) => setDraft(d => ({ ...d, [field]: value }));
  const ci = { width: '100%', border: '1px solid #93c5fd', borderRadius: 4,
    padding: '2px 6px', fontSize: '0.8125rem',
    background: 'var(--color-background-primary)', color: 'var(--color-text-primary)', boxSizing: 'border-box' };
  const td = { padding: '5px 8px', borderBottom: '0.5px solid var(--color-border-tertiary)' };
  return (
    <tr style={{ background: 'rgba(219, 234, 254, 0.3)' }}>
      <td style={td}><input style={ci} type="number" value={draft.INT_DP_Subsystem ?? ''}
        onChange={e => set('INT_DP_Subsystem', e.target.value === '' ? '' : Number(e.target.value))} /></td>
      <td style={td}><input style={ci} type="number" value={draft.INT_Bus_DP_Address ?? ''}
        onChange={e => set('INT_Bus_DP_Address', e.target.value === '' ? '' : Number(e.target.value))} /></td>
      <td style={td}><input style={ci} value={draft.T50_Fieldbus_Name ?? ''}
        onChange={e => set('T50_Fieldbus_Name', e.target.value)} /></td>
      <td style={td}><input style={ci} value={draft.LINT_T_Driver ?? ''}
        onChange={e => set('LINT_T_Driver', e.target.value)} /></td>
      <td style={td}><input style={ci} value={draft.T15_IP_Address ?? ''}
        onChange={e => set('T15_IP_Address', e.target.value)} /></td>
      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button onClick={onSave} style={{ fontSize: 12, color: '#16A34A', background: 'none', border: 'none',
            cursor: 'pointer', fontWeight: 500, marginRight: 10 }}>Save</button>
        <button onClick={onCancel} style={{ fontSize: 12, color: 'var(--color-text-secondary)',
            background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
      </td>
    </tr>
  );
}
