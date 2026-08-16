import React, { useState, useRef } from "react";
import { parseUserProjectXml, saveUserProjectConfigWithWarning } from "./api";

const PCS7_CONFIG_FIELDS = [
  { key: "project_name",    label: "Project Name"    },
  { key: "project_id_val",  label: "Project ID"      },
  { key: "device_name",     label: "Device Name"     },
  { key: "device_id",       label: "Device ID"       },
  { key: "cpu_id",          label: "CPU ID"          },
  { key: "process_cell",    label: "Process Cell"    },
  { key: "process_cell_id", label: "Process Cell ID" },
  { key: "unit_name",       label: "Unit Name"       },
  { key: "unit_id",         label: "Unit ID"         },
  { key: "cm_folder_id",    label: "CM Folder ID"    },
  { key: "export_user",     label: "Export User"     },
  { key: "unit_author",     label: "Unit Author"     },
];

export default function UserProjectConfigModal({
  projectId,
  userProjectName,
  onClose,
  onConfigSaved,
  onAddUserProject,
}) {
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState(null);
  const [extractedName, setExtractedName] = useState(null);
  const [showWarning, setShowWarning] = useState(false);
  const [parseError, setParseError] = useState("");
  const fileRef = useRef(null);

  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setParseError("");
    setParsing(true);
    try {
      const response = await parseUserProjectXml(projectId, userProjectName, file);
      setConfig(response.config);

      if (response.warning) {
        setExtractedName(response.extractedName);
        setShowWarning(true);
      } else {
        // Auto-save if no warning
        setSaving(true);
        try {
          const saved = await saveUserProjectConfigWithWarning(projectId, userProjectName, response.config, userProjectName);
          onConfigSaved?.(saved.config);
          onClose?.();
        } catch (err) {
          setParseError(err.message);
        } finally {
          setSaving(false);
        }
      }
    } catch (err) {
      setParseError(err.message);
    } finally {
      setParsing(false);
      e.target.value = "";
    }
  }

  async function handleConfirmWarning(createNewUserProject) {
    if (!config) return;
    setSaving(true);
    try {
      const targetUserProject = createNewUserProject ? extractedName : userProjectName;
      if (createNewUserProject) {
        onAddUserProject?.(extractedName);
      }
      const saved = await saveUserProjectConfigWithWarning(projectId, userProjectName, config, targetUserProject);
      onConfigSaved?.(saved.config);
      onClose?.();
    } catch (err) {
      setParseError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }}>
      <div style={{
        background: "white",
        borderRadius: "12px",
        padding: "24px",
        maxWidth: "600px",
        width: "90%",
        maxHeight: "90vh",
        overflow: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      }}>
        {!showWarning ? (
          <>
            <h2 style={{ margin: "0 0 16px 0", fontSize: 18, fontWeight: 600, color: "#1C1B19" }}>
              Upload PCS7 Config for {userProjectName}
            </h2>

            <div style={{ marginBottom: 16, fontSize: 13, color: "var(--color-text-secondary)" }}>
              Select a PCS7 SimaticML XML file to extract hardware configuration.
            </div>

            <div style={{ marginBottom: 20 }}>
              <input
                ref={fileRef}
                type="file"
                accept=".xml,.XML"
                onChange={handleFileSelect}
                style={{ display: "none" }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={parsing || saving}
                style={{
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 500,
                  background: parsing || saving ? "#E5E3E0" : "#1C1B19",
                  color: parsing || saving ? "#999" : "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: parsing || saving ? "default" : "pointer",
                  transition: "background 0.2s ease",
                }}
                onMouseEnter={e => !parsing && !saving && (e.target.style.background = "#333")}
                onMouseLeave={e => !parsing && !saving && (e.target.style.background = "#1C1B19")}
              >
                <i className="ti ti-upload" style={{ marginRight: 6 }} />
                {parsing ? "Parsing…" : saving ? "Saving…" : "Select File"}
              </button>
            </div>

            {parseError && (
              <div style={{
                padding: "12px",
                background: "#FEE2E2",
                border: "1px solid #FECACA",
                borderRadius: "6px",
                fontSize: 12,
                color: "#991B1B",
                marginBottom: 16,
              }}>
                {parseError}
              </div>
            )}

            {config && (
              <div style={{
                border: "0.5px solid var(--color-border-secondary)",
                borderRadius: "8px",
                overflow: "hidden",
                marginBottom: 16,
              }}>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "140px 1fr",
                  background: "var(--color-background-secondary)",
                }}>
                  {PCS7_CONFIG_FIELDS.map((f, idx) => {
                    const val = config[f.key];
                    return (
                      <React.Fragment key={f.key}>
                        <div style={{
                          padding: "5px 10px",
                          fontSize: 11,
                          fontWeight: 500,
                          color: "var(--color-text-secondary)",
                          borderRight: "0.5px solid var(--color-border-tertiary)",
                          borderBottom: idx < PCS7_CONFIG_FIELDS.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none",
                        }}>
                          {f.label}
                        </div>
                        <div style={{
                          padding: "5px 10px",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          color: val ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                          borderBottom: idx < PCS7_CONFIG_FIELDS.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none",
                        }}>
                          {val || "—"}
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={onClose}
                style={{
                  padding: "6px 14px",
                  fontSize: 13,
                  background: "var(--color-background-secondary)",
                  border: "1px solid var(--color-border-secondary)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  transition: "background 0.2s ease",
                }}
                onMouseEnter={e => e.target.style.background = "var(--color-background-tertiary)"}
                onMouseLeave={e => e.target.style.background = "var(--color-background-secondary)"}
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ margin: "0 0 16px 0", fontSize: 18, fontWeight: 600, color: "#DC2626" }}>
              Project Name Mismatch
            </h2>

            <div style={{ marginBottom: 20, fontSize: 13, color: "#333" }}>
              <p style={{ margin: "0 0 8px 0" }}>
                The XML file contains <strong>Project Name: {extractedName}</strong>
              </p>
              <p style={{ margin: "0 0 12px 0" }}>
                You are uploading to user project: <strong>{userProjectName}</strong>
              </p>
              <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
                Would you like to add <strong>{extractedName}</strong> as a new user project and save the config there?
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => handleConfirmWarning(false)}
                disabled={saving}
                style={{
                  padding: "6px 14px",
                  fontSize: 13,
                  background: "var(--color-background-secondary)",
                  border: "1px solid var(--color-border-secondary)",
                  borderRadius: "6px",
                  cursor: saving ? "default" : "pointer",
                  opacity: saving ? 0.6 : 1,
                  transition: "background 0.2s ease",
                }}
                onMouseEnter={e => !saving && (e.target.style.background = "var(--color-background-tertiary)")}
                onMouseLeave={e => !saving && (e.target.style.background = "var(--color-background-secondary)")}
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirmWarning(true)}
                disabled={saving}
                style={{
                  padding: "6px 14px",
                  fontSize: 13,
                  fontWeight: 500,
                  background: saving ? "#E5E3E0" : "#DC2626",
                  color: saving ? "#999" : "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: saving ? "default" : "pointer",
                  transition: "background 0.2s ease",
                }}
                onMouseEnter={e => !saving && (e.target.style.background = "#B91C1C")}
                onMouseLeave={e => !saving && (e.target.style.background = "#DC2626")}
              >
                {saving ? "Saving…" : "Add & Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
