import React, { useState, useEffect } from 'react';
import {
  getIOColumnMaps, createIOColumnMap, updateIOColumnMap, deleteIOColumnMap,
} from './api.js';

/**
 * UnifiedColumnMappingScreen — Single merged Column Mapping for both:
 * 1. Instance & Hierarchy (top panel)
 * 2. Hardware (bottom panel)
 *
 * Both panels map to the same uploaded Excel columns.
 * Single Config Sidebar stores both panels' mappings together.
 * Two independent action buttons: Import Instances, Import Hardware.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — Field Definitions
// ═══════════════════════════════════════════════════════════════════════════════

// Instance/Hierarchy Fields
const INSTANCE_INTERNAL_FIELDS = ['instrument_tag', 'function_val', 'hierarchy', 'assignment'];
const INSTANCE_FIELD_LABELS = {
  instrument_tag: 'Instrument Tag',
  function_val: 'Function',
  hierarchy: 'Hierarchy',
  assignment: 'AS Assignment',
};
const INSTANCE_FIELD_DESCRIPTIONS = {
  instrument_tag: 'CM identity — groups IO rows into one instance',
  function_val: 'Maps to CM type for instance creation',
  hierarchy: 'Full path (e.g., Area/Cell/Unit) — determines folder structure',
  assignment: 'AS assignment (e.g., AS01) — maps to user_project',
};

// Hardware Fields
const HW_CORE_MANDATORY = [
  { key: 'station_address', label: 'Station Address', desc: 'Hardware device ID' },
  { key: 'slot', label: 'Slot', desc: 'Module position in rack' },
  { key: 'tag', label: 'Tag', desc: 'Signal identifier' },
  { key: 'channel', label: 'Channel', desc: 'Signal channel number' },
];

const HW_MODULE_ORDER_FIELD = { key: 'module_order_no', label: 'Module Order No (Card MLFB)', desc: 'Siemens module catalog number — Tier 1' };
const HW_PROTOCOL_FIELD = { key: 'protocol', label: 'Protocol', desc: 'Used with Signal Type to resolve Card MLFB — Tier 2' };
const HW_SIGNAL_TYPE_FIELD = { key: 'signal_type', label: 'Signal Type', desc: 'DI / DO / AI / AO — required for Tier 2' };

const HW_OPTIONAL_FIELDS = [
  { key: 'station_name', label: 'Station Name' },
  { key: 'ip_address', label: 'IP Address' },
  { key: 'description', label: 'Description' },
  { key: 'subsystem_no', label: 'Subsystem No' },
  { key: 'router_address', label: 'Router Address' },
];

// UI Styles
const inputSx = {
  padding: '4px 8px',
  border: '0.5px solid var(--color-border-secondary)',
  borderRadius: 6,
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  background: 'var(--color-background-primary)',
  color: 'var(--color-text-primary)',
  width: '100%',
};

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

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
    green: { bg: '#D1FAE5', fg: '#065F46' },
    red: { bg: '#FEE2E2', fg: '#991B1B' },
    yellow: { bg: '#FEF3C7', fg: '#92400E' },
    blue: { bg: '#E6F1FB', fg: '#0C447C' },
    gray: { bg: 'var(--color-background-secondary)', fg: 'var(--color-text-secondary)' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 8, fontWeight: 600,
      background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{text}</span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS — Auto-Matching & Similarity
// ═══════════════════════════════════════════════════════════════════════════════

function suggestColumnMapping(columnName) {
  const ALIASES = {
    instrument_tag: ['instrument', 'instrumenttag', 'instrument_tag', 'cm_tag', 'cmtag', 'device', 'device_tag', 'tag_id', 'kks', 'tag', 'tagname'],
    function_val: ['function', 'func', 'type', 'instrument_type', 'iotype', 'category'],
    hierarchy: ['hierarchy', 'path', 'location', 'hierarchy_path', 'plant_path', 'structure', 'plant_structure', 'plant_hierarchy'],
    assignment: ['assignment', 'as', 'as_assignment', 'controller', 'plc', 'cpu', 'station', 'as01', 'as_station'],
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

// Auto-match hardware fields to Excel columns — same 3-step logic as HwColumnMappingPanel:
// 1. exact case-insensitive match on the field key
// 2. underscores→spaces match (e.g. "station_address" ↔ "Station Address")
// 3. fuzzy substring match (ignoring underscores)
// Returns { column: hw_field } (same shape hardwareMappings uses).
function autoMatchHardwareFields(headers) {
  const HW_FIELDS = [
    ...HW_CORE_MANDATORY,
    HW_MODULE_ORDER_FIELD, HW_PROTOCOL_FIELD, HW_SIGNAL_TYPE_FIELD,
    ...HW_OPTIONAL_FIELDS,
  ];
  const result = {};
  const usedHeaders = new Set();

  for (const field of HW_FIELDS) {
    let match = null;

    // 1. Exact match (case-insensitive)
    match = headers.find(h => !usedHeaders.has(h) && h.toLowerCase() === field.key.toLowerCase());

    // 2. Underscores → spaces
    if (!match) {
      const withSpaces = field.key.replace(/_/g, ' ').toLowerCase();
      match = headers.find(h => !usedHeaders.has(h) && h.toLowerCase() === withSpaces);
    }

    // 3. Fuzzy substring (underscores stripped)
    if (!match) {
      const fieldNoUnderscores = field.key.replace(/_/g, '').toLowerCase();
      match = headers.find(h => {
        if (usedHeaders.has(h)) return false;
        const hNorm = h.toLowerCase().replace(/_/g, '');
        return hNorm.includes(fieldNoUnderscores) || fieldNoUnderscores.includes(hNorm);
      });
    }

    if (match) {
      result[match] = field.key;   // { column: hw_field }
      usedHeaders.add(match);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function UnifiedColumnMappingScreen({
  projectId,
  importId,
  excelHeaders = [],
  onImportInstances,
  onImportHardware,
  setError,
  setLoading,
  loading,
}) {
  // State: Configs
  const [selectedConfigId, setSelectedConfigId] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [draft, setDraft] = useState(null); // { name, description, mappings: { instance: {...}, hardware: {...} } }
  const [loaded, setLoaded] = useState(false);

  // State: Mappings (dual panels)
  const [instanceMappings, setInstanceMappings] = useState({});
  const [hardwareMappings, setHardwareMappings] = useState({});
  const [headers, setHeaders] = useState(excelHeaders);
  const [busy, setBusy] = useState(false);

  // Load configs on mount
  useEffect(() => {
    loadConfigs();
    setHeaders(excelHeaders);
  }, [importId, excelHeaders]);

  async function loadConfigs() {
    try {
      // Reuse io_column_mappings table. Unified configs store both panels' mappings
      // in the `mappings` JSON field as { instance: {...}, hardware: {...} }.
      const all = await getIOColumnMaps();
      // Hide transient auto-created configs (named __io_instances_<id>) from the sidebar.
      const visible = (all || []).filter(c => !String(c.name || '').startsWith('__io_instances_'));
      setConfigs(visible);
      setLoaded(true);

      // Auto-select a config so the saved mapping shows immediately after a refresh
      // (instead of a blank editor until the user clicks the config). Prefer the one
      // already selected; otherwise fall back to the first available.
      if (visible.length > 0 && !draft) {
        const toSelect = visible.find(c => c.id === selectedConfigId) || visible[0];
        selectConfig(toSelect);
      }
    } catch (e) {
      console.error('Failed to load configs:', e.message);
      setConfigs([]);
      setLoaded(true);
    }
  }

  // Compute auto-suggested mappings for both panels against the current headers.
  function computeAutoSuggestions() {
    const instanceSuggestions = {};
    if (headers.length > 0) {
      headers.forEach(h => {
        const suggested = suggestColumnMapping(h);
        if (suggested) instanceSuggestions[h] = suggested;
      });
    }
    // Hardware auto-match uses the same 3-step logic as the HW config panel.
    const hardwareSuggestions = headers.length > 0 ? autoMatchHardwareFields(headers) : {};
    return { instanceSuggestions, hardwareSuggestions };
  }

  function newConfig() {
    const { instanceSuggestions, hardwareSuggestions } = computeAutoSuggestions();
    setSelectedConfigId(null);
    setDraft({
      name: 'New Config',
      description: '',
      mappings: {
        instance: instanceSuggestions,
        hardware: hardwareSuggestions,
      },
    });
    // The dropdowns render from instanceMappings/hardwareMappings state (not from draft),
    // so these must be set for the suggestions to actually appear prefilled.
    setInstanceMappings(instanceSuggestions);
    setHardwareMappings(hardwareSuggestions);
  }

  // Re-run auto-detection on the current draft, merging suggestions into existing
  // mappings (a field the user already set is left untouched). Fixes configs saved
  // before hardware auto-match existed, or created before headers finished loading.
  function autoDetectColumns() {
    if (!draft || headers.length === 0) return;
    const { instanceSuggestions, hardwareSuggestions } = computeAutoSuggestions();

    // Merge: keep every column the user already mapped, fill in the rest from
    // suggestions only for internal fields that aren't mapped yet.
    const mergeMap = (existing, suggested) => {
      const mappedFields = new Set(Object.values(existing));
      const mappedCols = new Set(Object.keys(existing));
      const merged = { ...existing };
      for (const [col, field] of Object.entries(suggested)) {
        if (!mappedFields.has(field) && !mappedCols.has(col)) merged[col] = field;
      }
      return merged;
    };

    const nextInstance = mergeMap(instanceMappings, instanceSuggestions);
    const nextHardware = mergeMap(hardwareMappings, hardwareSuggestions);
    setInstanceMappings(nextInstance);
    setHardwareMappings(nextHardware);
    setDraft(d => ({ ...d, mappings: { instance: nextInstance, hardware: nextHardware } }));
  }

  // Returns the saved config's id, or null on failure. Used directly by saveConfig's
  // button handler, and internally by handleImportHardware to guarantee a persisted
  // config always backs the hardware mapping handoff (see setIOSourceColumnMap).
  async function saveConfigAndGetId() {
    if (!draft || !draft.name.trim()) return null;
    setBusy(true);
    try {
      // Both panels stored in one config's `mappings` field as
      // { instance: {...}, hardware: {...} }. Send it as a plain OBJECT — the
      // backend does JSON.stringify itself. Pre-stringifying here double-encodes
      // it, so on reload JSON.parse yields a string (not an object) and every
      // mapping reads back empty.
      const payload = {
        name: draft.name.trim(),
        description: draft.description || '',
        mappings: {
          instance: instanceMappings,
          hardware: hardwareMappings,
        },
      };

      let savedId = selectedConfigId;
      if (selectedConfigId) {
        await updateIOColumnMap(selectedConfigId, payload);
      } else {
        const r = await createIOColumnMap(payload);
        savedId = r.id;
        setSelectedConfigId(r.id);
      }
      await loadConfigs();
      return savedId;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    await saveConfigAndGetId();
  }

  async function deleteConfig(id) {
    if (!confirm('Delete this column mapping config?')) return;
    try {
      await deleteIOColumnMap(id);
      if (selectedConfigId === id) {
        setSelectedConfigId(null);
        setDraft(null);
        setInstanceMappings({});
        setHardwareMappings({});
      }
      await loadConfigs();
    } catch (e) {
      setError(e.message);
    }
  }

  function selectConfig(config) {
    setSelectedConfigId(config.id);
    let parsed;
    try {
      parsed = typeof config.mappings === 'string' ? JSON.parse(config.mappings) : (config.mappings || {});
    } catch {
      parsed = {};
    }
    // Recover configs saved with the old double-encoding bug: the first parse
    // yields a string that's itself JSON. Parse once more before interpreting.
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
    }

    // Backward compatibility: legacy IO configs store a flat { column: field } map.
    // Unified configs store { instance: {...}, hardware: {...} }.
    let instance, hardware;
    if (parsed.instance !== undefined || parsed.hardware !== undefined) {
      instance = parsed.instance || {};
      hardware = parsed.hardware || {};
    } else {
      // Legacy flat map — treat it as instance mappings only
      instance = parsed;
      hardware = {};
    }

    setDraft({
      name: config.name,
      description: config.description || '',
      mappings: { instance, hardware },
    });
    setInstanceMappings(instance);
    setHardwareMappings(hardware);
  }

  function updateInstanceMapping(field, header) {
    const newMappings = { ...instanceMappings };
    // Remove old mapping for this field
    for (const [col, f] of Object.entries(newMappings)) {
      if (f === field) {
        delete newMappings[col];
        break;
      }
    }
    if (header) newMappings[header] = field;
    setInstanceMappings(newMappings);
    // Update draft
    if (draft) {
      setDraft(d => ({
        ...d,
        mappings: {
          ...d.mappings,
          instance: newMappings,
        },
      }));
    }
  }

  function updateHardwareMapping(field, header) {
    const newMappings = { ...hardwareMappings };
    // Remove old mapping for this field
    for (const [col, f] of Object.entries(newMappings)) {
      if (f === field) {
        delete newMappings[col];
        break;
      }
    }
    if (header) newMappings[header] = field;
    setHardwareMappings(newMappings);
    // Update draft
    if (draft) {
      setDraft(d => ({
        ...d,
        mappings: {
          ...d.mappings,
          hardware: newMappings,
        },
      }));
    }
  }

  // Invert mappings for display: field → column
  const instanceFieldToColumn = {};
  for (const [col, field] of Object.entries(instanceMappings)) {
    instanceFieldToColumn[field] = col;
  }

  const hardwareFieldToColumn = {};
  for (const [col, field] of Object.entries(hardwareMappings)) {
    hardwareFieldToColumn[field] = col;
  }

  async function handleImportInstances() {
    if (!draft) {
      setError('No config selected');
      return;
    }
    setBusy(true);
    try {
      if (onImportInstances) {
        await onImportInstances(instanceMappings);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImportHardware() {
    if (!draft) {
      setError('No config selected');
      return;
    }
    // Validate hardware mandatory fields
    const isMlfbMapped = !!hardwareFieldToColumn[HW_MODULE_ORDER_FIELD.key];
    const isTier1 = isMlfbMapped;
    const isProtocolMapped = !!hardwareFieldToColumn[HW_PROTOCOL_FIELD.key];
    const isSignalTypeMapped = !!hardwareFieldToColumn[HW_SIGNAL_TYPE_FIELD.key];

    const coreUnmapped = HW_CORE_MANDATORY.filter(f => !hardwareFieldToColumn[f.key]);
    if (coreUnmapped.length > 0) {
      setError(`Hardware: Missing required fields: ${coreUnmapped.map(f => f.label).join(', ')}`);
      return;
    }

    if (!isTier1 && (!isProtocolMapped || !isSignalTypeMapped)) {
      setError('Hardware: MLFB not mapped. Protocol and Signal Type are required for Tier 2 resolution.');
      return;
    }

    setBusy(true);
    try {
      // Ensure this config is persisted before handing off — the workflow engine
      // later reads the hardware mapping back from this saved config (via
      // io_imports.source_column_map_id), so an unsaved draft would leave it with
      // nothing to find.
      const configId = await saveConfigAndGetId();
      if (onImportHardware) {
        await onImportHardware(hardwareMappings, configId);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <div style={{ padding: 20, color: 'var(--color-text-secondary)' }}>Loading configs…</div>;
  }

  return (
    <div style={{ display: 'flex', gap: 0, height: '100%' }}>
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* CONFIGS SIDEBAR */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        width: 220, flexShrink: 0, borderRight: '0.5px solid var(--color-border-tertiary)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
            color: 'var(--color-text-secondary)',
          }}>Configs</span>
          <Btn onClick={newConfig}><i className="ti ti-plus" /></Btn>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {configs.map(cm => (
            <div key={cm.id} onClick={() => selectConfig(cm)}
              style={{
                padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                borderBottom: '0.5px solid var(--color-border-tertiary)',
                background: selectedConfigId === cm.id ? '#EEEDFE' : 'transparent',
              }}>
              <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{cm.name}</span>
              <button onClick={e => { e.stopPropagation(); deleteConfig(cm.id); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--color-text-secondary)', fontSize: 13,
                }}>
                <i className="ti ti-trash" />
              </button>
            </div>
          ))}
          {configs.length === 0 && (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              No configs yet.
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* MAIN EDITOR AREA */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        flex: 1, padding: '12px 16px', overflowY: 'auto', display: 'flex',
        flexDirection: 'column', gap: 12,
      }}>
        {!draft ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 20 }}>
            Select a config or create a new one.
          </div>
        ) : (
          <>
            {/* Config Name & Description */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Config name</div>
                <input
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  style={inputSx}
                />
              </div>
              <div style={{ flex: 2, minWidth: 200 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Description</div>
                <input
                  value={draft.description}
                  onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                  style={inputSx}
                />
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* PANEL 1: INSTANCE & HIERARCHY */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <div style={{ marginTop: 12 }}>
              <div style={{
                fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                color: 'var(--color-text-secondary)', marginBottom: 8,
              }}>
                Instance & Hierarchy Fields
              </div>

              <div style={{
                border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6,
                overflow: 'hidden',
              }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
                  background: 'var(--color-background-secondary)',
                  borderBottom: '0.5px solid var(--color-border-tertiary)',
                }}>
                  <div style={{
                    padding: '8px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    color: 'var(--color-text-secondary)',
                  }}>
                    Internal Field
                  </div>
                  <div style={{
                    padding: '8px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    color: 'var(--color-text-secondary)', borderLeft: '0.5px solid var(--color-border-tertiary)',
                  }}>
                    Customer Column
                  </div>
                </div>

                {INSTANCE_INTERNAL_FIELDS.map((field, idx) => (
                  <div key={field} style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr',
                    borderBottom: idx < INSTANCE_INTERNAL_FIELDS.length - 1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
                    minHeight: 80,
                  }}>
                    <div style={{
                      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
                      borderRight: '0.5px solid var(--color-border-tertiary)',
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                        {field}
                      </div>
                      <div style={{
                        fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.4,
                      }}>
                        {INSTANCE_FIELD_DESCRIPTIONS[field]}
                      </div>
                    </div>

                    <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center' }}>
                      <select
                        value={instanceFieldToColumn[field] || ''}
                        onChange={e => updateInstanceMapping(field, e.target.value || null)}
                        style={{ ...inputSx, flex: 1 }}>
                        <option value="">— select column —</option>
                        {headers.map(h => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* PANEL 2: HARDWARE */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <div style={{ marginTop: 20 }}>
              <div style={{
                fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                color: 'var(--color-text-secondary)', marginBottom: 8,
              }}>
                Hardware Fields
              </div>

              <div style={{
                border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6,
                overflow: 'hidden',
              }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
                  background: 'var(--color-background-secondary)',
                  borderBottom: '0.5px solid var(--color-border-tertiary)',
                }}>
                  <div style={{
                    padding: '8px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    color: 'var(--color-text-secondary)',
                  }}>
                    Field
                  </div>
                  <div style={{
                    padding: '8px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    color: 'var(--color-text-secondary)', borderLeft: '0.5px solid var(--color-border-tertiary)',
                  }}>
                    Column
                  </div>
                </div>

                {/* CORE MANDATORY */}
                {HW_CORE_MANDATORY.map((field, idx) => (
                  <div key={field.key} style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr',
                    borderBottom: '0.5px solid var(--color-border-tertiary)',
                    minHeight: 70,
                  }}>
                    <div style={{
                      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
                      borderRight: '0.5px solid var(--color-border-tertiary)',
                    }}>
                      <div style={{
                        fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-mono)',
                        color: !hardwareFieldToColumn[field.key] ? '#991B1B' : 'inherit',
                      }}>
                        {field.label}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                        {field.desc}
                      </div>
                    </div>

                    <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center' }}>
                      <select
                        value={hardwareFieldToColumn[field.key] || ''}
                        onChange={e => updateHardwareMapping(field.key, e.target.value || null)}
                        style={{ ...inputSx, flex: 1, borderColor: !hardwareFieldToColumn[field.key] ? '#FCA5A5' : undefined }}>
                        <option value="">— select —</option>
                        {headers.map(h => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}

                {/* TIER 1: MODULE ORDER */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr',
                  borderBottom: '0.5px solid var(--color-border-tertiary)',
                  minHeight: 70,
                  background: 'var(--color-background-secondary)',
                }}>
                  <div style={{
                    padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
                    borderRight: '0.5px solid var(--color-border-tertiary)',
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                      {HW_MODULE_ORDER_FIELD.label}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                      {HW_MODULE_ORDER_FIELD.desc}
                    </div>
                  </div>

                  <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center' }}>
                    <select
                      value={hardwareFieldToColumn[HW_MODULE_ORDER_FIELD.key] || ''}
                      onChange={e => updateHardwareMapping(HW_MODULE_ORDER_FIELD.key, e.target.value || null)}
                      style={{ ...inputSx, flex: 1 }}>
                      <option value="">— select —</option>
                      {headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* TIER 2: PROTOCOL & SIGNAL TYPE (shown when MLFB unmapped) */}
                {!hardwareFieldToColumn[HW_MODULE_ORDER_FIELD.key] && (
                  <>
                    <div style={{
                      padding: '8px 12px', background: '#FEF3C7', borderBottom: '0.5px solid var(--color-border-tertiary)',
                      fontSize: 10, color: '#92400E', fontWeight: 500,
                    }}>
                      ⚠️ Tier 2 Resolution (MLFB not mapped — Protocol + Signal Type required)
                    </div>

                    {[HW_PROTOCOL_FIELD, HW_SIGNAL_TYPE_FIELD].map(field => (
                      <div key={field.key} style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr',
                        borderBottom: field.key === HW_SIGNAL_TYPE_FIELD.key ? '0.5px solid var(--color-border-tertiary)' : '0.5px solid var(--color-border-tertiary)',
                        minHeight: 70,
                      }}>
                        <div style={{
                          padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
                          borderRight: '0.5px solid var(--color-border-tertiary)',
                        }}>
                          <div style={{
                            fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-mono)',
                            color: !hardwareFieldToColumn[field.key] ? '#991B1B' : 'inherit',
                          }}>
                            {field.label}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                            {field.desc}
                          </div>
                        </div>

                        <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center' }}>
                          <select
                            value={hardwareFieldToColumn[field.key] || ''}
                            onChange={e => updateHardwareMapping(field.key, e.target.value || null)}
                            style={{ ...inputSx, flex: 1, borderColor: !hardwareFieldToColumn[field.key] ? '#FCA5A5' : undefined }}>
                            <option value="">— select —</option>
                            {headers.map(h => (
                              <option key={h} value={h}>{h}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* OPTIONAL FIELDS */}
                {HW_OPTIONAL_FIELDS.map((field, idx) => (
                  <div key={field.key} style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr',
                    borderBottom: idx < HW_OPTIONAL_FIELDS.length - 1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
                    minHeight: 50,
                  }}>
                    <div style={{
                      padding: '10px 12px', display: 'flex', alignItems: 'center',
                      borderRight: '0.5px solid var(--color-border-tertiary)',
                    }}>
                      <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                        {field.label}
                      </div>
                    </div>

                    <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center' }}>
                      <select
                        value={hardwareFieldToColumn[field.key] || ''}
                        onChange={e => updateHardwareMapping(field.key, e.target.value || null)}
                        style={{ ...inputSx, flex: 1 }}>
                        <option value="">— select —</option>
                        {headers.map(h => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* ACTION BUTTONS */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <div style={{
              display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center',
              flexWrap: 'wrap', marginTop: 16,
            }}>
              <Btn onClick={autoDetectColumns} disabled={busy || !draft || headers.length === 0}
                style={{ marginRight: 'auto' }}>
                <i className="ti ti-wand" /> Auto-detect columns
              </Btn>
              <Btn onClick={handleImportInstances} disabled={busy || !draft}>
                <i className="ti ti-upload" /> {busy ? 'Importing…' : 'Import Instances'}
              </Btn>
              <Btn onClick={handleImportHardware} disabled={busy || !draft}>
                <i className="ti ti-upload" /> {busy ? 'Importing…' : 'Import Hardware'}
              </Btn>
              <Btn primary onClick={saveConfig} disabled={busy || !draft || !draft.name.trim()}>
                <i className="ti ti-device-floppy" /> Save config
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
