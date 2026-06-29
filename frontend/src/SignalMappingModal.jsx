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

export default function SignalMappingModal({ projectId, instance, profile, onClose }) {
  // mapping: { "<block>.<var>": { signalTag, signalType, hwSignalId } }
  const [mapping, setMapping]   = useState({});
  const [signals, setSignals]   = useState([]);   // candidate signals from latest HW import
  const [query, setQuery]       = useState("");
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [noImport, setNoImport] = useState(false);
  // Reconciliation result per pin: { "<block>.<var>": { status, signal_name, station_address, slot, channel } }
  const [connIoByKey, setConnIoByKey] = useState({});
  const debounceRef = useRef(null);

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

  // Load existing mappings on open.
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
    return () => { cancelled = true; };
  }, [projectId, instance.instanceName]);

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
      onClose(true);
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
            <span style={{ fontSize: 18, fontWeight: 700 }}>Signal Mapping</span>
            <span style={{ marginLeft: 12, fontSize: 13, opacity: 0.85 }}>
              {instance.instanceName} &nbsp;·&nbsp; {typeLabel}
            </span>
          </div>
          <button onClick={() => onClose(false)} style={{
            background: "none", border: "none", color: "#fff", fontSize: 22,
            cursor: "pointer", lineHeight: 1, padding: "0 4px",
          }}>✕</button>
        </div>

        {/* Toolbar */}
        <div style={{
          display: "flex", gap: 12, padding: "10px 20px", background: "#f8fafc",
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
          {(loading || !profile?.subBlocks) ? (
            <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading…</div>
          ) : activeBlocks.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
              No blocks/variables found for this Type. (Try reopening — block details load on demand.)
            </div>
          ) : (
            activeBlocks.map(blk => (
              <div key={blk.name} style={{ marginBottom: 18 }}>
                <div style={{
                  fontSize: 13, fontWeight: 700, color: "#0C447C",
                  padding: "6px 0", borderBottom: "1px solid #e5e7eb", marginBottom: 6,
                }}>
                  {blk.name} {blk.comment ? <span style={{ fontWeight: 400, color: "#6b7280" }}>— {blk.comment}</span> : null}
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
                    {(blk.vars || []).map(v => {
                      const key = `${blk.name}.${v.name}`;
                      const cur = mapping[key];
                      const mismatch = cur && datatypeMismatch(cur.signalType, v.dtype);
                      // Ensure the currently-saved tag is selectable even if it's not in
                      // the filtered signal list.
                      const options = cur && !signalByTag[cur.signalTag]
                        ? [cur.signalTag, ...signals.map(s => s.tag)]
                        : signals.map(s => s.tag);
                      // Reconciliation result for this pin (from "Generate Connections").
                      // Falls back to the rule-derived dummy name if never reconciled.
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
                        <tr key={v.name} style={{ borderBottom: "1px solid #f1f5f9" }}>
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
                    })}
                  </tbody>
                </table>
              </div>
            ))
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
          }}>{saving ? "Saving…" : "Save Mappings"}</button>
        </div>
      </div>
    </div>
  );
}
