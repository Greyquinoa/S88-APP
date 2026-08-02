import React, { useState, useEffect } from 'react';
import {
  getIOColumnMaps, createIOColumnMap, updateIOColumnMap, deleteIOColumnMap,
} from './api.js';

// Glass radio button styles for config selection (green theme, smooth sliding glider)
const glassRadioCss = `
.glass-radio-group-vertical {
  position: relative;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0);
  padding: 0.5rem 0;
  border: 0px solid rgb(255, 255, 255, 0);
  backdrop-filter: blur(16px);
  overflow-x: hidden;
  gap: 0;
}

.glass-radio-group-vertical input {
  display: none;
}

.glass-radio-group-vertical label {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.75rem 1rem;
  font-weight: 500;
  font-size: 0.9rem;
  color: #1a1a1a;
  cursor: pointer;
  z-index: 2;
  transition: color 0.4s ease-in-out;
  overflow: hidden;
}

.glass-label-text {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Rendered before the rows so it paints beneath them; the rows are transparent
   and sit at a higher z-index. Only 'transform' animates, so the slide is
   compositor-driven and stays smooth. */
/* Spans the sidebar edge to edge with a shiny glass effect. The layered
   shadows create depth (inset highlight at top, shadow at bottom), and the
   gradient overlay simulates refracted light. */
.glass-glider-vertical {
  position: absolute;
  left: 0;
  right: 0;
  top: 0.5rem;
  z-index: 0;
  pointer-events: none;
  flex: none;
  border-radius: 0;
  transition: transform 0.4s cubic-bezier(0.5, 1.6, 0.4, 1);
  background: linear-gradient(135deg, #3a3a3a, #555555);
  box-shadow:
    inset 0 0.2rem 0.6rem rgba(255, 255, 255, 0.25),
    inset 0 -0.1rem 0.3rem rgba(0, 0, 0, 0.5),
    inset 0 -0.3rem 0.6rem rgba(255, 255, 255, 0.3),
    0 2rem 2rem rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

/* Pseudo-element for the glossy highlight overlay. */
.glass-glider-vertical::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 50%;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.2) 0%,
    rgba(255, 255, 255, 0.05) 40%,
    transparent 100%
  );
  pointer-events: none;
}

/* Selected row sits on the dark band, so its text inverts to white. */
.glass-radio-group-vertical input:checked + label {
  color: #FFFFFF;
  font-weight: 600;
}
.glass-radio-group-vertical input:checked + label .glass-sub-text {
  color: rgba(255, 255, 255, 0.75) !important;
}
.glass-radio-group-vertical input:checked + label .ti-trash {
  color: #FFFFFF !important;
}
.glass-radio-group-vertical input:checked + label .ti-trash:hover {
  color: #FF4444 !important;
}

/* Unselected rows stay dark-on-light and lift slightly on hover. */
.glass-radio-group-vertical input:not(:checked) + label:hover {
  background: rgba(28, 27, 25, 0.05);
}
`;

// Row height before the first measurement lands, and the flex `gap` between rows.
const GLIDER_FALLBACK_H = 44;
const GLIDER_GAP = 0;   // matches `gap: 0` on .glass-radio-group-vertical

// Shares the single 'glass-radio-styles' tag with StepIOImport.jsx — both files
// define the same class names, so separate tags would just overwrite each other
// in load order. Contents are always rewritten so edits survive a hot reload.
if (typeof document !== 'undefined') {
  let style = document.getElementById('glass-radio-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'glass-radio-styles';
    document.head.appendChild(style);
  }
  style.textContent = glassRadioCss;
}

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
  instrument_tag: 'INSTRUMENT TAG *',
  function_val: 'FUNCTION *',
  hierarchy: 'HIERARCHY *',
  assignment: 'AS ASSIGNMENT',
};
const INSTANCE_FIELD_DESCRIPTIONS = {
  instrument_tag: 'CM identity — groups IO rows into one instance',
  function_val: 'Maps to CM type for instance creation',
  hierarchy: 'Full path (e.g., Area/Cell/Unit) — determines folder structure',
  assignment: 'AS assignment (e.g., AS01) — maps to user_project',
};

// Hardware Fields
const HW_CORE_MANDATORY = [
  { key: 'station_address', label: 'STATION ADDRESS *', desc: 'Hardware device ID' },
  { key: 'slot', label: 'SLOT *', desc: 'Module position in rack' },
  { key: 'tag', label: 'TAG *', desc: 'Signal identifier' },
  { key: 'channel', label: 'CHANNEL *', desc: 'Signal channel number' },
];

