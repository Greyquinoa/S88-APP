import React, { useState, useEffect } from 'react';
import './InstancesGrid.css';
import './StationAutoSlotsEditor.css';

/**
 * Hierarchical editor for configuring auto-slot JSON for stations
 * Can be used standalone (shows station selector) or with pre-filled orderNo (modal mode)
 * inlineMode: if true, renders content directly without modal popup styling
 */
export default function StationAutoSlotsEditor({ station, catalogue: preloadedCatalogue, onClose, inlineMode = false }) {
  // If station.orderNo is provided, use it directly; otherwise show station selector
  const isModal = !!station?.orderNo && !inlineMode;

  const [stations, setStations] = useState([]);
  const [selectedStation, setSelectedStation] = useState(station?.orderNo ? station.orderNo : null);
  const [config, setConfig] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalogue, setCatalogue] = useState(preloadedCatalogue || []);

  // Load available stations and catalogue on mount
  useEffect(() => {
    if (!isModal) {
      loadStations();
    }
    if (!preloadedCatalogue) {
      loadCatalogue();
    }
  }, []);

  // Load config when station is selected
  useEffect(() => {
    if (selectedStation) {
      loadConfig(selectedStation);
    }
  }, [selectedStation]);

  async function loadStations() {
    try {
      setLoading(true);
      const response = await fetch('/api/hw-config/station-auto-slots');
      if (!response.ok) throw new Error('Failed to load stations');
      const data = await response.json();
      setStations(data);
      setError('');
    } catch (err) {
      setError(`Error loading stations: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadConfig(orderNo) {
    try {
      setLoading(true);
      const response = await fetch(`/api/hw-config/station-auto-slots/${encodeURIComponent(orderNo)}`);
      if (!response.ok) throw new Error('Failed to load configuration');
      const data = await response.json();
      setConfig(data.config || { slots: [], rules: {} });
      setError('');
    } catch (err) {
      setError(`Error loading config: ${err.message}`);
      setConfig({ slots: [], rules: {} });
    } finally {
      setLoading(false);
    }
  }

  async function loadCatalogue() {
    try {
      const response = await fetch('/api/hw-config/module-templates');
      if (!response.ok) throw new Error('Failed to load catalogue');
      const data = await response.json();
      setCatalogue(data);
    } catch (err) {
      console.warn('Could not load catalogue:', err.message);
    }
  }

  function addSlot() {
    if (!config) return;
    // ET200SP: slot 0 is the interface module, then slots 1+ are IO modules
    // If no slots exist, start with slot 0; otherwise add after the max
    const existingSlots = config.slots || [];
    const newSlotNum = existingSlots.length === 0 ? 0 : Math.max(...existingSlots.map(s => s.slot || 0)) + 1;
    const newSlot = {
      slot: newSlotNum,
      type: '',
      order_no: '',
      label: '',
      subslots: []
    };
    setConfig({ ...config, slots: [...config.slots, newSlot] });
  }

  function deleteSlot(slotNum) {
    if (!config) return;
    setConfig({ ...config, slots: config.slots.filter(s => s.slot !== slotNum) });
    setSelectedItem(null);
  }

  function addSubslot(slotNum) {
    if (!config) return;
    const slot = config.slots.find(s => s.slot === slotNum);
    if (!slot) return;

    const newSubslot = {
      subslot: Math.max(0, ...((slot.subslots || []).map(ss => ss.subslot || 0))) + 1,
      type: '',
      order_no: '',
      label: '',
      port_label: ''
    };

    const updatedSlots = config.slots.map(s =>
      s.slot === slotNum
        ? { ...s, subslots: [...(s.subslots || []), newSubslot] }
        : s
    );
    setConfig({ ...config, slots: updatedSlots });
  }

  function deleteSubslot(slotNum, subslotNum) {
    if (!config) return;
    const updatedSlots = config.slots.map(s =>
      s.slot === slotNum
        ? { ...s, subslots: s.subslots.filter(ss => ss.subslot !== subslotNum) }
        : s
    );
    setConfig({ ...config, slots: updatedSlots });
    setSelectedItem(null);
  }

  function updateField(item, field, value) {
    setConfig(prevConfig => {
      if (!prevConfig) return prevConfig;

      if (item.subslot !== undefined) {
        // Updating subslot
        const updatedSlots = prevConfig.slots.map(s =>
          s.slot === item.parentSlot
            ? {
                ...s,
                subslots: s.subslots.map(ss =>
                  ss.subslot === item.subslot ? { ...ss, [field]: value } : ss
                )
              }
            : s
        );
        return { ...prevConfig, slots: updatedSlots };
      } else {
        // Updating slot
        const updatedSlots = prevConfig.slots.map(s =>
          s.slot === item.slot ? { ...s, [field]: value } : s
        );
        return { ...prevConfig, slots: updatedSlots };
      }
    });
  }

  function updateFields(item, fields) {
    setConfig(prevConfig => {
      if (!prevConfig) return prevConfig;

      if (item.subslot !== undefined) {
        const updatedSlots = prevConfig.slots.map(s =>
          s.slot === item.parentSlot
            ? {
                ...s,
                subslots: s.subslots.map(ss =>
                  ss.subslot === item.subslot ? { ...ss, ...fields } : ss
                )
              }
            : s
        );
        return { ...prevConfig, slots: updatedSlots };
      } else {
        const updatedSlots = prevConfig.slots.map(s =>
          s.slot === item.slot ? { ...s, ...fields } : s
        );
        return { ...prevConfig, slots: updatedSlots };
      }
    });
  }

  async function saveConfig() {
    if (!selectedStation || !config) return;

    try {
      setLoading(true);
      const response = await fetch(
        `/api/hw-config/station-auto-slots/${encodeURIComponent(selectedStation)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        }
      );

      if (!response.ok) throw new Error('Failed to save configuration');
      setSuccess('Configuration saved successfully!');
      setTimeout(() => setSuccess(''), 3000);
      setError('');
    } catch (err) {
      setError(`Error saving config: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }


  function renderEditorContent() {
    return (
      <div style={{ display: 'flex', gap: '20px', flexDirection: 'column' }} className="ig-cfg-editor">
        {/* Server Module Configuration */}
        <div style={{
          padding: '14px 16px',
          background: 'var(--color-background-tertiary, #f9f9f9)',
          border: '1px solid var(--color-border-secondary, #e0e0e0)',
          borderRadius: '6px'
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: 0, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.rules?.server_module_enabled === true}
              onChange={(e) => {
                setConfig({
                  ...config,
                  rules: { ...config.rules, server_module_enabled: e.target.checked }
                });
              }}
              style={{ cursor: 'pointer', width: '18px', height: '18px' }}
            />
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {config.rules?.server_module_enabled ? '✓' : '○'} Auto-attach Server Module
            </span>
          </label>
          <p style={{ fontSize: 12, color: 'var(--color-text-tertiary, #888)', margin: '6px 0 0 28px' }}>
            {config.rules?.server_module_enabled
              ? 'Server module will be automatically added as the last slot during CFG generation'
              : 'Server module must be added manually if needed'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '20px' }} className="ig-cfg-editor-main">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ig-toolbar">
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)' }}>
              Slot Configuration
            </span>
            <div className="ig-toolbar-right">
              <span className="ig-count">
                {config.slots.length} slot{config.slots.length !== 1 ? 's' : ''}
              </span>
              <button className="ig-btn ig-btn-primary" onClick={addSlot} disabled={loading}>
                + Add Slot
              </button>
            </div>
          </div>

          <div className="ig-cfg-table">
            <div className="ig-cfg-row ig-cfg-head">
              <div>Slot</div>
              <div>Subslot</div>
              <div>Order Number</div>
              <div>Label</div>
              <div style={{ textAlign: 'center' }}>Action</div>
            </div>

            {config.slots.map((slot) => (
              <React.Fragment key={`slot-${slot.slot}`}>
                <div
                  className={`ig-cfg-row ig-cfg-slot ${selectedItem?.slot === slot.slot && !selectedItem?.subslot ? 'is-selected' : ''}`}
                  onClick={() => setSelectedItem({ ...slot, parentSlot: slot.slot })}
                >
                  <div style={{ fontWeight: 600 }}>📦 {slot.slot}</div>
                  <div className="ig-cfg-muted">—</div>
                  <div className="ig-cfg-mono">{slot.order_no || '—'}</div>
                  <div>{slot.label || '—'}</div>
                  <div className="ig-cfg-actions">
                    <button
                      className="ig-cfg-iconbtn ig-cfg-add"
                      onClick={(e) => { e.stopPropagation(); addSubslot(slot.slot); }}
                      title="Add subslot"
                    >
                      +
                    </button>
                    <button
                      className="ig-cfg-iconbtn ig-cfg-del"
                      onClick={(e) => { e.stopPropagation(); deleteSlot(slot.slot); }}
                      title="Delete slot"
                    >
                      <i className="ti ti-trash" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {slot.subslots && slot.subslots.map((subslot) => (
                  <div
                    key={`subslot-${slot.slot}-${subslot.subslot}`}
                    className={`ig-cfg-row ig-cfg-subslot ${selectedItem?.slot === slot.slot && selectedItem?.subslot === subslot.subslot ? 'is-selected' : ''}`}
                    onClick={() => setSelectedItem({ ...subslot, parentSlot: slot.slot })}
                  >
                    <div></div>
                    <div className="ig-cfg-muted">└─ {subslot.subslot}</div>
                    <div className="ig-cfg-mono">{subslot.order_no || '—'}</div>
                    <div>{subslot.port_label || subslot.label || '—'}</div>
                    <div className="ig-cfg-actions">
                      <button
                        className="ig-cfg-iconbtn ig-cfg-del"
                        onClick={(e) => { e.stopPropagation(); deleteSubslot(slot.slot, subslot.subslot); }}
                        title="Delete subslot"
                      >
                        <i className="ti ti-trash" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>

          {selectedItem && (
            <ItemDetailsPanel
              item={selectedItem}
              onUpdateField={updateField}
              onUpdateFields={updateFields}
              catalogue={catalogue}
              config={config}
            />
          )}
        </div>
      </div>
    );
  }

  // Inline mode: render editor content directly without modal styling (for embedding in tabs)
  if (station?.orderNo && inlineMode && config) {
    return (
      <div>
        {error && <div style={{ padding: '12px 16px', background: '#fde2e4', color: '#842029', borderLeft: '4px solid #dc3545', marginBottom: '16px' }}>{error}</div>}
        {success && <div style={{ padding: '12px 16px', background: '#d1e7dd', color: '#0f5132', borderLeft: '4px solid #198754', marginBottom: '16px' }}>{success}</div>}
        {renderEditorContent()}

        {/* Save button after the table */}
        <div style={{ marginTop: '20px', textAlign: 'right', paddingRight: '20px' }}>
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
  }

  // Loading state for inline mode
  if (station?.orderNo && inlineMode && !config) {
    return <div style={{ padding: '20px', color: '#6b7280' }}>Loading configuration...</div>;
  }

  if (isModal) {
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000
      }}>
        <div style={{
          background: 'var(--bg-secondary, #fff)',
          borderRadius: 8,
          width: '90%',
          maxWidth: 1200,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)'
        }}>
          {/* Modal Header */}
          <div style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-color, #ddd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600 }}>
                Auto-Slot Configuration
              </h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary, #666)' }}>
                Station: {selectedStation}
              </p>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: 24,
                cursor: 'pointer',
                color: 'var(--text-secondary, #666)',
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ✕
            </button>
          </div>

          {error && <div style={{ padding: '12px 24px', background: '#fde2e4', color: '#842029', borderLeft: '4px solid #dc3545' }}>{error}</div>}
          {success && <div style={{ padding: '12px 24px', background: '#d1e7dd', color: '#0f5132', borderLeft: '4px solid #198754' }}>{success}</div>}

          {/* Modal Body */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>
            {selectedStation && config && renderEditorContent()}
          </div>

          {/* Modal Footer */}
          <div style={{
            display: 'flex',
            gap: 8,
            padding: '14px 20px',
            borderTop: '0.5px solid var(--color-border-tertiary, rgba(0,0,0,0.10))',
            background: 'var(--color-background-secondary, #f5f5f5)',
            justifyContent: 'flex-end'
          }}>
            <button className="ig-btn ig-btn-ghost" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button className="ig-btn ig-btn-primary" onClick={saveConfig} disabled={loading}>
              💾 Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Standalone mode - show full UI with station selector
  return (
    <div className="station-auto-slots-editor">
      <div className="editor-header">
        <h2>Station Auto-Slot Configuration</h2>
        <p>Configure JSON structure for each station</p>
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      <div className="editor-layout">
        <div className="station-selector-panel">
          <label>Select Station:</label>
          <select
            value={selectedStation || ''}
            onChange={(e) => setSelectedStation(e.target.value)}
            disabled={loading}
          >
            <option value="">-- Choose a station --</option>
            {stations.map((s) => (
              <option key={s.order_no} value={s.order_no}>
                {s.order_no}
              </option>
            ))}
          </select>
        </div>

        {selectedStation && config && (
          <div className="editor-content">
            <div className="table-section">
              <div className="table-header">
                <h3>Configuration Structure</h3>
                <div className="table-buttons">
                  <button className="btn btn-primary" onClick={addSlot} disabled={loading}>
                    + Add Slot
                  </button>
                </div>
              </div>

              <div className="config-table">
                <div className="table-row table-header-row">
                  <div className="col-slot">Slot</div>
                  <div className="col-subslot">Subslot</div>
                  <div className="col-order">Order Number</div>
                  <div className="col-label">Label / Port Label</div>
                  <div className="col-actions">Action</div>
                </div>

                {config.slots.map((slot) => (
                  <React.Fragment key={`slot-${slot.slot}`}>
                    <div
                      className={`table-row slot-row ${selectedItem?.slot === slot.slot && !selectedItem?.subslot ? 'selected' : ''}`}
                      onClick={() => setSelectedItem({ ...slot, parentSlot: slot.slot })}
                    >
                      <div className="col-slot">
                        <span className="slot-icon">📦</span> {slot.slot}
                      </div>
                      <div className="col-subslot">-</div>
                      <div className="col-order">{slot.order_no || '-'}</div>
                      <div className="col-label">{slot.label || slot.port_label || '-'}</div>
                      <div className="col-actions">
                        <button
                          className="btn-small btn-add"
                          onClick={() => addSubslot(slot.slot)}
                          title="Add subslot"
                        >
                          +
                        </button>
                        <button
                          className="btn-small btn-delete"
                          onClick={() => deleteSlot(slot.slot)}
                          title="Delete slot"
                        >
                          🗑
                        </button>
                      </div>
                    </div>

                    {slot.subslots && slot.subslots.map((subslot) => (
                      <div
                        key={`subslot-${slot.slot}-${subslot.subslot}`}
                        className={`table-row subslot-row ${selectedItem?.slot === slot.slot && selectedItem?.subslot === subslot.subslot ? 'selected' : ''}`}
                        onClick={() => setSelectedItem({ ...subslot, parentSlot: slot.slot })}
                      >
                        <div className="col-slot"></div>
                        <div className="col-subslot">
                          <span className="subslot-indent">└─ {subslot.subslot}</span>
                        </div>
                        <div className="col-order">{subslot.order_no || '-'}</div>
                        <div className="col-label">{subslot.port_label || subslot.label || '-'}</div>
                        <div className="col-actions">
                          <button
                            className="btn-small btn-delete"
                            onClick={() => deleteSubslot(slot.slot, subslot.subslot)}
                            title="Delete subslot"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </div>

            {selectedItem && (
              <ItemDetailsPanel
                item={selectedItem}
                onUpdateField={updateField}
                onUpdateFields={updateFields}
                catalogue={catalogue}
                config={config}
              />
            )}

            <div className="editor-footer">
              <button
                className="btn btn-primary btn-save"
                onClick={saveConfig}
                disabled={loading}
              >
                💾 Save Changes
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setSelectedStation(null)}
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Item Details Panel - Edit form for selected slot/subslot
 */
function ItemDetailsPanel({ item, onUpdateField, onUpdateFields, catalogue, config }) {
  const isSubslot = item.subslot !== undefined;

  // Get the live current item from config (not the stale prop)
  const liveItem = config ? (
    isSubslot
      ? config.slots.find(s => s.slot === item.parentSlot)?.subslots?.find(ss => ss.subslot === item.subslot)
      : config.slots.find(s => s.slot === item.slot)
  ) : item;

  const currentOrderNo = liveItem?.order_no || item.order_no || '';
  const currentLabel = liveItem?.label || item.label || '';

  // Find module in catalogue by current order_no
  const selectedModule = catalogue.find(m => m.order_no === currentOrderNo);

  function handleModuleChange(orderNo) {
    if (!orderNo) {
      onUpdateFields(item, { order_no: '', label: '' });
      return;
    }
    const module = catalogue.find(m => m.order_no === orderNo);
    if (module) {
      // Update order_no and label together (type is inferred by the backend on save).
      onUpdateFields(item, { order_no: module.order_no, label: module.display_name });
    }
  }

  return (
    <div className="item-details-panel">
      <h3>Item Details</h3>

      <div className="details-form">
        <div className="form-group">
          <label>Item Type:</label>
          <span className="badge">{isSubslot ? 'Subslot (Submodule)' : 'Slot (Module)'}</span>
        </div>

        {isSubslot && (
          <div className="form-group">
            <label>Parent Slot:</label>
            <span className="value">{item.parentSlot}</span>
          </div>
        )}

        <div className="form-group">
          <label>{isSubslot ? 'Subslot Number:' : 'Slot Number:'}</label>
          <input
            type="number"
            value={isSubslot ? item.subslot : item.slot}
            disabled
            className="input-readonly"
          />
        </div>

        <div className="form-group">
          <label>Module Type (from Catalogue):</label>
          <select
            value={currentOrderNo}
            onChange={(e) => handleModuleChange(e.target.value)}
          >
            <option value="">-- Select from catalogue --</option>
            {catalogue.map(m => (
              <option key={m.order_no} value={m.order_no}>
                {m.display_name} ({m.order_no})
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Order Number (Auto-filled):</label>
          <input
            type="text"
            value={currentOrderNo}
            disabled
            className="input-readonly"
            title="Auto-filled from catalogue selection"
          />
        </div>

        <div className="form-group">
          <label>Label (Auto-filled):</label>
          <input
            type="text"
            value={currentLabel}
            disabled
            className="input-readonly"
            title="Auto-filled from catalogue selection"
          />
        </div>

        {isSubslot && (
          <div className="form-group">
            <label>Port Label (Optional):</label>
            <input
              type="text"
              placeholder="e.g., Port 1 RJ45"
              value={liveItem?.port_label || ''}
              onChange={(e) => onUpdateField(item, 'port_label', e.target.value)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

