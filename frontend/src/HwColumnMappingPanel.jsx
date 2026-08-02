import React, { useState, useEffect } from 'react';
import { loadHwColumnMapping, saveHwColumnMapping } from './api.js';

/**
 * HwColumnMappingPanel — Two-step column mapping workflow
 * Step 1: Select columns from Excel
 * Step 2: Map columns to application fields
 */
export default function HwColumnMappingPanel({ importId, excelHeaders, selectedColumns, setSelectedColumns, setError, setLoading, loading, onMappingComplete }) {
  const [excelData, setExcelData] = useState([]);       // raw Excel rows from DB
  const [allHeaders, setAllHeaders] = useState([]);     // headers from DB (may differ from prop)
  const [mapping, setMapping] = useState({});
  const [suggestions, setSuggestions] = useState({});
  const [step, setStep] = useState('columns'); // 'columns' or 'mapping'

  // module_order_no (Card MLFB) is normally mandatory (Tier 1). If the user leaves it
  // unmapped, Protocol + Signal Type become mandatory instead so Tier 2 resolution
  // (lookup via hw_hardware_resolution) has what it needs.
  const CORE_MANDATORY_FIELDS = [
    { key: 'station_address', label: 'Station Address', desc: 'Hardware device ID' },
    { key: 'slot', label: 'Slot', desc: 'Module position in rack' },
    { key: 'tag', label: 'Tag', desc: 'Signal identifier' },
    { key: 'channel', label: 'Channel', desc: 'Signal channel number' },
  ];

  const MODULE_ORDER_FIELD = { key: 'module_order_no', label: 'Module Order No (Card MLFB)', desc: 'Siemens module catalog number — Tier 1' };
  const PROTOCOL_FIELD = { key: 'protocol', label: 'Protocol', desc: 'Used with Signal Type to resolve Card MLFB — Tier 2' };
  const SIGNAL_TYPE_FIELD = { key: 'signal_type', label: 'Signal Type', desc: 'DI / DO / AI / AO — required for Tier 2' };

  const OPTIONAL_FIELDS = [
    { key: 'station_name', label: 'Station Name' },
    { key: 'ip_address', label: 'IP Address' },
    { key: 'description', label: 'Description' },
    { key: 'subsystem_no', label: 'Subsystem No' },
    { key: 'router_address', label: 'Router Address' },
  ];

  // Load raw Excel rows from DB on mount (no file re-upload needed)
  useEffect(() => {
    if (importId) {
      loadPreview();
      loadSavedMapping();
    }
  }, [importId]);

  async function loadSavedMapping() {
    try {
      const data = await loadHwColumnMapping(importId);
      if (data.mapping && Object.keys(data.mapping).length > 0) {
        setMapping(data.mapping);
        // Restore selected columns from saved mapping — these are the Excel column names
        const selectedCols = new Set(Object.values(data.mapping).filter(Boolean));
        setSelectedColumns(selectedCols);
        // Auto-advance to mapping step if we have a saved mapping
        // The user can see their previous selections immediately
      }
    } catch (e) {
      // Silent fail - no saved mapping is fine
      console.debug('No saved column mapping found');
    }
  }

  async function loadPreview() {
    setLoading('Loading preview…');
    try {
      const resp = await fetch(`/api/hw-config/imports/${importId}/excel-preview`);
      if (!resp.ok) throw new Error('Failed to load preview');
      const data = await resp.json();
      setExcelData(data.rows || []);
      setAllHeaders(data.headers || excelHeaders);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading('');
    }
  }

  const toggleColumn = (col) => {
    const next = new Set(selectedColumns);
    next.has(col) ? next.delete(col) : next.add(col);
    setSelectedColumns(next);
  };

  // Use allHeaders from DB if available, otherwise fall back to prop
  const headersToUse = allHeaders.length > 0 ? allHeaders : excelHeaders;
  const selectedList = Array.from(selectedColumns).sort();
  const unselectedList = headersToUse.filter(h => !selectedColumns.has(h)).sort();

  // Map field keys to parsed row properties
  const FIELD_TO_PROP = {
    station_address: 'stationAddr',
    module_order_no: 'orderNo',
    tag: 'tag',
    channel: 'channel',
    slot: 'slot',
    station_name: 'stationName',
    ip_address: 'ip',
    signal_type: 'signalType',
    description: 'desc',
    subsystem_no: 'subsystemNo',
    router_address: 'routerAddress',
  };

  function handleNextStep() {
    if (selectedList.length === 0) {
      setError('Select at least one column');
      return;
    }
    setError('');
    // Auto-map: exact case-insensitive match first, then fuzzy match
    const auto = {};
    const selectedLower = new Map(selectedList.map(col => [col.toLowerCase(), col]));

    const allMappableFields = [...CORE_MANDATORY_FIELDS, MODULE_ORDER_FIELD, PROTOCOL_FIELD, SIGNAL_TYPE_FIELD, ...OPTIONAL_FIELDS];
    for (const field of allMappableFields) {
      // 1. Try exact match (e.g., "Station_Address" → "station_address")
      let match = selectedLower.get(field.key.toLowerCase());

      // 2. Try replacing underscores with spaces (e.g., "Station Address" → "station_address")
      if (!match) {
        const withSpaces = field.key.replace(/_/g, ' ').toLowerCase();
        match = selectedList.find(col => col.toLowerCase() === withSpaces);
      }

      // 3. Fuzzy: find column containing the field name (without underscores)
      if (!match) {
        const fieldNoUnderscores = field.key.replace(/_/g, '').toLowerCase();
        match = selectedList.find(col =>
          col.toLowerCase().replace(/_/g, '').includes(fieldNoUnderscores) ||
          fieldNoUnderscores.includes(col.toLowerCase().replace(/_/g, ''))
        );
      }

      if (match) auto[field.key] = match;
    }
    setMapping(auto);
    setStep('mapping');
  }

  function handleBackStep() {
    setStep('columns');
  }

  async function handleProceedWithMapping() {
    // Validate all mandatory fields are mapped.
    // Tier 1: module_order_no mapped → that's sufficient.
    // Tier 2: module_order_no NOT mapped → protocol + signal_type become mandatory instead.
    const tierFields = mapping[MODULE_ORDER_FIELD.key]
      ? []
      : [PROTOCOL_FIELD, SIGNAL_TYPE_FIELD];
    const unmapped = [...CORE_MANDATORY_FIELDS, ...tierFields].filter(f => !mapping[f.key]);
    if (unmapped.length > 0) {
      setError(`Missing mappings: ${unmapped.map(f => f.label).join(', ')}`);
      return;
    }

    setLoading('Preparing import…');
    setError('');
    try {
      // Build the column map: app field → Excel column name
      const columnMap = mapping; // mapping already has this structure

      // Save the mapping configuration for future loads
      await saveHwColumnMapping(importId, columnMap);

      // Fetch preview with the mapping applied (no file needed, using stored raw rows)
      const resp = await fetch(`/api/hw-config/imports/${importId}/preview-mapped?columnMap=${encodeURIComponent(JSON.stringify(columnMap))}`, {
        method: 'GET',
      });
      if (!resp.ok) throw new Error('Failed to preview with mapping');

      const data = await resp.json();
      // data contains: { summary, items, parsedRows, fileName, stationCount, resolutionStats }
      // Each item may include stationConflicts array for highlighting conflicted rows
      // Pass to parent to show review modal
      if (onMappingComplete) {
        onMappingComplete({
          summary: data.summary,
          items: data.items,
          parsedRows: data.parsedRows,
          fileName: data.fileName,
          resolutionStats: data.resolutionStats,
        });
      }
      // Reset
      setSelectedColumns(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Column Selection
  // ═══════════════════════════════════════════════════════════════════════
  if (step === 'columns') {
    return (
      <div style={{ display: 'flex', height: '100%', gap: 0, flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 0, flex: 1, minHeight: 0 }}>
          {/* Left Panel: Column List */}
          <div style={{
            width: 280, flexShrink: 0, borderRight: '0.5px solid var(--color-border-tertiary)',
            display: 'flex', flexDirection: 'column', background: 'var(--color-background-secondary)',
          }}>
            <div style={{ padding: '16px 12px', borderBottom: '1px solid var(--color-border-tertiary)' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)' }}>
                Select Columns
              </h3>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                <button onClick={() => setSelectedColumns(new Set(headersToUse))} style={{ padding: '4px 8px', fontSize: 10, border: '0.5px solid var(--color-border-secondary)', borderRadius: 3, background: 'transparent', cursor: 'pointer', flex: 1 }}>
                  All
                </button>
                <button onClick={() => setSelectedColumns(new Set())} style={{ padding: '4px 8px', fontSize: 10, border: '0.5px solid var(--color-border-secondary)', borderRadius: 3, background: 'transparent', cursor: 'pointer', flex: 1 }}>
                  None
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              {/* Selected columns */}
              {selectedList.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8, paddingLeft: 4 }}>
                    SELECTED ({selectedList.length})
                  </div>
                  {selectedList.map(col => (
                    <label key={col} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 4,
                      background: 'var(--color-background-primary)', cursor: 'pointer',
                    }}>
                      <input type="checkbox" checked={true} onChange={() => toggleColumn(col)} style={{ cursor: 'pointer' }} />
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-sans)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {col}
                      </span>
                    </label>
                  ))}
                </>
              )}

              {/* Unselected columns */}
              {unselectedList.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginTop: 12, marginBottom: 8, paddingLeft: 4 }}>
                    AVAILABLE ({unselectedList.length})
                  </div>
                  {unselectedList.map(col => (
                    <label key={col} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 4,
                      background: 'transparent', cursor: 'pointer', opacity: 0.6,
                    }}>
                      <input type="checkbox" checked={false} onChange={() => toggleColumn(col)} style={{ cursor: 'pointer' }} />
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-sans)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {col}
                      </span>
                    </label>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Right Panel: Data Preview */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0 }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)' }}>
              <h2 style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 600 }}>Excel File Preview</h2>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {selectedList.length === 0 ? 'Select columns to see preview' : `${selectedList.length} column${selectedList.length !== 1 ? 's' : ''} — ${excelData.length} row${excelData.length !== 1 ? 's' : ''}`}
              </p>
            </div>

            {/* Data Table */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
              {selectedList.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                  Select columns from the left to see preview
                </div>
              ) : (
                <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid var(--color-border-secondary)' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: 'var(--color-background-secondary)' }}>
                        {selectedList.map(col => (
                          <th key={col} style={{
                            padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontFamily: 'var(--font-mono)',
                            borderBottom: '1px solid var(--color-border-secondary)', fontSize: 10, whiteSpace: 'nowrap',
                          }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {excelData.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          {selectedList.map(col => {
                            const val = row[col];
                            return (
                              <td key={col} style={{
                                padding: '6px 12px', fontFamily: 'var(--font-mono)', maxWidth: 200,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {val !== undefined && val !== null && val !== '' ? String(val) : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer with buttons */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid var(--color-border-secondary)',
          background: 'var(--color-background-secondary)', display: 'flex', gap: 12, justifyContent: 'flex-end',
          flexShrink: 0,
        }}>
          <button onClick={() => setSelectedColumns(new Set())}
            style={{
              padding: '8px 16px', fontSize: 13, border: '0.5px solid var(--color-border-secondary)',
              borderRadius: 4, background: 'transparent', cursor: 'pointer', color: 'var(--color-text-primary)',
            }}>
            Cancel
          </button>
          <button onClick={handleNextStep}
            disabled={selectedList.length === 0 || loading}
            style={{
              padding: '8px 16px', fontSize: 13, border: 'none', borderRadius: 4,
              background: selectedList.length === 0 || loading ? '#ccc' : '#2255cc',
              color: '#fff', cursor: selectedList.length === 0 || loading ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}>
            Next →
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Field Mapping (Single Panel)
  // ═══════════════════════════════════════════════════════════════════════
  const moduleOrderMapped = !!mapping[MODULE_ORDER_FIELD.key];
  // Tier 2 is active whenever Card MLFB isn't mapped — Protocol + Signal Type
  // become mandatory in that mode so hw_hardware_resolution lookup can run.
  const tier2Active = !moduleOrderMapped;
  const mandatoryFieldsForValidation = [
    ...CORE_MANDATORY_FIELDS,
    ...(tier2Active ? [PROTOCOL_FIELD, SIGNAL_TYPE_FIELD] : []),
  ];

  return (
    <div style={{ display: 'flex', height: '100%', gap: 0, flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '16px 24px', overflowY: 'auto', background: 'var(--color-background-primary)' }}>
        <h2 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600 }}>Map Fields</h2>
        <p style={{ margin: '0 0 12px 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Assign Excel columns to application fields ({excelData.length} row{excelData.length !== 1 ? 's' : ''} to import)
        </p>

        {tier2Active && (
          <div style={{
            marginBottom: 20, padding: '10px 14px', borderRadius: 6,
            background: 'rgba(230, 162, 0, 0.12)', border: '1px solid rgba(230, 162, 0, 0.4)',
            fontSize: 12, color: 'var(--color-text-primary)',
          }}>
            <strong>Card MLFB not mapped.</strong> Tier 2 resolution will be used — Card MLFB (and Station MLFB) will be derived
            from <strong>Protocol</strong> + <strong>Signal Type</strong> via the lookup table. Both fields are required below.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24 }}>
          {/* Mandatory Fields */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#c00', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--color-border-secondary)' }}>
              Required Fields
            </div>
            {CORE_MANDATORY_FIELDS.map(field => (
              <div key={field.key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6, display: 'block' }}>
                  {field.label}
                </label>
                <select
                  value={mapping[field.key] || ''}
                  onChange={(e) => setMapping({...mapping, [field.key]: e.target.value || undefined})}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 11,
                    border: '0.5px solid var(--color-border-secondary)',
                    borderRadius: 4, background: 'var(--color-background-secondary)',
                    color: 'var(--color-text-primary)',
                  }}>
                  <option value="">— Select column —</option>
                  {selectedList.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
            ))}

            {/* Module Order No — mandatory for Tier 1, becomes optional (and Protocol/SignalType take over) when unmapped */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6, display: 'block' }}>
                {MODULE_ORDER_FIELD.label}
              </label>
              <select
                value={mapping[MODULE_ORDER_FIELD.key] || ''}
                onChange={(e) => setMapping({...mapping, [MODULE_ORDER_FIELD.key]: e.target.value || undefined})}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 11,
                  border: '0.5px solid var(--color-border-secondary)',
                  borderRadius: 4, background: 'var(--color-background-secondary)',
                  color: 'var(--color-text-primary)',
                }}>
                <option value="">— Not mapped (use Tier 2) —</option>
                {selectedList.map(col => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
              <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 4 }}>{MODULE_ORDER_FIELD.desc}</div>
            </div>

            {/* Protocol + Signal Type — mandatory ONLY in Tier 2 mode (Module Order No unmapped) */}
            {[PROTOCOL_FIELD, SIGNAL_TYPE_FIELD].map(field => (
              <div key={field.key} style={{ marginBottom: 14 }}>
                <label style={{
                  fontSize: 11, fontWeight: 600, marginBottom: 6, display: 'block',
                  color: tier2Active ? '#c00' : 'var(--color-text-primary)',
                }}>
                  {field.label}{tier2Active ? ' *' : ''}
                </label>
                <select
                  value={mapping[field.key] || ''}
                  onChange={(e) => setMapping({...mapping, [field.key]: e.target.value || undefined})}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 11,
                    border: tier2Active && !mapping[field.key]
                      ? '1px solid #c00'
                      : '0.5px solid var(--color-border-secondary)',
                    borderRadius: 4, background: 'var(--color-background-secondary)',
                    color: 'var(--color-text-primary)',
                  }}>
                  <option value="">{tier2Active ? '— Select column —' : '— Skip —'}</option>
                  {selectedList.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
                <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 4 }}>{field.desc}</div>
              </div>
            ))}
          </div>

          {/* Optional Fields */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--color-border-secondary)' }}>
              Optional Fields
            </div>
            {OPTIONAL_FIELDS.map(field => (
              <div key={field.key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 6, display: 'block' }}>
                  {field.label}
                </label>
                <select
                  value={mapping[field.key] || ''}
                  onChange={(e) => setMapping({...mapping, [field.key]: e.target.value || undefined})}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 11,
                    border: '0.5px solid var(--color-border-secondary)',
                    borderRadius: 4, background: 'var(--color-background-secondary)',
                    color: 'var(--color-text-primary)',
                  }}>
                  <option value="">— Skip —</option>
                  {selectedList.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer with buttons */}
      <div style={{
        padding: '16px 24px', borderTop: '1px solid var(--color-border-secondary)',
        background: 'var(--color-background-secondary)', display: 'flex', gap: 12, justifyContent: 'flex-end',
        flexShrink: 0,
      }}>
        <button onClick={handleBackStep}
          style={{
            padding: '8px 16px', fontSize: 13, border: '0.5px solid var(--color-border-secondary)',
            borderRadius: 4, background: 'transparent', cursor: 'pointer', color: 'var(--color-text-primary)',
          }}>
          ← Back
        </button>
        <button onClick={() => setSelectedColumns(new Set())}
          style={{
            padding: '8px 16px', fontSize: 13, border: '0.5px solid var(--color-border-secondary)',
            borderRadius: 4, background: 'transparent', cursor: 'pointer', color: 'var(--color-text-primary)',
          }}>
          Cancel
        </button>
        <button onClick={handleProceedWithMapping}
          disabled={mandatoryFieldsForValidation.some(f => !mapping[f.key]) || loading}
          style={{
            padding: '8px 16px', fontSize: 13, border: 'none', borderRadius: 4,
            background: mandatoryFieldsForValidation.some(f => !mapping[f.key]) || loading ? '#ccc' : '#2255cc',
            color: '#fff', cursor: mandatoryFieldsForValidation.some(f => !mapping[f.key]) || loading ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}>
          Import →
        </button>
      </div>
    </div>
  );
}
