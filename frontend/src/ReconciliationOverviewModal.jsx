import { useState, useMemo, useCallback } from 'react';
import {
  Btn, Callout, StatTile, Tag, textInputSx, EmptyState, ROW_SELECTED_BG,
} from './ImportUIKit.jsx';
import {
  runReconciliation, getReconciliationInstances,
  bulkAcceptDummyInstances, bulkRevertDummyInstances,
} from './api.js';

const STATUS_TAGS = {
  OK:             { color: 'green',  label: 'OK' },
  IMPORTED_OK:    { color: 'blue',   label: 'Imported (OK)' },
  DUMMY:          { color: 'red',    label: 'Dummy' },
  DUMMY_ACCEPTED: { color: 'yellow', label: 'Dummy Accepted' },
  ERROR:          { color: 'purple', label: 'Inconsistent' },
  PENDING:        { color: 'gray',   label: 'Not reconciled' },
};

const FILTERS = ['ALL', 'OK', 'IMPORTED_OK', 'DUMMY', 'DUMMY_ACCEPTED', 'ERROR'];
const smBtnSx = { padding: '4px 10px', fontSize: 12 };

export default function ReconciliationOverviewModal({ projectId, instances: initialInstances, onClose, onDataUpdate }) {
  const [instances, setInstances] = useState(initialInstances || []);
  const [loading, setLoading] = useState(!initialInstances);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getReconciliationInstances(projectId);
      setInstances(res.instances || []);
      setSelected(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const summary = useMemo(() => {
    const counts = { OK: 0, IMPORTED_OK: 0, DUMMY: 0, DUMMY_ACCEPTED: 0, ERROR: 0, PENDING: 0 };
    for (const i of instances) {
      if (counts[i.reconciliationStatus] !== undefined) counts[i.reconciliationStatus]++;
    }
    return counts;
  }, [instances]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return instances.filter(i => {
      if (filter !== 'ALL' && i.reconciliationStatus !== filter) return false;
      if (term && !i.instanceName.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [instances, filter, search]);

  const selectedVisible = useMemo(
    () => visible.filter(i => selected.has(i.id)),
    [visible, selected],
  );
  const acceptableIds = selectedVisible.filter(i => i.reconciliationStatus === 'DUMMY').map(i => i.id);
  const revertableIds = selectedVisible.filter(i => i.reconciliationStatus === 'DUMMY_ACCEPTED').map(i => i.id);

  const toggleRow = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(prev => {
      const allShown = visible.length > 0 && visible.every(i => prev.has(i.id));
      if (allShown) return new Set();
      return new Set(visible.map(i => i.id));
    });
  };

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await runReconciliation(projectId);
      const c = res.countsPerStatus || {};
      setNotice(
        `Reconciled ${res.instancesUpdated} instance(s): ` +
        `${c.OK || 0} OK · ${c.IMPORTED_OK || 0} Imported · ` +
        `${c.DUMMY || 0} Dummy · ${c.DUMMY_ACCEPTED || 0} Accepted`
      );
      await load();
      onDataUpdate?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const handleBulkAccept = async () => {
    if (!acceptableIds.length) return;
    if (!confirm(`Accept ${acceptableIds.length} dummy instance(s)? They will be included in the XML export.`)) return;
    setError(null);
    try {
      await bulkAcceptDummyInstances(acceptableIds, 'user');
      await load();
      onDataUpdate?.();
    } catch (e) { setError(e.message); }
  };

  const handleBulkRevert = async () => {
    if (!revertableIds.length) return;
    if (!confirm(`Revert ${revertableIds.length} instance(s) to Dummy? They will be excluded from the XML export.`)) return;
    setError(null);
    try {
      await bulkRevertDummyInstances(revertableIds);
      await load();
      onDataUpdate?.();
    } catch (e) { setError(e.message); }
  };

  const handleRowAccept = async (id) => {
    setError(null);
    try {
      await bulkAcceptDummyInstances([id], 'user');
      await load();
      onDataUpdate?.();
    } catch (e) { setError(e.message); }
  };

  const handleRowRevert = async (id) => {
    setError(null);
    try {
      await bulkRevertDummyInstances([id]);
      await load();
      onDataUpdate?.();
    } catch (e) { setError(e.message); }
  };

  const allShownSelected = visible.length > 0 && visible.every(i => selected.has(i.id));

  return (
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
      zIndex: 9999,
      padding: '20px',
    }}>
      <div style={{
        background: 'white',
        borderRadius: '8px',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
        width: '100%',
        maxWidth: '1200px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '20px',
          borderBottom: '1px solid var(--color-border-tertiary)',
        }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '18px', fontWeight: 600 }}>Reconciliation Overview</h2>
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              {instances.length} instances · {summary.OK} OK, {summary.IMPORTED_OK} imported, {summary.DUMMY} dummy, {summary.ERROR} error
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              color: 'var(--color-text-secondary)',
              padding: '0',
            }}
            title="Close modal"
          >
            ×
          </button>
        </div>

        {/* Content - scrollable */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Btn primary onClick={handleRun} disabled={running}>
              {running ? 'Running…' : 'Run Reconciliation'}
            </Btn>
            <Btn onClick={load} disabled={loading || running}>Refresh</Btn>
          </div>

          {/* Error/notice messages */}
          {error  && <Callout tone="danger">{error}</Callout>}
          {notice && <Callout tone="success">{notice}</Callout>}
          {summary.DUMMY > 0 && (
            <Callout tone="warning">
              {summary.DUMMY} unaccepted dummy instance(s) will be excluded from the XML export.
            </Callout>
          )}
          {summary.ERROR > 0 && (
            <Callout tone="danger">
              {summary.ERROR} instance(s) are neither imported nor generated — this indicates inconsistent data.
            </Callout>
          )}

          {/* Status cards grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            <StatTile label="OK"             value={summary.OK} />
            <StatTile label="Imported (OK)"  value={summary.IMPORTED_OK} />
            <StatTile label="Dummy"          value={summary.DUMMY} />
            <StatTile label="Dummy Accepted" value={summary.DUMMY_ACCEPTED} />
          </div>

          {/* Filter and search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                style={{ ...textInputSx, maxWidth: 260 }}
                placeholder="Search tag name…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {FILTERS.map(f => (
                  <Btn key={f} style={smBtnSx} primary={filter === f} onClick={() => setFilter(f)}>
                    {f === 'ALL' ? 'All' : (STATUS_TAGS[f]?.label || f)}
                  </Btn>
                ))}
              </div>
            </div>

            {selectedVisible.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {selectedVisible.length} selected
                </span>
                <Btn style={smBtnSx} green onClick={handleBulkAccept} disabled={!acceptableIds.length}>
                  Accept ({acceptableIds.length})
                </Btn>
                <Btn style={smBtnSx} danger onClick={handleBulkRevert} disabled={!revertableIds.length}>
                  Revert to Dummy ({revertableIds.length})
                </Btn>
              </div>
            )}
          </div>

          {/* Table */}
          {loading ? (
            <EmptyState>Loading…</EmptyState>
          ) : visible.length === 0 ? (
            <EmptyState>No instances match the current filter.</EmptyState>
          ) : (
            <div style={{ overflowX: 'auto', borderTop: '1px solid var(--color-border-tertiary)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                    <th style={{ padding: '6px 8px', width: 32 }}>
                      <input type="checkbox" checked={allShownSelected} onChange={toggleAll} />
                    </th>
                    <th style={{ padding: '6px 8px' }}>Tag</th>
                    <th style={{ padding: '6px 8px' }}>CM Type</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center' }}>Imported</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center' }}>Generated</th>
                    <th style={{ padding: '6px 8px' }}>Status</th>
                    <th style={{ padding: '6px 8px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(inst => {
                    const tag = STATUS_TAGS[inst.reconciliationStatus] || STATUS_TAGS.PENDING;
                    const isSelected = selected.has(inst.id);
                    return (
                      <tr
                        key={inst.id}
                        style={{
                          borderBottom: '0.5px solid var(--color-border-tertiary)',
                          background: isSelected ? ROW_SELECTED_BG : 'transparent',
                        }}
                      >
                        <td style={{ padding: '6px 8px' }}>
                          <input type="checkbox" checked={isSelected} onChange={() => toggleRow(inst.id)} />
                        </td>
                        <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{inst.instanceName}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }}>{inst.cmType}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>{inst.isImported ? '✅' : '❌'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>{inst.isGenerated ? '✅' : '❌'}</td>
                        <td style={{ padding: '6px 8px' }}><Tag text={tag.label} color={tag.color} /></td>
                        <td style={{ padding: '6px 8px' }}>
                          {inst.reconciliationStatus === 'DUMMY' && (
                            <Btn style={smBtnSx} green onClick={() => handleRowAccept(inst.id)}>Accept</Btn>
                          )}
                          {inst.reconciliationStatus === 'DUMMY_ACCEPTED' && (
                            <Btn style={smBtnSx} onClick={() => handleRowRevert(inst.id)}>Revert</Btn>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer - Close button */}
        <div style={{
          borderTop: '1px solid var(--color-border-tertiary)',
          padding: '16px',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
        }}>
          <Btn onClick={onClose}>Close</Btn>
        </div>
      </div>
    </div>
  );
}
