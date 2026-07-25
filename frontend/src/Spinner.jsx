import React from 'react';
import './Spinner.css';

/**
 * Reusable loading spinner component.
 * Matches existing SymbolTableGrid spinner CSS.
 *
 * Usage:
 *   <Spinner />                                    (centered, standalone)
 *   <Spinner inline message="Loading data..." />  (inline, with message)
 *   <Spinner size="large" />                       (size: small, medium, large)
 */
export default function Spinner({ message, inline = false, size = 'medium' }) {
  const sizeClass = `spinner-${size}`;
  const spinner = <div className={`spinner ${sizeClass}`}>⏳</div>;

  if (inline) {
    return (
      <div className="spinner-inline">
        {spinner}
        {message && <span className="spinner-message">{message}</span>}
      </div>
    );
  }

  return (
    <div className="spinner-container">
      {spinner}
      {message && <div className="spinner-message">{message}</div>}
    </div>
  );
}
