import React, { useState } from "react";
import "./UnitTypeImportModal.css";

export default function UnitTypeImportModal({ isOpen, onClose, onImportSuccess, compositeCmTypes }) {
  const [unitName, setUnitName] = useState("");
  const [description, setDescription] = useState("");
  const [xmlFile, setXmlFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [preview, setPreview] = useState(null);  // { cmInstances, stats, etc }
  const [step, setStep] = useState("upload");  // "upload" | "preview" | "confirm"

  // Reset state when modal opens (ensures fresh form on each open)
  React.useEffect(() => {
    if (isOpen && result) {
      // If modal was previously showing a success screen, clear it when reopening
      setResult(null);
      setUnitName("");
      setDescription("");
      setXmlFile(null);
      setPreview(null);
      setStep("upload");
      setError("");
    }
  }, [isOpen, result]);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setXmlFile(file);
      setError("");
    }
  };

  const handlePreview = async () => {
    setError("");
    setPreview(null);

    if (!xmlFile) {
      setError("Please select an XML file");
      return;
    }

    setLoading(true);

    try {
      const xmlText = await xmlFile.text();

      const response = await fetch("/api/unit-types/import-pcs7/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xmlText })
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to parse XML");
        return;
      }

      setPreview(data);
      setStep("preview");
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    setError("");
    setResult(null);

    if (!unitName.trim()) {
      setError("Unit name is required");
      return;
    }

    if (!preview) {
      setError("No preview data available");
      return;
    }

    setLoading(true);

    try {
      // Call import endpoint with preview data
      const response = await fetch("/api/unit-types/import-pcs7", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unitName: unitName.trim(),
          description: description.trim(),
          assignments: preview.assignments || preview.cmInstances,  // use assignments if available (with composite matching)
          interconnections: preview.interconnections
        })
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          setError(data.error);
        } else {
          setError(data.error || "Import failed");
        }
        return;
      }

      // Set success result (shown to user)
      setResult({
        type: "success",
        unitTypeId: data.unitTypeId,
        unitName: data.unitName,
        memberCount: data.memberCount,
        connectionCount: data.connectionCount,
        members: data.members
      });

      // Notify parent (this may close the modal from outside)
      if (onImportSuccess) {
        onImportSuccess(data);
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleClose = () => {
    // Reset all state when closing — ensures fresh modal on next open
    setUnitName("");
    setDescription("");
    setXmlFile(null);
    setLoading(false);
    setError("");
    setResult(null);
    setPreview(null);
    setStep("upload");
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content unit-import-modal">
        <div className="modal-header">
          <h2>Import Unit Type from PCS7</h2>
          <button className="close-btn" onClick={handleClose}>✕</button>
        </div>

        {!result && step === "upload" ? (
          <div className="modal-body">
            <div className="import-section">
              <label>Unit Name *</label>
              <input
                type="text"
                placeholder="e.g., REACTOR_CONTROL_01"
                value={unitName}
                onChange={(e) => setUnitName(e.target.value)}
              />
            </div>

            <div className="import-section">
              <label>Description (optional)</label>
              <textarea
                placeholder="e.g., Imported from PCS7 AS01 station"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div className="import-section">
              <label>XML File *</label>
              <div className="file-upload">
                <input
                  type="file"
                  accept=".xml"
                  onChange={handleFileChange}
                  id="xml-file-input"
                />
                <label htmlFor="xml-file-input" className="file-label">
                  {xmlFile ? xmlFile.name : "Choose XML file"}
                </label>
              </div>
              <small>Select the XML export from PCS7 (SimaticML format)</small>
            </div>


            {error && <div className="error-box">{error}</div>}

            <div className="modal-actions">
              <button
                className="btn-cancel"
                onClick={handleClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                className="btn-import"
                onClick={handlePreview}
                disabled={loading || !xmlFile}
              >
                {loading ? "Parsing..." : "Next: Preview CM Types"}
              </button>
            </div>
          </div>
        ) : step === "preview" && preview ? (
          <div className="modal-body preview-step">
            <h3>Unit Type Preview</h3>

            {preview.metadata?.unitName && (
              <div style={{ background: "#f0f8ff", border: "1px solid #0066cc", borderRadius: "4px", padding: "12px", marginBottom: "16px", fontSize: "13px" }}>
                <strong>Unit Name Detected:</strong> <span style={{ fontFamily: "monospace", color: "#0066cc" }}>{preview.metadata.unitName}</span>
                <p style={{ margin: "8px 0 0 0", color: "#666" }}>Instance names matching <code>{preview.metadata.unitName}_*</code> will have this prefix stripped for aliases.</p>
              </div>
            )}

            <div className="stats-box">
              <div className="stat-item">
                <span className="stat-label">Total Instances:</span>
                <span className="stat-value">{preview.stats.totalInstances}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Control Modules (CM):</span>
                <span className="stat-value">{preview.stats.cmCount}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Equipment Modules (EM):</span>
                <span className="stat-value">{preview.stats.emCount}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Interconnections:</span>
                <span className="stat-value">{preview.stats.connectionCount}</span>
              </div>
              {preview.stats.matchedToComposite !== undefined && (
                <div className="stat-item">
                  <span className="stat-label">Matched to Composite:</span>
                  <span className="stat-value" style={{ color: "#28a745" }}>{preview.stats.matchedToComposite}</span>
                </div>
              )}
            </div>

            <div className="cm-list">
              <strong>Unit Members (after grouping):</strong>
              <table>
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Source Instance(s)</th>
                    <th>Composite CM</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.assignments && preview.assignments.map((assign, idx) => (
                    <tr key={idx}>
                      <td style={{ fontFamily: "monospace", color: "#0066cc", fontWeight: 500 }}>{assign.alias}</td>
                      <td style={{ fontFamily: "monospace", fontSize: "11px", color: "#555" }}>
                        {assign.collapsedFrom
                          ? assign.collapsedFrom.join(" + ")
                          : assign.alias}
                      </td>
                      <td style={{ fontFamily: "monospace" }}>
                        {assign.compositeInfo ? (
                          <span style={{ color: "#28a745", fontWeight: 500 }}>{assign.compositeInfo.name}</span>
                        ) : (
                          assign.cmTypeName
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.intraCompositeChecks && preview.intraCompositeChecks.length > 0 && (
              <div className="cm-list" style={{ marginTop: 16 }}>
                <strong>Intra-Composite Connections (check only — not imported):</strong>
                <p style={{ fontSize: 12, color: "#666", margin: "4px 0 8px" }}>
                  {preview.stats?.intraExisting || 0} of {preview.intraCompositeChecks.length} already declared in their composite CM type.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Composite</th>
                      <th>Connection</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.intraCompositeChecks.map((c, idx) => (
                      <tr key={idx}>
                        <td style={{ fontFamily: "monospace", color: "#0066cc" }}>
                          {c.compositeName || "—"}
                        </td>
                        <td style={{ fontFamily: "monospace", fontSize: 11 }}>
                          {c.fromSubCmType}.{c.fromVarName} → {c.toSubCmType}.{c.toVarName}
                        </td>
                        <td>
                          {c.existsInComposite ? (
                            <span className="kind-badge" style={{ background: "#e8f5e9", color: "#2e7d32" }}>✓ Exists</span>
                          ) : (
                            <span className="kind-badge" style={{ background: "#fdecea", color: "#c62828" }}>✗ Missing</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.interconnections.length > 0 && (
              <div className="connections-list">
                <strong>Cross-Composite Connections (will be imported as unit wiring):</strong>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: 8, border: "1px solid #dee2e6", background: "#f8f9fa" }}>From</th>
                      <th style={{ textAlign: "left", padding: 8, border: "1px solid #dee2e6", background: "#f8f9fa" }}>To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.interconnections.map((c, idx) => (
                      <tr key={idx}>
                        <td style={{ fontFamily: "monospace", padding: 8, border: "1px solid #dee2e6" }}>{c.from_alias}.{c.from_var_name}</td>
                        <td style={{ fontFamily: "monospace", padding: 8, border: "1px solid #dee2e6" }}>{c.to_alias}.{c.to_var_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="modal-actions">
              <button
                className="btn-cancel"
                onClick={() => setStep("upload")}
                disabled={loading}
              >
                Back
              </button>
              <button
                className="btn-import"
                onClick={() => setStep("confirm")}
                disabled={loading}
              >
                Continue: Create Unit Type
              </button>
            </div>
          </div>
        ) : step === "confirm" ? (
          <div className="modal-body confirm-step">
            <h3>Create Unit Type</h3>

            <div className="confirm-section">
              <label>Unit Name *</label>
              <input
                type="text"
                placeholder="e.g., REACTOR_CONTROL_01"
                value={unitName}
                onChange={(e) => setUnitName(e.target.value)}
              />
            </div>

            <div className="confirm-section">
              <label>Description (optional)</label>
              <textarea
                placeholder="e.g., Imported from PCS7 AS01 station"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div className="summary-box">
              <strong>Import Summary:</strong>
              <p>{preview.stats.totalInstances} instances will be imported</p>
              {preview.stats.matchedToComposite > 0 && (
                <p>✓ {preview.stats.matchedToComposite} instance(s) matched to Composite CM Type(s)</p>
              )}
              {preview.stats.matchedDirect > 0 && (
                <p>✓ {preview.stats.matchedDirect} instance(s) as direct unit member(s)</p>
              )}
            </div>

            {error && <div className="error-box">{error}</div>}

            <div className="modal-actions">
              <button
                className="btn-cancel"
                onClick={() => setStep("preview")}
                disabled={loading}
              >
                Back
              </button>
              <button
                className="btn-import"
                onClick={handleImport}
                disabled={loading || !unitName.trim()}
              >
                {loading ? "Creating..." : "Create Unit Type"}
              </button>
            </div>
          </div>
        ) : result && result.type === "success" ? (
          <div className="modal-body result-success">
            <div className="success-icon">✓</div>
            <h3>Unit Type Imported Successfully!</h3>

            <div className="result-details">
              <div className="detail-row">
                <span className="label">Unit Type ID:</span>
                <span className="value">{result.unitTypeId}</span>
              </div>
              <div className="detail-row">
                <span className="label">Unit Name:</span>
                <span className="value">{result.unitName}</span>
              </div>
              <div className="detail-row">
                <span className="label">Members:</span>
                <span className="value">{result.memberCount}</span>
              </div>
              <div className="detail-row">
                <span className="label">Connections:</span>
                <span className="value">{result.connectionCount}</span>
              </div>
            </div>

            {result.members && result.members.length > 0 && (
              <div className="members-box">
                <strong>Created Members:</strong>
                <ul>
                  {result.members.map((m, i) => (
                    <li key={i}>{m.alias} → {m.cmTypeName}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="modal-actions">
              <button
                className="btn-primary"
                onClick={handleClose}
              >
                Close
              </button>
            </div>
          </div>
        ) : result.type === "confidence_failed" ? (
          <div className="modal-body result-error">
            <div className="error-icon">⚠</div>
            <h3>Confidence Threshold Not Met</h3>
            <p className="error-message">{error}</p>

            <div className="threshold-info">
              <p><strong>Required:</strong> {(result.threshold * 100).toFixed(0)}%</p>
              <p className="hint">{result.hint}</p>
            </div>

            <div className="scores-section">
              <button
                className="toggle-scores"
                onClick={() => setShowScores(!showScores)}
              >
                {showScores ? "Hide" : "Show"} Matching Scores
              </button>

              {showScores && (
                <div className="scores-list">
                  <table>
                    <thead>
                      <tr>
                        <th>Composite</th>
                        <th>Confidence</th>
                        <th>Matches</th>
                        <th>Missing</th>
                        <th>Extra</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.allMatches?.map((match, i) => (
                        <tr key={i}>
                          <td>{match.name}</td>
                          <td>
                            <span className={match.confidence >= result.threshold ? "confidence-good" : "confidence-bad"}>
                              {(match.confidence * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td>{match.matches?.length || 0}</td>
                          <td>{match.missingMembers?.length || 0}</td>
                          <td>{match.extraMembers?.length || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="solutions-box">
              <strong>How to fix:</strong>
              <ol>
                <li>Lower the <strong>Confidence Threshold</strong> and try again (less safe)</li>
                <li>Create a new Composite CM Type matching your CFG's CM types</li>
                <li>Verify the CFG export has the correct MODULE_INFO lines</li>
              </ol>
            </div>

            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setResult(null)}>
                Back
              </button>
              <button
                className="btn-import"
                onClick={() => {
                  // Allow lowering threshold
                  setConfidenceThreshold(Math.max(0, confidenceThreshold - 0.1));
                  setResult(null);
                  setError("");
                }}
              >
                Retry with Lower Threshold
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
