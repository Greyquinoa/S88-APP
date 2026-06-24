import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { listHwImports, listHwControllers, listHwFieldbuses, mrpGetDevices, mrpGetConfig, mrpSaveConfig, mrpDownloadCfg, mrpImportFromCfg } from "./api.js";
import MRPTopologyView from "./MRPTopologyView.jsx";

// MRP role definitions
const ROLES = [
  { value: 0, label: "Off (no MRP)" },
  { value: 3, label: "MRM – Ring Manager" },
  { value: 2, label: "MRC – Ring Client" },
];

function roleLabel(v) {
  return ROLES.find(r => r.value === v)?.label ?? "Off";
}

// ─── Screen 3 wrapper (handles fullscreen) ────────────────────────────────────

function Screen3PortConnections({
  ringDevices, links, allPortDevices, roles, ringIssues,
  saving, saved, canDownload, downloading,
  setLink, handleSave, handleDownload, onBack, onNext,
}) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const outer = fullscreen
    ? { position: "fixed", inset: 0, zIndex: 9999, background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }
    : { background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0", padding: 0, display: "flex", flexDirection: "column" };

  return (
    <div style={outer}>
      {/* Toolbar */}
      <div style={s3.toolbar}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9" }}>Port Connections</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={s3.toolbarBtn} onClick={() => setFullscreen(f => !f)}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Open fullscreen"}>
            {fullscreen ? "⊠ Exit Fullscreen" : "⛶ Fullscreen"}
          </button>
        </div>
      </div>

      {/* Body: form left, diagram right */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* Left: form */}
        <div style={{ ...s3.formPane, overflowY: "auto" }}>
          <p style={styles.hint}>
            For each ring port (first port pair), select which device and port it connects to.
            Both ports must be connected.
          </p>

          {ringDevices.length === 0 && (
            <div style={styles.notice}>No devices have MRP roles assigned. Go back to Device Roles.</div>
          )}

          {ringDevices.map(dev => (
            <div key={dev.alias} style={styles.devCard}>
              <div style={styles.devHeader}>
                <b>{dev.alias}</b>
                <span style={styles.badge}>{roleLabel(roles.get(dev.alias)?.role ?? 0)}</span>
              </div>

              {(dev.ports || []).slice(0, 2).map(port => {
                const key = `${dev.alias}:${port.subslot}`;
                const link = links.get(key) || { toDevice: "", toIfaceSubslot: 1, toPortSubslot: 2 };
                const toDevObj = allPortDevices.find(d => d.alias === link.toDevice);
                return (
                  <div key={port.subslot} style={styles.portRow}>
                    <span style={styles.portLabel}>
                      {(port.label || `P${port.subslot}`).replace(/\s*RJ45\s*/i, "").trim()}
                    </span>
                    <span style={styles.arrow}>→</span>
                    <select
                      style={styles.selectSm}
                      value={link.toDevice}
                      onChange={e => {
                        const newDev = allPortDevices.find(d => d.alias === e.target.value);
                        setLink(dev.alias, port.subslot, "toDevice", e.target.value);
                        if (newDev?.ports?.[0]) {
                          setLink(dev.alias, port.subslot, "toIfaceSubslot", newDev.ifaceSubslot ?? 1);
                          setLink(dev.alias, port.subslot, "toPortSubslot", newDev.ports[0].subslot);
                        }
                      }}
                    >
                      <option value="">— device —</option>
                      {allPortDevices.filter(d => d.alias !== dev.alias).map(d => (
                        <option key={d.alias} value={d.alias}>{d.alias}</option>
                      ))}
                    </select>
                    <select
                      style={styles.selectSm}
                      value={link.toPortSubslot}
                      onChange={e => setLink(dev.alias, port.subslot, "toPortSubslot", parseInt(e.target.value, 10))}
                      disabled={!link.toDevice}
                    >
                      {(toDevObj?.ports || []).map(p => (
                        <option key={p.subslot} value={p.subslot}>
                          {(p.label || `P${p.subslot}`).replace(/\s*RJ45\s*/i, "").trim()}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          ))}

          {ringIssues.length > 0 && (
            <div style={styles.warn}>
              <b>Ring validation issues:</b>
              <ul style={{ margin: "4px 0 0 0", paddingLeft: 20 }}>
                {ringIssues.map((issue, i) => <li key={i}>{issue}</li>)}
              </ul>
            </div>
          )}

          <div style={styles.row}>
            <button style={styles.btnSecondary} onClick={onBack}>← Back</button>
            <button style={saving ? styles.btnDisabled : styles.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : saved ? "✓ Saved" : "Save Configuration"}
            </button>
            <button
              style={(!canDownload || downloading) ? styles.btnDisabled : styles.btnSuccess}
              onClick={handleDownload} disabled={!canDownload || downloading}
              title={!saved ? "Save first" : ringIssues.length > 0 ? "Fix ring issues first" : ""}
            >
              {downloading ? "Generating…" : "Generate CFG with MRP"}
            </button>
          </div>

          {saved && ringIssues.length === 0 && (
            <div style={styles.successMsg}>
              Configuration saved. Click <b>Generate CFG with MRP</b> to download.
            </div>
          )}
        </div>

        {/* Right: diagram */}
        <div style={s3.diagramPane}>
          <div style={s3.diagramLabel}>Connection Preview</div>
          <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", padding: "8px 12px" }}>
            {ringDevices.length === 0
              ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", marginTop: 40 }}>No ring devices configured yet.</p>
              : <PortConnectionsDiagram ringDevices={ringDevices} links={links} allPortDevices={allPortDevices} />
            }
          </div>
        </div>
      </div>
    </div>
  );
}

const s3 = {
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 14px",
    background: "#1e293b",
    color: "#f1f5f9",
    flexShrink: 0,
    borderRadius: "8px 8px 0 0",
  },
  toolbarBtn: {
    padding: "4px 12px",
    background: "transparent",
    border: "1px solid #475569",
    borderRadius: 4,
    color: "#cbd5e1",
    fontSize: 12,
    cursor: "pointer",
  },
  formPane: {
    width: 480,
    minWidth: 380,
    flexShrink: 0,
    borderRight: "1px solid #e2e8f0",
    padding: "16px 20px",
    overflowY: "auto",
  },
  diagramPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    background: "#f8fafc",
    minWidth: 0,
  },
  diagramLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.6px",
    padding: "8px 12px 4px",
    borderBottom: "1px solid #e2e8f0",
    flexShrink: 0,
  },
};

// ─── Port Connections Diagram ─────────────────────────────────────────────────

const DIAG = {
  nodeW:      180,
  nodeHeaderH: 28,
  portH:       24,
  portPadV:     6,
  colGap:      220, // horizontal gap between left-col right-edge and right-col left-edge
  rowGap:       20, // vertical gap between device cards
  sidePad:      40, // canvas left/right margin
  topPad:       16,
};

function nodeBodyH(portCount) {
  return DIAG.portPadV + portCount * DIAG.portH + DIAG.portPadV;
}
function nodeH(portCount) {
  return DIAG.nodeHeaderH + nodeBodyH(portCount);
}
// Y centre of port row i inside a node (relative to node top)
function portCY(portIdx) {
  return DIAG.nodeHeaderH + DIAG.portPadV + portIdx * DIAG.portH + DIAG.portH / 2;
}

function PortConnectionsDiagram({ ringDevices, links, allPortDevices }) {
  // Split devices into two columns (left: even-index, right: odd-index)
  const leftDevs  = ringDevices.filter((_, i) => i % 2 === 0);
  const rightDevs = ringDevices.filter((_, i) => i % 2 === 1);

  // Column X positions
  const leftX  = DIAG.sidePad;
  const rightX = DIAG.sidePad + DIAG.nodeW + DIAG.colGap;

  // Compute Y positions per device in each column
  function colYs(devs) {
    const ys = [];
    let y = DIAG.topPad;
    for (const dev of devs) {
      ys.push(y);
      y += nodeH((dev.ports || []).slice(0, 2).length) + DIAG.rowGap;
    }
    return ys;
  }
  const leftYs  = colYs(leftDevs);
  const rightYs = colYs(rightDevs);

  // Total canvas height
  const leftH  = leftDevs.reduce((s, d) => s + nodeH((d.ports || []).slice(0, 2).length) + DIAG.rowGap, DIAG.topPad);
  const rightH = rightDevs.reduce((s, d) => s + nodeH((d.ports || []).slice(0, 2).length) + DIAG.rowGap, DIAG.topPad);
  const svgH   = Math.max(leftH, rightH, 100) + DIAG.topPad;
  const svgW   = rightX + DIAG.nodeW + DIAG.sidePad;

  // Build a lookup: alias → { col: "left"|"right", devIdx, nodeY, ports }
  const devMeta = useMemo(() => {
    const m = new Map();
    leftDevs.forEach((d, i)  => m.set(d.alias, { col: "left",  devIdx: i, nodeY: leftYs[i],  dev: d }));
    rightDevs.forEach((d, i) => m.set(d.alias, { col: "right", devIdx: i, nodeY: rightYs[i], dev: d }));
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringDevices]);

  // Build edge list: { x1, y1, x2, y2, isRing }
  const edges = useMemo(() => {
    const seen = new Set();
    const result = [];
    for (const [key, val] of links) {
      if (!val.toDevice) continue;
      const [fromAlias, ssStr] = key.split(":");
      const fromSS = parseInt(ssStr, 10);
      const toAlias = val.toDevice;
      const toSS    = val.toPortSubslot;

      const edgeKey = [key, `${toAlias}:${toSS}`].sort().join("--");
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      const fromMeta = devMeta.get(fromAlias);
      const toMeta   = devMeta.get(toAlias);
      if (!fromMeta || !toMeta) continue;

      const fromPorts = (fromMeta.dev.ports || []).slice(0, 2);
      const toPorts   = (toMeta.dev.ports   || []).slice(0, 2);
      const fromPIdx  = fromPorts.findIndex(p => p.subslot === fromSS);
      const toPIdx    = toPorts.findIndex(p => p.subslot === toSS);
      if (fromPIdx < 0 || toPIdx < 0) continue;

      // Anchor X: left-col ports connect from the right edge, right-col ports from the left edge
      const fromX = fromMeta.col === "left"  ? leftX + DIAG.nodeW : rightX;
      const toX   = toMeta.col   === "right" ? rightX             : leftX + DIAG.nodeW;
      const fromY = fromMeta.nodeY + portCY(fromPIdx);
      const toY   = toMeta.nodeY  + portCY(toPIdx);

      result.push({ fromX, fromY, toX, toY });
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, devMeta]);

  // Routing: corridor X values outside both columns
  const leftCorridorX  = leftX - 20;
  const rightCorridorX = rightX + DIAG.nodeW + 20;

  // Build SVG path for an edge: straight if between left and right col, else routed around via corridor
  function edgePath(e) {
    const fromLeft = e.fromX === leftX + DIAG.nodeW; // exits from left column
    const toRight  = e.toX   === rightX;             // enters right column

    if (fromLeft && toRight) {
      // Cross connection: straight horizontal middle corridor
      const midX = leftX + DIAG.nodeW + DIAG.colGap / 2;
      return `M${e.fromX},${e.fromY} H${midX} V${e.toY} H${e.toX}`;
    }
    // Same-side (left→left or right→right): route via side corridor
    const corridorX = fromLeft ? leftCorridorX : rightCorridorX;
    return `M${e.fromX},${e.fromY} H${corridorX} V${e.toY} H${e.toX}`;
  }

  function renderNode(dev, nodeX, nodeY) {
    const ports = (dev.ports || []).slice(0, 2);
    const h = nodeH(ports.length);
    const isLeft = nodeX === leftX;
    return (
      <g key={dev.alias} transform={`translate(${nodeX},${nodeY})`}>
        {/* Card background */}
        <rect width={DIAG.nodeW} height={h} rx={5} fill="#fff" stroke="#cbd5e1" strokeWidth={1.5} />
        {/* Header */}
        <rect width={DIAG.nodeW} height={DIAG.nodeHeaderH} rx={5} fill="#1e293b" />
        <rect y={DIAG.nodeHeaderH - 5} width={DIAG.nodeW} height={5} fill="#1e293b" />
        <text x={DIAG.nodeW / 2} y={DIAG.nodeHeaderH / 2 + 1} textAnchor="middle" dominantBaseline="middle"
          fill="#f1f5f9" fontSize={11} fontWeight={600} fontFamily="inherit">
          {dev.alias}
        </text>
        {/* Ports */}
        {ports.map((port, pi) => {
          const cy = portCY(pi);
          const portKey = `${dev.alias}:${port.subslot}`;
          const connected = links.has(portKey) && !!links.get(portKey)?.toDevice;
          const dotX = isLeft ? DIAG.nodeW - 8 : 8;
          const labelX = isLeft ? DIAG.nodeW - 18 : 18;
          const anchor = isLeft ? "end" : "start";
          return (
            <g key={port.subslot}>
              <line x1={0} y1={cy} x2={DIAG.nodeW} y2={cy} stroke="#f1f5f9" strokeWidth={1} />
              <text x={labelX} y={cy} dominantBaseline="middle" textAnchor={anchor}
                fontSize={10} fill="#475569" fontFamily="inherit">
                {(port.label || `P${port.subslot}`).replace(/\s*RJ45\s*/i, "").trim()}
              </text>
              {/* Port dot at edge (connection point) */}
              <circle cx={dotX} cy={cy} r={4}
                fill={connected ? "#16a34a" : "#d1d5db"}
                stroke="#fff" strokeWidth={1} />
            </g>
          );
        })}
      </g>
    );
  }

  return (
    <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: "block", overflow: "visible" }}>
      {/* Connection lines — drawn first so they appear behind nodes */}
      {edges.map((e, i) => (
        <path key={i} d={edgePath(e)}
          fill="none" stroke="#2563eb" strokeWidth={1.5}
          strokeLinejoin="round" markerEnd="url(#arrowhead)" />
      ))}

      {/* Arrow marker */}
      <defs>
        <marker id="arrowhead" markerWidth={8} markerHeight={6} refX={6} refY={3} orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#2563eb" />
        </marker>
      </defs>

      {/* Device nodes — drawn on top of lines */}
      {leftDevs.map((dev, i)  => renderNode(dev, leftX,  leftYs[i]))}
      {rightDevs.map((dev, i) => renderNode(dev, rightX, rightYs[i]))}
    </svg>
  );
}

export default function StepMRP({ projectId }) {
  const [importId,    setImportId]    = useState(null);
  const [devices,     setDevices]     = useState([]);   // from /api/mrp/:id/devices
  const [stationName, setStationName] = useState("");
  const [fieldbuses,  setFieldbuses]  = useState([]);   // [{id, INT_DP_Subsystem, T50_Fieldbus_Name}]

  // Screen 1 — domain setup
  const [domainName,  setDomainName]  = useState("mrpdomain-1");
  const [fieldbusNo,  setFieldbusNo]  = useState(null);

  // Screen 2 — device roles: Map<alias, {role, mrpInstances}>
  const [roles, setRoles] = useState(new Map());

  // Screen 3 — port links: Map<"fromAlias:portSubslot", {toDevice, toIfaceSubslot, toPortSubslot}>
  const [links, setLinks] = useState(new Map());

  const [screen,   setScreen]   = useState(1);  // 1, 2, or 3
  const [loading,  setLoading]  = useState("");
  const [error,    setError]    = useState("");
  const [saved,    setSaved]    = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [downloading,  setDownloading]  = useState(false);
  const [importing,    setImporting]    = useState(false);
  const cfgImportRef = useRef();

  // Load the latest HW import + fieldbuses for this project on mount
  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      listHwImports(projectId),
      listHwControllers(projectId),
    ]).then(([imports, controllers]) => {
      const latest = imports[0];
      if (latest) setImportId(latest.id);
      // Load fieldbuses from the first controller (same as HW Config tab does)
      if (controllers.length > 0) {
        listHwFieldbuses(controllers[0].id)
          .then(fbs => {
            setFieldbuses(fbs);
            if (fbs.length > 0 && fieldbusNo == null) {
              setFieldbusNo(Number(fbs[0].INT_DP_Subsystem));
            }
          })
          .catch(() => {});
      }
    }).catch(() => {});
  }, [projectId]);

  // When importId is known, load devices and any saved config
  useEffect(() => {
    if (!importId) return;
    setLoading("Loading devices from baseline CFG…");
    Promise.all([mrpGetDevices(importId), mrpGetConfig(importId)])
      .then(([devData, cfg]) => {
        setDevices(devData.devices || []);
        setStationName(devData.stationName || "");

        // Restore saved config if present
        if (cfg) {
          setDomainName(cfg.domain_name || "mrpdomain-1");
          setFieldbusNo(cfg.fieldbus_no);

          const rMap = new Map();
          for (const r of cfg.roles || []) {
            rMap.set(r.device_alias, { role: r.mrp_role, mrpInstances: r.mrp_instances, ringPort1: r.ring_port_1 ?? null, ringPort2: r.ring_port_2 ?? null });
          }
          setRoles(rMap);

          const lMap = new Map();
          for (const l of cfg.links || []) {
            lMap.set(`${l.from_device}:${l.from_port_subslot}`, {
              toDevice:         l.to_device,
              toIfaceSubslot:   l.to_iface_subslot,
              toPortSubslot:    l.to_port_subslot,
            });
          }
          setLinks(lMap);
        }
        setLoading("");
      })
      .catch(e => { setError(e.message); setLoading(""); });
  }, [importId]);

  // Devices that are on the selected fieldbus and have ports
  const filteredDevices = fieldbusNo == null
    ? devices
    : devices.filter(d => d.subsystemNo === Number(fieldbusNo));

  // All devices with ports (regardless of filter — for port link dropdowns)
  const allPortDevices = devices.filter(d => d.ports && d.ports.length > 0);

  function setRole(alias, role) {
    setRoles(prev => {
      const next = new Map(prev);
      const existing = next.get(alias) || { role: 0, mrpInstances: 0 };
      next.set(alias, { ...existing, role, mrpInstances: role === 3 ? 1 : 0 });
      return next;
    });
    setSaved(false);
  }

  function setLink(fromAlias, fromPortSubslot, field, value) {
    const key = `${fromAlias}:${fromPortSubslot}`;
    setLinks(prev => {
      const next = new Map(prev);
      const existing = next.get(key) || { toDevice: "", toIfaceSubslot: 1, toPortSubslot: 2 };
      next.set(key, { ...existing, [field]: value });
      return next;
    });
    setSaved(false);
  }

  async function handleImportFromCfg(file) {
    if (!file) return;
    setImporting(true);
    setError("");
    try {
      await mrpImportFromCfg(importId, file);
      // Reload devices and config from DB so UI reflects imported values
      const [devData, cfg] = await Promise.all([mrpGetDevices(importId), mrpGetConfig(importId)]);
      setDevices(devData.devices || []);
      setStationName(devData.stationName || "");
      if (cfg) {
        setDomainName(cfg.domain_name || "mrpdomain-1");
        setFieldbusNo(cfg.fieldbus_no);
        const rMap = new Map();
        for (const r of cfg.roles || []) {
          rMap.set(r.device_alias, { role: r.mrp_role, mrpInstances: r.mrp_instances, ringPort1: r.ring_port_1 ?? null, ringPort2: r.ring_port_2 ?? null });
        }
        setRoles(rMap);
        const lMap = new Map();
        for (const l of cfg.links || []) {
          lMap.set(`${l.from_device}:${l.from_port_subslot}`, {
            toDevice:       l.to_device,
            toIfaceSubslot: l.to_iface_subslot,
            toPortSubslot:  l.to_port_subslot,
          });
        }
        setLinks(lMap);
      }
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const rolesArr = [...roles.entries()].map(([alias, r]) => ({
        deviceAlias:  alias,
        mrpRole:      r.role,
        mrpInstances: r.mrpInstances,
      }));
      const linksArr = [...links.entries()].map(([key, l]) => {
        const [fromDevice, fromPortSubslot] = key.split(":");
        // fromIfaceSubslot: look up from devices
        const dev = devices.find(d => d.alias === fromDevice);
        return {
          fromDevice,
          fromIfaceSubslot: dev?.ifaceSubslot ?? 1,
          fromPortSubslot:  parseInt(fromPortSubslot, 10),
          toDevice:         l.toDevice,
          toIfaceSubslot:   l.toIfaceSubslot,
          toPortSubslot:    l.toPortSubslot,
        };
      });

      await mrpSaveConfig(importId, {
        domainName,
        fieldbusNo,
        stationName,
        roles:  rolesArr,
        links:  linksArr,
      });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    setError("");
    try {
      await mrpDownloadCfg(importId);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  }

  // Devices that actually participate (role != 0)
  const ringDevices = filteredDevices.filter(d => (roles.get(d.alias)?.role ?? 0) !== 0);

  // Validate ring: only the first 2 ports (instance 1 ring pair) need links configured
  function validateRing() {
    const issues = [];
    for (const dev of ringDevices) {
      const ringPorts = (dev.ports || []).slice(0, 2);
      for (const port of ringPorts) {
        const key = `${dev.alias}:${port.subslot}`;
        const link = links.get(key);
        if (!link || !link.toDevice) {
          issues.push(`${dev.alias} port (subslot ${port.subslot}) has no connection`);
        }
      }
    }
    return issues;
  }

  const ringIssues = validateRing();
  const canDownload = saved && ringIssues.length === 0;

  if (!projectId) {
    return <div style={styles.notice}>Select a project first (Projects step).</div>;
  }

  if (!importId) {
    return <div style={styles.notice}>No HW import found. Upload a baseline CFG in the HW Config step first.</div>;
  }

  if (loading) {
    return <div style={styles.notice}>{loading}</div>;
  }

  return (
    <div style={styles.container}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h2 style={{ ...styles.heading, margin: 0, flex: 1 }}>MRP Ring Configuration</h2>
        <input
          ref={cfgImportRef}
          type="file"
          accept=".cfg"
          style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFromCfg(f); e.target.value = ""; }}
        />
        <button
          style={importing ? styles.btnDisabled : styles.btnSecondary}
          disabled={importing}
          onClick={() => { cfgImportRef.current.value = ""; cfgImportRef.current.click(); }}
          title="Import MRP roles and port links from a configured CFG file"
        >
          {importing ? "Importing…" : "Import from CFG"}
        </button>
      </div>

      {/* Screen tabs */}
      <div style={styles.tabs}>
        {["1. Domain & Fieldbus", "2. Device Roles", "3. Port Connections"].map((label, idx) => (
          <button
            key={idx}
            style={{ ...styles.tab, ...(screen === idx + 1 ? styles.tabActive : {}) }}
            onClick={() => setScreen(idx + 1)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* ── Screen 1: Domain & Fieldbus ──────────────────────────────── */}
      {screen === 1 && (
        <div style={styles.section}>
          <label style={styles.label}>MRP Domain Name</label>
          <input
            style={styles.input}
            value={domainName}
            onChange={e => { setDomainName(e.target.value); setSaved(false); }}
            placeholder="mrpdomain-1"
          />

          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6, marginTop: 16 }}>Fieldbus</label>
          <select
            style={styles.input}
            value={fieldbusNo ?? ""}
            onChange={e => { setFieldbusNo(parseInt(e.target.value, 10)); setSaved(false); }}
          >
            <option value="">— select fieldbus —</option>
            {fieldbuses.map(fb => (
              <option key={fb.id} value={fb.INT_DP_Subsystem}>
                {fb.T50_Fieldbus_Name
                  ? `${fb.T50_Fieldbus_Name} (IOSUBSYSTEM ${fb.INT_DP_Subsystem})`
                  : `IOSUBSYSTEM ${fb.INT_DP_Subsystem}`}
              </option>
            ))}
          </select>

          <div style={{ marginTop: 24 }}>
            <p style={styles.hint}>
              The domain name and fieldbus you select here will be used for all devices
              in the ring. Click <b>Device Roles</b> to continue.
            </p>
          </div>

          <div style={styles.row}>
            <button style={styles.btnPrimary} onClick={() => setScreen(2)}>
              Next: Device Roles →
            </button>
          </div>
        </div>
      )}

      {/* ── Screen 2: Device Roles ───────────────────────────────────── */}
      {screen === 2 && (
        <div style={styles.section}>
          <p style={styles.hint}>
            Assign an MRP role to each device. Devices with more than 2 ports (e.g. SCALANCE switches)
            are shown as one row per port pair — each row is one MRP instance. Ring port 1 and Ring port 2
            show the physical port assignments.
          </p>

          {filteredDevices.length === 0 && (
            <div style={styles.notice}>No devices found. Check that the baseline CFG has IOSUBSYSTEM devices.</div>
          )}

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Station / Device</th>
                <th style={styles.th}>MRP inst.</th>
                <th style={styles.th}>MRP Domain</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}>Ring port 1</th>
                <th style={styles.th}>Ring port 2</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.flatMap(dev => {
                const currentRole = roles.get(dev.alias)?.role ?? 0;
                const ports = dev.ports || [];
                // Split ports into pairs of 2; each pair = one row (one MRP instance)
                const pairs = [];
                for (let i = 0; i < Math.max(ports.length, 1); i += 2) {
                  pairs.push(ports.slice(i, i + 2));
                }

                return pairs.map((pair, pairIdx) => (
                  <tr
                    key={`${dev.alias}-${pairIdx}`}
                    style={currentRole !== 0 ? styles.rowActive : {}}
                  >
                    {/* Station/Device — only on first row for this device */}
                    {pairIdx === 0 ? (
                      <td style={styles.td} rowSpan={pairs.length}>
                        <b>{dev.alias}</b>
                        <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: 6 }}>
                          {dev.ioAddress != null ? `(${dev.ioAddress})` : `rack ${dev.rackSlot}`}
                          {dev.isSwitch ? " SW" : ""}
                        </span>
                      </td>
                    ) : null}

                    {/* MRP inst — 1-based pair index */}
                    <td style={{ ...styles.td, color: "#6b7280", fontSize: 13 }}>{pairIdx + 1}</td>

                    {/* MRP Domain — show domain name when role is active */}
                    <td style={{ ...styles.td, fontSize: 13 }}>
                      {currentRole !== 0 ? domainName : <span style={{ color: "#d1d5db" }}>—</span>}
                    </td>

                    {/* Role — only on first row; subsequent rows are "Not a node in the ring" */}
                    {pairIdx === 0 ? (
                      <td style={styles.td} rowSpan={pairs.length}>
                        <select
                          style={styles.select}
                          value={currentRole}
                          onChange={e => setRole(dev.alias, parseInt(e.target.value, 10))}
                        >
                          {ROLES.map(r => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      </td>
                    ) : null}

                    {/* Ring port 1 */}
                    <td style={{ ...styles.td, fontSize: 13 }}>
                      {pair[0]
                        ? <span>{pair[0].label || `Port ${pair[0].subslot}`}</span>
                        : <span style={{ color: "#d1d5db" }}>—</span>}
                    </td>

                    {/* Ring port 2 */}
                    <td style={{ ...styles.td, fontSize: 13 }}>
                      {pair[1]
                        ? <span>{pair[1].label || `Port ${pair[1].subslot}`}</span>
                        : <span style={{ color: "#d1d5db" }}>—</span>}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>

          <div style={styles.row}>
            <button style={styles.btnSecondary} onClick={() => setScreen(1)}>← Back</button>
            <button style={styles.btnPrimary} onClick={() => setScreen(3)}>Next: Port Connections →</button>
          </div>
        </div>
      )}

      {/* ── Screen 3: Port Connections ───────────────────────────────── */}
      {screen === 3 && (
        <Screen3PortConnections
          ringDevices={ringDevices}
          links={links}
          allPortDevices={allPortDevices}
          roles={roles}
          ringIssues={ringIssues}
          saving={saving}
          saved={saved}
          canDownload={canDownload}
          downloading={downloading}
          setLink={setLink}
          handleSave={handleSave}
          handleDownload={handleDownload}
          onBack={() => setScreen(2)}
          onNext={() => setScreen(4)}
        />
      )}

    </div>
  );
}

const styles = {
  container: {
    padding: "24px",
    maxWidth: 900,
    fontFamily: "inherit",
  },
  heading: {
    margin: "0 0 20px 0",
    fontSize: 20,
    fontWeight: 600,
  },
  tabs: {
    display: "flex",
    gap: 4,
    marginBottom: 20,
    borderBottom: "2px solid #e2e8f0",
  },
  tab: {
    padding: "8px 20px",
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 14,
    color: "#64748b",
    borderBottom: "2px solid transparent",
    marginBottom: -2,
  },
  tabActive: {
    color: "#2563eb",
    borderBottomColor: "#2563eb",
    fontWeight: 600,
  },
  section: {
    background: "#fff",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    padding: 24,
  },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    display: "block",
    width: "100%",
    padding: "8px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 14,
    boxSizing: "border-box",
    maxWidth: 400,
  },
  hint: {
    fontSize: 13,
    color: "#6b7280",
    marginBottom: 16,
  },
  notice: {
    padding: 20,
    color: "#6b7280",
    fontStyle: "italic",
  },
  error: {
    background: "#fef2f2",
    border: "1px solid #fca5a5",
    color: "#dc2626",
    padding: "10px 14px",
    borderRadius: 6,
    marginBottom: 16,
    fontSize: 14,
  },
  warn: {
    background: "#fffbeb",
    border: "1px solid #fcd34d",
    color: "#92400e",
    padding: "10px 14px",
    borderRadius: 6,
    marginTop: 16,
    fontSize: 13,
  },
  successMsg: {
    marginTop: 12,
    color: "#15803d",
    fontSize: 13,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 14,
    marginBottom: 20,
  },
  th: {
    textAlign: "left",
    padding: "8px 12px",
    borderBottom: "2px solid #e2e8f0",
    color: "#374151",
    fontWeight: 600,
    fontSize: 13,
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid #f1f5f9",
  },
  rowActive: {
    background: "#eff6ff",
  },
  select: {
    padding: "6px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 5,
    fontSize: 13,
    minWidth: 200,
  },
  selectSm: {
    padding: "4px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 5,
    fontSize: 13,
    minWidth: 120,
  },
  devCard: {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    marginBottom: 16,
    overflow: "hidden",
  },
  devHeader: {
    background: "#f8fafc",
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    borderBottom: "1px solid #e2e8f0",
    fontSize: 14,
  },
  badge: {
    background: "#dbeafe",
    color: "#1d4ed8",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 500,
  },
  portRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderBottom: "1px solid #f1f5f9",
    fontSize: 13,
    flexWrap: "wrap",
  },
  portLabel: {
    minWidth: 180,
    color: "#374151",
    fontWeight: 500,
  },
  arrow: {
    color: "#9ca3af",
    fontSize: 12,
  },
  row: {
    display: "flex",
    gap: 12,
    marginTop: 20,
    alignItems: "center",
  },
  btnPrimary: {
    padding: "9px 20px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    cursor: "pointer",
    fontWeight: 500,
  },
  btnSecondary: {
    padding: "9px 20px",
    background: "#f1f5f9",
    color: "#374151",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 14,
    cursor: "pointer",
  },
  btnSuccess: {
    padding: "9px 20px",
    background: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    cursor: "pointer",
    fontWeight: 500,
  },
  btnDisabled: {
    padding: "9px 20px",
    background: "#e5e7eb",
    color: "#9ca3af",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    cursor: "not-allowed",
  },
};
