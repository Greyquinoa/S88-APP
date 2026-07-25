import React from 'react';
import './ProgressBar.css';

/**
 * Slim, non-blocking progress bar pinned to the top of the app.
 * Renders nothing when `progress` is null/undefined.
 *
 * progress: { pct: number (0-100), phase?: string, msg?: string }
 */
export default function ProgressBar({ progress }) {
  if (!progress) return null;
  const pct = Math.max(0, Math.min(100, Math.round(progress.pct ?? 0)));
  const label = progress.msg || progress.phase || 'Working…';

  return (
    <div className="app-progress" role="progressbar"
      aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="app-progress-track">
        <div className="app-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="app-progress-meta">
        <span className="app-progress-label">{label}</span>
        <span className="app-progress-pct">{pct}%</span>
      </div>
    </div>
  );
}
