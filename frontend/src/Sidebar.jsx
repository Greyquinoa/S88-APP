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
    <>
      {/* Sidebar Panel - shown when expanded */}
      {expanded && (
        <div className="sidebar-panel-expanded">
          <div className="sidebar-header">
            <h1>PCS7 App</h1>
            <button
              className="sidebar-collapse-btn"
              onClick={() => setExpanded(false)}
              title="Collapse sidebar"
            >
              <i className="ti ti-chevron-left" />
            </button>
          </div>

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
              <div style={{ fontSize: '0.875rem', color: '#6B7280', fontWeight: 400 }}>
                Project: <strong style={{ wordBreak: 'break-word', color: '#111827' }}>{projectName}</strong>
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

      {/* Icon Rail - shown only when collapsed */}
      {!expanded && (
        <div className="sidebar-rail">
          <div style={{ marginBottom: '1rem', fontSize: '1.5rem', fontWeight: 700, color: '#34D399' }}>
            ⚙️
          </div>

          {STEPS_CONFIG.map(step => (
            <button
              key={step.id}
              onClick={() => onStepChange(step.id)}
              className={`sidebar-rail-item ${activeStep === step.id ? 'active' : ''}`}
              title={step.label}
              aria-label={step.label}
            >
              <i className={`ti ${step.icon}`} />
            </button>
          ))}

          <div style={{ flex: 1 }} />

          {/* Progress indicator */}
          {libStatus?.cm_count > 0 && (
            <div
              style={{
                width: '2.75rem',
                height: '2.75rem',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: '#34D399',
                background: 'var(--color-background-secondary)',
                marginBottom: '1rem',
                cursor: 'default',
              }}
              title={`${libStatus.cm_count} types loaded`}
            >
              {libStatus.cm_count}
            </div>
          )}

          {/* Toggle button */}
          <button
            className="sidebar-toggle-btn"
            onClick={() => setExpanded(true)}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}
    </>
  );
}
