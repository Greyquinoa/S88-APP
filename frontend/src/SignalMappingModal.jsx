// SignalMappingModal.jsx — assign hardware signals to a Type's ControlVariables.
//
// Opened from a row in the Instances step (Step 6). Lists the instance's active
// blocks → variables (inputs & outputs) and lets the user bind each to a hardware
// signal drawn from the project's latest HW import. Datatype mismatches are warned
// but allowed. Mappings are stored standalone and injected during XML export.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSignalMappings,
  saveInstanceSignalMappings,
  getMappableSignals,
  getConnectionIOs,
  getDerivedValues,
  setDerivedValueOverride,
  getMatrixOverrides,
  setMatrixOverride,
} from "./api";

// Client-side mirror of the backend DTYPE_COMPAT table (signalMappings.js).
// Used only for an instant inline warning badge — the backend is authoritative.
const DTYPE_COMPAT = {
  DI: ["bool"],
  DO: ["bool"],
  BI: ["bool"],
  BO: ["bool"],
  AI: ["real", "word", "int", "integer", "doubleint", "doubleword", "dword"],
  AO: ["real", "word", "int", "integer", "doubleint", "doubleword", "dword"],
};

function datatypeMismatch(signalType, varDtype) {
  if (!signalType || !varDtype) return false;
  const allowed = DTYPE_COMPAT[String(signalType).toUpperCase()];
  if (!allowed) return false;
  return !allowed.includes(String(varDtype).toLowerCase());
}