const HW_MODULE_ORDER_FIELD = { key: 'module_order_no', label: 'MODULE ORDER NO (CARD MLFB)', desc: 'Siemens module catalog number — Tier 1' };
const HW_PROTOCOL_FIELD = { key: 'protocol', label: 'PROTOCOL', desc: 'Used with Signal Type to resolve Card MLFB — Tier 2' };
const HW_SIGNAL_TYPE_FIELD = { key: 'signal_type', label: 'SIGNAL TYPE', desc: 'DI / DO / AI / AO — required for Tier 2' };

const HW_OPTIONAL_FIELDS = [
  { key: 'station_name', label: 'STATION NAME' },
  { key: 'ip_address', label: 'IP ADDRESS' },
  { key: 'description', label: 'DESCRIPTION' },
  { key: 'subsystem_no', label: 'SUBSYSTEM NO' },
  { key: 'router_address', label: 'ROUTER ADDRESS' },
];

// UI Styles
const inputSx = {
  padding: '6px 10px',
  border: '0.5px solid var(--color-border-secondary)',
  borderRadius: 6,
  fontSize: 14,
  fontFamily: 'var(--font-mono)',
  background: 'var(--color-background-primary)',
  color: 'var(--color-text-primary)',
  width: '100%',
};

// Glass morphism sidebar card + its header strip — mirrors glassPanelSx /
// glassPanelHeaderSx in StepIOImport.jsx so the Column Mapping configs sidebar
// reads identically to the Function Mapping one.
const glassPanelSx = {
  border: '1px solid rgba(255,255,255,0.3)',
  borderRadius: '16px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  flex: 1,
  minHeight: 0,
  background: 'rgba(255,255,255,0.18)',
  backdropFilter: 'blur(16px)',
  boxShadow: '0 8px 32px 0 rgba(0,0,0,0.1)',
};

const glassPanelHeaderSx = {
  padding: '12px 16px',
  borderBottom: '1px solid rgba(255,255,255,0.25)',
  background: 'rgba(255,255,255,0.12)',
  flexShrink: 0,
};

