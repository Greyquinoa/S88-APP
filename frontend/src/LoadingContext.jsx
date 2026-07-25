import React, { createContext, useContext } from 'react';

/**
 * Global loading context for coordinating UI feedback across the app.
 * Usage:
 *   const { setLoading } = useGlobalLoading();
 *   setLoading("Action in progress...");
 */
const GlobalLoadingContext = createContext(null);

export function useGlobalLoading() {
  const ctx = useContext(GlobalLoadingContext);
  if (!ctx) throw new Error('useGlobalLoading must be used within GlobalLoadingProvider');
  return ctx;
}

export function GlobalLoadingProvider({ children, uiLoading, setUiLoading }) {
  return (
    <GlobalLoadingContext.Provider value={{ uiLoading, setUiLoading }}>
      {children}
    </GlobalLoadingContext.Provider>
  );
}
