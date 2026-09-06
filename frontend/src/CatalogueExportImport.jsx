import React, { useState, useMemo, useRef } from "react";
import { downloadCatalogueExport, previewCatalogueImport, commitCatalogueImport } from "./api.js";

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

function ItemRow({ item, kind, selected, onToggle }) {
  const getItemName = () => {
    if (kind === 'template') return item.display_name || item.order_no;
    if (kind === 'slotCompat') return `${item.slot_name || item.slot_order_no} → ${item.subslot_name || item.subslot_order_no}`;
    if (kind === 'signalType') return item.name;
    return 'Unknown';
  };

  return (
    <div style={{ borderBottom: "0.5px solid var(--color-border-tertiary)", padding: "10px 16px",
      background: selected ? "var(--color-background-secondary)" : "transparent" }}>
      <div style={{ display: "grid", gridTemplateColumns: "24px 1fr auto", gap: 12, alignItems: "center" }}>
        <input type="checkbox" checked={selected} onChange={onToggle}
          disabled={item.status === 'UNCHANGED' || item.status === 'REMOVED_FROM_FILE'}
          style={{ width: 16, height: 16, cursor: "pointer" }} />
        <div style={{ fontSize: 12, fontWeight: 500 }}>{getItemName()}</div>
        <StatusBadge status={item.status} />
      </div>
    </div>
  );
}

function Section({ title, diff, kind, selected, setSelected }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const items = diff?.items || [];
  const summary = diff?.summary || {};

  const filtered = useMemo(() => statusFilter === 'all' ? items : items.filter(i => i.status === statusFilter), [items, statusFilter]);

  const toggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectableInView = filtered.filter(i => i.status !== 'UNCHANGED' && i.status !== 'REMOVED_FROM_FILE');
  const selectAll = () => setSelected(prev => new Set([...prev, ...selectableInView.map(i => i.id)]));
  const deselectAll = () => setSelected(prev => {
    const next = new Set(prev);
    selectableInView.forEach(i => next.delete(i.id));
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
            <ItemRow key={item.id} item={item} kind={kind} selected={selected.has(item.id)} onToggle={() => toggle(item.id)} />
          ))
        )}
      </div>
    </div>
  );
}

function CatalogueExportImportPanel({ onImported }) {
  const fileRef = useRef();
  const [preview, setPreview] = useState(null);   // { token, templates, slotCompat, signalTypes, meta }
  const [selectedTemplates, setSelectedTemplates] = useState(new Set());
  const [selectedSlotCompat, setSelectedSlotCompat] = useState(new Set());
  const [selectedSignalTypes, setSelectedSignalTypes] = useState(new Set());
  const [busy, setBusy] = useState(null);          // status text while busy
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);      // commit result stats

  const handleExport = async () => {
    setError(null);
    setBusy("Preparing export…");
    try {
      await downloadCatalogueExport();
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
      const data = await previewCatalogueImport(file);
      setPreview(data);
      // Pre-select all NEW/UPDATED items by default
      setSelectedTemplates(new Set((data.templates?.items || []).filter(i => i.status === 'NEW' || i.status === 'UPDATED').map(i => i.id)));
      setSelectedSlotCompat(new Set((data.slotCompat?.items || []).filter(i => i.status === 'NEW' || i.status === 'UPDATED').map(i => i.id)));
      setSelectedSignalTypes(new Set((data.signalTypes?.items || []).filter(i => i.status === 'NEW' || i.status === 'UPDATED').map(i => i.id)));
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
      const stats = await commitCatalogueImport(preview.token, [...selectedTemplates], [...selectedSlotCompat], [...selectedSignalTypes]);
      setResult(stats);
      setPreview(null);
      await onImported?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const cancelPreview = () => {
    setPreview(null);
    setSelectedTemplates(new Set());
    setSelectedSlotCompat(new Set());
    setSelectedSignalTypes(new Set());
  };

  const totalSelected = selectedTemplates.size + selectedSlotCompat.size + selectedSignalTypes.size;

  return (
    <div>
      {/* Export section */}
      <div style={{ marginBottom: "2rem" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Export Catalogue</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
          Downloads a single JSON file containing all module templates, slot compatibility rules, signal types, and module parameters.
        </div>
        <button onClick={handleExport} disabled={!!busy}
          style={{ fontSize: 13, padding: "7px 16px", border: "none", borderRadius: "var(--border-radius-md)",
            background: "var(--color-text-primary)", color: "#fff", cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 500, opacity: busy ? 0.6 : 1 }}>
          <i className="ti ti-download" style={{ marginRight: 6 }} />
          Export Catalogue
        </button>
      </div>

      {/* Import section */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Import Catalogue</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
          Upload a previously exported catalogue file. You'll be able to review differences and choose exactly what to import.
        </div>

        {!preview && (
          <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)",
              padding: "2rem", textAlign: "center", cursor: "pointer" }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
            <i className="ti ti-file-upload" style={{ fontSize: 28, color: "var(--color-text-secondary)", display: "block", marginBottom: 10 }} />
            <div style={{ fontSize: 13, fontWeight: 600 }}>Drop catalogue export (.json) here</div>
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
            Import complete — Templates: {result.templatesNew} new, {result.templatesUpdated} updated, {result.templatesSkipped} skipped.
            {" "}Slot Compat: {result.slotCompatNew} new, {result.slotCompatSkipped} skipped.
            {" "}Signal Types: {result.signalTypesNew} new, {result.signalTypesSkipped} skipped.
          </div>
        )}

        {preview && (
          <div style={{ marginTop: 16 }}>
            {preview.meta && (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 12 }}>
                Source exported: {preview.meta.exportedAt ? new Date(preview.meta.exportedAt).toLocaleString() : 'unknown'}
                {preview.meta.sourceStats && ` — ${preview.meta.sourceStats.templateCount} templates, ${preview.meta.sourceStats.slotCompatCount} slot compat rules, ${preview.meta.sourceStats.signalTypeCount} signal types`}
              </div>
            )}
            <Section title="Module Templates" diff={preview.templates} kind="template" selected={selectedTemplates} setSelected={setSelectedTemplates} />
            <Section title="Slot Compatibility Rules" diff={preview.slotCompat} kind="slotCompat" selected={selectedSlotCompat} setSelected={setSelectedSlotCompat} />
            <Section title="Signal Types" diff={preview.signalTypes} kind="signalType" selected={selectedSignalTypes} setSelected={setSelectedSignalTypes} />

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

export default CatalogueExportImportPanel;
