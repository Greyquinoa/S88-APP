# Loading Feedback Implementation Summary

## What Was Implemented

A **global loading indicator system** for the PCS7 app that provides visual feedback whenever async operations are in progress (data fetching, generating, saving, etc.). The system prevents double-submits, shows spinner animations, and displays operation-specific messages.

## Files Created

### 1. **Spinner.jsx** - Reusable spinner component
- Displays a rotating ⏳ icon with optional message
- Supports sizes: small, medium (default), large
- Can be inline or centered
- Responsive to dark mode via CSS variables

### 2. **Spinner.css** - Spinner styling
- Rotating animation (2s, infinite loop)
- Responsive layout for centered and inline variants
- Skeleton pulse animation for future skeleton-screen support
- CSS variables for themeing

### 3. **useAsync.js** - Custom React hook
- Wraps async operations with loading/error state management
- Built-in double-submit protection via debounce (300ms default)
- Prevents rapid clicks on buttons
- Callbacks: `onSuccess`, `onError` for side effects
- Returns: `{ loading, error, execute, reset }`

### 4. **LoadingContext.jsx** - Global loading context
- Provides `useGlobalLoading()` hook to access global `uiLoading` state from any component
- Wraps entire app via `<GlobalLoadingProvider>`
- Allows decentralized setting of loading message from child components

## Changes to App.jsx

### State Added
```jsx
const [uiLoading, setUiLoading] = useState("");  // global UI feedback spinner
```

### Imports Added
```jsx
import Spinner from "./Spinner.jsx";
import { GlobalLoadingProvider } from "./LoadingContext.jsx";
```

### Provider Wrapper
```jsx
<GlobalLoadingProvider uiLoading={uiLoading} setUiLoading={setUiLoading}>
  <div>...entire app...</div>
</GlobalLoadingProvider>
```

### Spinner Display
```jsx
{uiLoading && <Spinner message={uiLoading} />}
```

### Functions Updated with UI Feedback

#### `loadUnitInstances(projectId)`
- Shows: "Loading instances…" while fetching 2000+ rows
- Critical for slow Instances tab (step 6) load

#### `handleGenerate()`
- Shows: "Generating XML…" during generation
- Clears on completion or error
- Prevents user navigation during generation

## How It Works

1. **User clicks button** (e.g., "Generate XML")
   - Button is disabled via `disabled={!!loading}`

2. **Async operation starts**
   - `setUiLoading("Operation message…")` is called
   - Spinner overlay appears at top of page

3. **During operation**
   - Buttons remain disabled
   - Spinner rotates continuously
   - Message displays under spinner

4. **Operation completes (success or error)**
   - `setUiLoading("")` clears the spinner
   - Error messages appear in existing error box
   - Button is re-enabled

5. **User can proceed**
   - Click another button to start a new operation
   - Or navigate between tabs

## Usage in Other Components

### Option A: Global Context (Recommended for Most Cases)
```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyComponent() {
  const { setUiLoading } = useGlobalLoading();

  async function handleAction() {
    setUiLoading("Performing action…");
    try {
      await api.doSomething();
    } finally {
      setUiLoading("");
    }
  }

  return <button onClick={handleAction}>Do It</button>;
}
```

### Option B: Encapsulated Hook (For Reusable Components)
```jsx
import { useAsync } from './useAsync.js';

function MyComponent() {
  const { loading, execute } = useAsync(
    async () => await api.doSomething(),
    { debounce: 300 }
  );

  return (
    <button onClick={execute} disabled={loading}>
      {loading ? 'Loading…' : 'Click me'}
    </button>
  );
}
```

## Key Features

✅ **Global Spinner** — Single, consistent loading indicator across the entire app
✅ **Double-Submit Protection** — Buttons auto-disabled during async operations
✅ **Debounce Built-In** — 300ms default prevents rapid clicks
✅ **Async-Aware** — Works with promises, try/catch, error handling
✅ **Dark Mode Ready** — CSS variables adapt to color scheme
✅ **No External Dependencies** — Pure React, no spinner library needed
✅ **Reusable** — Two patterns (hook + context) for different use cases
✅ **Low Overhead** — Minimal state, no complex state management

## Performance Impact

- **Zero overhead when not loading** — Spinner not mounted if `uiLoading` is empty
- **Smooth animation** — CSS-based rotation, GPU-accelerated
- **No layout shifts** — Fixed spinner position, doesn't affect page layout

## Testing Checklist

- [ ] Load Instances tab (step 6) — should show "Loading instances…" spinner briefly
- [ ] Click "Generate XML" on step 6 — should show "Generating XML…" spinner for ~5-10s
- [ ] Rapidly click buttons — should not trigger duplicates (debounce prevents it)
- [ ] Check dark mode — spinner and message color should adapt
- [ ] Verify error display — errors should appear after spinner clears
- [ ] Test on slow network (DevTools throttle) — spinner should stay visible longer, providing user feedback

## Next Steps (Optional Enhancements)

1. **Toast Notifications** — Add snackbar/toast for quick success messages
2. **Progress Bars** — For file uploads with known size
3. **Skeleton Screens** — Replace spinners with content placeholders for large lists
4. **Timeouts** — Show warning if operation takes >30s
5. **Request Cancellation** — Use AbortController for cancellable requests
6. **Analytics** — Log slow operations (>3s) for performance monitoring

## Files Modified

- **App.jsx** — Added global loading state, spinner display, provider wrapper, UI feedback in key async functions
- **Spinner.jsx** (new) — Reusable spinner component
- **Spinner.css** (new) — Spinner styling and animations
- **useAsync.js** (new) — Custom hook for async operations
- **LoadingContext.jsx** (new) — Global loading context provider
- **LOADING_FEEDBACK.md** (new) — Documentation

---

**Status**: ✅ **Ready to test**  
Start by navigating to the Instances tab (step 6) and watching for the loading spinner.
