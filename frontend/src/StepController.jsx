// StepController.jsx — Controller editor panel (no sidebar; controller selected by parent)
import React, { useState, useEffect } from 'react';
import {
  updateHwController, deleteHwController,
  listHwModuleTemplates,
  listHwFieldbuses, createHwFieldbus, updateHwFieldbus, deleteHwFieldbus,
} from './api.js';

const STATION_TYPES = ['S7400', 'S7300', 'WinAC'];

const S = {
  card: {
    border: '0.5px solid var(--color-border-tertiary)',
    borderRadius: 'var(--border-radius-lg)',
    padding: '1rem 1.25rem',
    background: 'var(--color-background-primary)',
    marginBottom: '1rem',
  },
  cardTitle: {
    fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: 'var(--color-text-secondary)',
    marginBottom: '0.75rem',
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  label: {
    display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 4,
  },
  input: {
    display: 'block', width: '100%', padding: '6px 10px',
    border: '0.5px solid var(--color-border-secondary)',
    borderRadius: 'var(--border-radius-md)', fontSize: 13,
    background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
    boxSizing: 'border-box',
  },
  select: {
    display: 'block', width: '100%', padding: '6px 10px',
    border: '0.5px solid var(--color-border-secondary)',
    borderRadius: 'var(--border-radius-md)', fontSize: 13,
    background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
    boxSizing: 'border-box',
  },
  btnPrimary: {
    padding: '7px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
    background: 'var(--color-text-primary)', color: '#fff',
    border: 'none', borderRadius: 'var(--border-radius-md)',
  },
  btnSecondary: {
    padding: '7px 14px', fontSize: 13, cursor: 'pointer',
    background: 'transparent', color: 'var(--color-text-primary)',
    border: '0.5px solid var(--color-border-secondary)',
    borderRadius: 'var(--border-radius-md)',
  },
  btnDanger: {
    padding: '7px 14px', fontSize: 13, cursor: 'pointer',
    background: 'transparent', color: '#DC2626',
    border: '0.5px solid #FCA5A5',
    borderRadius: 'var(--border-radius-md)',
  },
};

export default function StepController({ controller, onSaved, onDeleted, pipMappings = [] }) {
  const [form, setForm]         = useState(null);
  const [saving, setSaving]     = useState(false);
  const [savedAt, setSavedAt]   = useState(null);
  const [hwLibrary, setHwLibrary] = useState([]);
  const [error, setError]       = useState('');

  const [fieldbuses, setFieldbuses]   = useState([]);
  const [fbEditingId, setFbEditingId] = useState(null);
  const [fbDraft, setFbDraft]         = useState({});

  useEffect(() => {
    listHwModuleTemplates().then(setHwLibrary).catch(() => {});
  }, []);

  useEffect(() => {
    if (!controller) { setForm(null); setFieldbuses([]); return; }
    setForm({ ...controller });
    setSavedAt(null);
    setFbEditingId(null);
    setFbDraft({});
    listHwFieldbuses(controller.id).then(setFieldbuses).catch(() => setFieldbuses([]));
  }, [controller?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  // ── Fieldbus handlers ────────────────────────────────────────────────────────
  const fbStartNew = () => {
    setFbEditingId('new');
    setFbDraft({ hw_controller_id: controller?.id, INT_DP_Subsystem: '', INT_Bus_DP_Address: '', T50_Fieldbus_Name: '', LINT_T_Driver: '', T15_IP_Address: '' });
  };
  const fbCancel = () => { setFbEditingId(null); setFbDraft({}); };
  const fbSave = async () => {
    try {
      if (fbEditingId === 'new') await createHwFieldbus(fbDraft);
      else await updateHwFieldbus(fbEditingId, fbDraft);
      setFieldbuses(await listHwFieldbuses(controller.id));
      fbCancel();
    } catch (e) { setError(e.message); }
  };
  const fbDelete = async (id) => {
    if (!window.confirm('Delete this fieldbus?')) return;
    try {
      await deleteHwFieldbus(id);
      setFieldbuses(prev => prev.filter(f => f.id !== id));
    } catch (e) { setError(e.message); }
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await updateHwController(form.id, form);
      setSavedAt(Date.now());
      setError('');
      onSaved?.();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!controller) return;
    if (!window.confirm(`Delete controller "${controller.T16_Controller_TagName}" and all its fieldbuses? This cannot be undone.`)) return;
    try {
      await deleteHwController(controller.id);
      onDeleted?.();
    } catch (e) { setError(e.message); }
  };

  if (!controller) {
    return (
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, paddingTop: '3rem', textAlign: 'center' }}>
        Select a controller from the list.
      </div>
    );
  }

  if (!form) return null;

  return (
    <div>
      {error && (
        <div style={{ background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 'var(--border-radius-md)',
            padding: '8px 12px', marginBottom: '1rem', fontSize: 13, color: '#991B1B' }}>
          {error}
        </div>
      )}

      {/* Identity */}
      <div style={S.card}>
        <div style={S.cardTitle}>Identity</div>
        <div style={S.grid2}>
          <Field label="Controller Tag Name">
            <input style={S.input} value={form.T16_Controller_TagName || ''}
              onChange={e => set('T16_Controller_TagName', e.target.value)} />
          </Field>
          <Field label="Station Type">
            <select style={S.select} value={form.T16_Station_Type || ''}
              onChange={e => set('T16_Station_Type', e.target.value)}>
              {STATION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {/* Fieldbuses */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div style={S.cardTitle}>Fieldbuses</div>
          <button onClick={fbStartNew}
            style={{ fontSize: 12, color: '#2563EB', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
            + Add fieldbus
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['Subsystem No.', 'DP Address', 'Name', 'Driver', 'IP Address', ''].map(h => (
                <th key={h} style={{ padding: '5px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.04em', color: 'var(--color-text-secondary)',
                    borderBottom: '0.5px solid var(--color-border-tertiary)', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fbEditingId === 'new' && (
              <FbEditRow draft={fbDraft} setDraft={setFbDraft} onSave={fbSave} onCancel={fbCancel} />
            )}
            {fieldbuses.map(fb =>
              fbEditingId === fb.id ? (
                <FbEditRow key={fb.id} draft={fbDraft} setDraft={setFbDraft} onSave={fbSave} onCancel={fbCancel} />
              ) : (
                <tr key={fb.id}>
                  <td style={fbTd}>{fb.INT_DP_Subsystem ?? '—'}</td>
                  <td style={fbTd}>{fb.INT_Bus_DP_Address ?? '—'}</td>
                  <td style={fbTd}>
                    {fb.T50_Fieldbus_Name
                      ? `${fb.T50_Fieldbus_Name}: PROFINET IO system (${fb.INT_DP_Subsystem ?? '?'})`
                      : '—'}
                  </td>
                  <td style={fbTd}>{fb.LINT_T_Driver ?? '—'}</td>
                  <td style={fbTd}>{fb.T15_IP_Address || '—'}</td>
                  <td style={{ ...fbTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => { setFbEditingId(fb.id); setFbDraft({ ...fb }); }}
                      style={{ fontSize: 12, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', marginRight: 10 }}>
                      Edit
                    </button>
                    <button onClick={() => fbDelete(fb.id)}
                      style={{ fontSize: 12, color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              )
            )}
            {fieldbuses.length === 0 && fbEditingId !== 'new' && (
              <tr>
                <td colSpan={6} style={{ ...fbTd, textAlign: 'center', color: 'var(--color-text-secondary)', padding: '1rem' }}>
                  No fieldbuses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Process Image Partitions */}
      {pipMappings.length > 0 && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <div style={S.cardTitle}>Process Image Partitions</div>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {pipMappings.length} active PIP{pipMappings.length !== 1 ? 's' : ''}
            </span>
          </div>
          <table style={{ width: 'auto', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['PIP', 'Cyclic Update OB', 'Execution Time'].map(h => (
                  <th key={h} style={{ padding: '5px 16px 5px 0', fontSize: 11, fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                      color: 'var(--color-text-secondary)',
                      borderBottom: '0.5px solid var(--color-border-tertiary)', textAlign: 'left' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pipMappings.map((p, i) => (
                <tr key={p.pipNo} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--color-background-secondary)' }}>
                  <td style={{ ...fbTd, fontWeight: 700, color: '#2255cc', fontFamily: 'var(--font-mono, monospace)', paddingRight: 24 }}>
                    PIP{p.pipNo}
                  </td>
                  <td style={{ ...fbTd, fontFamily: 'var(--font-mono, monospace)', paddingRight: 24 }}>
                    OB{p.ob}
                  </td>
                  <td style={{ ...fbTd, fontVariantNumeric: 'tabular-nums' }}>
                    {p.executionTime} {p.timeScale}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Hardware */}
      <div style={S.card}>
        <div style={S.cardTitle}>Hardware</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: '0.75rem', marginTop: -4 }}>
          Populated automatically on CFG import.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <span style={S.label}>Rack</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={S.input} placeholder="Part Number" value={form.T50_Rack_Order_No || ''}
                onChange={e => set('T50_Rack_Order_No', e.target.value)} />
              <input style={S.input} placeholder="Type" value={form.T50_Rack_Name || ''}
                onChange={e => set('T50_Rack_Name', e.target.value)} />
            </div>
          </div>
          <div>
            <span style={S.label}>Power Supply</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={S.input} placeholder="Part Number" value={form.T50_PS_Order_No || ''}
                onChange={e => set('T50_PS_Order_No', e.target.value)} />
              <input style={S.input} placeholder="Type" value={form.T50_PS_Name || ''}
                onChange={e => set('T50_PS_Name', e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      {/* Flags */}
      <div style={S.card}>
        <div style={S.cardTitle}>Flags</div>
        <div style={{ display: 'flex', gap: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.YN_Redundant}
              onChange={e => set('YN_Redundant', e.target.checked ? 1 : 0)} />
            Redundant
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.YN_Slave}
              onChange={e => set('YN_Slave', e.target.checked ? 1 : 0)} />
            Slave
          </label>
        </div>
      </div>

      {/* Documentation */}
      <div style={S.card}>
        <div style={S.cardTitle}>Documentation</div>
        <Field label="Change note">
          <textarea style={{ ...S.input, height: 72, resize: 'vertical', fontFamily: 'inherit' }}
            value={form.MEM_Doc_Change || ''}
            onChange={e => set('MEM_Doc_Change', e.target.value)} />
        </Field>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <button onClick={handleSave} disabled={saving}
          style={{ ...S.btnPrimary, opacity: saving ? 0.5 : 1 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {savedAt && <span style={{ fontSize: 12, color: '#16A34A' }}>Saved</span>}
        <div style={{ flex: 1 }} />
        <button onClick={handleDelete} style={S.btnDanger}>Delete controller</button>
      </div>
    </div>
  );
}

const fbTd = {
  padding: '5px 8px', fontSize: 13,
  borderBottom: '0.5px solid var(--color-border-tertiary)',
  color: 'var(--color-text-primary)',
};

function FbEditRow({ draft, setDraft, onSave, onCancel }) {
  const set = (field, value) => setDraft(d => ({ ...d, [field]: value }));
  const ci = {
    width: '100%', border: '1px solid #93c5fd', borderRadius: 4,
    padding: '2px 6px', fontSize: '0.8125rem',
    background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
    boxSizing: 'border-box',
  };
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

function Field({ label, children }) {
  return (
    <div>
      <span style={S.label}>{label}</span>
      {children}
    </div>
  );
}

function HwPicker({ label, orderNo, name, library, onSelect, onChangeOrderNo, onChangeName }) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);

  const filtered = query.length < 2 ? [] : library.filter(h =>
    (h.display_name || '').toLowerCase().includes(query.toLowerCase()) ||
    (h.order_no || '').toLowerCase().includes(query.toLowerCase())
  ).slice(0, 30);

  const pick = (hw) => { onSelect(hw); setQuery(''); setOpen(false); };

  return (
    <div>
      <span style={S.label}>{label}</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
        <input style={S.input} placeholder="Order No." value={orderNo}
          onChange={e => onChangeOrderNo(e.target.value)} />
        <input style={S.input} placeholder="Name" value={name}
          onChange={e => onChangeName(e.target.value)} />
      </div>
      <div style={{ position: 'relative' }}>
        <input style={{ ...S.input, fontSize: 12 }}
          placeholder={`Search catalogue for ${label.toLowerCase()}…`}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => filtered.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)} />
        {open && filtered.length > 0 && (
          <ul style={{ position: 'absolute', zIndex: 30, left: 0, right: 0, marginTop: 2,
              maxHeight: 180, overflowY: 'auto', background: 'var(--color-background-primary)',
              border: '0.5px solid var(--color-border-secondary)', borderRadius: 'var(--border-radius-md)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.10)', listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.map(hw => (
              <li key={hw.id} onMouseDown={() => pick(hw)}
                style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12,
                    display: 'flex', justifyContent: 'space-between', gap: 8,
                    borderBottom: '0.5px solid var(--color-border-tertiary)' }}
                onMouseEnter={e => e.currentTarget.style.background = '#F0F9FF'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ fontWeight: 500 }}>{hw.display_name}</span>
                <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {hw.order_no}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
