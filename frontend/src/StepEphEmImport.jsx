// StepEphEmImport.jsx — EPH/EM import workflow step
import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect, Fragment } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  uploadEphEmList, listEphEmImports, getEphEmImport, deleteEphEmImport, getEphEmRows, patchEphEmRow, rejectEphEmRow,
  applyEphEmColumnMap, runEphEmAssignment, promoteEphEmImport,
  getEphEmTypeMappingConfigs, createEphEmTypeMappingConfig, updateEphEmTypeMappingConfig, deleteEphEmTypeMappingConfig,
  listCompositeCmTypes,
} from './api.js';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
// Same primitives the IO import renders with, so both workflows stay in step.
import {
  GLIDER_FALLBACK_H, GLIDER_GAP,
  Btn, SLabel, PanelHeading, EmptyState, Callout,
  panelSx, glassPanelSx, panelHeaderSx, glassPanelHeaderSx,
  inputSx, textInputSx, eyebrowLabelSx,
} from './ImportUIKit.jsx';

ModuleRegistry.registerModules([AllCommunityModule]);

// Inject spin animation for loading spinner
if (typeof document !== 'undefined') {
  let style = document.getElementById('ephemimport-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ephemimport-styles';
    document.head.appendChild(style);
  }
  style.textContent = `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
}

// Saved mappings come back as a JSON string from Postgres, but may already be an
// object depending on the driver — normalise both to a plain { column: composite }.
function parseMappings(mappings) {
  if (!mappings) return {};
  if (typeof mappings === 'object') return mappings;
  try {
    return JSON.parse(mappings) || {};
  } catch {
    return {};
  }
}

// A fresh editor row. Returned from a factory rather than shared as a constant
// so rows never alias each other in state.
const BLANK_MAPPING_ROW = () => ({
  type_column: '', composite_type: '', match_mode: 'exact', priority: 0,
});

// Grid template shared by the mapping table's header and body rows, so the
// columns cannot drift apart.
const MAP_COLS = '1fr 180px 110px 80px 40px';

// Module scope, not component scope: as a component-level object literal this is
// rebuilt every render, which gives every useCallback that closes over it a new
// identity, which re-fires the "on mount" effects that depend on them.
const STORAGE_KEYS = {
  UNIT_COLUMN: 'ephemUpload_selectedUnitColumn',
  TYPE_MAPPING: 'ephemUpload_selectedTypeMapping',
  ASSIGNMENT_SUCCESS: 'ephemUpload_assignmentSuccess',
  IMPORT_ID: 'ephemUpload_currentImportId',
};

const PHASE = {
  TYPE_MAPPINGS: 'type_mappings',
  UPLOAD: 'upload',
  FUNCTION_MAP: 'function_map',
  REVIEW: 'review',
  PROMOTE: 'promote',
};

// Sub-tab bar, mirroring StepIOImport's. Type Mappings and Upload are always
// reachable; Review appears after assignment. FUNCTION_MAP and PROMOTE are kept
// for backwards compatibility but hidden from UI (Promote integrated into Review).
const EPHEM_TABS = [
  { key: PHASE.TYPE_MAPPINGS, label: 'Type Mappings' },
  { key: PHASE.UPLOAD,        label: 'Upload' },
  { key: PHASE.REVIEW,        label: 'Review' },
];

const ALWAYS_ENABLED = [PHASE.TYPE_MAPPINGS, PHASE.UPLOAD];

function SubTabs({ tab, setTab, importReady }) {
  return (
    <div style={{ display: 'flex', borderBottom: '0.5px solid var(--color-border-tertiary)',
        marginBottom: '1rem', flexShrink: 0 }}>
      {EPHEM_TABS.map(t => {
        const disabled = !ALWAYS_ENABLED.includes(t.key) && !importReady;
        const active   = tab === t.key;
        return (
          <button key={t.key} onClick={() => !disabled && setTab(t.key)} disabled={disabled}
            title={disabled ? 'Upload an EPH/EM file first' : undefined}
            style={{
              padding: '7px 18px', border: 'none', background: 'transparent',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: '1rem', fontWeight: active ? 600 : 400,
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              opacity: disabled ? 0.4 : 1,
              borderBottom: active ? '2px solid var(--color-text-primary)' : '2px solid transparent',
              marginBottom: -1,
            }}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

const styles = {
  container: {
    padding: '30px',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  heading: {
    fontSize: '28px',
    fontWeight: '600',
    marginBottom: '10px',
    color: '#1a1a1a',
  },
  description: {
    fontSize: '14px',
    color: '#666',
    marginBottom: '20px',
  },
  uploadSection: {
    border: '2px dashed #ccc',
    borderRadius: '8px',
    padding: '40px',
    textAlign: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s',
    backgroundColor: '#fafafa',
  },
  uploadText: {
    fontSize: '18px',
    marginBottom: '10px',
    color: '#1a1a1a',
  },
  uploadSubtext: {
    color: '#666',
    fontSize: '14px',
  },
  infoBox: {
    backgroundColor: '#e7f3ff',
    border: '1px solid #b3d9ff',
    padding: '12px',
    borderRadius: '4px',
    marginBottom: '20px',
    fontSize: '14px',
  },
  configSelector: {
    marginBottom: '20px',
  },
  configLabel: {
    fontWeight: '600',
    marginBottom: '8px',
    display: 'block',
    color: '#333',
  },
  configSelect: {
    width: '100%',
    maxWidth: '400px',
    padding: '8px 12px',
    border: '1px solid #ccc',
    borderRadius: '4px',
    fontSize: '14px',
    boxSizing: 'border-box',
  },
  buttonGroup: {
    marginTop: '20px',
    display: 'flex',
    gap: '10px',
  },
  primaryButton: {
    padding: '10px 20px',
    backgroundColor: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600',
  },
  secondaryButton: {
    padding: '10px 20px',
    backgroundColor: '#f0f0f0',
    color: '#333',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600',
  },
  primaryButtonDisabled: {
    opacity: '0.6',
    cursor: 'not-allowed',
  },
  statsBox: {
    marginBottom: '20px',
    padding: '12px',
    backgroundColor: '#f0f0f0',
    borderRadius: '4px',
    fontSize: '14px',
  },
  successBox: {
    backgroundColor: '#d4edda',
    border: '1px solid #c3e6cb',
    padding: '12px',
    borderRadius: '4px',
    marginBottom: '20px',
    color: '#155724',
    fontWeight: '600',
  },
};

export default function StepEphEmImport({ projectId, onComplete }) {
  const [phase, setPhase] = useState(PHASE.TYPE_MAPPINGS);
  const [importId, setImportId] = useState(null);
  const [importing, setImporting] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  // Initialize from localStorage on mount, before render — so the form fields
  // paint with their saved values instead of empty and then flashing to saved.
  const [unitColumn, setUnitColumn] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.UNIT_COLUMN) || null;
  });
  const [assignmentColumn, setAssignmentColumn] = useState(() => {
    return localStorage.getItem('ephemUpload_selectedAssignmentColumn') || null;
  });
  const [selectedTypeMapping, setSelectedTypeMapping] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.TYPE_MAPPING);
    if (!saved) return null;
    try {
      return JSON.parse(saved);
    } catch {
      return null;
    }
  });
  const [typeColumnMappings, setTypeColumnMappings] = useState({});
  const [rows, setRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [allComposites, setAllComposites] = useState([]);
  const [compositesLoading, setCompositesLoading] = useState(true);
  const [promoting, setPromoting] = useState(false);
  const [typeMappingConfigs, setTypeMappingConfigs] = useState([]);
  const [configsLoading, setConfigsLoading] = useState(true);
  const [editingConfig, setEditingConfig] = useState(null);
  const [editConfigName, setEditConfigName] = useState('');
  const [editConfigMappings, setEditConfigMappings] = useState([]);
  const [configSaving, setConfigSaving] = useState(false);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState(null);
  const [assignmentSuccess, setAssignmentSuccess] = useState(false);
  const [storedImports, setStoredImports] = useState([]);
  const [importsLoading, setImportsLoading] = useState(false);
  const gridRef = useRef(null);

  // Save form selections to localStorage. Each field is written authoritatively
  // — clearing a selection must erase it, otherwise a stale value outlives the
  // state it mirrors and gets restored on the next reload.
  const saveFormState = useCallback((column, mapping, success, impId) => {
    if (column) localStorage.setItem(STORAGE_KEYS.UNIT_COLUMN, column);
    else localStorage.removeItem(STORAGE_KEYS.UNIT_COLUMN);

    if (mapping) localStorage.setItem(STORAGE_KEYS.TYPE_MAPPING, JSON.stringify(mapping));
    else localStorage.removeItem(STORAGE_KEYS.TYPE_MAPPING);

    localStorage.setItem(STORAGE_KEYS.ASSIGNMENT_SUCCESS, String(success));

    if (impId) localStorage.setItem(STORAGE_KEYS.IMPORT_ID, String(impId));
    else localStorage.removeItem(STORAGE_KEYS.IMPORT_ID);
  }, []);

  // Clear form selections from localStorage
  const clearFormState = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.UNIT_COLUMN);
    localStorage.removeItem(STORAGE_KEYS.TYPE_MAPPING);
    localStorage.removeItem(STORAGE_KEYS.ASSIGNMENT_SUCCESS);
    localStorage.removeItem(STORAGE_KEYS.IMPORT_ID);
  }, []);

  // Sliding-highlight geometry for the config sidebar. The row height is
  // measured rather than assumed: rows size to their own font/padding, so a
  // hard-coded value drifts the highlight further off with every row down.
  const cfgRowRef = useRef(null);
  const [cfgRowH, setCfgRowH] = useState(GLIDER_FALLBACK_H);
  const selectedCfgIdx = typeMappingConfigs.findIndex(
    c => editingConfig && c.id === editingConfig.id
  );
  useLayoutEffect(() => {
    const h = cfgRowRef.current?.offsetHeight;
    if (h) setCfgRowH(h);
  }, [typeMappingConfigs, editingConfig]);

  // Sliding-highlight geometry for the imports sidebar.
  const impRowRef = useRef(null);
  const [impRowH, setImpRowH] = useState(GLIDER_FALLBACK_H);
  const [imports, setImports] = useState([]);
  const selectedImpIdx = imports.findIndex(imp => imp.id === importId);
  useLayoutEffect(() => {
    const h = impRowRef.current?.offsetHeight;
    if (h) setImpRowH(h);
  }, [imports, importId]);

  const fileInputRef = useRef(null);

  // Load stored EPH/EM imports from database
  const loadStoredImports = useCallback(async () => {
    try {
      setImportsLoading(true);
      const imports = await listEphEmImports(projectId);
      setStoredImports(imports || []);
    } catch (e) {
      console.error('Failed to load stored imports:', e);
      setStoredImports([]);
    } finally {
      setImportsLoading(false);
    }
  }, [projectId]);

  // Load available composite types from library
  const loadAvailableComposites = useCallback(async () => {
    try {
      setCompositesLoading(true);
      const composites = await listCompositeCmTypes();
      setAllComposites(composites || []);
    } catch (e) {
      console.error('Failed to load composites:', e);
      setAllComposites([]);
    } finally {
      setCompositesLoading(false);
    }
  }, []);

  // Load type mapping configs on mount
  // Returns the loaded list so callers can immediately find a just-saved config
  // without waiting for the state update to land.
  const loadTypeMappingConfigs = useCallback(async () => {
    try {
      setConfigsLoading(true);
      const configs = await getEphEmTypeMappingConfigs();
      setTypeMappingConfigs(configs || []);
      return configs || [];
    } catch (e) {
      console.error('Failed to load type mapping configs:', e);
      setTypeMappingConfigs([]);
      return [];
    } finally {
      setConfigsLoading(false);
    }
  }, []);

  // Normalise a saved config's mappings into editor rows. Configs written
  // before match_mode/priority existed are stored as a flat { column: composite }
  // object, so upgrade those to the row shape on read.
  const configToRows = useCallback((config) => {
    const parsed = parseMappings(config?.mappings);
    const rows = Array.isArray(parsed)
      ? parsed.map(m => ({
          type_column: m.type_column || '',
          composite_type: m.composite_type || '',
          match_mode: m.match_mode || 'exact',
          priority: Number(m.priority || 0),
        }))
      : Object.entries(parsed).map(([type_column, composite_type]) => ({
          type_column, composite_type, match_mode: 'exact', priority: 0,
        }));
    return rows.length ? rows : [BLANK_MAPPING_ROW()];
  }, []);

  // Open a saved config in the editor pane.
  const selectConfig = useCallback((config) => {
    setEditingConfig(config);
    setEditConfigName(config.name);
    setEditConfigMappings(configToRows(config));
  }, [configToRows]);

  // Start a brand-new config. Kept unsaved until "Save mappings" so an
  // accidental click does not litter the list with empty configs.
  const startNewConfig = useCallback(() => {
    setEditingConfig(0);
    setEditConfigName(`Type Map ${typeMappingConfigs.length + 1}`);
    setEditConfigMappings([BLANK_MAPPING_ROW()]);
  }, [typeMappingConfigs.length]);

  // Patch one field of one editor row.
  const updateMappingRow = useCallback((idx, field, value) => {
    setEditConfigMappings(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }, []);

  // Handle type mapping config save
  const handleSaveTypeMapping = useCallback(async () => {
    if (!editConfigName.trim()) {
      alert('Config name required');
      return;
    }

    // Collect complete rows, dropping those with empty type_column or composite_type
    const mappings = editConfigMappings
      .filter(m => (m.type_column || '').trim() && (m.composite_type || '').trim())
      .map(m => ({
        type_column: (m.type_column || '').trim().toUpperCase(),
        composite_type: (m.composite_type || '').trim(),
        match_mode: m.match_mode || 'exact',
        priority: Number(m.priority || 0),
      }));

    if (mappings.length === 0) {
      alert('Add at least one complete mapping (type column + composite type)');
      return;
    }

    try {
      setConfigSaving(true);
      let savedId;
      if (editingConfig) {
        savedId = editingConfig.id;
        await updateEphEmTypeMappingConfig(savedId, {
          name: editConfigName,
          mappings,
        });
      } else {
        const created = await createEphEmTypeMappingConfig({
          name: editConfigName,
          mappings,
        });
        savedId = created?.id;
      }
      const fresh = await loadTypeMappingConfigs();
      // Keep the saved config open and highlighted rather than dropping back to
      // the empty pane — matches the IO function-map editor, and a newly created
      // config needs its real id so the next save updates instead of duplicating.
      const match = (fresh || []).find(c => String(c.id) === String(savedId));
      if (match) {
        setEditingConfig(match);
        setEditConfigName(match.name);
      }
    } catch (e) {
      alert('Error saving config: ' + e.message);
    } finally {
      setConfigSaving(false);
    }
  }, [editConfigName, editConfigMappings, editingConfig, loadTypeMappingConfigs]);

  // Handle type mapping config delete
  const handleDeleteTypeMapping = useCallback(async (id) => {
    if (!confirm('Delete this type mapping config?')) return;
    try {
      await deleteEphEmTypeMappingConfig(id);
      // Close the editor if it was showing the config just deleted, otherwise
      // it would stay bound to a row that no longer exists and a save would
      // 404 against the missing id.
      setEditingConfig(prev => (prev && prev.id === id ? null : prev));
      await loadTypeMappingConfigs();
    } catch (e) {
      alert('Error deleting config: ' + e.message);
    }
  }, [loadTypeMappingConfigs]);

  // Handle file upload
  const handleFileUpload = useCallback(async (file) => {
    if (!file) return;

    try {
      setImporting(true);
      const result = await uploadEphEmList(projectId, file);

      setUploadResult(result);
      setImportId(result.importId);
      setUnitColumn(null);
      setTypeColumnMappings({});
      setSelectedTypeMapping(null);
      setAssignmentError(null);
      setAssignmentSuccess(false);

      // Clear any previously saved form state for a fresh start with new file
      clearFormState();

      // Refresh stored imports list to show the newly uploaded file
      await loadStoredImports();
    } catch (e) {
      alert('Upload failed: ' + e.message);
    } finally {
      setImporting(false);
    }
  }, [projectId, loadStoredImports]);

  // Load rows for review
  const loadRows = useCallback(async () => {
    if (!importId) return;

    try {
      setRowsLoading(true);
      const result = await getEphEmRows(importId, { offset: 0, limit: 1000 });
      setRows(result.rows || []);
      setTotalRows(result.total || 0);
    } catch (e) {
      console.error('Failed to load rows:', e);
    } finally {
      setRowsLoading(false);
    }
  }, [importId]);

  // Apply column mapping
  const handleApplyColumnMap = useCallback(async () => {
    if (!unitColumn || !importId || !uploadResult?.headers) {
      alert('Please select a unit column');
      return;
    }

    try {
      setImporting(true);
      const mappings = { unit_column: unitColumn };
      await applyEphEmColumnMap(importId, mappings, uploadResult.headers);
      setPhase(PHASE.FUNCTION_MAP);
    } catch (e) {
      alert('Failed to apply column mapping: ' + e.message);
    } finally {
      setImporting(false);
    }
  }, [unitColumn, importId, uploadResult]);

  // Run function-map assignment
  const handleRunAssignment = useCallback(async () => {
    if (!typeColumnMappings || Object.keys(typeColumnMappings).length === 0 || !importId) {
      alert('Please select composite types for all columns');
      return;
    }

    try {
      setImporting(true);
      // typeColumnMappings is already { excelColumn: compositeName }
      await runEphEmAssignment(importId, typeColumnMappings);
      setPhase(PHASE.REVIEW);
      await loadRows();
    } catch (e) {
      alert('Failed to run assignment: ' + e.message);
    } finally {
      setImporting(false);
    }
  }, [typeColumnMappings, importId, loadRows]);

  // Update row assignment
  const handleRowUpdate = useCallback(async (rowId, updates) => {
    try {
      await patchEphEmRow(importId, rowId, updates);
      await loadRows();
    } catch (e) {
      alert('Failed to update row: ' + e.message);
    }
  }, [importId]);

  // Reject row
  const handleRejectRow = useCallback(async (rowId) => {
    if (!confirm('Reject this row?')) return;

    try {
      await rejectEphEmRow(importId, rowId);
      await loadRows();
    } catch (e) {
      alert('Failed to reject row: ' + e.message);
    }
  }, [importId]);

  // Promote import
  const handlePromote = useCallback(async () => {
    if (!importId) return;

    try {
      setPromoting(true);
      const result = await promoteEphEmImport(importId, projectId);
      const msg = `Successfully created ${result.created || result.instances?.length || 0} instances${result.warnings?.length ? '\n\nWarnings:\n' + result.warnings.join('\n') : ''}`;
      alert(msg);
      if (onComplete) onComplete();
    } catch (e) {
      alert('Failed to promote: ' + e.message);
    } finally {
      setPromoting(false);
    }
  }, [importId, projectId, onComplete]);

  // Transform rows: convert one-per-unit format with multiple EM/EPH types into
  // one-per-EM/EPH-designation format. Each ticked EM/EPH type becomes a separate row.
  const transformedRows = useMemo(() => {
    if (!rows || rows.length === 0) return [];

    const result = [];
    let rowIndex = 1;

    for (const row of rows) {
      const ephEmTypes = parseMappings(row.eph_em_types || {});
      const assignedTypes = parseMappings(row.assigned_cm_types || {});

      // Find all EM/EPH types that are true for this unit
      const tickedTypes = Object.entries(ephEmTypes)
        .filter(([, isOn]) => isOn)
        .map(([typeCol]) => typeCol);

      // Create one virtual row for each ticked EM/EPH type
      for (const ephEmType of tickedTypes) {
        result.push({
          // Keep original row id for actions (reject), but add ephEmType for virtual row key
          id: `${row.id}-${ephEmType}`,
          originalRowId: row.id,
          rowIndex: rowIndex++,
          unitName: row.unit_name,
          ephEmType: ephEmType,
          ephEmDesignation: `${row.unit_name}_${ephEmType}`,
          hierarchyPath: row.hierarchy_path,
          assignedCmType: assignedTypes[ephEmType],
          assignment: row.assignment,
          assignmentStatus: row.assignment_status,
          // Preserve original data for backend operations
          _originalRow: row,
        });
      }
    }
    return result;
  }, [rows]);

  // AG Grid hands this a params object, NOT the row — `p => p.id` silently
  // yields "undefined" for every row, and since ids must be unique the grid
  // collapses the whole set down to whichever row was reconciled last.
  const getRowId = useCallback(p => String(p.data.id), []);

  const columnDefs = useMemo(() => [
    {
      headerName: '#', colId: 'rowNumber', width: 60, maxWidth: 60, pinned: 'left',
      sortable: false, filter: false, resizable: false,
      valueGetter: p => p.data.rowIndex,
      cellStyle: { textAlign: 'center', fontWeight: 500, color: '#6b7280', fontFamily: 'ui-monospace, monospace' },
    },
    {
      headerName: 'EM / EPH', colId: 'eph_em_designation',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, flex: 1.8,
      valueGetter: p => p.data.ephEmDesignation,
      cellStyle: { fontFamily: 'ui-monospace, monospace', fontWeight: 500, color: '#1a1a1a' },
    },
    {
      headerName: 'Unit', field: 'unitName',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 80, flex: 0.8,
      cellStyle: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
    },
    {
      headerName: 'Hierarchy', field: 'hierarchyPath',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 140, flex: 1.2,
      cellStyle: { color: 'var(--color-text-secondary)' },
      cellRenderer: (p) => p.value
        ? <span>{p.value}</span>
        : <span style={{ color: '#b26a00' }} title="Unit not found in Plant Hierarchy">⚠ not in hierarchy</span>,
    },
    {
      headerName: 'Type Assignment', colId: 'type_assignment',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 140, flex: 1.2,
      valueGetter: (p) => {
        if (!p.data.assignedCmType) return '(unmapped)';
        return p.data.assignedCmType;
      },
      cellStyle: { color: 'var(--color-text-secondary)', fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
    },
    {
      headerName: 'AS Assignment', colId: 'as_assignment',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 100, flex: 0.8,
      valueGetter: (p) => p.data.assignment || '(not assigned)',
      cellStyle: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', color: 'var(--color-text-secondary)' },
    },
    {
      headerName: 'Status', field: 'assignmentStatus',
      filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 100, flex: 0.8,
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: (props) => {
        const statusColors = {
          assigned: { bg: '#DCFCE7', fg: '#166534' },
          rejected: { bg: '#FEE2E2', fg: '#991B1B' },
          pending: { bg: '#F3F4F6', fg: '#6B7280' },
        };
        const color = statusColors[props.value] || statusColors.pending;
        return (
          <span style={{
            padding: '3px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 500,
            background: color.bg,
            color: color.fg,
            whiteSpace: 'nowrap',
          }}>
            {props.value || 'pending'}
          </span>
        );
      },
    },
    {
      headerName: '', colId: 'actions', sortable: false, filter: false, resizable: false,
      width: 90, maxWidth: 90, pinned: 'right',
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
      cellRenderer: (props) => (
        <Btn danger onClick={() => handleRejectRow(props.data.originalRowId)} style={{ padding: '4px 8px', fontSize: '11px' }}>
          <i className="ti ti-trash" /> Reject
        </Btn>
      ),
    },
  ], [handleRejectRow]);

  // Load composites, configs, and stored imports on mount
  useEffect(() => {
    loadAvailableComposites();
    loadTypeMappingConfigs();
    loadStoredImports();
  }, [loadAvailableComposites, loadTypeMappingConfigs, loadStoredImports]);

  // Restore the import record on mount (unitColumn and selectedTypeMapping are
  // restored via lazy useState initializers above, so they paint immediately).
  useEffect(() => {
    const savedImportId = localStorage.getItem(STORAGE_KEYS.IMPORT_ID);
    if (savedImportId) {
      const id = parseInt(savedImportId, 10);
      if (Number.isFinite(id)) {
        setImportId(id);
        getEphEmImport(id).then(full => {
          setUploadResult({
            importId: full.id,
            headers: full.headers || [],
            sheet: full.sheetName,
            totalRows: full.rowCount,
            preview: full.preview || [],
          });
        }).catch(() => {
          // Import was deleted since it was saved — drop the stale pointer.
          clearFormState();
          setImportId(null);
        });
      }
    }
  }, []);

  // Refetch whenever the Review tab is entered. Without this the grid keeps
  // whatever `rows` the last assignment left in state — so switching tabs (or
  // reloading, which restores importId but not rows) renders a stale row set,
  // or nothing at all.
  //
  // `cancelled` matters: importId arrives asynchronously on reload, so this
  // effect can fire twice in quick succession and two fetches overlap. Without
  // the guard the slower response wins and overwrites the newer row set.
  useEffect(() => {
    if (phase !== PHASE.REVIEW || !importId) return;
    let cancelled = false;
    (async () => {
      try {
        setRowsLoading(true);
        const result = await getEphEmRows(importId, { offset: 0, limit: 1000 });
        if (cancelled) return;
        setRows(result.rows || []);
        setTotalRows(result.total || 0);
      } catch (e) {
        if (!cancelled) console.error('Failed to load rows:', e);
      } finally {
        if (!cancelled) setRowsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [phase, importId]);

  // Helper to check if assignment has been completed successfully
  const isAssignmentComplete = assignmentSuccess && !assignmentError;

  // Each phase returns its own panel; the shell below wraps them with the tab bar.
  const renderPhase = () => {
  // ── Phase: Type Mappings (Settings) ──────────────────────────────────────
  if (phase === PHASE.TYPE_MAPPINGS) {
    const isEditing = editingConfig !== null;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PanelHeading
          title=""
          subtitle="Map each Excel type column to the composite CM type it should instantiate." />

        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>

          {/* Config list panel */}
          <div style={glassPanelSx}>
            <div style={glassPanelHeaderSx}>
              <Btn primary onClick={startNewConfig} disabled={configSaving} style={{ width: '100%' }}>
                <i className="ti ti-plus" /> New config
              </Btn>
            </div>
            <div className="glass-radio-group-vertical" style={{ flex: 1, overflowY: 'auto' }}>
              {configsLoading ? (
                <div style={{ padding: '1rem', fontSize: 12, color: '#888', textAlign: 'center' }}>
                  Loading...
                </div>
              ) : typeMappingConfigs.length === 0 ? (
                <div style={{ padding: '1rem', fontSize: 12, color: '#888', textAlign: 'center' }}>
                  No configs yet
                </div>
              ) : (
                <>
                  {/* Sliding highlight. Rendered first so it paints beneath the
                      rows, and positioned from the measured row height. */}
                  {selectedCfgIdx >= 0 && (
                    <div className="glass-glider-vertical" style={{
                      height: cfgRowH,
                      transform: `translateY(${selectedCfgIdx * (cfgRowH + GLIDER_GAP)}px)`,
                    }} />
                  )}
                  {typeMappingConfigs.map(cfg => (
                    <Fragment key={cfg.id}>
                      <input
                        type="radio"
                        id={`ephem-typemap-${cfg.id}`}
                        name="ephem-type-map"
                        checked={editingConfig?.id === cfg.id}
                        onChange={() => selectConfig(cfg)} />
                      <label ref={cfg.id === typeMappingConfigs[0].id ? cfgRowRef : undefined}
                        htmlFor={`ephem-typemap-${cfg.id}`}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="glass-label-text" title={cfg.name}>
                          {cfg.name}
                        </div>
                        {editingConfig?.id === cfg.id && (
                          <span onClick={e => { e.preventDefault(); e.stopPropagation(); handleDeleteTypeMapping(cfg.id); }}
                            className="io-import-icon-delete" title="Delete this configuration"
                            style={{ cursor: configSaving ? 'not-allowed' : 'pointer', padding: '2px 4px',
                              color: '#6b7280', fontSize: 13, lineHeight: 1, flexShrink: 0,
                              transition: 'color 0.15s ease' }}
                            onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                            onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}>
                            <i className="ti ti-trash" />
                          </span>
                        )}
                      </label>
                    </Fragment>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Editor panel */}
          <div style={{ ...panelSx, padding: !isEditing ? 0 : '1rem 1.25rem', overflowY: 'auto' }}>
            {!isEditing ? (
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 13,
                  paddingTop: '2rem', textAlign: 'center' }}>
                Select a config or create a new one
              </div>
            ) : (
              <>
                <div style={{ marginBottom: '1.25rem' }}>
                  <label style={eyebrowLabelSx}>Config name</label>
                  <input value={editConfigName}
                    onChange={e => setEditConfigName(e.target.value)}
                    placeholder="e.g. Physical Model Config"
                    style={{ ...textInputSx, padding: '6px 8px', border: '1px solid rgba(28,27,25,0.08)',
                      borderRadius: '8px', background: '#FFFFFF', outline: 'none' }} />
                </div>

                <SLabel text={`Mappings (${editConfigMappings.length})`}>
                  <Btn onClick={() => setEditConfigMappings(m => [...m, BLANK_MAPPING_ROW()])}
                    style={{ fontSize: 11, padding: '5px 12px' }}>
                    <i className="ti ti-plus" /> Add mapping
                  </Btn>
                </SLabel>

                {editConfigMappings.length === 0 ? (
                  <EmptyState style={{ marginBottom: '1rem' }}>
                    No mappings yet — click "Add mapping" to start
                  </EmptyState>
                ) : (
                  <div style={{ border: '1px solid rgba(28,27,25,0.08)', borderRadius: '12px',
                      overflow: 'hidden', background: '#FBFAF7',
                      boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)',
                      marginBottom: '1rem' }}>
                    <div style={{
                      ...panelHeaderSx,
                      display: 'grid', gridTemplateColumns: MAP_COLS, gap: 12,
                      padding: '10px 16px',
                    }}>
                      {['TYPE COLUMN', 'COMPOSITE TYPE', 'MATCH MODE', 'PRIORITY', ''].map((h, i) => (
                        <div key={i} style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                            color: '#6B6862', paddingRight: i < 4 ? '12px' : '0',
                            borderRight: i < 4 ? '1px solid rgba(28,27,25,0.08)' : 'none' }}>{h}</div>
                      ))}
                    </div>

                    {editConfigMappings.map((m, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: MAP_COLS, gap: 12,
                          padding: '10px 16px', alignItems: 'center',
                          borderBottom: '1px solid rgba(28,27,25,0.08)',
                          background: i % 2 === 0 ? '#FFFFFF' : '#FBF8F0' }}>
                        <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                          <input value={m.type_column}
                            onChange={e => updateMappingRow(i, 'type_column', e.target.value.toUpperCase())}
                            placeholder="e.g. EM_DNS" style={{ ...inputSx, padding: '6px 8px', flex: 1 }} />
                        </div>
                        <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                          <select value={m.composite_type}
                            onChange={e => updateMappingRow(i, 'composite_type', e.target.value)}
                            style={{ ...inputSx, padding: '6px 8px', cursor: 'pointer', flex: 1 }}>
                            <option value="">- pick type -</option>
                            {compositesLoading && <option disabled>Loading...</option>}
                            {allComposites.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                          </select>
                        </div>
                        <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                          <select value={m.match_mode || 'exact'}
                            onChange={e => updateMappingRow(i, 'match_mode', e.target.value)}
                            style={{ ...inputSx, padding: '6px 8px', cursor: 'pointer', flex: 1 }}>
                            {['exact', 'prefix', 'contains', 'regex'].map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        </div>
                        <div style={{ display: 'flex', borderRight: '1px solid rgba(28,27,25,0.08)', paddingRight: '12px' }}>
                          <input type="number" value={m.priority ?? 0}
                            onChange={e => updateMappingRow(i, 'priority', parseInt(e.target.value, 10) || 0)}
                            style={{ ...inputSx, padding: '6px 8px', flex: 1 }} />
                        </div>
                        <button onClick={() => setEditConfigMappings(rows => rows.filter((_, idx) => idx !== i))}
                          title="Remove mapping"
                          className="io-import-icon-delete"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                            padding: '2px 4px', color: 'var(--color-text-secondary)',
                            fontSize: 13, lineHeight: 1, justifySelf: 'center' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#DC2626'}
                          onMouseLeave={e => e.currentTarget.style.color = 'var(--color-text-secondary)'}>
                          <i className="ti ti-x" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!compositesLoading && allComposites.length === 0 && (
                  <Callout tone="warning" style={{ marginBottom: '1rem' }}>
                    No composite CM types exist yet. Create them in the Library first —
                    there is nothing to map type columns onto until then.
                  </Callout>
                )}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
                  <Btn onClick={() => { setEditingConfig(null); setEditConfigName(''); setEditConfigMappings([]); }}>
                    Cancel
                  </Btn>
                  <Btn primary onClick={handleSaveTypeMapping} disabled={configSaving}>
                    <i className="ti ti-device-floppy" /> {configSaving ? 'Saving...' : 'Save mappings'}
                  </Btn>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, flexShrink: 0 }}>
          <Btn primary onClick={() => { loadTypeMappingConfigs(); setPhase(PHASE.UPLOAD); }}>
            Next: Upload file <i className="ti ti-arrow-right" />
          </Btn>
        </div>
      </div>
    );
  }

  // ── Phase: Upload ────────────────────────────────────────────────────────
  if (phase === PHASE.UPLOAD) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
        {importing && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
              <crystal-loader style={{ '--crystal-loader-size': '160px', '--crystal-loader-bg': 'transparent' }}></crystal-loader>
              <div style={{ fontSize: 16, fontWeight: 500, color: '#FFFFFF' }}>Parsing...</div>
            </div>
          </div>
        )}

        <PanelHeading
          title=""
          subtitle="Upload a Physical Model matrix to import EPH/EM instances." />

        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>

          {/* Sidebar: drag-drop zone with glass effect */}
          <div style={glassPanelSx}
            onDragOver={e => {
              if (importing) return;
              e.preventDefault();
              e.currentTarget.style.outline = '1.5px dashed var(--color-accent)';
              e.currentTarget.style.outlineOffset = '-3px';
            }}
            onDragLeave={e => { e.currentTarget.style.outline = 'none'; }}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.style.outline = 'none';
              if (importing) return;
              const f = e.dataTransfer.files?.[0];
              if (f) handleFileUpload(f);
            }}>
            <div style={glassPanelHeaderSx}>
              <Btn primary disabled={importing} onClick={() => { fileInputRef.current.value = ''; fileInputRef.current.click(); }}
                style={{ width: '100%' }}>
                <i className="ti ti-plus" /> {importing ? 'Parsing...' : 'Upload EPH/EM List'}
              </Btn>
            </div>

            {/* Stored imports list */}
            {storedImports.length > 0 && (
              <div style={{ padding: '0.75rem', flex: 1, overflow: 'auto', minHeight: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                    color: '#6B6862', marginBottom: '8px', paddingLeft: '8px' }}>
                  Stored Imports
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {storedImports.map(imp => (
                    <div key={imp.id} style={{ display: 'flex', alignItems: 'center', gap: '4px',
                        padding: '6px 8px', borderRadius: '6px', fontSize: 11, cursor: 'pointer',
                        background: uploadResult && importId === imp.id ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                        border: uploadResult && importId === imp.id ? '0.5px solid #10B981' : '0.5px solid rgba(28,27,25,0.1)',
                        transition: 'all 0.15s' }}
                      onMouseEnter={(e) => { if (!uploadResult || importId !== imp.id) e.currentTarget.style.background = 'rgba(28,27,25,0.05)'; }}
                      onMouseLeave={(e) => { if (!uploadResult || importId !== imp.id) e.currentTarget.style.background = 'transparent'; }}
                      onClick={async () => {
                        try {
                          const fullImport = await getEphEmImport(imp.id);
                          setUploadResult({
                            importId: fullImport.id,
                            headers: fullImport.headers || [],
                            sheet: fullImport.sheetName,
                            totalRows: fullImport.rowCount,
                            preview: fullImport.preview || [],
                          });
                          setImportId(fullImport.id);
                          setAssignmentError(null);
                          setAssignmentSuccess(false);
                          // Preserve form selections when switching imports
                          saveFormState(unitColumn, selectedTypeMapping, assignmentSuccess, fullImport.id);
                        } catch (e) {
                          alert('Failed to load import: ' + e.message);
                        }
                      }}>
                      <i className="ti ti-file-text" style={{ flex: 0 }} />
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {imp.fileName}
                      </div>
                      <Btn danger onClick={(e) => {
                        e.stopPropagation();
                        if (confirm('Delete this import?')) {
                          deleteEphEmImport(imp.id).then(() => {
                            if (importId === imp.id) {
                              setImportId(null);
                              setUploadResult(null);
                              setUnitColumn(null);
                            }
                            loadStoredImports();
                          }).catch(err => alert('Failed to delete: ' + err.message));
                        }
                      }} style={{ padding: '2px 6px', fontSize: '10px', flexShrink: 0 }}>
                        <i className="ti ti-trash" />
                      </Btn>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {storedImports.length === 0 && !importsLoading && (
              <div style={{ padding: '1rem', fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Drag file here or click the button above
              </div>
            )}

            {importsLoading && (
              <div style={{ padding: '1rem', fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Loading imports...
              </div>
            )}
          </div>

          {/* Content area: file info + preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>

            {/* File info */}
            {uploadResult?.headers?.length > 0 && (
              <div style={{ ...panelSx, flexShrink: 0, padding: '12px 16px' }}>
                <div style={{ fontSize: 24, color: 'var(--color-text-primary)', fontWeight: 600, textAlign: 'center' }}>
                  {uploadResult.sheet || 'Uploaded file'}
                </div>
                <div style={{ fontSize: 14, color: 'var(--color-text-secondary)', textAlign: 'center', marginTop: 4 }}>
                  {uploadResult.totalRows} rows, {uploadResult.headers.length} columns
                </div>
              </div>
            )}

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => handleFileUpload(e.target.files?.[0])}
              style={{ display: 'none' }}
            />

            {/* Preview table */}
            {uploadResult?.headers?.length > 0 && uploadResult.preview?.length > 0 ? (
              <div style={{ ...panelSx, flex: 1 }}>
                <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                    <thead>
                      <tr style={{ background: '#FBF8F0', position: 'sticky', top: 0, zIndex: 1 }}>
                        {uploadResult.headers.map(h => (
                          <th key={h} style={{ padding: '12px 16px', textAlign: 'left', whiteSpace: 'nowrap',
                              fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                              borderBottom: '1px solid rgba(28,27,25,0.08)',
                              color: '#6B6862' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {uploadResult.preview.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid rgba(28,27,25,0.08)' }}>
                          {uploadResult.headers.map(h => (
                            <td key={h} style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)',
                                whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }}>
                              {row[h] != null ? String(row[h]) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--color-text-secondary)',
                    borderTop: '1px solid rgba(28,27,25,0.08)',
                    background: '#FBF8F0', flexShrink: 0 }}>
                  Showing {uploadResult.preview.length} of {uploadResult.totalRows} rows
                </div>
              </div>
            ) : (
              <EmptyState style={{ flex: 1, justifyContent: 'center' }}>
                Upload a file to see data preview
              </EmptyState>
            )}

            {/* Column selection card — consolidates the unit column selection
                that would otherwise require navigating to a separate tab */}
            {uploadResult?.headers?.length > 0 && (
              <div style={{ ...panelSx, flexShrink: 0 }}>
                <div style={panelHeaderSx}>
                  <SLabel text="Select Columns" />
                </div>

                <div style={{ padding: '1rem 1.25rem' }}>
                  <label style={eyebrowLabelSx}>Unit Name Column</label>
                  <select
                    value={unitColumn || ''}
                    onChange={(e) => {
                      setUnitColumn(e.target.value);
                      saveFormState(e.target.value, selectedTypeMapping, assignmentSuccess, importId);
                    }}
                    style={{ ...inputSx, padding: '8px 10px', marginBottom: '1rem' }}>
                    <option value="">-- Select a column --</option>
                    {uploadResult.headers.map(h => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>

                  {unitColumn && uploadResult.preview?.length > 0 && (
                    <div style={{ marginTop: '12px', padding: '10px 12px', backgroundColor: 'var(--color-background-secondary)',
                        borderRadius: 'var(--border-radius-md)' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                          letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                        Sample Values
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>
                        {uploadResult.preview
                          .slice(0, 3)
                          .map(row => row[unitColumn])
                          .filter(v => v != null)
                          .join(', ')}
                      </div>
                    </div>
                  )}

                  {unitColumn && (
                    <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border-secondary)' }}>
                      <label style={eyebrowLabelSx}>AS Assignment Column (Optional)</label>
                      <select
                        value={assignmentColumn || ''}
                        onChange={(e) => {
                          setAssignmentColumn(e.target.value || null);
                          if (e.target.value) localStorage.setItem('ephemUpload_selectedAssignmentColumn', e.target.value);
                          else localStorage.removeItem('ephemUpload_selectedAssignmentColumn');
                        }}
                        style={{ ...inputSx, padding: '8px 10px', marginBottom: '1rem' }}>
                        <option value="">-- No AS assignment --</option>
                        {uploadResult.headers.filter(h => h !== unitColumn).map(h => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>

                      {assignmentColumn && uploadResult.preview?.length > 0 && (
                        <div style={{ marginTop: '12px', padding: '10px 12px', backgroundColor: 'var(--color-background-secondary)',
                            borderRadius: 'var(--border-radius-md)' }}>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                              letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                            Sample Values
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>
                            {uploadResult.preview
                              .slice(0, 3)
                              .map(row => row[assignmentColumn])
                              .filter(v => v != null)
                              .join(', ')}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {!unitColumn && (
                    <Callout tone="info">
                      Select a unit column to proceed. This column will be used to identify units in your import.
                    </Callout>
                  )}
                </div>
              </div>
            )}

            {/* Type Mapping Selection Card */}
            {uploadResult?.headers?.length > 0 && unitColumn && (
              <div style={{ ...panelSx, flexShrink: 0 }}>
                <div style={panelHeaderSx}>
                  <SLabel text="Apply Saved Type Mapping" />
                </div>

                <div style={{ padding: '1rem 1.25rem' }}>
                  <label style={eyebrowLabelSx}>Type Mapping Config</label>
                  <select
                    value={selectedTypeMapping ? String(selectedTypeMapping.id) : ''}
                    onChange={(e) => {
                      let cfg = null;
                      if (e.target.value) {
                        cfg = typeMappingConfigs.find(c => String(c.id) === e.target.value);
                        setSelectedTypeMapping(cfg || null);
                      } else {
                        setSelectedTypeMapping(null);
                      }
                      saveFormState(unitColumn, cfg, assignmentSuccess, importId);
                    }}
                    style={{ ...inputSx, padding: '8px 10px', marginBottom: '1rem' }}>
                    <option value="">-- Select a mapping --</option>
                    {typeMappingConfigs.map(cfg => (
                      <option key={cfg.id} value={String(cfg.id)}>
                        {cfg.name}
                      </option>
                    ))}
                  </select>

                  {selectedTypeMapping && (
                    <div style={{ marginTop: '12px', padding: '10px 12px', backgroundColor: 'var(--color-background-secondary)',
                        borderRadius: 'var(--border-radius-md)' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                          letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                        Mapped Types
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>
                        {(() => {
                          const mappings = parseMappings(selectedTypeMapping.mappings);
                          if (Array.isArray(mappings)) {
                            return mappings.map(m => `${m.type_column} → ${m.composite_type}`).join(', ');
                          }
                          return Object.entries(mappings).map(([k, v]) => `${k} → ${v}`).join(', ');
                        })()}
                      </div>
                    </div>
                  )}

                  {!selectedTypeMapping && (
                    <Callout tone="info">
                      Select a saved type mapping to automatically assign composite types to your EPH/EM columns.
                    </Callout>
                  )}
                </div>
              </div>
            )}

            {/* Run Assignment Button */}
            {uploadResult?.headers?.length > 0 && unitColumn && selectedTypeMapping && (
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {assignmentError && (
                  <Callout tone="danger">
                    {assignmentError}
                  </Callout>
                )}

                {isAssignmentComplete && (
                  <Callout tone="positive">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontWeight: 600 }}>✓ Assignment completed successfully</div>
                      <div style={{ fontSize: 13, color: 'inherit' }}>
                        Unit Column: <strong>{unitColumn}</strong> | Mapping: <strong>{selectedTypeMapping.name}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: 'inherit', marginTop: 4 }}>
                        Review the results in the Review tab, or click Reset to start over with a new file.
                      </div>
                    </div>
                  </Callout>
                )}

                <Btn primary onClick={async () => {
                  if (!uploadResult?.headers?.length) {
                    setAssignmentError('Upload a file first');
                    return;
                  }
                  if (!unitColumn) {
                    setAssignmentError('Please select a unit column');
                    return;
                  }
                  if (!selectedTypeMapping) {
                    setAssignmentError('Please select a type mapping');
                    return;
                  }

                  try {
                    setAssignmentError(null);
                    setAssignmentLoading(true);

                    // Step 1: Apply column mapping (extract unit_name, AS assignment, and detect type columns)
                    const columnMappingPayload = { unit_column: unitColumn };
                    if (assignmentColumn) columnMappingPayload.assignment_column = assignmentColumn;
                    await applyEphEmColumnMap(importId, columnMappingPayload, uploadResult.headers);

                    // Step 2: Extract type_column_mappings from the selected config
                    const mappings = parseMappings(selectedTypeMapping.mappings);
                    let typeColumnMappingsObj = {};

                    if (Array.isArray(mappings)) {
                      mappings.forEach(m => {
                        typeColumnMappingsObj[m.type_column] = m.composite_type;
                      });
                    } else {
                      typeColumnMappingsObj = mappings;
                    }

                    // Step 3: Run assignment with the extracted mappings
                    await runEphEmAssignment(importId, typeColumnMappingsObj);

                    // Mark assignment as successful; retain all form selections
                    setAssignmentSuccess(true);
                    setAssignmentError(null);

                    // Save successful state to localStorage
                    saveFormState(unitColumn, selectedTypeMapping, true, importId);
                    if (assignmentColumn) localStorage.setItem('ephemUpload_selectedAssignmentColumn', assignmentColumn);

                    // Navigate to review phase
                    setPhase(PHASE.REVIEW);
                    await loadRows();
                  } catch (e) {
                    setAssignmentError('Assignment failed: ' + e.message);
                  } finally {
                    setAssignmentLoading(false);
                  }
                }} disabled={assignmentLoading || isAssignmentComplete}
                  style={{ width: '100%' }}>
                  {assignmentLoading ? (
                    <>
                      <i className="ti ti-loader" style={{ animation: 'spin 1s linear infinite' }} />
                      Assigning Types...
                    </>
                  ) : isAssignmentComplete ? (
                    <>
                      <i className="ti ti-check-circle-2" style={{ color: '#16a34a' }} />
                      Assignment Complete
                    </>
                  ) : (
                    <>
                      <i className="ti ti-check" />
                      Assign Types & Create Instances
                    </>
                  )}
                </Btn>

                {isAssignmentComplete && (
                  <Btn onClick={() => {
                    setUploadResult(null);
                    setImportId(null);
                    setUnitColumn(null);
                    setSelectedTypeMapping(null);
                    setAssignmentSuccess(false);
                    setAssignmentError(null);
                    setRows([]);
                    setTotalRows(0);
                    clearFormState();
                  }} style={{ width: '100%' }}>
                    <i className="ti ti-refresh" /> Reset & Upload New File
                  </Btn>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, flexShrink: 0 }}>
          <Btn onClick={() => setPhase(PHASE.TYPE_MAPPINGS)}>Back</Btn>
        </div>
      </div>
    );
  }

  // ── Phase: Assign Types ──────────────────────────────────────────────────
  if (phase === PHASE.FUNCTION_MAP) {
    if (!uploadResult?.headers?.length) {
      return (
        <div style={styles.container}>
          <h2 style={styles.heading}>Assign Types</h2>
          <p style={styles.description}>Upload a file and set the unit column first.</p>
          <button onClick={() => setPhase(PHASE.UPLOAD)} style={styles.primaryButton}>Go to Upload</button>
        </div>
      );
    }

    const typeColumns = uploadResult.headers.filter(h => h !== unitColumn);
    const allMapped = typeColumns.length > 0 && typeColumns.every(tc => typeColumnMappings[tc]);

    // Applying a saved Type Mapping config fills in every column it knows about.
    // Mappings can be array format (new) or object format (legacy).
    const applyConfig = (configId) => {
      const cfg = typeMappingConfigs.find(c => String(c.id) === String(configId));
      if (!cfg) return;
      const mappings = parseMappings(cfg.mappings);
      const next = { ...typeColumnMappings };

      if (Array.isArray(mappings)) {
        // New array format: find matching entry per type_column
        for (const tc of typeColumns) {
          const match = mappings.find(m => m.type_column === tc);
          if (match) next[tc] = match.composite_type;
        }
      } else {
        // Legacy object format
        for (const tc of typeColumns) {
          if (mappings[tc]) next[tc] = mappings[tc];
        }
      }
      setTypeColumnMappings(next);
    };

    return (
      <div style={styles.container}>
        <h2 style={styles.heading}>Assign Types</h2>
        <p style={styles.description}>For each EPH/EM type column, pick the composite CM type to instantiate. Apply a saved Type Mapping to fill these in.</p>

        <div style={styles.configSelector}>
          <label style={styles.configLabel}>Apply saved Type Mapping:</label>
          <select
            defaultValue=""
            onChange={(e) => { applyConfig(e.target.value); e.target.value = ''; }}
            style={styles.configSelect}
          >
            <option value="">-- Select a saved config --</option>
            {typeMappingConfigs.map((cfg) => (
              <option key={cfg.id} value={cfg.id}>{cfg.name}</option>
            ))}
          </select>
        </div>

        <div style={styles.configSelector}>
          {typeColumns.map((typeCol) => (
            <div key={typeCol} style={{ marginBottom: '15px' }}>
              <label style={styles.configLabel}>{typeCol}</label>
              <select
                value={typeColumnMappings[typeCol] || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setTypeColumnMappings(prev => ({ ...prev, [typeCol]: val }));
                }}
                style={styles.configSelect}
              >
                <option value="">-- Select Composite Type --</option>
                {allComposites.map((cm) => (
                  <option key={cm.id} value={cm.name}>
                    {cm.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div style={styles.buttonGroup}>
          <button
            onClick={handleRunAssignment}
            disabled={!allMapped || importing}
            style={{
              ...styles.primaryButton,
              ...((!allMapped || importing) ? styles.primaryButtonDisabled : {})
            }}
          >
            {importing ? 'Running Assignment...' : 'Run Assignment'}
          </button>
          <button
            onClick={() => setPhase(PHASE.UPLOAD)}
            style={styles.secondaryButton}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Phase: Review Rows ───────────────────────────────────────────────────
  if (phase === PHASE.REVIEW) {
    if (!importId) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--color-text-secondary)' }}>No import selected. Go back to Upload.</p>
          <Btn onClick={() => setPhase(PHASE.UPLOAD)} style={{ marginTop: '1rem' }}>
            Back to Upload
          </Btn>
        </div>
      );
    }

    const assignedCount = (transformedRows || []).filter(r => r.assignmentStatus === 'assigned').length;
    const rejectedCount = (transformedRows || []).filter(r => r.assignmentStatus === 'rejected').length;
    const totalEphEmCount = (transformedRows || []).length;

    const handlePromote = async () => {
      if (!confirm('Create instances for all assigned rows?')) return;
      try {
        setPromoting(true);
        await promoteEphEmImport(importId, projectId);
        alert('EPH/EM instances created successfully.');
        onComplete?.();
      } catch (e) {
        alert('Promotion failed: ' + e.message);
      } finally {
        setPromoting(false);
      }
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PanelHeading
          title="Review instances"
          subtitle="Verify EPH/EM type assignments and hierarchy paths. Rejected rows will be skipped during promotion." />

        <div className="ig-root" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
            border: '1px solid rgba(28,27,25,0.08)', borderRadius: '22px',
            overflow: 'hidden', background: '#FFFFFF', boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)' }}>

          {/* Toolbar */}
          <div className="ig-toolbar" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px',
              borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)',
              flexShrink: 0, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                {totalEphEmCount} EM/EPH instance{totalEphEmCount !== 1 ? 's' : ''} · {assignedCount} assigned · {rejectedCount} rejected
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={() => setPhase(PHASE.UPLOAD)}>
                <i className="ti ti-arrow-left" /> Back
              </Btn>
              <Btn primary onClick={handlePromote} disabled={promoting || promoting}>
                {promoting ? (
                  <>
                    <i className="ti ti-loader" style={{ animation: 'spin 1s linear infinite' }} />
                    Creating instances...
                  </>
                ) : (
                  <>
                    <i className="ti ti-arrow-right" /> Create Instances
                  </>
                )}
              </Btn>
            </div>
          </div>

          {/* Grid. AgGridReact must be the DIRECT child of .ig-grid-wrap — that
              class carries `overflow-y: auto`, so any wrapper in between gets its
              own scroll box and the grid's first data row slips above the viewport
              with no scrollbar to reveal it. Same structure as the IO review grid. */}
          <div className="ig-grid-wrap" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {rowsLoading && (
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.8)', zIndex: 1 }}>
                <div style={{ color: 'var(--color-text-secondary)' }}>Loading rows...</div>
              </div>
            )}
            {transformedRows && transformedRows.length > 0 ? (
              <AgGridReact
                ref={gridRef}
                rowData={transformedRows}
                columnDefs={columnDefs}
                defaultColDef={{ sortable: true, resizable: true }}
                getRowId={getRowId}
                pagination={true}
                paginationPageSize={20}
                paginationPageSizeSelector={[20, 50, 100]}
                theme={themeQuartz}
                animateRows={false}
                suppressNoRowsOverlay={false}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
                  color: 'var(--color-text-secondary)' }}>
                No EM/EPH instances to display
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <SubTabs tab={phase} setTab={setPhase} importReady={!!importId} />
      {/* minHeight:0 lets the phase actually claim the leftover height — without
          it a flex child refuses to shrink below its content, so the Type
          Mappings panels collapse instead of filling the pane. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {renderPhase()}
      </div>
    </div>
  );
}
