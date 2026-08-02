import React, { useState } from 'react';
import { BookMarked, FileText, FolderTree, Cpu, Boxes, BookOpenCheck, Home, ArrowDownToLine } from 'lucide-react';

const STEPS_CONFIG = [
  { id: 0, label: 'Projects', icon: null, component: Home },
  { id: 1, label: 'IO Import', icon: null, component: FileText },
  { id: 2, label: 'EPH/EM Import', icon: null, component: FileText },
  { id: 3, label: 'Library', icon: null, component: BookMarked },
  { id: 4, label: 'Unit Types', icon: null, component: Boxes },
  { id: 5, label: 'Hierarchy', icon: null, component: FolderTree },
  { id: 6, label: 'Instances', icon: null, component: BookOpenCheck },
  { id: 7, label: 'HW Config', icon: null, component: Cpu },
  { id: 8, label: 'Generate', icon: null, component: ArrowDownToLine },
];

export default function Sidebar({ activeStep, onStepChange, libStatus, projectName, instanceCount = 0 }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <>
      {/* Sidebar Panel - shown when expanded */}
      {expanded && (
        <div className="sidebar-panel-expanded">
          <div className="sidebar-header pcs7-header">
            <h1>S88X</h1>
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
                {step.component ? (
                  <step.component size={18} style={{ flexShrink: 0 }} />
                ) : (
                  <i className={`ti ${step.icon}`} style={{ fontSize: 14 }} />
                )}
                <span style={{ flex: 1, textAlign: 'left' }}>{step.label}</span>
              </button>
            ))}
          </nav>

          {/* Summary Section - always visible below nav */}
          <div style={{
            padding: '1rem',
            borderTop: '1px solid #E5E7EB',
            backgroundColor: '#F9FAFB',
            marginTop: 'auto',
            fontSize: '0.875rem'
          }}>
            {projectName ? (
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.75rem', color: '#9CA3AF', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.25rem' }}>Project</div>
                <div style={{ color: '#111827', fontWeight: 500, wordBreak: 'break-word' }}>{projectName}</div>
              </div>
            ) : (
              <div style={{ marginBottom: '0.75rem', color: '#D1D5DB' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.25rem' }}>Project</div>
                <div>—</div>
              </div>
            )}
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.25rem' }}>Library</div>
              {libStatus && (libStatus.cm_count > 0 || libStatus.em_count > 0 || libStatus.eph_count > 0) ? (
                <div style={{ color: '#111827', fontWeight: 400 }}>
                  <div>CM: {libStatus.cm_count || 0}</div>
                  <div>EM: {libStatus.em_count || 0}</div>
                  <div>EPH: {libStatus.eph_count || 0}</div>
                </div>
              ) : (
                <div style={{ color: '#D1D5DB' }}>—</div>
              )}
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.25rem' }}>Instances</div>
              <div style={{ color: '#111827', fontWeight: 500 }}>{instanceCount}</div>
            </div>
          </div>
        </div>
      )}

      {/* Icon Rail - shown only when collapsed */}
      {!expanded && (
        <div style={{ position: 'relative' }}>
          <div className="sidebar-rail">
            <img src="/pcs7-logo.png" alt="S88X" style={{ marginBottom: '1rem', width: '40px', height: '40px', objectFit: 'contain' }} />

            {STEPS_CONFIG.map(step => (
              <button
                key={step.id}
                onClick={() => onStepChange(step.id)}
                className={`sidebar-rail-item ${activeStep === step.id ? 'active' : ''}`}
                title={step.label}
                aria-label={step.label}
              >
                {step.component ? (
                  <step.component size={20} />
                ) : (
                  <i className={`ti ${step.icon}`} />
                )}
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
          </div>

          {/* Notch handle sticking from right edge */}
          <button
            className="sidebar-notch-handle"
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