export default function SignalMappingModal({ projectId, instance, profile, compositeCmTypes, onClose, getCompositeCmType, valveCommands = [] }) {
  // mapping: { "<block>.<var>": { signalTag, signalType, hwSignalId } }
  const [mapping, setMapping]   = useState({});
  // values: { "<var>": { staticValue } } for edited static values
  const [values, setValues]     = useState({});
  const [signals, setSignals]   = useState([]);   // candidate signals from latest HW import
  const [query, setQuery]       = useState("");
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [noImport, setNoImport] = useState(false);
  // Reconciliation result per pin: { "<block>.<var>": { status, signal_name, station_address, slot, channel } }
  const [connIoByKey, setConnIoByKey] = useState({});
  // Derived-value connections (composite "Value" wired to an IO-list column) per
  // variable name — these connections aren't block-scoped (same as static "Value"
  // connections; see xmlGenerator.js wireSpec keyed only by var name).
  // { "<var>": { value, status, column_name } }
  const [derivedByVar, setDerivedByVar] = useState({});
  const [compositeDetail, setCompositeDetail] = useState(null);  // full composite with matrix data
  // Per-instance matrix override: single flag + edited cells keyed by mode_nr → { colName: val }
  const [matrixEnabled, setMatrixEnabled] = useState(false);
  const [matrixCells, setMatrixCells]     = useState({});
  const matrixSaveRef = useRef(null);
  const debounceRef = useRef(null);

  // Check if this is a matrix CM instance
  const compositeTypeSummary = instance.compositeId
    ? (compositeCmTypes || []).find(c => c.id === instance.compositeId)
    : null;
  const isMatrixCm = !!compositeTypeSummary?.is_matrix;

  // Load full composite details + this instance's saved override when it's a matrix CM
  useEffect(() => {
    if (!isMatrixCm || !instance.compositeId) return;
    let cancelled = false;
    (async () => {
      try {
        const [detail, overrideResp] = await Promise.all([
          getCompositeCmType(instance.compositeId),
          projectId ? getMatrixOverrides(projectId).catch(() => ({ overrides: [] })) : Promise.resolve({ overrides: [] }),
        ]);
        if (cancelled) return;
        setCompositeDetail(detail);
        const mine = (overrideResp?.overrides || []).find(o => o.instance_name === instance.instanceName);
        if (mine) {
          setMatrixEnabled(!!mine.enabled);
          setMatrixCells(mine.cells || {});
        }
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to load composite details:', e);
          setError(`Failed to load matrix data: ${e.message}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isMatrixCm, instance.compositeId, instance.instanceName, projectId, getCompositeCmType]);

  // Debounced persist of the whole {enabled, cells} override blob.
  function persistMatrixOverride(enabled, cells) {
    if (!projectId) return;
    clearTimeout(matrixSaveRef.current);
    matrixSaveRef.current = setTimeout(async () => {
      try {
        await setMatrixOverride(projectId, instance.instanceName, enabled, cells);
      } catch (e) {
        setError(`Failed to save matrix override: ${e.message}`);
      }
    }, 400);
  }

  function toggleMatrixOverride(next) {
    setMatrixEnabled(next);
    // Seed cells from composite defaults on first enable so editing starts from the
    // current effective values rather than blanks.
    let seeded = matrixCells;
    if (next && Object.keys(matrixCells).length === 0 && compositeDetail) {
      seeded = {};
      for (const mode of (compositeDetail.matrixModes || [])) {
        seeded[mode.mode_nr] = {};
        for (const col of (compositeDetail.matrixColumns || [])) {
          seeded[mode.mode_nr][col] = mode.cells?.[col] ?? 0;
        }
      }
      setMatrixCells(seeded);
    }
    persistMatrixOverride(next, seeded);
  }

  function setMatrixCell(modeNr, colName, rawVal) {
    const intVal = parseInt(rawVal);
    const val = isNaN(intVal) ? 0 : intVal;
    setMatrixCells(prev => {
      const next = { ...prev, [modeNr]: { ...(prev[modeNr] || {}), [colName]: val } };
      persistMatrixOverride(matrixEnabled, next);
      return next;
    });
  }

  // Active blocks = non-optional, or optional-and-enabled (matches export filter).
  // Filter variables to only show those marked valid in the library.
  const enabledBlocks = profile?.enabledBlocks || [];
  const activeBlocks = useMemo(() => {
    const blocks = profile?.subBlocks || [];
    return blocks
      .filter(b => !b.optional || enabledBlocks.includes(b.name))
      .map(blk => ({
        ...blk,
        vars: (blk.vars || []).filter(v => v.isValid),  // Silent filter: only valid variables (backend returns camelCase)
      }))
      .filter(blk => blk.vars.length > 0);  // Hide blocks with no valid variables
  }, [profile, enabledBlocks]);

  // Load existing mappings and values on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await getSignalMappings(projectId, instance.instanceName);
        if (cancelled) return;
        const m = {};
        for (const r of rows) {
          m[`${r.block_name}.${r.var_name}`] = {
            signalTag:  r.signal_tag,
            signalType: r.signal_type,
            hwSignalId: r.hw_signal_id,
          };
        }
        setMapping(m);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Initialize values from instance connections.
    // Only seed genuine hand-entered static values here — a 'derived' connection's
    // static_value column holds a JSON config blob (mode/column/prefix/suffix), not
    // a value to display/edit. That JSON gets decoded separately into derivedByVar
    // via getDerivedValues(); ValueRow reads the resolved number from there.
    const initValues = {};
    if (instance.connections && Array.isArray(instance.connections)) {
      for (const conn of instance.connections) {
        if (conn.conn_type === 'value' && conn.target_pin && conn.value_mode !== 'derived' && conn.static_value) {
          initValues[conn.target_pin] = conn.static_value;
        }
      }
    }
    setValues(initValues);
    return () => { cancelled = true; };
  }, [projectId, instance.instanceName, instance.connections]);

  // Load reconciliation result (from "Generate Connections") for this instance so
  // each pin can show its actual REAL/DUMMY status and the bound hardware address.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getConnectionIOs(projectId);
        if (cancelled) return;
        const m = {};
        for (const io of (r.ios || [])) {
          if (io.instance_name !== instance.instanceName) continue;
          m[`${io.block_name}.${io.var_name}`] = io;
        }
        setConnIoByKey(m);
      } catch { /* non-fatal — status badges just won't show */ }
    })();
    return () => { cancelled = true; };
  }, [projectId, instance.instanceName]);

  // Load derived-value resolution (from "Generate Connections") for this instance.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getDerivedValues(projectId);
        if (cancelled) return;
        const m = {};
        for (const dv of (r.values || [])) {
          if (dv.instance_name !== instance.instanceName) continue;
          m[dv.to_var_name] = dv;
        }
        setDerivedByVar(m);
      } catch { /* non-fatal — DERIVED badge just won't show */ }
    })();
    return () => { cancelled = true; };
  }, [projectId, instance.instanceName]);

  // Load candidate signals (debounced on query).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await getMappableSignals(projectId, { q: query, limit: 300 });
        setSignals(r.signals || []);
        setNoImport(r.importId == null);
      } catch (e) {
        setError(e.message);
      }
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [projectId, query]);

  const signalByTag = useMemo(() => {
    const m = {};
    for (const s of signals) m[s.tag] = s;
    return m;
  }, [signals]);

  // Map of variables that have IO connection rules in composite CM types →
  // their derived dummy signal name. Keyed by "<block>.<pin>". The dummy name
  // mirrors backend generation: prefix + instance name + suffix.
  const dummyByKey = useMemo(() => {
    const m = {};
    if (instance.connections && Array.isArray(instance.connections)) {
      for (const conn of instance.connections) {
        // Connection has target_block and target_pin indicating which parameter gets the dummy
        if (conn.target_block && conn.target_pin) {
          const key = `${conn.target_block}.${conn.target_pin}`;
          m[key] = `${conn.prefix || ""}${instance.instanceName}${conn.suffix || ""}`;
        }
      }
    }
    return m;
  }, [instance.connections, instance.instanceName]);

  // Categorize variables by connection type (IO vs Value)
  const connTypeByVar = useMemo(() => {
    const m = {}; // varName -> 'io_connection' | 'value' | undefined
    if (instance.connections && Array.isArray(instance.connections)) {
      for (const conn of instance.connections) {
        const varName = conn.target_pin; // Same field for both IO and Value connections
        if (varName) {
          m[varName] = conn.conn_type;
        }
      }
    }
    return m;
  }, [instance.connections]);

  // Track which variables have hardware signal mappings (even without IO connection rules)
  const hasSignalMappingByVar = useMemo(() => {
    const m = {};
    for (const key of Object.keys(mapping)) {
      const [, varName] = key.split(".");
      m[varName] = true;
    }
    return m;
  }, [mapping]);

  // Track which variables have reconciliation results (REAL or DUMMY connections)
  const hasConnReconByVar = useMemo(() => {
    const m = {};
    for (const key of Object.keys(connIoByKey)) {
      const [, varName] = key.split(".");
      m[varName] = true;
    }
    return m;
  }, [connIoByKey]);

  function setVarSignal(blockName, varName, tag) {
    const key = `${blockName}.${varName}`;
    setMapping(prev => {
      const next = { ...prev };
      if (!tag) {
        delete next[key];
      } else {
        const s = signalByTag[tag];
        next[key] = { signalTag: tag, signalType: s?.signal_type ?? null, hwSignalId: s?.id ?? null };
      }
      return next;
    });
  }

  function setVarValue(varName, value) {
    setValues(prev => ({
      ...prev,
      [varName]: value,
    }));
  }

  // Derived-value overrides persist immediately (debounced) via their own endpoint —
  // they live in instance_derived_values, not the composite connection's static_value
  // (which holds the derivation JSON config and must stay intact for re-resolution).
  const overrideDebounceRef = useRef({});
  function setDerivedOverride(varName, rawValue) {
    const value = rawValue === "" ? null : rawValue;
    // Optimistic local update so the input reflects the edit immediately.
    setDerivedByVar(prev => ({
      ...prev,
      [varName]: { ...prev[varName], override_value: value },
    }));
    clearTimeout(overrideDebounceRef.current[varName]);
    overrideDebounceRef.current[varName] = setTimeout(async () => {
      try {
        await setDerivedValueOverride(projectId, instance.instanceName, varName, value);
      } catch (e) {
        setError(e.message);
      }
    }, 400);
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const varDtypeByKey = {};
      for (const blk of activeBlocks)
        for (const v of (blk.vars || []))
          varDtypeByKey[`${blk.name}.${v.name}`] = v.dtype;

      const mappings = Object.entries(mapping).map(([key, val]) => {
        const [blockName, varName] = key.split(".");
        return {
          blockName,
          varName,
          signalTag:  val.signalTag,
          hwSignalId: val.hwSignalId ?? null,
          varDtype:   varDtypeByKey[key] ?? null,
          signalType: val.signalType ?? null,
        };
      });
      const r = await saveInstanceSignalMappings(projectId, instance.instanceName, mappings);
      if (r.warnings?.length) {
        // Surface warnings but treat the save as successful.
        alert("Saved with warnings:\n\n" + r.warnings.join("\n"));
      }
      onClose(true, { values });
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  const assignedCount = Object.keys(mapping).length;
  const typeLabel = profile?.cmType || instance.profileId;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000,
      background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "stretch",
    }}>
      <div style={{
        margin: "auto", width: "92vw", maxWidth: 1100, height: "88vh",
        background: "#fff", borderRadius: 12, display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.35)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", background: "#0C447C", color: "#fff", flexShrink: 0,
        }}>
          <div>
            <span style={{ fontSize: 18, fontWeight: 700 }}>Parameters</span>
            <span style={{ marginLeft: 12, fontSize: 13, opacity: 0.85 }}>
              {instance.instanceName} &nbsp;·&nbsp; {typeLabel}
            </span>
          </div>
          <button onClick={() => onClose(false)} style={{
            fontSize: 20, border: "none", background: "transparent", color: "#fff",
            cursor: "pointer", padding: 0, width: 24, height: 24,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>×</button>
        </div>

        {/* Toolbar */}
        <div style={{
          display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 20px",
          borderBottom: "1px solid #e5e7eb", flexShrink: 0, alignItems: "center",
        }}>
          <input
            type="text"
            placeholder="Filter signals (tag)…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{
              flex: "0 0 320px", padding: "6px 10px", fontSize: 13,
              border: "1px solid #d1d5db", borderRadius: 6,
            }}
          />
          <span style={{ fontSize: 12, color: "#6b7280" }}>
            {signals.length} signal{signals.length !== 1 ? "s" : ""} shown
            {noImport && " — no HW import found for this project"}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 13, color: "#374151" }}>
            {assignedCount} variable{assignedCount !== 1 ? "s" : ""} assigned
          </span>
        </div>

        {error && (
          <div style={{ padding: "8px 20px", color: "#b91c1c", background: "#fef2f2", fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "8px 20px" }}>
          {isMatrixCm ? (
            // Matrix CM grid display
            <div style={{ marginTop: 20 }}>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: "#0C447C", margin: 0 }}>
                    Matrix: {compositeTypeSummary?.name}
                  </h3>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer",
                      padding: "6px 12px", borderRadius: 6,
                      background: matrixEnabled ? "#f0fdf4" : "#f3f4f6",
                      border: `1px solid ${matrixEnabled ? "#86efac" : "#e5e7eb"}` }}
                    title={matrixEnabled
                      ? "Override ON — edited values below override the composite defaults for this instance and are used in XML export."
                      : "Override OFF — the composite type's matrix defaults are used. Check to edit values for this instance only."}>
                    <input type="checkbox" checked={matrixEnabled}
                      onChange={e => toggleMatrixOverride(e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer" }} />
                    <span style={{ fontWeight: 500, color: matrixEnabled ? "#166534" : "#374151" }}>
                      Override matrix values
                    </span>
                  </label>
                </div>
                {compositeDetail?.matrixColumns?.length > 0 && compositeDetail?.matrixModes?.length > 0 ? (
                  // Layout: CMs in rows, modes in columns (matches the composite editor).
                  // Cell values are the numeric valve-state codes; show the human label
                  // (e.g. "OPEN (101)") from valveCommands when known.
                  <table style={{ borderCollapse: "collapse", border: "1px solid #d1d5db", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f3f4f6" }}>
                        <th style={{ padding: "8px 12px", border: "1px solid #d1d5db", textAlign: "left", fontWeight: 600 }}>
                          CM \ Mode
                        </th>
                        {(compositeDetail.matrixModes || []).map((mode, mi) => (
                          <th key={mi} style={{ padding: "8px 12px", border: "1px solid #d1d5db", textAlign: "center", fontWeight: 600, minWidth: 120 }}>
                            {mode.mode_name?.trim() || `Mode ${mode.mode_nr}`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(compositeDetail.matrixColumns || []).map((col, ci) => (
                        <tr key={ci}>
                          <td style={{ padding: "8px 12px", border: "1px solid #d1d5db", fontWeight: 600, background: "#f9fafb", fontFamily: "var(--font-mono, monospace)" }}>
                            {col}
                          </td>
                          {(compositeDetail.matrixModes || []).map((mode, mi) => {
                            // Effective value = override (if enabled & set) else composite
                            // default, else 0 — exactly the precedence XML export uses.
                            const overrideVal = matrixEnabled ? matrixCells?.[mode.mode_nr]?.[col] : undefined;
                            const compVal = mode.cells?.[col];
                            const val = overrideVal != null ? overrideVal
                              : (compVal === undefined || compVal === null || compVal === "") ? 0 : compVal;
                            const match = valveCommands.find(o => Number(o.value) === Number(val));
                            const display = match ? match.label : `${val}`;
                            const knownOption = !!match;
                            return (
                              <td key={mi} style={{
                                padding: matrixEnabled ? "4px 6px" : "8px 12px",
                                border: "1px solid #d1d5db",
                                textAlign: "center",
                                fontFamily: "var(--font-mono, monospace)",
                                fontSize: 12,
                                color: "#0C447C",
                              }}>
                                {matrixEnabled ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                    <select
                                      value={knownOption ? String(val) : "__other__"}
                                      onChange={e => {
                                        if (e.target.value !== "__other__") setMatrixCell(mode.mode_nr, col, e.target.value);
                                      }}
                                      style={{ width: "100%", padding: "3px 4px", fontSize: 12, borderRadius: 4,
                                        border: "1px solid #d1d5db", background: "#fff", color: "#0C447C" }}>
                                      {valveCommands.map(o => (
                                        <option key={o.value} value={String(o.value)}>{o.label}</option>
                                      ))}
                                      <option value="__other__">Other…</option>
                                    </select>
                                    {!knownOption && (
                                      <input type="number" value={val} min={0}
                                        onChange={e => setMatrixCell(mode.mode_nr, col, e.target.value)}
                                        placeholder="code"
                                        style={{ width: "100%", padding: "3px 4px", fontSize: 12, borderRadius: 4,
                                          border: "1px solid #d1d5db", fontFamily: "var(--font-mono, monospace)" }} />
                                    )}
                                  </div>
                                ) : display}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : !compositeDetail ? (
                  <div style={{ padding: 20, textAlign: "center", color: "#6b7280" }}>
                    Loading matrix data…
                  </div>
                ) : (
                  <div style={{ padding: 20, textAlign: "center", color: "#6b7280" }}>
                    No matrix data configured for this composite type.
                  </div>
                )}
              </div>
            </div>
          ) : (loading || !profile?.subBlocks) ? (
            <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading…</div>
          ) : activeBlocks.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
              No blocks/variables found for this Type. (Try reopening — block details load on demand.)
            </div>
          ) : (
            activeBlocks.map(blk => {
              const ioVars = (blk.vars || []).filter(v => connTypeByVar[v.name] === 'io_connection' || hasSignalMappingByVar[v.name] || hasConnReconByVar[v.name]);
              const valueVars = (blk.vars || []).filter(v => connTypeByVar[v.name] === 'value' && !hasSignalMappingByVar[v.name] && !hasConnReconByVar[v.name]);
              const interconnectVars = (blk.vars || []).filter(v => connTypeByVar[v.name] === 'interconnection');
              const unassignedVars = (blk.vars || []).filter(v => !connTypeByVar[v.name] && !hasSignalMappingByVar[v.name] && !hasConnReconByVar[v.name]);

              return (
                <div key={blk.name} style={{ marginBottom: 20 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: "#0C447C",
                    padding: "6px 0", borderBottom: "1px solid #e5e7eb", marginBottom: 12,
                  }}>
                    {blk.name} {blk.comment ? <span style={{ fontWeight: 400, color: "#6b7280" }}>— {blk.comment}</span> : null}
                  </div>

                  {/* Signals section (IO connections) */}
                  {ioVars.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 6, paddingLeft: "4px" }}>
                        SIGNALS
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: "#6b7280" }}>
                            <th style={{ padding: "4px 8px", width: "26%" }}>Variable</th>
                            <th style={{ padding: "4px 8px", width: "12%" }}>Dir</th>
                            <th style={{ padding: "4px 8px", width: "14%" }}>Type</th>
                            <th style={{ padding: "4px 8px" }}>Signal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ioVars.map(v => (
                            <SignalRow key={v.name} blk={blk} v={v} mapping={mapping} setVarSignal={setVarSignal} signalByTag={signalByTag} signals={signals} connIoByKey={connIoByKey} dummyByKey={dummyByKey} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Values section (static/derived Value connections) */}
                  {valueVars.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 6, paddingLeft: "4px" }}>
                        VALUES
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: "#6b7280" }}>
                            <th style={{ padding: "4px 8px", width: "26%" }}>Variable</th>
                            <th style={{ padding: "4px 8px", width: "12%" }}>Dir</th>
                            <th style={{ padding: "4px 8px", width: "14%" }}>Type</th>
                            <th style={{ padding: "4px 8px" }}>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {valueVars.map(v => {
                            const conn = (instance.connections || []).find(c => c.target_pin === v.name && c.conn_type === 'value');
                            return <ValueRow key={v.name} v={v} conn={conn} derivedByVar={derivedByVar} values={values} onValueChange={setVarValue} onOverrideChange={setDerivedOverride} />;
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Interconnections section (inter-member wiring, read-only) */}
                  {interconnectVars.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 6, paddingLeft: "4px" }}>
                        INTERCONNECTIONS
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: "#6b7280" }}>
                            <th style={{ padding: "4px 8px", width: "26%" }}>Variable</th>
                            <th style={{ padding: "4px 8px", width: "12%" }}>Dir</th>
                            <th style={{ padding: "4px 8px", width: "14%" }}>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {interconnectVars.map(v => (
                            <tr key={v.name} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "4px 8px", fontFamily: "var(--font-mono, monospace)" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  {v.name}
                                  <span style={{
                                    display: "inline-block", fontSize: 10, fontWeight: 600,
                                    color: "#166534", background: "#dcfce7", padding: "2px 6px",
                                    borderRadius: 3, whiteSpace: "nowrap",
                                  }}>INTERCONNECT</span>
                                </div>
                              </td>
                              <td style={{ padding: "4px 8px", color: "#6b7280" }}>
                                {v.dir === "VarOutput" ? "out" : v.dir === "VarInput" ? "in" : v.dir}
                              </td>
                              <td style={{ padding: "4px 8px", color: "#6b7280" }}>{v.dtype}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Unassigned section (orphan variables with no connections) */}
                  {unassignedVars.length > 0 && (
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 6, paddingLeft: "4px" }}>
                        UNASSIGNED
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: "#6b7280" }}>
                            <th style={{ padding: "4px 8px", width: "26%" }}>Variable</th>
                            <th style={{ padding: "4px 8px", width: "12%" }}>Dir</th>
                            <th style={{ padding: "4px 8px", width: "14%" }}>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unassignedVars.map(v => (
                            <tr key={v.name} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "4px 8px", fontFamily: "var(--font-mono, monospace)", color: "#9ca3af" }}>
                                {v.name}
                              </td>
                              <td style={{ padding: "4px 8px", color: "#9ca3af" }}>
                                {v.dir === "VarOutput" ? "out" : v.dir === "VarInput" ? "in" : v.dir}
                              </td>
                              <td style={{ padding: "4px 8px", color: "#9ca3af" }}>{v.dtype}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: 10,
          padding: "12px 20px", borderTop: "1px solid #e5e7eb", flexShrink: 0,
        }}>
          <button onClick={() => onClose(false)} disabled={saving} style={{
            padding: "7px 16px", fontSize: 13, border: "1px solid #d1d5db",
            borderRadius: 6, background: "#fff", cursor: "pointer",
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || loading} style={{
            padding: "7px 16px", fontSize: 13, border: "none", borderRadius: 6,
            background: "#0C447C", color: "#fff", cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function SignalRow({ blk, v, mapping, setVarSignal, signalByTag, signals, connIoByKey, dummyByKey }) {
  const key = `${blk.name}.${v.name}`;
  const cur = mapping[key];
  const mismatch = cur && datatypeMismatch(cur.signalType, v.dtype);
  const options = cur && !signalByTag[cur.signalTag]
    ? [cur.signalTag, ...signals.map(s => s.tag)]
    : signals.map(s => s.tag);
  const recon     = connIoByKey[key];
  const reconName = recon?.signal_name || dummyByKey[key];
  const isReal    = !cur && recon?.status === "real";
  const isDummy   = !cur && !isReal && !!reconName;
  const reconAddr = (isReal && recon)
    ? [recon.station_address != null ? `S${recon.station_address}` : null,
       recon.slot    != null ? `Sl${recon.slot}`    : null,
       recon.channel != null ? `Ch${recon.channel}` : null].filter(Boolean).join("/")
    : "";

  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td style={{ padding: "4px 8px", fontFamily: "var(--font-mono, monospace)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {v.name}
          {isReal && (
            <span title={`Auto-connected to hardware signal ${recon.signal_name}${reconAddr ? ` (${reconAddr})` : ""}`} style={{
              display: "inline-block", fontSize: 10, fontWeight: 600,
              color: "#166534", background: "#dcfce7", padding: "2px 6px",
              borderRadius: 3, whiteSpace: "nowrap",
            }}>REAL</span>
          )}
          {isDummy && (
            <span title="Dummy IO signal from an IO connection rule — no matching hardware symbol. Run Generate Connections after importing hardware." style={{
              display: "inline-block", fontSize: 10, fontWeight: 600,
              color: "#7c2d12", background: "#fed7aa", padding: "2px 6px",
              borderRadius: 3, whiteSpace: "nowrap",
            }}>DUMMY</span>
          )}
        </div>
      </td>
      <td style={{ padding: "4px 8px", color: "#6b7280" }}>
        {v.dir === "VarOutput" ? "out" : v.dir === "VarInput" ? "in" : v.dir}
      </td>
      <td style={{ padding: "4px 8px", color: "#6b7280" }}>{v.dtype}</td>
      <td style={{ padding: "4px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={cur?.signalTag || ""}
            onChange={e => setVarSignal(blk.name, v.name, e.target.value)}
            style={{
              flex: 1, padding: "4px 6px", fontSize: 13,
              border: mismatch ? "1px solid #f59e0b"
                    : isReal ? "1px solid #86efac"
                    : isDummy ? "1px solid #fdba74" : "1px solid #d1d5db",
              borderRadius: 5,
              background: mismatch ? "#fffbeb" : isReal ? "#f0fdf4" : isDummy ? "#fff7ed" : "#fff",
              color: isReal ? "#166534" : isDummy ? "#9a3412" : "inherit",
              fontFamily: (isReal || isDummy) ? "var(--font-mono, monospace)" : "inherit",
            }}
          >
            <option value="">
              {isReal ? `${recon.signal_name}${reconAddr ? ` → ${reconAddr}` : ""}  (connected)`
                : isDummy ? `${reconName}  (dummy)`
                : "— none —"}
            </option>
            {options.map(tag => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
          {mismatch && (
            <span title={`Signal type ${cur.signalType} may not match ${v.dtype}`}
              style={{ color: "#b45309", fontSize: 12, whiteSpace: "nowrap" }}>
              ⚠ type
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function ValueRow({ v, conn, derivedByVar, values, onValueChange, onOverrideChange }) {
  const derived = derivedByVar[v.name];
  const isDerived = conn?.value_mode === 'derived';
  const staticValue = values[v.name] !== undefined ? values[v.name] : (conn?.static_value || "");

  // Derived pins: user override (persisted separately, wins everywhere) > auto-resolved
  // IO-list value > empty (unresolved, awaiting Generate Connections or manual entry).
  const hasOverride = isDerived && derived?.override_value != null && derived.override_value !== "";
  const derivedInputValue = hasOverride
    ? derived.override_value
    : (derived?.status === "resolved" ? String(derived.value) : "");

  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td style={{ padding: "4px 8px", fontFamily: "var(--font-mono, monospace)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {v.name}
          {isDerived ? (
            <span title={derived?.status === "resolved"
                ? `Derived from IO list column "${derived.column_name}" (symbol: ${derived.symbol_name}). You can override with a custom value.`
                : `Derived from IO list column "${conn.column}" — no matching tag for "${conn.prefix}${v.name}${conn.suffix}". Run Generate Connections after importing the IO list, or enter a custom value.`}
              style={{
                display: "inline-block", fontSize: 10, fontWeight: 600,
                color: derived?.status === "resolved" ? "#3730a3" : "#92400e",
                background: derived?.status === "resolved" ? "#e0e7ff" : "#fef3c7",
                padding: "2px 6px", borderRadius: 3, whiteSpace: "nowrap",
              }}>DERIVED</span>
          ) : staticValue && (
            <span title="Static value (hand-entered)"
              style={{
                display: "inline-block", fontSize: 10, fontWeight: 600,
                color: "#92400e", background: "#fef3c7", padding: "2px 6px",
                borderRadius: 3, whiteSpace: "nowrap",
              }}>STATIC</span>
          )}
        </div>
      </td>
      <td style={{ padding: "4px 8px", color: "#6b7280" }}>
        {v.dir === "VarOutput" ? "out" : v.dir === "VarInput" ? "in" : v.dir}
      </td>
      <td style={{ padding: "4px 8px", color: "#6b7280" }}>{v.dtype}</td>
      <td style={{ padding: "4px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isDerived && (
            <input
              type="checkbox"
              checked={hasOverride}
              onChange={e => {
                if (e.target.checked) {
                  onOverrideChange && onOverrideChange(v.name, derived?.value ?? "");
                } else {
                  onOverrideChange && onOverrideChange(v.name, null);
                }
              }}
              title={hasOverride
                ? "Uncheck to revert to auto-derived value (will be re-resolved on Generate Connections)"
                : "Check to enable manual override (will persist across Generate Connections)"}
              style={{
                width: 16, height: 16, cursor: "pointer", flexShrink: 0,
              }}
            />
          )}
          <input
            type="text"
            value={isDerived ? derivedInputValue : staticValue}
            onChange={e => isDerived
              ? (onOverrideChange && onOverrideChange(v.name, e.target.value))
              : (onValueChange && onValueChange(v.name, e.target.value))}
            disabled={isDerived && !hasOverride}
            placeholder={isDerived && !hasOverride ? derived?.status === "resolved" ? derived.value : "Auto-derived" : "Enter value"}
            style={{
              flex: 1, padding: "4px 6px", fontSize: 13,
              border: "1px solid #d1d5db", borderRadius: 5,
              background: isDerived && !hasOverride ? "#f3f4f6" : "#fff",
              color: isDerived && !hasOverride ? "#9ca3af" : "inherit",
              cursor: isDerived && !hasOverride ? "not-allowed" : "text",
            }}
          />
          {isDerived && derived?.status === "resolved" && !hasOverride && (
            <span title={`Auto-resolved from IO list column "${derived.column_name}" (symbol: ${derived.symbol_name}).`}
              style={{
                fontSize: 10, fontWeight: 600, color: "#3730a3", background: "#e0e7ff",
                padding: "2px 6px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
              }}>AUTO</span>
          )}
          {isDerived && hasOverride && (
            <span title="Manual override enabled — takes priority over the auto-resolved value. Uncheck the box to revert to auto."
              style={{
                fontSize: 10, fontWeight: 600, color: "#166534", background: "#dcfce7",
                padding: "2px 6px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
              }}>OVERRIDE</span>
          )}
          {isDerived && !hasOverride && derived?.status !== "resolved" && (
            <span title={`Unresolved: No matching tag for "${conn.prefix}${v.name}${conn.suffix}". Check the box to enter a custom value.`}
              style={{
                fontSize: 10, fontWeight: 600, color: "#92400e", background: "#fef3c7",
                padding: "2px 6px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
              }}>UNRESOLVED</span>
          )}
        </div>
      </td>
    </tr>
  );
}
