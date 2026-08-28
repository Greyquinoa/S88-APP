// ContextMenu.jsx — small fixed-position right-click menu.
// items: [{ label, onClick, disabled? }]
import React, { useEffect, useRef } from "react";

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    function handleMouseDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    }
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref}
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 1000,
        minWidth: 170,
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-secondary)",
        borderRadius: "var(--border-radius-md)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
        padding: "4px 0",
        fontSize: 13,
      }}>
      {items.map((item, idx) => (
        <button key={idx}
          onClick={() => { if (!item.disabled) item.onClick?.(); }}
          disabled={item.disabled}
          style={{
            display: "block", width: "100%", textAlign: "left",
            padding: "7px 14px", border: "none", background: "transparent",
            cursor: item.disabled ? "default" : "pointer",
            color: item.disabled ? "var(--color-text-secondary)" : "var(--color-text-primary)",
            opacity: item.disabled ? 0.5 : 1,
          }}
          onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = "var(--color-background-secondary)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
