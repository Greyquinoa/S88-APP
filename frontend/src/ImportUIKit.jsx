// ImportUIKit.jsx — shared presentational primitives for the import workflows.
//
// These were originally private to StepIOImport.jsx. They are extracted here so
// the EPH/EM import can present the same surface without cloning ~200 lines of
// style objects that would then drift apart on the next restyle. Behaviour is
// unchanged from the originals — this is a move, not a rewrite.

// Glass radio button styles for config selection (green theme, smooth sliding glider)
const glassRadioCss = `
.glass-radio-group-vertical {
  position: relative;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0);
  padding: 0;
  border: 0px solid rgb(255, 255, 255, 0);
  backdrop-filter: blur(16px);
  overflow-x: hidden;
  gap: 0;
}

.glass-radio-group-vertical input {
  display: none;
}

.glass-radio-group-vertical label {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.5rem 1rem;
  font-weight: 500;
  font-size: 0.9rem;
  color: #1a1a1a;
  cursor: pointer;
  z-index: 2;
  transition: color 0.4s ease-in-out;
  overflow: hidden;
  box-sizing: border-box;
  /* Rows must never shrink: in a column flex container an overflowing list
     would otherwise compress every row, clipping the two-line labels and
     desynchronising the glider from the row it is meant to sit on. */
  flex: 0 0 auto;
}

.glass-label-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
  min-width: 0;
}

/* Rendered before the rows so it paints beneath them; the rows are transparent
   and sit at a higher z-index. Only 'transform' animates, so the slide is
   compositor-driven and stays smooth. */
/* Spans the sidebar edge to edge with a shiny glass effect. The layered
   shadows create depth (inset highlight at top, shadow at bottom), and the
   gradient overlay simulates refracted light. */
.glass-glider-vertical {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  z-index: 0;
  pointer-events: none;
  flex: none;
  border-radius: 0;
  transition: transform 0.4s cubic-bezier(0.5, 1.6, 0.4, 1);
  background: linear-gradient(135deg, #3a3a3a, #555555);
  box-shadow:
    inset 0 0.2rem 0.6rem rgba(255, 255, 255, 0.25),
    inset 0 -0.1rem 0.3rem rgba(0, 0, 0, 0.5),
    inset 0 -0.3rem 0.6rem rgba(255, 255, 255, 0.3),
    0 2rem 2rem rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

/* Pseudo-element for the glossy highlight overlay. */
.glass-glider-vertical::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 50%;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.2) 0%,
    rgba(255, 255, 255, 0.05) 40%,
    transparent 100%
  );
  pointer-events: none;
}

/* Selected row sits on the dark band, so its text inverts to white. */
.glass-radio-group-vertical input:checked + label {
  color: #FFFFFF;
  font-weight: 600;
}
.glass-radio-group-vertical input:checked + label .io-import-icon-delete {
  color: #FFFFFF !important;
}
.glass-radio-group-vertical input:checked + label .io-import-icon-delete:hover {
  color: #FF4444 !important;
}

/* Unselected rows stay dark-on-light and lift slightly on hover. */
.glass-radio-group-vertical input:not(:checked) + label:hover {
  background: rgba(28, 27, 25, 0.05);
}
`;

// Reuse the existing <style> tag if present and always rewrite its contents.
// Skipping the write when the tag exists would pin the page to whatever CSS was
// injected on first load, so edits here would not survive a hot reload.
if (typeof document !== 'undefined') {
  let style = document.getElementById('glass-radio-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'glass-radio-styles';
    document.head.appendChild(style);
  }
  style.textContent = glassRadioCss;
}

// ── Sliding-highlight geometry ────────────────────────────────────────────────
// Fallback only; call sites measure the real row height because rows size to
// their own font/padding and a hard-coded value drifts further off with every
// row down the list.
export const GLIDER_FALLBACK_H = 44;
export const GLIDER_GAP = 0;   // matches `gap: 0` on .glass-radio-group-vertical

// Matches the Library panels' Btn (App.jsx): accent-filled primary, hairline
// outline secondary. `green` is kept as an alias of `primary` so existing call
// sites keep working without touching behaviour.
export function Btn({ onClick, primary, danger, disabled, children, style, green }) {
  const filled = primary || green;
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        padding: '7px 18px',
        borderRadius: 'var(--border-radius-md)',
        fontSize: 13,
        fontWeight: filled ? 500 : 400,
        border: danger ? '0.5px solid #FCA5A5' : filled ? 'none' : '0.5px solid var(--color-border-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: danger ? '#FEE2E2' : filled ? 'var(--color-accent)' : 'transparent',
        color: danger ? '#991B1B' : filled ? 'white' : 'var(--color-text-primary)',
        opacity: disabled ? 0.45 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        transition: 'opacity 0.15s ease',
        ...style,
      }}>
      {children}
    </button>
  );
}

// Small uppercase section label — mirrors SLabel in App.jsx.
export function SLabel({ text, top, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        margin: `${top ? '1rem' : 0} 0 8px` }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', textTransform: 'uppercase',
          letterSpacing: '0.05em', fontWeight: 500 }}>{text}</div>
      {children}
    </div>
  );
}

