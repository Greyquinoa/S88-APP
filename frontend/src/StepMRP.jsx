import React, { useState, useEffect, useCallback } from "react";
import { listHwImports, listHwControllers, listHwFieldbuses, mrpGetDevices, mrpGetConfig, mrpSaveConfig, mrpDownloadCfg } from "./api.js";
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
  const [downloading, setDownloading] = useState(false);

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
            rMap.set(r.device_alias, { role: r.mrp_role, mrpInstances: r.mrp_instances });
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
      <h2 style={styles.heading}>MRP Ring Configuration</h2>

      {/* Screen tabs */}
      <div style={styles.tabs}>
        {["1. Domain & Fieldbus", "2. Device Roles", "3. Port Connections", "4. Topology View"].map((label, idx) => (
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
        <div style={styles.section}>
          <p style={styles.hint}>
            For each ring port (instance 1 only — the first port pair), select which device and port it
            connects to. This defines the ring topology. Both ports must be connected.
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
                      Port {port.label || port.subslot} (subslot {port.subslot})
                    </span>
                    <span style={styles.arrow}>→ connects to</span>

                    {/* Target device */}
                    <select
                      style={styles.selectSm}
                      value={link.toDevice}
                      onChange={e => {
                        const newDev = allPortDevices.find(d => d.alias === e.target.value);
                        setLink(dev.alias, port.subslot, "toDevice", e.target.value);
                        if (newDev?.ports?.[0]) {
                          setLink(dev.alias, port.subslot, "toIfaceSubslot", newDev.ifaceSubslot ?? 1);
                          setLink(dev.alias, port.subslot, "toPortSubslot",  newDev.ports[0].subslot);
                        }
                      }}
                    >
                      <option value="">— device —</option>
                      {allPortDevices.filter(d => d.alias !== dev.alias).map(d => (
                        <option key={d.alias} value={d.alias}>{d.alias}</option>
                      ))}
                    </select>

                    {/* Target port */}
                    <select
                      style={styles.selectSm}
                      value={link.toPortSubslot}
                      onChange={e => {
                        setLink(dev.alias, port.subslot, "toPortSubslot", parseInt(e.target.value, 10));
                      }}
                      disabled={!link.toDevice}
                    >
                      {(toDevObj?.ports || []).map(p => (
                        <option key={p.subslot} value={p.subslot}>
                          Port {p.label || p.subslot} (ss {p.subslot})
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
            <button style={styles.btnSecondary} onClick={() => setScreen(2)}>← Back</button>

            <button
              style={saving ? styles.btnDisabled : styles.btnPrimary}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving…" : saved ? "✓ Saved" : "Save Configuration"}
            </button>

            <button
              style={(!canDownload || downloading) ? styles.btnDisabled : styles.btnSuccess}
              onClick={handleDownload}
              disabled={!canDownload || downloading}
              title={!saved ? "Save configuration first" : ringIssues.length > 0 ? "Fix ring issues first" : ""}
            >
              {downloading ? "Generating…" : "Generate CFG with MRP"}
            </button>
          </div>

          {saved && ringIssues.length === 0 && (
            <div style={styles.successMsg}>
              Configuration saved. Click <b>Generate CFG with MRP</b> to download the patched .cfg file.
            </div>
          )}
        </div>
      )}

      {/* ── Screen 4: Topology View ──────────────────────────────────── */}
      {screen === 4 && (
        <div style={styles.section}>
          <p style={styles.hint}>
            Interactive network topology. Click a node or link to highlight connections.
            Hover a link to see port details. Switch between Hierarchy and Ring layouts.
          </p>
          <MRPTopologyView
            devices={filteredDevices}
            links={links}
            roles={roles}
            domainName={domainName}
          />
          <div style={styles.row}>
            <button style={styles.btnSecondary} onClick={() => setScreen(3)}>← Back</button>
          </div>
        </div>
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
