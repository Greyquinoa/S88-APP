import React, { useState, useEffect } from 'react';

export default function UnitConnectionsEditor({
  unitType,
  compositeCmTypes = [],
  connections = [],
  cmTypeVars = {},
  onSave,
  onCancel,
  loading = false
}) {
  const [localConns, setLocalConns] = useState(connections || []);
  const [wire, setWire] = useState({
    from_alias: '',
    from_var_name: '',
    to_alias: '',
    to_var_name: '',
    type: 'interconnection',
    static_value: ''
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Keep the local list in sync with the parent's connections prop. Without this,
  // useState only reads the prop on first mount — so after switching windows/tabs
  // (which re-renders or remounts this editor with the latest prop), the local copy
  // would go stale and the connections would appear to vanish. Skip while a save is
  // in flight so we don't clobber an optimistic update mid-request.
  useEffect(() => {
    if (!saving) setLocalConns(connections || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  const memberAliases = ['__UNIT__', ...(unitType.members || []).map(m => m.alias).sort()];

  // cmTypeVars keyed by member alias with structure:
  //   simple    → { kind:'simple', cmTypeName, vars:[{name,dir,dtype,block}] }
  //   composite → { kind:'composite', subMembers:[{subIdx,subAlias,cmTypeName,vars:[...]}] }
  //   __UNIT__  → { kind:'unit', vars:[{name,dir,dtype,block}] }  [synthetic, unit-level outputs]
  const getVariablesForMember = (alias) => {
    // For the unit controller (__UNIT__), return any unit-level outputs from the system.
    // These are typically QCmndUnitCM, QStatUnitCM, QCmndUnitEM, etc. — standard
    // control/status outputs exposed at the unit hierarchy level.
    if (alias === '__UNIT__') {
      return [
        { name: 'QCmndUnitCM',  block: 'Unit',  dir: 'out', subIdx: 0, subAlias: null, label: 'QCmndUnitCM (Unit)'  },
        { name: 'QStatUnitCM',  block: 'Unit',  dir: 'out', subIdx: 0, subAlias: null, label: 'QStatUnitCM (Unit)'  },
        { name: 'QCmndUnitEM',  block: 'Unit',  dir: 'out', subIdx: 0, subAlias: null, label: 'QCmndUnitEM (Unit)'  },
        { name: 'QStatUnitEM',  block: 'Unit',  dir: 'out', subIdx: 0, subAlias: null, label: 'QStatUnitEM (Unit)'  },
      ];
    }
    const entry = cmTypeVars[alias];
    if (!entry) return [];

    const out = [];
    if (entry.kind === 'composite') {
      for (const sub of entry.subMembers || []) {
        for (const v of sub.vars || []) {
          out.push({
            name: v.name,
            block: v.block,
            dir: v.dir,
            subIdx: sub.subIdx,
            subAlias: sub.subAlias,
            label: `${sub.subAlias} › ${v.name} (${v.block})`
          });
        }
      }
    } else {
      for (const v of entry.vars || []) {
        out.push({
          name: v.name,
          block: v.block,
          dir: v.dir,
          subIdx: 0,
          subAlias: null,
          label: `${v.name} (${v.block})`
        });
      }
    }
    return out;
  };

  const encodeVar = (v) => `${v.subIdx}::${v.name}`;
  const decodeVar = (val) => {
    const i = val.indexOf('::');
    if (i === -1) return { subIdx: 0, name: val };
    return { subIdx: parseInt(val.slice(0, i)) || 0, name: val.slice(i + 2) };
  };

  const isInterconnection = wire.type === 'interconnection';
  const isValue = wire.type === 'value';
  const fromVars = getVariablesForMember(wire.from_alias).filter(v => isValue || v.dir === 'out' || v.dir === 'inout');
  const toVars = getVariablesForMember(wire.to_alias).filter(v => v.dir === 'in' || v.dir === 'inout');

  // Persist the given list to the backend, rolling back local state on failure.
  const persist = async (nextConns) => {
    const prev = localConns;
    setLocalConns(nextConns);
    setSaving(true);
    try {
      await onSave(nextConns);
    } catch (err) {
      setLocalConns(prev); // revert on failure
      setError(`Failed to save: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const addConnection = async () => {
    setError('');
    if (!wire.from_alias || !wire.to_alias || !wire.to_var_name) {
      setError('Please fill all required fields');
      return;
    }
    if (isInterconnection && !wire.from_var_name) {
      setError('From variable required for Interconnection');
      return;
    }
    if (isValue && !wire.static_value) {
      setError('Static value required for Value type');
      return;
    }

    // Decode variables to get sub-indices
    const fromData = isInterconnection ? decodeVar(`${wire.from_var_name}`) : { subIdx: 0, name: '' };
    const toData = decodeVar(`${wire.to_var_name}`);

    // Check duplicate
    const isDuplicate = localConns.some(c =>
      c.from_alias === wire.from_alias &&
      c.from_sub_idx === (fromData.subIdx) &&
      c.from_var_name === fromData.name &&
      c.to_alias === wire.to_alias &&
      c.to_sub_idx === (toData.subIdx) &&
      c.to_var_name === toData.name &&
      c.conn_type === wire.type
    );

    if (isDuplicate) {
      setError('This connection already exists');
      return;
    }

    const connToSave = {
      conn_type: wire.type,
      from_alias: wire.from_alias,
      from_sub_idx: fromData.subIdx || 0,
      from_var_name: fromData.name || '',
      to_alias: wire.to_alias,
      to_sub_idx: toData.subIdx || 0,
      to_var_name: toData.name,
      static_value: wire.static_value || '',
      sort_order: localConns.length
    };

    // Reset the form and persist immediately
    setWire({
      from_alias: '',
      from_var_name: '',
      to_alias: '',
      to_var_name: '',
      type: 'interconnection',
      static_value: ''
    });
    await persist([...localConns, connToSave]);
  };

  const removeConnection = async (idx) => {
    setError('');
    await persist(localConns.filter((_, i) => i !== idx));
  };

  // Helper to resolve member + sub_idx to label
  const memberLabel = (alias, subIdx) => {
    if (alias === '__UNIT__') return `${unitType.name} [Unit]`;
    const entry = cmTypeVars[alias];
    if (entry && entry.kind === 'composite') {
      const sub = (entry.subMembers || []).find(s => s.subIdx === (subIdx ?? 0));
      return sub ? `${alias}[${sub.subAlias}]` : `${alias}[${subIdx ?? 0}]`;
    }
    return alias;
  };

  // Tag components (matching composite style)
  const TagOUT = () => (
    <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
        background: '#DCFCE7', color: '#166534', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>OUT</span>
  );
  const TagIN = () => (
    <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
        background: '#DBEAFE', color: '#1D4ED8', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>IN</span>
  );
  const TagVAL = () => (
    <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
        background: '#FEF9C3', color: '#854D0E', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>VAL</span>
  );

  const selStyle = (borderColor) => ({
    width: '100%', padding: '5px 6px', border: `0.5px solid ${borderColor}`,
    borderRadius: 'var(--border-radius-md)', fontSize: 11, boxSizing: 'border-box',
    fontFamily: 'inherit', background: 'var(--color-background-primary)',
    color: 'var(--color-text-primary)', cursor: 'pointer'
  });

  return (
    <div style={{ padding: '0.75rem' }}>
      <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '14px', fontWeight: 'bold' }}>
        Wiring: {unitType.name}
      </h3>

      {error && (
        <div style={{ padding: '0.6rem 0.8rem', marginBottom: '1rem', background: '#FEE2E2', border: '0.5px solid #FECACA',
            borderRadius: '4px', color: '#991B1B', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {/* Existing Connections — grey panel wrapping the saved list (Composite CM style) */}
      {localConns.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
              color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
            CONNECTIONS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
              padding: '10px 12px', background: 'var(--color-background-secondary)',
              border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)' }}>
            {localConns.map((c, idx) => {
              if (c.conn_type === 'value') {
                const toLabel = `${memberLabel(c.to_alias, c.to_sub_idx)} · ${c.to_var_name}`;
                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6,
                      padding: '5px 10px', background: '#FEFCE8',
                      border: '0.5px solid #FDE68A', borderRadius: 'var(--border-radius-md)' }}>
                    <TagVAL />
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#854D0E' }}>
                      {c.static_value}
                    </span>
                    <i className="ti ti-arrow-right" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }} />
                    <TagIN />
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{toLabel}</span>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => removeConnection(idx)}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                        color: '#DC2626', fontSize: 14, padding: '2px 4px' }}>
                      <i className="ti ti-x" />
                    </button>
                  </div>
                );
              }

              const fromLabel = `${memberLabel(c.from_alias, c.from_sub_idx)} · ${c.from_var_name}`;
              const toLabel = `${memberLabel(c.to_alias, c.to_sub_idx)} · ${c.to_var_name}`;
              return (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 10px', background: 'var(--color-background-primary)',
                    border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)' }}>
                  <TagOUT />
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{fromLabel}</span>
                  <i className="ti ti-arrow-right" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }} />
                  <TagIN />
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{toLabel}</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => removeConnection(idx)}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                      color: '#DC2626', fontSize: 14, padding: '2px 4px' }}>
                    <i className="ti ti-x" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Connection Type Toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--color-text-secondary)', alignSelf: 'center', marginRight: 4 }}>Type:</div>
        {[
          { val: 'interconnection', label: 'Interconnection', desc: 'Output → Input', on: '#6366F1', bg: '#EEF2FF', fg: '#4338CA' },
          { val: 'value', label: 'Value', desc: 'Static → Input', on: '#D97706', bg: '#FEF3C7', fg: '#92400E' }
        ].map(opt => (
          <button key={opt.val} onClick={() => setWire(w => ({ ...w, type: opt.val, from_var_name: '', static_value: '' }))}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
              border: `1.5px solid ${wire.type === opt.val ? opt.on : 'var(--color-border-secondary)'}`,
              borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: wire.type === opt.val ? opt.bg : 'var(--color-background-primary)',
              color: wire.type === opt.val ? opt.fg : 'var(--color-text-secondary)',
            }}>
            {opt.label}
            <span style={{ fontWeight: 400, opacity: 0.75, fontSize: 10 }}>({opt.desc})</span>
          </button>
        ))}
      </div>

      {/* Add-connection row — single horizontal layout like Composite CM connections */}
      <div style={{ border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)',
          padding: '10px 12px', background: 'var(--color-background-secondary)', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>

          {/* Source group — Interconnection only */}
          {isInterconnection && (
            <>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.04em', color: '#166534', marginBottom: 3 }}>Output from member</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <select value={wire.from_alias}
                    onChange={e => setWire(w => ({ ...w, from_alias: e.target.value, from_var_name: '' }))}
                    style={{ ...selStyle('#86EFAC'), flex: '0 0 40%' }}>
                    <option value="">— member —</option>
                    {memberAliases.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <select value={wire.from_var_name}
                    onChange={e => setWire(w => ({ ...w, from_var_name: e.target.value }))}
                    disabled={!wire.from_alias}
                    style={{ ...selStyle('#86EFAC'), flex: 1 }}>
                    <option value="">— output var —</option>
                    {fromVars.map(v => (
                      <option key={`${v.subIdx}-${v.name}`} value={encodeVar(v)}>{v.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 18, color: 'var(--color-text-secondary)', paddingBottom: 4, flexShrink: 0 }}>→</div>
            </>
          )}

          {/* Static value group — Value only */}
          {isValue && (
            <>
              <div style={{ flex: '0 0 160px' }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.04em', color: '#854D0E', marginBottom: 3 }}>Static value</div>
                <input value={wire.static_value}
                  onChange={e => setWire(w => ({ ...w, static_value: e.target.value }))}
                  placeholder='e.g. 1, true, "text"'
                  style={{ ...selStyle('#FCD34D'), fontFamily: 'var(--font-mono)', cursor: 'text' }} />
              </div>
              <div style={{ fontSize: 18, color: 'var(--color-text-secondary)', paddingBottom: 4, flexShrink: 0 }}>→</div>
            </>
          )}

          {/* Destination group — always shown */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: '#1D4ED8', marginBottom: 3 }}>Input to member</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <select value={wire.to_alias}
                onChange={e => setWire(w => ({ ...w, to_alias: e.target.value, to_var_name: '' }))}
                style={{ ...selStyle('#93C5FD'), flex: '0 0 40%' }}>
                <option value="">— member —</option>
                {memberAliases.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <select value={wire.to_var_name}
                onChange={e => setWire(w => ({ ...w, to_var_name: e.target.value }))}
                disabled={!wire.to_alias}
                style={{ ...selStyle('#93C5FD'), flex: 1 }}>
                <option value="">— input var —</option>
                {toVars.map(v => (
                  <option key={`${v.subIdx}-${v.name}`} value={encodeVar(v)}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Add button — persists immediately */}
          <button onClick={addConnection} disabled={saving || loading}
            style={{ padding: '5px 12px', background: saving || loading ? '#D1D5DB' : '#10B981',
              color: 'white', border: 'none', borderRadius: 'var(--border-radius-md)',
              cursor: saving || loading ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>
            <i className={`ti ${saving ? 'ti-loader-2' : 'ti-plus'}`} style={{ fontSize: 13 }} />
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
