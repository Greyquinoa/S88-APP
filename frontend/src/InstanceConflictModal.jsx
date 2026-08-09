import { useState, useMemo } from 'react';
import { Btn } from './ImportUIKit.jsx';

export default function InstanceConflictModal({ conflicts, onResolve, onCancel }) {
  const [resolutions, setResolutions] = useState(() =>
    Object.fromEntries(conflicts.map(c => [c.name, null]))
  );

  const allResolved = useMemo(
    () => conflicts.every(c => resolutions[c.name] !== null),
    [conflicts, resolutions]
  );

  const handleResolution = (name, action) => {
    setResolutions(prev => ({ ...prev, [name]: action }));
  };

  const handleConfirm = () => {
    const resolutionArray = conflicts.map(c => ({
      name: c.name,
      action: resolutions[c.name],
    }));
    onResolve(resolutionArray);
  };

  const handleQuickResolve = (action) => {
    const newResolutions = Object.fromEntries(
      conflicts.map(c => [c.name, action])
    );
    setResolutions(newResolutions);
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        backgroundColor: 'var(--color-bg-primary, #fff)',
        borderRadius: '8px',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
        maxHeight: '80vh',
        width: '100%',
        maxWidth: '600px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '24px',
          borderBottom: '1px solid var(--color-border-tertiary, #e0e0e0)',
          flexShrink: 0,
        }}>
          <h2 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: 600 }}>
            Instance Name Conflicts
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-fg-secondary, #666)' }}>
            {conflicts.length} instance{conflicts.length !== 1 ? 's' : ''} already exist in this project.
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <Btn size="sm" onClick={() => handleQuickResolve('update')}>
              Update All
            </Btn>
            <Btn size="sm" onClick={() => handleQuickResolve('skip')}>
              Skip All
            </Btn>
          </div>
        </div>

        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px',
        }}>
          {conflicts.map(conflict => (
            <ConflictRow
              key={conflict.name}
              conflict={conflict}
              selected={resolutions[conflict.name]}
              onChange={action => handleResolution(conflict.name, action)}
            />
          ))}
        </div>

        <div style={{
          display: 'flex',
          gap: '8px',
          padding: '16px',
          borderTop: '1px solid var(--color-border-tertiary, #e0e0e0)',
          flexShrink: 0,
          justifyContent: 'flex-end',
        }}>
          <Btn onClick={onCancel}>
            Cancel
          </Btn>
          <Btn onClick={handleConfirm} disabled={!allResolved} primary>
            Apply Resolutions
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ConflictRow({ conflict, selected, onChange }) {
  return (
    <div style={{
      padding: '12px',
      marginBottom: '8px',
      backgroundColor: 'var(--color-bg-secondary, #f5f5f5)',
      borderRadius: '6px',
      border: '1px solid var(--color-border-secondary, #ddd)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-fg-primary, #333)' }}>
            {conflict.name}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-fg-tertiary, #999)', marginTop: '4px' }}>
            Already exists (ID #{conflict.existingId}) · Current type: <code>{conflict.existing.cmType}</code>
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex',
        gap: '8px',
        marginTop: '12px',
        flexWrap: 'wrap',
      }}>
        {[
          { value: 'skip', label: 'Skip', title: 'Do not create or modify this instance' },
          { value: 'update', label: 'Update', title: 'Delete and recreate this instance' },
          { value: 'create_anyway', label: 'Create Anyway', title: 'Create despite the name conflict' },
        ].map(option => (
          <label key={option.value} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            cursor: 'pointer',
            userSelect: 'none',
            borderRadius: '4px',
            backgroundColor: selected === option.value ? 'var(--color-bg-selected, #e3f2fd)' : 'transparent',
            border: `1px solid ${selected === option.value ? 'var(--color-border-focus, #2196f3)' : 'transparent'}`,
          }} title={option.title}>
            <input
              type="radio"
              name={`conflict-${conflict.name}`}
              value={option.value}
              checked={selected === option.value}
              onChange={() => onChange(option.value)}
              style={{ cursor: 'pointer' }}
            />
            <span style={{ fontSize: '13px', fontWeight: 500 }}>
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
