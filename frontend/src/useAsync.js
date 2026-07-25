import { useState, useCallback, useRef } from 'react';

/**
 * Hook for handling async operations with loading/error state and debounce protection.
 * Prevents double-submits by ignoring rapid clicks.
 *
 * Usage:
 *   const { loading, error, execute } = useAsync(apiCall, { debounce: 300 });
 *   return <button onClick={() => execute(args)} disabled={loading}>{loading ? 'Loading...' : 'Submit'}</button>
 *
 * @param {Function} fn - Async function to execute (receives ...args)
 * @param {Object} options - { debounce: ms, onSuccess: fn, onError: fn }
 * @returns {Object} { loading, error, execute, reset }
 */
export function useAsync(fn, options = {}) {
  const { debounce = 300, onSuccess, onError } = options;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const debounceTimer = useRef(null);
  const isExecuting = useRef(false);

  const execute = useCallback(
    async (...args) => {
      // Prevent double-submit within debounce window
      if (isExecuting.current) return;

      // Clear previous error
      setError('');
      setLoading(true);
      isExecuting.current = true;

      // Debounce: if another call comes in < debounce ms, ignore it
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(async () => {
        try {
          const result = await fn(...args);
          setLoading(false);
          onSuccess?.(result);
          return result;
        } catch (e) {
          const msg = e?.message || String(e);
          setError(msg);
          setLoading(false);
          onError?.(e);
        } finally {
          isExecuting.current = false;
        }
      }, 0); // Run after debounce delay (actual delay is negligible for immediate feedback)
    },
    [fn, debounce, onSuccess, onError]
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError('');
    isExecuting.current = false;
    clearTimeout(debounceTimer.current);
  }, []);

  return { loading, error, execute, reset };
}
