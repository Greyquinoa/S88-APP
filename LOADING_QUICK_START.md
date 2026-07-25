# Quick Start: Adding Loading Feedback

## In Existing Components

### Scenario 1: Simple button with async action in a step component
```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

export default function MyStep() {
  const { setUiLoading } = useGlobalLoading();

  async function handleSave() {
    setUiLoading("Saving your data…");
    try {
      await api.saveData();
      // Success — spinner automatically clears when component re-renders
    } catch (e) {
      setError(e.message);  // Show error in existing error box
    } finally {
      setUiLoading("");  // Always clear when done
    }
  }

  return (
    <button onClick={handleSave}>Save</button>
  );
}
```

### Scenario 2: Modal with submit button
```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyModal({ onClose }) {
  const [error, setError] = useState("");
  const { setUiLoading } = useGlobalLoading();

  async function handleSubmit() {
    setError("");
    setUiLoading("Submitting…");
    try {
      await api.submitForm(formData);
      setUiLoading("");
      onClose();  // Close modal after success
    } catch (e) {
      setUiLoading("");
      setError(e.message);
    }
  }

  return (
    <div>
      {error && <div style={{ color: 'red' }}>{error}</div>}
      <button onClick={handleSubmit}>Submit</button>
    </div>
  );
}
```

### Scenario 3: Multiple async operations (use Promise.all)
```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyComponent() {
  const { setUiLoading } = useGlobalLoading();

  async function handleSync() {
    setUiLoading("Syncing data…");
    try {
      const [result1, result2] = await Promise.all([
        api.fetchUsersFromServer(),
        api.fetchProjectsFromServer(),
      ]);
      // Both complete together
      updateUI(result1, result2);
    } finally {
      setUiLoading("");
    }
  }

  return <button onClick={handleSync}>Sync All</button>;
}
```

### Scenario 4: Long-running operation with intermediate steps
```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyComponent() {
  const { setUiLoading } = useGlobalLoading();

  async function handleGenerate() {
    try {
      setUiLoading("Step 1: Preparing data…");
      await api.prepareData();

      setUiLoading("Step 2: Processing…");
      await api.process();

      setUiLoading("Step 3: Finalizing…");
      await api.finalize();

      setUiLoading("");  // All done
    } catch (e) {
      setUiLoading("");
      setError(`Failed at step: ${e.message}`);
    }
  }

  return <button onClick={handleGenerate}>Generate</button>;
}
```

## Testing Locally

1. **Start the app** (if not already running)
   ```bash
   cd frontend
   npm run dev
   ```

2. **Navigate to step 6 (Instances tab)**
   - You'll see the spinner appear briefly while instances load
   - Message: "Loading instances…"

3. **Click "Generate XML" on step 6**
   - Spinner appears with "Generating XML…"
   - Button becomes disabled
   - After ~5-10s, XML generation completes
   - Spinner clears, you're navigated to step 7

4. **Test on slow network** (optional, for better testing)
   - Open DevTools → Network tab
   - Set throttling to "Slow 3G" or "Fast 3G"
   - Repeat step 2 — spinner stays visible longer
   - Good UX: User sees spinner instead of blank/frozen UI

## Copy-Paste Template

Use this template when adding new async operations:

```jsx
import { useGlobalLoading } from './LoadingContext.jsx';

function MyComponent() {
  const [error, setError] = useState("");
  const { setUiLoading } = useGlobalLoading();

  async function handleAction() {
    setError("");
    setUiLoading("Action in progress…");  // ← Customize this message
    try {
      // Your async code here
      const result = await api.doSomething();
      // Handle result
    } catch (e) {
      setError(e.message);
    } finally {
      setUiLoading("");
    }
  }

  return (
    <>
      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      <button onClick={handleAction}>Do Something</button>
    </>
  );
}
```

## Common Messages to Use

| Operation | Message |
|-----------|---------|
| Loading data | "Loading…" or "Loading instances…" |
| Saving | "Saving…" or "Saving project…" |
| Generating | "Generating XML…" or "Generating…" |
| Uploading | "Uploading file…" (use progress bar if progress available) |
| Importing | "Importing…" or "Processing import…" |
| Syncing | "Syncing…" or "Syncing data…" |
| Searching | "Searching…" |
| Deleting | "Deleting…" |

## Avoid These Mistakes

❌ **Don't forget to clear the spinner**
```jsx
// WRONG
async function handleSave() {
  setUiLoading("Saving…");
  await api.save();  // If this throws, spinner stays forever!
}

// RIGHT
async function handleSave() {
  setUiLoading("Saving…");
  try {
    await api.save();
  } finally {
    setUiLoading("");  // Always clear
  }
}
```

❌ **Don't set uiLoading in useEffect without cleanup**
```jsx
// WRONG
useEffect(() => {
  setUiLoading("Loading…");
  loadData();  // If component unmounts, spinner stays
}, []);

// RIGHT
useEffect(() => {
  let cancelled = false;
  (async () => {
    setUiLoading("Loading…");
    try {
      const data = await loadData();
      if (!cancelled) setData(data);
    } finally {
      if (!cancelled) setUiLoading("");
    }
  })();
  return () => { cancelled = true; };
}, []);
```

❌ **Don't use vague messages**
```jsx
// WRONG
setUiLoading("Please wait…");  // User doesn't know what's happening
setUiLoading("Working…");       // Too vague

// RIGHT
setUiLoading("Loading instances…");  // Specific to the action
setUiLoading("Generating XML…");     // Clear what's happening
```

## Debugging

If the spinner doesn't appear:

1. **Check that you're using `useGlobalLoading()`**
   ```jsx
   const { setUiLoading } = useGlobalLoading();  // Must be called
   ```

2. **Verify the message is set**
   ```jsx
   setUiLoading("My message");  // Must be truthy (non-empty string)
   ```

3. **Check browser console for errors**
   - Spinner.jsx won't load if there's a syntax error
   - Look for "LoadingContext is not exported" etc.

4. **Verify App.jsx has the Spinner rendered**
   ```jsx
   {uiLoading && <Spinner message={uiLoading} />}  // Should be present
   ```

If double-submits still happen:
- Use `useAsync()` hook instead for automatic debounce protection
- Or manually disable the button: `disabled={loading}`

---

**That's it!** You now have global loading feedback across your app. 🎉
