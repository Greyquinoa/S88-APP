import React from 'react';

const statusConfig = {
  OK: { label: 'OK', color: '#10B981', bg: '#D1FAE5', icon: 'ti-circle-check' },
  IMPORTED_OK: { label: 'Imported', color: '#0EA5E9', bg: '#CFFAFE', icon: 'ti-circle-check' },
  DUMMY: { label: 'Dummy', color: '#EF4444', bg: '#FEE2E2', icon: 'ti-alert-circle' },
  DUMMY_ACCEPTED: { label: 'Accepted', color: '#F59E0B', bg: '#FEF3C7', icon: 'ti-circle-check' },
  ERROR: { label: 'Error', color: '#8B5CF6', bg: '#F3E8FF', icon: 'ti-alert-triangle' },
  PENDING: { label: 'Pending', color: '#6B7280', bg: '#F3F4F6', icon: 'ti-hourglass-2' },
};

export default function ReconciliationStatusRenderer({ reconData, instanceName }) {
  const data = reconData?.[instanceName];
  if (!data) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
        color: '#9CA3AF', fontSize: 12
      }}>
        —
      </div>
    );
  }

  const config = statusConfig[data.status] || statusConfig.PENDING;

  const getTooltip = () => {
    const parts = [];
    if (data.isImported) parts.push('✓ Imported');
    if (data.isGenerated) parts.push('✓ Generated');
    if (data.acceptedAt) {
      const date = new Date(data.acceptedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      parts.push(`Accepted ${date}`);
      if (data.acceptedBy) parts.push(`by ${data.acceptedBy}`);
    }
    return parts.join(' · ');
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
      }}
      title={getTooltip()}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
        background: config.bg, color: config.color, whiteSpace: 'nowrap',
      }}>
        <i className={`ti ${config.icon}`} aria-hidden="true" style={{ fontSize: 13 }} />
        {config.label}
      </span>
    </div>
  );
}
