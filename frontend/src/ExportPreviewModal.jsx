import React, { useEffect, useState } from 'react';
import { getExportedBlocks } from './api';

export default function ExportPreviewModal({ projectId, instanceName, cmTypeName, onClose, onOpenParameters }) {
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [timestamp, setTimestamp] = useState('');

  useEffect(() => {
    loadExportedBlocks();
  }, [projectId, instanceName]);

  async function loadExportedBlocks() {
    setLoading(true);
    setError('');
    try {
      const result = await getExportedBlocks(projectId, instanceName);
      setBlocks(result.exported_blocks || []);
      setTimestamp(result.timestamp);
    } catch (err) {
      setError(`Failed to load exported blocks: ${err.message}`);
      setBlocks([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999
    }}>
      <div style={{
        background: "var(--color-background-primary)", borderRadius: "var(--border-radius-lg)",
        padding: 20, maxWidth: 600, maxHeight: "80vh", overflow: "auto",
        boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", border: "1px solid var(--color-border-secondary)"
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            Exported Blocks: <span style={{ color: "#0F766E", fontFamily: "var(--font-mono)" }}>{instanceName}</span>
          </h3>
          <button onClick={onClose}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: "var(--color-text-secondary)" }}>
            ✕
          </button>
        </div>

        {timestamp && (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
            Generated: {new Date(timestamp).toLocaleString()}
          </div>
        )}

        {loading && (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--color-text-secondary)" }}>
            Loading exported blocks…
          </div>
        )}

        {error && (
          <div style={{ padding: "12px", background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 6, color: "#991B1B", fontSize: 12, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {!loading && !error && (
          <div style={{ marginBottom: 16 }}>
            {blocks.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "12px 0" }}>
                No blocks exported for this instance.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {blocks.map((block, idx) => (
                  <div key={idx} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "10px",
                    background: "var(--color-background-secondary)", borderRadius: 6,
                    border: "0.5px solid var(--color-border-tertiary)"
                  }}>
                    <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 600, color: "#0F766E", flex: 1 }}>
                      {block.block_name}
                    </span>
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4,
                      background: block.status === 'real' ? "#DCFCE7" : "#FEE2E2",
                      color: block.status === 'real' ? "#166534" : "#991B1B", fontWeight: 500 }}>
                      {block.status}
                    </span>
                    {block.optional && (
                      <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4,
                        background: "#F3F4F6", color: "#6B7280" }}>
                        optional
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {!loading && !error && (
            <button onClick={loadExportedBlocks}
              style={{
                padding: "6px 12px", borderRadius: "var(--border-radius-md)",
                border: "1px solid var(--color-border-secondary)", background: "var(--color-background-secondary)",
                cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)"
              }}>
              Refresh
            </button>
          )}
          {onOpenParameters && (
            <button onClick={onOpenParameters}
              style={{
                padding: "6px 12px", borderRadius: "var(--border-radius-md)",
                border: "none", background: "var(--color-accent)", color: "white",
                cursor: "pointer", fontSize: 12, fontWeight: 600
              }}>
              Open Parameters
            </button>
          )}
          <button onClick={onClose}
            style={{
              padding: "6px 12px", borderRadius: "var(--border-radius-md)",
              border: "1px solid var(--color-border-secondary)", background: "var(--color-background-secondary)",
              cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)"
            }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
