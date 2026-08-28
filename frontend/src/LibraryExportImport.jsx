import React, { useState, useMemo, useRef } from "react";
import { downloadLibraryExport, previewLibraryImport, commitLibraryImport } from "./api.js";

const STATUS_CONFIG = {
  NEW: { color: "#DCFCE7", textColor: "#166534", label: "New" },
  UPDATED: { color: "#DBEAFE", textColor: "#1D4ED8", label: "Updated" },
  UNCHANGED: { color: "#F3F4F6", textColor: "#6B7280", label: "Unchanged" },
  REMOVED_FROM_FILE: { color: "#FEF3C7", textColor: "#92400E", label: "Removed from file" },
};

function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] || {};
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: "var(--border-radius-md)",
      background: config.color, color: config.textColor,
      fontSize: 11, fontWeight: 600, whiteSpace: "nowrap"
    }}>
      {config.label}
    </span>
  );
}

function SummaryCard({ status, count }) {
  const config = STATUS_CONFIG[status] || {};
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "8px 12px", borderRadius: "var(--border-radius-lg)",
      border: `1px solid ${config.color}`, background: config.color, minWidth: 90
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: config.textColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {config.label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: config.textColor }}>
        {count}
      </div>
    </div>
  );
}

function ChangeDetailModal({ item, kind, onClose }) {
  const changes = kind === 'cm' ? item.blockChanges : item.changes;
  if (!changes || changes.length === 0) return null;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0, 0, 0, 0.6)", display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: "20px"
    }} onClick={onClose}>
      <div style={{
        background: "#fff", borderRadius: "var(--border-radius-lg)",
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        width: "100%", maxWidth: 700, maxHeight: "85vh",
        overflowY: "auto", padding: 0, display: "flex", flexDirection: "column"
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "20px 24px", borderBottom: "1px solid var(--color-border-tertiary)",
          flexShrink: 0
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{item.name}</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
              {kind === 'cm' ? 'CM / EM / EPH Type' : 'Composite CM Type'} • {changes.length} change{changes.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "transparent", border: "none", cursor: "pointer",
            fontSize: 24, color: "var(--color-text-secondary)", width: 32, height: 32,
            display: "flex", alignItems: "center", justifyContent: "center"
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: "24px", overflow: "auto", flex: 1 }}>
          {changes.map((change, idx) => {
            if (kind === 'cm') {
              if (change.type === 'BLOCK_ADDED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 18 }}>✓</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#16A34A" }}>Block added</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginLeft: 28 }}>{change.blockName}</div>
                    <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginLeft: 28, marginTop: 4 }}>
                      {change.varCount} variable{change.varCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                );
              }
              if (change.type === 'BLOCK_REMOVED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 18 }}>✗</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#DC2626" }}>Block removed</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginLeft: 28 }}>{change.blockName}</div>
                  </div>
                );
              }
              if (change.type === 'BLOCK_FLAGS_CHANGED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 18 }}>⚙</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>Block flags changed</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginLeft: 28, marginBottom: 12 }}>{change.blockName}</div>
                    <div style={{ marginLeft: 28 }}>
                      {change.oldVal.optional !== change.newVal.optional && (
                        <div style={{ fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 600, minWidth: 100 }}>Optional:</span>
                          <span style={{ color: "#DC2626", fontWeight: 600 }}>{String(change.oldVal.optional)}</span>
                          <span style={{ color: "var(--color-text-secondary)" }}>→</span>
                          <span style={{ color: "#16A34A", fontWeight: 600 }}>{String(change.newVal.optional)}</span>
                        </div>
                      )}
                      {change.oldVal.isConditional !== change.newVal.isConditional && (
                        <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 600, minWidth: 100 }}>Conditional:</span>
                          <span style={{ color: "#DC2626", fontWeight: 600 }}>{String(change.oldVal.isConditional)}</span>
                          <span style={{ color: "var(--color-text-secondary)" }}>→</span>
                          <span style={{ color: "#16A34A", fontWeight: 600 }}>{String(change.newVal.isConditional)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              if (change.type === 'ENABLED_BLOCKS_CHANGED') {
                const unchanged = change.unchanged || [];
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <div style={{ fontSize: 18 }}>🔘</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#2563EB" }}>Enabled blocks</div>
                    </div>
                    <div style={{ marginLeft: 28 }}>
                      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, padding: "12px", background: "#EFF6FF", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid #2563EB" }}>
                        <strong>Currently:</strong> {change.oldCount} blocks<br />
                        <strong>After import:</strong> {change.newCount} blocks
                      </div>

                      {/* Summary of changes */}
                      <div style={{ fontSize: 12, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        {change.added.length > 0 && (
                          <div style={{ padding: "8px", background: "#F0FDF4", borderRadius: "var(--border-radius-md)", textAlign: "center" }}>
                            <div style={{ fontWeight: 700, color: "#16A34A" }}>+{change.added.length}</div>
                            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>to enable</div>
                          </div>
                        )}
                        {change.removed.length > 0 && (
                          <div style={{ padding: "8px", background: "#FEF2F2", borderRadius: "var(--border-radius-md)", textAlign: "center" }}>
                            <div style={{ fontWeight: 700, color: "#DC2626" }}>−{change.removed.length}</div>
                            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>to disable</div>
                          </div>
                        )}
                      </div>

                      {change.added.length > 0 && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#16A34A", marginBottom: 8 }}>✓ Will be enabled:</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
                            {change.added.map((block, i) => (
                              <div key={i} style={{
                                background: "#F0FDF4", border: "1px solid #BBEF63",
                                borderRadius: "var(--border-radius-md)", padding: "8px 12px",
                                fontSize: 12, fontWeight: 500, color: "#16A34A"
                              }}>
                                ✓ {block}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {change.removed.length > 0 && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#DC2626", marginBottom: 8 }}>✗ Will be disabled:</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
                            {change.removed.map((block, i) => (
                              <div key={i} style={{
                                background: "#FEF2F2", border: "1px solid #FECACA",
                                borderRadius: "var(--border-radius-md)", padding: "8px 12px",
                                fontSize: 12, fontWeight: 500, color: "#DC2626"
                              }}>
                                ✗ {block}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {unchanged.length > 0 && (
                        <details>
                          <summary style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 8, cursor: "pointer" }}>
                            — Will remain enabled ({unchanged.length})
                          </summary>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginTop: 8 }}>
                            {unchanged.map((block, i) => (
                              <div key={i} style={{
                                background: "#F9FAFB", border: "1px solid var(--color-border-secondary)",
                                borderRadius: "var(--border-radius-md)", padding: "8px 12px",
                                fontSize: 12, fontWeight: 500, color: "#6B7280"
                              }}>
                                {block}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                );
              }
              if (change.type === 'VARS_CHANGED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <div style={{ fontSize: 18 }}>📝</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>Variables changed</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginLeft: 28, marginBottom: 12 }}>{change.blockName}</div>
                    <div style={{ marginLeft: 28 }}>
                      {change.details?.map((v, i) => (
                        <div key={i} style={{ marginBottom: 14, padding: "12px", background: "#F9FAFB", borderRadius: "var(--border-radius-md)" }}>
                          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>{v.name}</div>
                          {v.change === 'ADDED' && <div style={{ color: "#16A34A", fontSize: 12 }}>✓ Added</div>}
                          {v.change === 'REMOVED' && <div style={{ color: "#DC2626", fontSize: 12 }}>✗ Removed</div>}
                          {v.change === 'CHANGED' && (
                            <div style={{ fontSize: 12, display: "grid", gap: 4 }}>
                              {v.oldVal.val !== v.newVal.val && (
                                <div>
                                  <span style={{ fontWeight: 600 }}>Value:</span> <span style={{ color: "#DC2626" }}>{v.oldVal.val}</span> → <span style={{ color: "#16A34A" }}>{v.newVal.val}</span>
                                </div>
                              )}
                              {v.oldVal.isValid !== v.newVal.isValid && (
                                <div>
                                  <span style={{ fontWeight: 600 }}>Valid:</span> <span style={{ color: "#DC2626" }}>{String(v.oldVal.isValid)}</span> → <span style={{ color: "#16A34A" }}>{String(v.newVal.isValid)}</span>
                                </div>
                              )}
                              {v.oldVal.dtype !== v.newVal.dtype && (
                                <div>
                                  <span style={{ fontWeight: 600 }}>Type:</span> <span style={{ color: "#DC2626" }}>{v.oldVal.dtype}</span> → <span style={{ color: "#16A34A" }}>{v.newVal.dtype}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
            } else {
              // Composite changes
              if (change.type === 'FIELD_CHANGED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B", marginBottom: 8 }}>{change.field}</div>
                    <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                      <span style={{ color: "#DC2626", fontWeight: 600 }}>{String(change.oldVal)}</span>
                      <span style={{ color: "var(--color-text-secondary)" }}> → </span>
                      <span style={{ color: "#16A34A", fontWeight: 600 }}>{String(change.newVal)}</span>
                    </div>
                  </div>
                );
              }
              if (change.type === 'MEMBERS_CHANGED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>{change.detail}</div>
                  </div>
                );
              }
              if (change.type === 'MATRIX_MODES_CHANGED') {
                const cols = change.columns || [];
                const cellVal = v => (v === null || v === undefined || v === '') ? '—' : String(v);
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <div style={{ fontSize: 18 }}>🔢</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>Matrix modes</div>
                    </div>
                    <div style={{ marginLeft: 28 }}>
                      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, padding: "12px", background: "#FFFBEB", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid #F59E0B" }}>
                        <strong>Currently:</strong> {change.oldCount} mode{change.oldCount !== 1 ? 's' : ''}<br />
                        <strong>After import:</strong> {change.newCount} mode{change.newCount !== 1 ? 's' : ''}
                      </div>

                      {change.changed.length > 0 && (
                        <div style={{ marginBottom: 14, overflowX: "auto" }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#F59E0B", marginBottom: 8 }}>Modified modes:</div>
                          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: "left", padding: "6px 10px", borderBottom: "2px solid var(--color-border-secondary)", fontWeight: 700 }}>Mode</th>
                                {cols.map(col => (
                                  <th key={col} style={{ textAlign: "left", padding: "6px 10px", borderBottom: "2px solid var(--color-border-secondary)", fontWeight: 700 }}>{col}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {change.changed.map((m, i) => {
                                const cellMap = Object.fromEntries(m.cellDiffs.map(cd => [cd.column, cd]));
                                return (
                                  <tr key={i} style={{ borderBottom: "1px solid var(--color-border-tertiary)" }}>
                                    <td style={{ padding: "8px 10px", fontWeight: 600, verticalAlign: "top" }}>
                                      #{m.modeNr}
                                      {m.nameChanged ? (
                                        <div style={{ fontSize: 11, marginTop: 2 }}>
                                          <span style={{ color: "#DC2626", textDecoration: "line-through" }}>{m.oldName || '(unnamed)'}</span>
                                          {" → "}
                                          <span style={{ color: "#16A34A" }}>{m.newName || '(unnamed)'}</span>
                                        </div>
                                      ) : (m.newName && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{m.newName}</div>)}
                                    </td>
                                    {cols.map(col => {
                                      const cd = cellMap[col];
                                      return (
                                        <td key={col} style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                          {cd ? (
                                            <div>
                                              <span style={{ color: "#DC2626", textDecoration: "line-through" }}>{cellVal(cd.oldVal)}</span>
                                              {" "}
                                              <span style={{ color: "#16A34A", fontWeight: 600 }}>{cellVal(cd.newVal)}</span>
                                            </div>
                                          ) : (
                                            <span style={{ color: "var(--color-text-secondary)" }}>—</span>
                                          )}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {change.added?.length > 0 && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#16A34A", marginBottom: 8 }}>+ Modes to add ({change.added.length}):</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {change.added.map((m, i) => (
                              <div key={i} style={{ background: "#F0FDF4", border: "1px solid #BBEF63", borderRadius: "var(--border-radius-md)", padding: "8px 12px", fontSize: 12, color: "#166534" }}>
                                #{m.mode_nr}{m.mode_name ? ` — ${m.mode_name}` : ''}: {cols.map(c => `${c}=${cellVal(m.cells[c])}`).join(', ')}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {change.removed?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#DC2626", marginBottom: 8 }}>− Modes to remove ({change.removed.length}):</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {change.removed.map((m, i) => (
                              <div key={i} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "var(--border-radius-md)", padding: "8px 12px", fontSize: 12, color: "#991B1B" }}>
                                #{m.mode_nr}{m.mode_name ? ` — ${m.mode_name}` : ''}: {cols.map(c => `${c}=${cellVal(m.cells[c])}`).join(', ')}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              if (change.type === 'MEMBER_CHANGED') {
                const FIELD_LABELS = {
                  cm_type_name: 'CM Type', hierarchy_folder: 'Folder', name_prefix: 'Prefix',
                  name_suffix: 'Suffix', is_primary: 'Primary', scope: 'Scope', roles: 'Roles',
                };
                const fieldDiffs = [];
                for (const key of ['cm_type_name', 'hierarchy_folder', 'name_prefix', 'name_suffix', 'is_primary', 'scope', 'roles']) {
                  let ov = change.oldVal[key], nv = change.newVal[key];
                  if (key === 'is_primary') { ov = !!ov; nv = !!nv; }
                  if (key === 'scope') { ov = ov || 'unit'; nv = nv || 'unit'; }
                  if (key === 'roles') { ov = JSON.stringify(ov || {}); nv = JSON.stringify(nv || {}); }
                  if (ov !== nv) fieldDiffs.push({ key, oldVal: ov, newVal: nv });
                }
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 18 }}>👤</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>Member changed</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginLeft: 28, marginBottom: 10 }}>
                      #{change.index + 1} — {change.newVal.cm_type_name}
                    </div>
                    <div style={{ marginLeft: 28, display: "grid", gap: 8 }}>
                      {fieldDiffs.map((f, i) => (
                        <div key={i} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 600, minWidth: 90 }}>{FIELD_LABELS[f.key] || f.key}:</span>
                          <span style={{ color: "#DC2626", fontWeight: 600 }}>{f.oldVal === '' ? '(empty)' : String(f.oldVal)}</span>
                          <span style={{ color: "var(--color-text-secondary)" }}>→</span>
                          <span style={{ color: "#16A34A", fontWeight: 600 }}>{f.newVal === '' ? '(empty)' : String(f.newVal)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              if (change.type === 'CONNECTIONS_CHANGED') {
                const connLabel = c => {
                  const typeTag = c.conn_type && c.conn_type !== 'interconnection' ? ` [${c.conn_type}]` : '';
                  return `${c.fromLabel} → ${c.toLabel}${typeTag}`;
                };
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <div style={{ fontSize: 18 }}>🔗</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#2563EB" }}>Connections</div>
                    </div>
                    <div style={{ marginLeft: 28 }}>
                      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, padding: "12px", background: "#EFF6FF", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid #2563EB" }}>
                        <strong>Currently:</strong> {change.oldCount} connection{change.oldCount !== 1 ? 's' : ''}<br />
                        <strong>After import:</strong> {change.newCount} connection{change.newCount !== 1 ? 's' : ''}
                      </div>
                      {change.added.length > 0 && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#16A34A", marginBottom: 8 }}>+ Will be added ({change.added.length}):</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {change.added.map((c, i) => (
                              <div key={i} style={{
                                background: "#F0FDF4", border: "1px solid #BBEF63",
                                borderRadius: "var(--border-radius-md)", padding: "10px 12px",
                                fontSize: 12, fontWeight: 500, color: "#166534", fontFamily: "monospace"
                              }}>
                                {connLabel(c)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {change.removed.length > 0 && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#DC2626", marginBottom: 8 }}>− Will be removed ({change.removed.length}):</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {change.removed.map((c, i) => (
                              <div key={i} style={{
                                background: "#FEF2F2", border: "1px solid #FECACA",
                                borderRadius: "var(--border-radius-md)", padding: "10px 12px",
                                fontSize: 12, fontWeight: 500, color: "#991B1B", fontFamily: "monospace"
                              }}>
                                {connLabel(c)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              if (change.type === 'MATRIX_COLUMNS_CHANGED') {
                return (
                  <div key={idx} style={{ marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid var(--color-border-secondary)" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#F59E0B", marginBottom: 10 }}>Matrix columns</div>
                    <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 600 }}>Old:</span> <span style={{ fontFamily: "monospace" }}>[{change.oldVal.join(', ')}]</span>
                      </div>
                      <div>
                        <span style={{ fontWeight: 600 }}>New:</span> <span style={{ fontFamily: "monospace" }}>[{change.newVal.join(', ')}]</span>
                      </div>
                    </div>
                  </div>
                );
              }
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

function ItemRow({ item, kind, selected, onToggle }) {
  const [showDetails, setShowDetails] = useState(false);
  const changes = kind === 'cm' ? item.blockChanges : item.changes;
  const hasDetail = changes && changes.length > 0;

  return (
    <>
      <div style={{ borderBottom: "0.5px solid var(--color-border-tertiary)", padding: "10px 16px",
        background: selected ? "var(--color-background-secondary)" : "transparent" }}>
        <div style={{ display: "grid", gridTemplateColumns: "24px 1fr auto auto", gap: 12, alignItems: "center" }}>
          <input type="checkbox" checked={selected} onChange={onToggle}
            disabled={item.status === 'UNCHANGED' || item.status === 'REMOVED_FROM_FILE'}
            style={{ width: 16, height: 16, cursor: "pointer" }} />
          <div style={{ fontSize: 12, fontWeight: 500 }}>{item.name}</div>
          <StatusBadge status={item.status} />
          {hasDetail && (
            <button onClick={() => setShowDetails(true)}
              style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 11, color: "#2563EB", fontWeight: 500 }}>
              <i className="ti ti-details" style={{ fontSize: 12, marginRight: 4 }} />
              {changes.length} change{changes.length !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>
      {showDetails && <ChangeDetailModal item={item} kind={kind} onClose={() => setShowDetails(false)} />}
    </>
  );
}

function Section({ title, diff, kind, selected, setSelected }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const items = diff?.items || [];
  const summary = diff?.summary || {};

  const filtered = useMemo(() => statusFilter === 'all' ? items : items.filter(i => i.status === statusFilter), [items, statusFilter]);

  const toggle = (name) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectableInView = filtered.filter(i => i.status !== 'UNCHANGED' && i.status !== 'REMOVED_FROM_FILE');
  const selectAll = () => setSelected(prev => new Set([...prev, ...selectableInView.map(i => i.name)]));
  const deselectAll = () => setSelected(prev => {
    const next = new Set(prev);
    selectableInView.forEach(i => next.delete(i.name));
    return next;
  });

  if (!items.length) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <SummaryCard status="NEW" count={summary.new || 0} />
        <SummaryCard status="UPDATED" count={summary.updated || 0} />
        <SummaryCard status="UNCHANGED" count={summary.unchanged || 0} />
        <SummaryCard status="REMOVED_FROM_FILE" count={summary.removed || 0} />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        {['all', 'NEW', 'UPDATED', 'UNCHANGED', 'REMOVED_FROM_FILE'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding: "3px 9px", fontSize: 11, fontWeight: statusFilter === s ? 600 : 400,
              border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)",
              background: statusFilter === s ? "var(--color-background-secondary)" : "transparent", cursor: "pointer" }}>
            {s === 'all' ? 'All' : STATUS_CONFIG[s]?.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto" }} />
        <button onClick={selectAll} style={{ fontSize: 11, border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "3px 9px", cursor: "pointer", background: "transparent" }}>Select all in view</button>
        <button onClick={deselectAll} style={{ fontSize: 11, border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "3px 9px", cursor: "pointer", background: "transparent" }}>Deselect all</button>
      </div>
      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", maxHeight: 320, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12 }}>No items match this filter.</div>
        ) : (
          filtered.map(item => (
            <ItemRow key={item.name} item={item} kind={kind} selected={selected.has(item.name)} onToggle={() => toggle(item.name)} />
          ))
        )}
      </div>
    </div>
  );
}

function LibraryExportImportPanel({ onImported, projectId }) {
  const fileRef = useRef();
  const [preview, setPreview] = useState(null);   // { token, cmTypes, composites, meta }
  const [selectedCm, setSelectedCm] = useState(new Set());
  const [selectedComposites, setSelectedComposites] = useState(new Set());
  const [busy, setBusy] = useState(null);          // status text while busy
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);      // commit result stats

  const handleExport = async () => {
    setError(null);
    setBusy("Preparing export…");
    try {
      await downloadLibraryExport(projectId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (file) => {
    setError(null);
    setResult(null);
    setBusy("Parsing file…");
    try {
      const data = await previewLibraryImport(projectId, file);
      setPreview(data);
      // Pre-select all NEW/UPDATED items by default
      setSelectedCm(new Set((data.cmTypes?.items || []).filter(i => i.status === 'NEW' || i.status === 'UPDATED').map(i => i.name)));
      setSelectedComposites(new Set((data.composites?.items || []).filter(i => i.status === 'NEW' || i.status === 'UPDATED').map(i => i.name)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    if (!preview) return;
    setBusy("Importing…");
    setError(null);
    try {
      const stats = await commitLibraryImport(projectId, preview.token, [...selectedCm], [...selectedComposites]);
      setResult(stats);
      setPreview(null);
      // The import rewrote blocks and enabled-block prefs server-side. App.jsx caches
      // both per CM type (ensureBlocksLoaded only refetches when subBlocks is unset),
      // so without this the Type Configuration tab keeps showing pre-import state.
      await onImported?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const cancelPreview = () => {
    setPreview(null);
    setSelectedCm(new Set());
    setSelectedComposites(new Set());
  };

  const totalSelected = selectedCm.size + selectedComposites.size;

  return (
    <div>
      {/* Export section */}
      <div style={{ marginBottom: "2rem" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Export Library</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
          Downloads a single JSON file containing all CM/EM/EPH types, Composite CM types, and matrix modes.
        </div>
        <button onClick={handleExport} disabled={!!busy}
          style={{ fontSize: 13, padding: "7px 16px", border: "none", borderRadius: "var(--border-radius-md)",
            background: "var(--color-text-primary)", color: "#fff", cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 500, opacity: busy ? 0.6 : 1 }}>
          <i className="ti ti-download" style={{ marginRight: 6 }} />
          Export Library
        </button>
      </div>

      {/* Import section */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Import Library</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
          Upload a previously exported library file. You'll be able to review differences and choose exactly what to import.
        </div>

        {!preview && (
          <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
              padding: "2rem", textAlign: "center", cursor: "pointer" }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
            <i className="ti ti-file-upload" style={{ fontSize: 28, color: "var(--color-text-secondary)", display: "block", marginBottom: 10 }} />
            <div style={{ fontSize: 13, fontWeight: 600 }}>Drop library export (.json) here</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>or click to browse</div>
          </div>
        )}
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />

        {busy && (
          <div style={{ marginTop: 10, fontSize: 13, color: "var(--color-text-secondary)" }}>{busy}</div>
        )}
        {error && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "#FEE2E2", border: "1px solid #FCA5A5",
            borderRadius: "var(--border-radius-md)", color: "#991B1B", fontSize: 12 }}>
            {error}
          </div>
        )}
        {result && (
          <div style={{ marginTop: 10, padding: "10px 14px", background: "#DCFCE7", border: "1px solid #86EFAC",
            borderRadius: "var(--border-radius-md)", color: "#166534", fontSize: 12 }}>
            Import complete — CM types: {result.cmNew} new, {result.cmUpdated} updated, {result.cmSkipped} skipped.
            {" "}Composites: {result.compNew} new, {result.compUpdated} updated, {result.compSkipped} skipped.
          </div>
        )}

        {preview && (
          <div style={{ marginTop: 16 }}>
            {preview.meta && (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 12 }}>
                Source exported: {preview.meta.exportedAt ? new Date(preview.meta.exportedAt).toLocaleString() : 'unknown'}
                {preview.meta.sourceStats && ` — ${preview.meta.sourceStats.cmCount} CM types, ${preview.meta.sourceStats.compositeCount} composites`}
              </div>
            )}
            <Section title="CM / EM / EPH Types" diff={preview.cmTypes} kind="cm" selected={selectedCm} setSelected={setSelectedCm} />
            <Section title="Composite CM Types" diff={preview.composites} kind="composite" selected={selectedComposites} setSelected={setSelectedComposites} />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={cancelPreview} disabled={!!busy}
                style={{ fontSize: 13, padding: "6px 16px", border: "0.5px solid var(--color-border-secondary)",
                  borderRadius: "var(--border-radius-md)", background: "transparent", cursor: "pointer", fontWeight: 500 }}>
                Cancel
              </button>
              <button onClick={handleImport} disabled={totalSelected === 0 || !!busy}
                style={{ fontSize: 13, padding: "6px 16px", border: "none", borderRadius: "var(--border-radius-md)",
                  background: "var(--color-text-primary)", color: "#fff",
                  cursor: (totalSelected === 0 || busy) ? "not-allowed" : "pointer",
                  fontWeight: 500, opacity: (totalSelected === 0 || busy) ? 0.5 : 1 }}>
                Import selected ({totalSelected})
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default LibraryExportImportPanel;
