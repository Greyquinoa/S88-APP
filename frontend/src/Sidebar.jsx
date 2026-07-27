import React, { useState } from 'react';

const STEPS_CONFIG = [
  { id: 0, label: 'Projects', icon: 'ti-home' },
  { id: 1, label: 'IO Import', icon: 'ti-database' },
  { id: 2, label: 'Library', icon: 'ti-book' },
  { id: 3, label: 'Unit Types', icon: 'ti-puzzle' },
  { id: 4, label: 'Hierarchy', icon: 'ti-hierarchy' },
  { id: 5, label: 'Instances', icon: 'ti-grid-dots' },
  { id: 6, label: 'HW Config', icon: 'ti-server' },
  { id: 7, label: 'Generate', icon: 'ti-download' },
];

export default function Sidebar({ activeStep, onStepChange, libStatus, projectName }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="sidebar">
      {/* Icon Rail */}
      <div className="sidebar-rail">
        <div style={{ marginBottom: 16, fontSize: 18, fontWeight: 700, color: '#34D399' }}>
          ⚙️
        </div>

        {STEPS_CONFIG.map(step => (
          <button
            key={step.id}
            onClick={() => onStepChange(step.id)}
            className={`sidebar-rail-item ${activeStep === step.id ? 'active' : ''}`}
            title={step.label}
          >
            <i className={`ti ${step.icon}`} />
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Progress indicator */}
        {libStatus?.cm_count > 0 && (
          <div style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            color: '#34D399',
            background: 'var(--color-background-secondary)',
            marginBottom: 16,
          }}>
            {libStatus.cm_count}
          </div>
        )}

        {/* Utility icons */}
        <button className="sidebar-rail-item" style={{ marginTop: 'auto' }} title="Help">
          <i className="ti ti-help" />
        </button>
      </div>

      {/* Expandable Panel */}
      {expanded && (
        <div className="sidebar-panel">
          <div className="sidebar-header">
            <h1>PCS7 App</h1>
            <button
              className="sidebar-collapse-btn"
              onClick={() => setExpanded(false)}
              title="Collapse"
            >
              <i className="ti ti-chevron-left" />
            </button>
          </div>

          {/* Primary action */}
          <button className="sidebar-action-btn">
            <i className="ti ti-plus" />
            Add New
          </button>

          {/* Navigation list */}
          <nav className="sidebar-nav">
            {STEPS_CONFIG.map(step => (
              <button
                key={step.id}
                onClick={() => onStepChange(step.id)}
                className={`sidebar-nav-item ${activeStep === step.id ? 'active' : ''}`}
              >
                <i className={`ti ${step.icon}`} style={{ fontSize: 14 }} />
                <span style={{ flex: 1, textAlign: 'left' }}>{step.label}</span>
              </button>
            ))}
          </nav>

          {/* Footer stats */}
          <div className="sidebar-footer">
            {projectName && (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                Project: <strong>{projectName}</strong>
              </div>
            )}
            {libStatus?.cm_count > 0 && (
              <div className="sidebar-stat-card">
                <div className="sidebar-stat-card-value">{libStatus.cm_count}</div>
                <div className="sidebar-stat-card-label">Types Loaded</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Collapsed state - show expand chevron */}
      {!expanded && (
        <button
          className="sidebar-collapse-btn"
          onClick={() => setExpanded(true)}
          style={{ margin: '16px auto', position: 'absolute', bottom: 16 }}
          title="Expand"
        >
          <i className="ti ti-chevron-right" />
        </button>
      )}
    </div>
  );
}
