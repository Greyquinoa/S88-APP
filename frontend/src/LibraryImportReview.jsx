import React, { useState, useMemo } from "react";

const STATUS_CONFIG = {
  NEW: { color: "#DCFCE7", textColor: "#166534", label: "New", sortOrder: 1 },
  UPDATED: { color: "#DBEAFE", textColor: "#1D4ED8", label: "Updated", sortOrder: 2 },
  UNCHANGED: { color: "#F3F4F6", textColor: "#6B7280", label: "Unchanged", sortOrder: 3 },
  REMOVED_FROM_FILE: { color: "#FEF3C7", textColor: "#92400E", label: "Removed from file", sortOrder: 4 },
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
      display: "flex", flexDirection: "column", gap: 6,
      padding: "12px 16px", borderRadius: "var(--border-radius-lg)",
      border: `1px solid ${config.color}`, background: config.color,
      minWidth: 120
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: config.textColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {config.label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: config.textColor }}>
        {count}
      </div>
    </div>
  );
}

function ExpandableBlockChanges({ blockChanges }) {
  const [expanded, setExpanded] = useState(false);

  if (!blockChanges || blockChanges.length === 0) {
    return <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>No changes</span>;
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          background: "transparent", border: "none", cursor: "pointer",
          fontSize: 11, color: "#2563EB", padding: 0, fontWeight: 500
        }}>
        <i className={`ti ti-chevron-${expanded ? "down" : "right"}`} style={{ fontSize: 12 }} />
        {blockChanges.length} change{blockChanges.length !== 1 ? "s" : ""}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "1px solid var(--color-border-secondary)" }}>
          {blockChanges.map((change, idx) => {
            if (change.type === 'BLOCK_ADDED') {
              return (
                <div key={idx} style={{ fontSize: 11, color: "#16A34A", marginBottom: 4 }}>
                  ✓ <strong>{change.blockName}</strong> added ({change.varCount} vars)
                </div>
              );
            }
            if (change.type === 'BLOCK_REMOVED') {
              return (
                <div key={idx} style={{ fontSize: 11, color: "#DC2626", marginBottom: 4 }}>
                  ✗ <strong>{change.blockName}</strong> removed (kept in DB for safety)
                </div>
              );
            }
            if (change.type === 'VARS_CHANGED') {
              return (
                <div key={idx} style={{ fontSize: 11, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 2 }}>
                    📝 {change.blockName}
                  </div>
                  {change.details && change.details.map((varDiff, vIdx) => (
                    <div key={vIdx} style={{ fontSize: 10, marginLeft: 12, marginBottom: 2, color: "var(--color-text-secondary)" }}>
                      {varDiff.name}
                      {varDiff.change === 'ADDED' && <span style={{ color: "#16A34A" }}> [ADDED]</span>}
                      {varDiff.change === 'REMOVED' && <span style={{ color: "#DC2626" }}> [REMOVED]</span>}
                      {varDiff.change === 'CHANGED' && (
                        <span style={{ color: "#F59E0B" }}>
                          {" "}[CHANGED: {varDiff.oldVal.val} → {varDiff.newVal.val}]
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

function LibraryImportReview({ diffResult, onImport, onCancel }) {
  const [selected, setSelected] = useState(new Set());
  const [statusFilter, setStatusFilter] = useState("all");

  const summary = diffResult?.summary || {};
  const items = diffResult?.items || [];

  // Pre-select all non-UNCHANGED types by default
  React.useEffect(() => {
    const preselected = new Set(
      items
        .filter(item => item.status !== 'UNCHANGED')
        .map(item => item.name)
    );
    setSelected(preselected);
  }, [items]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return items;
    return items.filter(item => item.status === statusFilter);
  }, [items, statusFilter]);

  const selectedCount = filtered.filter(item => selected.has(item.name)).length;

  const toggleItem = (name) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(filtered.map(item => item.name)));
  };

  const deselectAll = () => {
    const toDeselect = new Set(filtered.map(item => item.name));
    setSelected(prev => {
      const next = new Set(prev);
      toDeselect.forEach(name => next.delete(name));
      return next;
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center"
    }}>
      <div style={{
        background: "var(--color-background-primary)", borderRadius: "var(--border-radius-lg)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)", width: "90vw", maxWidth: 900, maxHeight: "85vh",
        display: "flex", flexDirection: "column", overflow: "hidden"
      }}>

        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
            Review Library Import
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 12 }}>
            {selectedCount} of {filtered.length} selected — only checked items will be imported.
          </div>

          {/* Summary cards */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <SummaryCard status="NEW" count={summary.new || 0} />
            <SummaryCard status="UPDATED" count={summary.updated || 0} />
            <SummaryCard status="UNCHANGED" count={summary.unchanged || 0} />
            <SummaryCard status="REMOVED_FROM_FILE" count={summary.removed || 0} />
          </div>

          {/* Status filter tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            {['all', 'NEW', 'UPDATED', 'UNCHANGED', 'REMOVED_FROM_FILE'].map(status => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: statusFilter === status ? 600 : 400,
                  border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)",
                  background: statusFilter === status ? "var(--color-background-secondary)" : "transparent",
                  color: "var(--color-text-primary)", cursor: "pointer"
                }}>
                {status === 'all' ? 'All' : STATUS_CONFIG[status]?.label}
              </button>
            ))}
          </div>

          {/* Bulk actions */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={selectAll}
              style={{
                fontSize: 12, border: "0.5px solid var(--color-border-secondary)",
                borderRadius: "var(--border-radius-md)", padding: "3px 10px",
                cursor: "pointer", background: "transparent", color: "var(--color-text-primary)"
              }}>
              Select all in view
            </button>
            <button
              onClick={deselectAll}
              style={{
                fontSize: 12, border: "0.5px solid var(--color-border-secondary)",
                borderRadius: "var(--border-radius-md)", padding: "3px 10px",
                cursor: "pointer", background: "transparent", color: "var(--color-text-primary)"
              }}>
              Deselect all
            </button>
          </div>
        </div>

        {/* Type list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
              No types match the selected filter.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>
              {filtered.map(item => (
                <label
                  key={item.name}
                  style={{
                    display: "grid", gridTemplateColumns: "24px 1fr auto auto auto",
                    gap: 12, alignItems: "start", padding: "10px 16px",
                    borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer",
                    background: selected.has(item.name) ? "var(--color-background-secondary)" : "transparent"
                  }}>

                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selected.has(item.name)}
                    onChange={() => toggleItem(item.name)}
                    style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, cursor: "pointer" }}
                  />

                  {/* Name + Status */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
                      color: "var(--color-text-primary)", marginBottom: 4
                    }}>
                      {item.name}
                    </div>
                    <StatusBadge status={item.status} />
                  </div>

                  {/* Block/var counts */}
                  {item.newType && (
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap", textAlign: "right" }}>
                      <div>{item.newType.subBlocks?.length || 0} blocks</div>
                      <div>
                        {item.newType.subBlocks?.reduce((sum, b) => sum + (b.vars?.length || 0), 0) || 0} vars
                      </div>
                    </div>
                  )}

                  {/* Block changes */}
                  <div style={{ fontSize: 11, minWidth: 200, whiteSpace: "nowrap" }}>
                    <ExpandableBlockChanges blockChanges={item.blockChanges} />
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 16px", borderTop: "0.5px solid var(--color-border-tertiary)",
          display: "flex", justifyContent: "flex-end", gap: 8
        }}>
          <button
            onClick={onCancel}
            style={{
              fontSize: 13, padding: "6px 16px", border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-md)", background: "transparent",
              color: "var(--color-text-primary)", cursor: "pointer", fontWeight: 500
            }}>
            Cancel
          </button>
          <button
            onClick={() => onImport(selected)}
            disabled={selectedCount === 0}
            style={{
              fontSize: 13, padding: "6px 16px", border: "none",
              borderRadius: "var(--border-radius-md)", background: "var(--color-text-primary)",
              color: "#fff", cursor: selectedCount === 0 ? "not-allowed" : "pointer",
              fontWeight: 500, opacity: selectedCount === 0 ? 0.5 : 1
            }}>
            Import selected ({selectedCount})
          </button>
        </div>
      </div>
    </div>
  );
}

export default LibraryImportReview;
