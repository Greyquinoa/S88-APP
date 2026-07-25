# Loading & Status Feedback System

This document describes the global loading feedback system added to the PCS7 app. It provides consistent UI feedback whenever async operations are in progress (data fetching, saving, generating, etc.).

## Overview

- **Global Spinner**: Centered spinner with optional message displayed during async operations
- **No Double-Submits**: Buttons disabled during operations prevent rapid clicks
- **Consistent Pattern**: Reusable hook and context for components to integrate easily
- **CSS-based Animation**: Smooth rotation animation, respects dark mode

## Components & Utilities

### 1. `Spinner.jsx` & `Spinner.css`
A reusable spinner component that displays an animated icon with optional message.

**Usage:**
```jsx
import Spinner from './Spinner.jsx';

// Centered standalone spinner
<Spinner message="Loading instances..." />

// Inline spinner (beside text)
<Spinner inline message="Saving…" />

// Size control
<Spinner size="large" />  // small, medium (default), large
```

### 2. `useAsync.js` (Hook)
A custom hook for wrapping async operations with loading/error state and double-submit prevention.

**Usage:**
```jsx
import { useAsync } from './useAsync.js';

const { loading, error, execute, reset } = useAsync(
  async (arg1, arg2) => {
    // Your async operation
    const result = await api.doSomething(arg1, arg2);
    return result;
  },
  {
    debounce: 300,  // debounce ms (optional)
    onSuccess: (result) => console.log('Done!'),  // optional
    onError: (err) => console.error(err),  // optional
  }
);

return (
  <button onClick={() => execute(arg1, arg2)} disabled={loading}>
    {loading ? 'Loading…' : 'Click me'}
  </button>
);
```

### 3. `LoadingContext.jsx` (Context)
Provides global access to the `uiLoading` state across the app.

**Usage in child components:**
```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyComponent() {
  const { setUiLoading } = useGlobalLoading();

  async function handleClick() {
    setUiLoading("Performing action…");
    try {
      await doAsyncWork();
    } finally {
      setUiLoading("");  // Always clear
    }
  }

  return <button onClick={handleClick}>Do something</button>;
}
```

### 4. Integration in `App.jsx`

- **Global `uiLoading` state**: Stored in main App component state
- **Spinner display**: Shown when `uiLoading` is truthy
- **Context provider**: Wraps entire app to make `uiLoading` accessible to all children
- **Key functions updated**:
  - `loadUnitInstances()` — shows "Loading instances…" when fetching 2000+ rows
  - `handleGenerate()` — shows "Generating XML…" during generation

## Usage Pattern

### For Simple Async Operations
Use `useGlobalLoading()` in components:

```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyButton() {
  const { setUiLoading } = useGlobalLoading();

  async function handleSave() {
    setUiLoading("Saving…");
    try {
      await saveProject();
    } finally {
      setUiLoading("");
    }
  }

  return <button onClick={handleSave}>Save</button>;
}
```

### For Reusable Async Hooks
Use `useAsync()` for encapsulated components:

```jsx
import { useAsync } from './useAsync.js';

function DataFetcher({ onLoad }) {
  const { loading, error, execute } = useAsync(
    async () => {
      const data = await fetch('/api/data').then(r => r.json());
      onLoad?.(data);
      return data;
    },
    { debounce: 300 }
  );

  return (
    <div>
      <button onClick={execute} disabled={loading}>Load</button>
      {error && <div style={{ color: 'red' }}>{error}</div>}
    </div>
  );
}
```

## Visual Feedback

1. **Spinner**: Rotating ⏳ icon, 24px default size, 2s rotation
2. **Message**: Optional text below spinner (e.g., "Loading instances…", "Generating XML…")
3. **Button state**: Disabled (`opacity: 0.4`) while `loading` is true
4. **Dark mode**: Spinner color and message text adapt via CSS variables

## Best Practices

1. **Always clear on completion**: Use try/finally to ensure `setUiLoading("")` is called
2. **Descriptive messages**: Use action-specific text ("Loading…", "Saving…", "Generating XML…")
3. **Debounce for protection**: `useAsync` includes default 300ms debounce to prevent double-submits
4. **Disable buttons during load**: Always check `disabled={!!loading}` on clickable elements
5. **Show errors after**: Clear `uiLoading` first, then show error in the error box or toast

## Files Added/Modified

| File | Purpose |
|------|---------|
| `Spinner.jsx` | Reusable spinner component |
| `Spinner.css` | Spinner animation and styling |
| `useAsync.js` | Hook for async operations with debounce |
| `LoadingContext.jsx` | Context for global `uiLoading` state |
| `App.jsx` | Updated to show spinner, wrap with provider, set `uiLoading` in key functions |

## Future Enhancements

- [ ] Toast notifications for success/error messages
- [ ] Progress bar for long-running operations (if progress can be tracked)
- [ ] Skeleton screens for content-heavy loads (replace with real data)
- [ ] Timeout handling (show message if operation takes >30s)
- [ ] Request cancellation with AbortController
- [ ] Analytics/logging for slow operations

---

**Example**: When user clicks "Generate XML" button on step 6 (Instances):
1. Button is disabled (`loading={true}`)
2. Global spinner appears with message "Generating XML…"
3. After ~5-10s, generation completes
4. Spinner clears, user is navigated to step 7 (Generate tab)
5. If error occurs, spinner clears and error message appears in red box