// Field label matching the hero's "AT A GLANCE" eyebrow (.nimbus-eyebrow-label).
const eyebrowLabelSx = {
  marginBottom: 3,
  fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 13,
  letterSpacing: '0.02em', textTransform: 'uppercase', color: '#6B6862',
};

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function Btn({ onClick, primary, danger, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        padding: '7px 18px',
        borderRadius: 'var(--border-radius-md)',
        fontSize: 13,
        fontWeight: primary ? 500 : 400,
        border: danger ? '0.5px solid #FCA5A5' : primary ? 'none' : '0.5px solid var(--color-border-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: danger ? '#FEE2E2' : primary ? 'var(--color-accent)' : 'transparent',
        color: danger ? '#991B1B' : primary ? 'white' : 'var(--color-text-primary)',
        opacity: disabled ? 0.45 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        transition: 'opacity 0.15s ease',
        ...style,
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

  // Sliding-highlight geometry. The row height is measured rather than assumed:
  // rows size to their own content (a description makes a row taller), so a
  // hard-coded value drifts the highlight further off with every row down.
  const rowRef = React.useRef(null);
  const [rowH, setRowH] = useState(GLIDER_FALLBACK_H);
  const selectedIdx = configs.findIndex(c => c.id === selectedConfigId);
  React.useLayoutEffect(() => {
    const h = rowRef.current?.offsetHeight;
    if (h) setRowH(h);
  }, [configs, selectedConfigId]);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Panel heading — mirrors PanelHeading in StepIOImport.jsx (subtitle only,
          matching the Upload and Function Mapping tabs). */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Assign each column from your imported IO list to the corresponding field used by the application for processing.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* CONFIGS SIDEBAR */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={glassPanelSx}>
          <div style={glassPanelHeaderSx}>
            <Btn primary onClick={newConfig} style={{ width: '100%' }}>
              <i className="ti ti-plus" /> New config
            </Btn>
          </div>
          <div className="glass-radio-group-vertical" style={{ flex: 1, overflowY: 'auto' }}>
            {configs.length === 0 ? (
              <div style={{ padding: '1rem', fontSize: 12, color: '#888', textAlign: 'center' }}>
                No configs yet
              </div>
            ) : (
              <>
                {/* Sliding highlight. Rendered first so it paints beneath the rows,
                    and positioned from the measured row height (rows vary — those
                    with a description are taller than those without). */}
                {selectedIdx >= 0 && (
                  <div className="glass-glider-vertical" style={{
                    height: rowH,
                    transform: `translateY(${selectedIdx * (rowH + GLIDER_GAP)}px)`,
                  }} />
                )}
                {configs.map(cm => (
                  <React.Fragment key={cm.id}>
                    <input
                      type="radio"
                      id={`colmap-${cm.id}`}
                      name="column-map"
                      checked={selectedConfigId === cm.id}
                      onChange={() => selectConfig(cm)} />
                    <label ref={cm.id === configs[0].id ? rowRef : undefined}
                      htmlFor={`colmap-${cm.id}`}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="glass-label-text" style={{ minWidth: 0 }} title={cm.name}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {cm.name}
                          </div>
                          {cm.description && (
                            <div className="glass-sub-text" style={{ fontSize: '0.85rem', color: '#999',
                                marginTop: '0.2rem',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {cm.description}
                            </div>
                          )}
                        </div>
                      </div>
                      {selectedConfigId === cm.id && (
                        <span onClick={e => { e.preventDefault(); e.stopPropagation(); deleteConfig(cm.id); }}
                          title="Delete config"
                          style={{ cursor: 'pointer', padding: '2px 4px', color: '#6b7280',
                            fontSize: 13, lineHeight: 1, flexShrink: 0,
                            transition: 'color 0.15s ease' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                          onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}>
                          <i className="ti ti-trash" />
                        </span>
                      )}
                    </label>
                  </React.Fragment>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* MAIN EDITOR AREA */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        minWidth: 0, overflowY: 'auto', display: 'flex',
        flexDirection: 'column', gap: 12,
      }}>
        {!draft ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 20 }}>
            Select a config or create a new one.
          </div>
        ) : (
          <>
            {/* Config Name & Description (50-50) + Save Button + Auto-detect */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <div style={eyebrowLabelSx}>Config name</div>
                <input
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  style={{ ...inputSx, width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={eyebrowLabelSx}>Description</div>
                <input
                  value={draft.description}
                  onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                  style={{ ...inputSx, width: '100%' }}
                />
              </div>
              <Btn primary onClick={saveConfig} disabled={busy || !draft.name.trim()}>
                <i className="ti ti-device-floppy" /> {busy ? 'Saving…' : 'Save config'}
              </Btn>
              <Btn onClick={autoDetectColumns} disabled={busy || !draft || headers.length === 0}>
                <i className="ti ti-wand" /> Auto-detect
              </Btn>
            </div>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* PANEL 1: INSTANCE & HIERARCHY */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <div style={{
              fontSize: 14, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.04em', color: 'var(--color-text-secondary)',
              marginTop: 16, marginBottom: 8,
            }}>
              INSTANCE & HIERARCHY FIELDS
            </div>
            <div style={{ border: '1px solid rgba(28,27,25,0.08)', borderRadius: '12px', overflow: 'hidden', background: '#FBFAF7', boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)', flexShrink: 0 }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '40% 60%', gap: 0,
                background: '#FBF8F0',
                borderBottom: '1px solid rgba(28,27,25,0.08)',
              }}>
                <div style={{
                  padding: '10px 16px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                  color: '#6B6862',
                }}>
                  INTERNAL FIELD
                </div>
                <div style={{
                  padding: '10px 16px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                  color: '#6B6862', borderLeft: '1px solid rgba(28,27,25,0.08)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span>CUSTOMER COLUMN</span>
                  <Btn primary onClick={handleImportInstances} disabled={busy || !draft}
                    style={{ textTransform: 'none', letterSpacing: 'normal' }}>
                    <i className="ti ti-upload" /> {busy ? 'Importing…' : 'Import Instances'}
                  </Btn>
                </div>
              </div>

              {INSTANCE_INTERNAL_FIELDS.map((field, idx) => (
                <div key={field} style={{
                  display: 'grid', gridTemplateColumns: '40% 60%',
                  borderBottom: '1px solid rgba(28,27,25,0.08)',
                  background: '#FFFFFF',
                  borderLeft: '1px solid rgba(28,27,25,0.08)',
                  borderRight: '1px solid rgba(28,27,25,0.08)',
                }}>
                  <div style={{
                    padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2,
                    borderRight: '1px solid rgba(28,27,25,0.08)',
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-sans)', textTransform: 'uppercase' }}>
                      {INSTANCE_FIELD_LABELS[field]}
                    </div>
                    <div style={{
                      fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.3,
                    }}>
                      {INSTANCE_FIELD_DESCRIPTIONS[field]}
                    </div>
                  </div>

                  <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center' }}>
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

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* PANEL 2: HARDWARE */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <div style={{
              fontSize: 14, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.04em', color: 'var(--color-text-secondary)',
              marginTop: 20, marginBottom: 8,
            }}>
              HARDWARE FIELDS
            </div>
            <div style={{ border: '1px solid rgba(28,27,25,0.08)', borderRadius: '12px', overflow: 'hidden', background: '#FBFAF7', boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)', flexShrink: 0 }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '40% 60%', gap: 0,
                background: '#FBF8F0',
                borderBottom: '1px solid rgba(28,27,25,0.08)',
              }}>
                <div style={{
                  padding: '10px 16px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                  color: '#6B6862',
                }}>
                  FIELD
                </div>
                <div style={{
                  padding: '10px 16px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                  color: '#6B6862', borderLeft: '1px solid rgba(28,27,25,0.08)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span>COLUMN</span>
                  <Btn primary onClick={handleImportHardware} disabled={busy || !draft}
                    style={{ textTransform: 'none', letterSpacing: 'normal' }}>
                    <i className="ti ti-upload" /> {busy ? 'Importing…' : 'Import Hardware'}
                  </Btn>
                </div>
              </div>

                {/* CORE MANDATORY */}
                {HW_CORE_MANDATORY.map((field, idx) => (
                  <div key={field.key} style={{
                    display: 'grid', gridTemplateColumns: '40% 60%',
                    borderBottom: '1px solid rgba(28,27,25,0.08)',
                    background: '#FFFFFF',
                    borderLeft: '1px solid rgba(28,27,25,0.08)',
                    borderRight: '1px solid rgba(28,27,25,0.08)',
                  }}>
                    <div style={{
                      padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2,
                      borderRight: '1px solid rgba(28,27,25,0.08)',
                    }}>
                      <div style={{
                        fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-sans)',
                        color: !hardwareFieldToColumn[field.key] ? '#991B1B' : 'inherit',
                        textTransform: 'uppercase',
                      }}>
                        {field.label}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                        {field.desc}
                      </div>
                    </div>

                    <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center' }}>
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
                  display: 'grid', gridTemplateColumns: '40% 60%',
                  borderBottom: '1px solid rgba(28,27,25,0.08)',
                  background: '#FFFFFF',
                  borderLeft: '1px solid rgba(28,27,25,0.08)',
                  borderRight: '1px solid rgba(28,27,25,0.08)',
                }}>
                  <div style={{
                    padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2,
                    borderRight: '1px solid rgba(28,27,25,0.08)',
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-sans)', textTransform: 'uppercase' }}>
                      {HW_MODULE_ORDER_FIELD.label}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                      {HW_MODULE_ORDER_FIELD.desc}
                    </div>
                  </div>

                  <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center' }}>
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
                      padding: '8px 16px', background: '#FEF3C7', borderBottom: '1px solid rgba(28,27,25,0.08)',
                      fontSize: 10, color: '#92400E', fontWeight: 500,
                    }}>
                      ⚠️ Tier 2 Resolution (MLFB not mapped — Protocol + Signal Type required)
                    </div>

                    {[HW_PROTOCOL_FIELD, HW_SIGNAL_TYPE_FIELD].map(field => (
                      <div key={field.key} style={{
                        display: 'grid', gridTemplateColumns: '40% 60%',
                        borderBottom: '1px solid rgba(28,27,25,0.08)',
                        background: '#FFFFFF',
                        borderLeft: '1px solid rgba(28,27,25,0.08)',
                        borderRight: '1px solid rgba(28,27,25,0.08)',
                      }}>
                        <div style={{
                          padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2,
                          borderRight: '1px solid rgba(28,27,25,0.08)',
                        }}>
                          <div style={{
                            fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-sans)',
                            color: !hardwareFieldToColumn[field.key] ? '#991B1B' : 'inherit',
                            textTransform: 'uppercase',
                          }}>
                            {field.label}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.3 }}>
                            {field.desc}
                          </div>
                        </div>

                        <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center' }}>
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
                    display: 'grid', gridTemplateColumns: '40% 60%',
                    borderBottom: idx < HW_OPTIONAL_FIELDS.length - 1 ? '1px solid rgba(28,27,25,0.08)' : 'none',
                    background: '#FFFFFF',
                    borderLeft: '1px solid rgba(28,27,25,0.08)',
                    borderRight: idx < HW_OPTIONAL_FIELDS.length - 1 ? '1px solid rgba(28,27,25,0.08)' : 'none',
                  }}>
                    <div style={{
                      padding: '10px 16px', display: 'flex', alignItems: 'center',
                      borderRight: '1px solid rgba(28,27,25,0.08)',
                    }}>
                      <div style={{ fontSize: 14, fontFamily: 'var(--font-sans)', fontWeight: 600, textTransform: 'uppercase' }}>
                        {field.label}
                      </div>
                    </div>

                    <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center' }}>
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

          </>
        )}
      </div>
      </div>
    </div>
  );
}