// Panel heading block used at the top of every sub-tab, matching the Library's
// "Composite CM Types / Group multiple CM types…" title + subtitle pattern.
export function PanelHeading({ title, subtitle }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{title}</div>
      {subtitle && (
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{subtitle}</div>
      )}
    </div>
  );
}

// Bordered card that hosts a list or an editor — matches Projects panel style.
export const panelSx = {
  border: '1px solid rgba(28,27,25,0.08)',
  borderRadius: '22px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  minHeight: 0,
  background: '#FFFFFF',
  boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 14px 30px -18px rgba(28,27,25,0.18)',
};

// Glass morphism panels for sidebar lists (Imports, Column Map configs)
export const glassPanelSx = {
  border: '1px solid rgba(255,255,255,0.3)',
  borderRadius: '16px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  minHeight: 0,
  background: 'rgba(255,255,255,0.18)',
  backdropFilter: 'blur(16px)',
  boxShadow: '0 8px 32px 0 rgba(0,0,0,0.1)',
};

// Header strip inside a panel (list toolbars, table heads).
export const panelHeaderSx = {
  padding: '12px 16px',
  borderBottom: '1px solid rgba(28,27,25,0.08)',
  background: '#FBF8F0',
  flexShrink: 0,
};

// Glass panel header
export const glassPanelHeaderSx = {
  padding: '12px 16px',
  borderBottom: '1px solid rgba(255,255,255,0.25)',
  background: 'rgba(255,255,255,0.12)',
  flexShrink: 0,
};

// Selected row tint used across every Library list.
export const ROW_SELECTED_BG = '#EEEDFE';

// Empty-state box — dashed outline, centred muted text.
export function EmptyState({ children, dashed = true, style }) {
  return (
    <div style={{
      border: dashed ? '1.5px dashed var(--color-border-secondary)' : 'none',
      borderRadius: 'var(--border-radius-lg)',
      padding: '2rem 1.5rem', textAlign: 'center',
      fontSize: 13, color: 'var(--color-text-secondary)',
      ...style,
    }}>
      {children}
    </div>
  );
}

// Tinted status callout, matching the Library's "Library loaded ✓" banner
// (solid tint + hairline border of the same hue, not a heavy left rule).
export const CALLOUT_TONES = {
  info:    { bg: '#E6F1FB', border: '#B9D4EE', fg: '#0C447C' },
  success: { bg: '#DCFCE7', border: '#86EFAC', fg: '#166534' },
  warning: { bg: '#FEF3C7', border: '#FCD34D', fg: '#92400E' },
  danger:  { bg: '#FEE2E2', border: '#FCA5A5', fg: '#991B1B' },
};

export function Callout({ tone = 'info', children, style }) {
  const t = CALLOUT_TONES[tone] || CALLOUT_TONES.info;
  return (
    <div style={{
      background: t.bg, border: `1px solid ${t.border}`, color: t.fg,
      borderRadius: 'var(--border-radius-md)', padding: '10px 14px',
      fontSize: 13, lineHeight: 1.5, ...style,
    }}>
      {children}
    </div>
  );
}

// Compact metric tile used for workflow result stats.
export function StatTile({ label, value }) {
  return (
    <div style={{ border: '0.5px solid var(--color-border-tertiary)',
        borderRadius: 'var(--border-radius-md)', padding: '10px 12px',
        background: 'var(--color-background-secondary)' }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export function Tag({ text, color }) {
  const colors = {
    green:  { bg: '#ECFDF5', fg: '#065F46' },
    red:    { bg: '#FEE2E2', fg: '#991B1B' },
    yellow: { bg: '#FEF3C7', fg: '#92400E' },
    blue:   { bg: '#E6F1FB', fg: '#0C447C' },
    gray:   { bg: 'var(--color-background-secondary)', fg: 'var(--color-text-secondary)' },
    purple: { bg: '#F3E8FF', fg: '#6B21A8' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 8, fontWeight: 600,
      background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{text}</span>
  );
}

export const STATUS_COLOR = {
  auto:            'green',
  approved:        'green',
  manual_override: 'blue',
  unresolved:      'yellow',
  pending:         'gray',
  rejected:        'red',
};

export const inputSx = {
  padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)',
  borderRadius: 'var(--border-radius-md)', fontSize: 12, fontFamily: 'var(--font-mono)',
  background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
  width: '100%', boxSizing: 'border-box',
};

// Plain (non-mono) field for prose-like values such as names and descriptions.
export const textInputSx = { ...inputSx, fontFamily: 'var(--font-sans)', fontSize: 13 };

// Field label matching the hero's "AT A GLANCE" eyebrow (.nimbus-eyebrow-label).
export const eyebrowLabelSx = {
  display: 'block', marginBottom: 4,
  fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 11.5,
  letterSpacing: '0.02em', textTransform: 'uppercase', color: '#6B6862',
};

// Toggle switch — same geometry and colour as BlockRow's switch in App.jsx.
export function Switch({ checked, onChange }) {
  return (
    <div onClick={() => onChange(!checked)}
      style={{ width: 34, height: 18, borderRadius: 9, cursor: 'pointer', flexShrink: 0,
        background: checked ? '#10B981' : 'var(--color-border-secondary)',
        position: 'relative', transition: 'background 0.15s' }}>
      <div style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 14, height: 14, borderRadius: '50%', background: 'white',
        transition: 'left 0.15s',
      }} />
    </div>
  );
}
