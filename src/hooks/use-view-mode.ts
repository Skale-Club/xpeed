import { useState, useCallback } from 'react';

export type ViewMode = 'simple' | 'advanced';

const STORAGE_KEY = 'xpeed-view-mode';

function readStored(): ViewMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'advanced' || v === 'simple') return v;
  } catch {}
  return 'simple';
}

export function useViewMode() {
  const [mode, setModeState] = useState<ViewMode>(readStored);

  const setMode = useCallback((next: ViewMode) => {
    setModeState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }, []);

  const toggle = useCallback(() => {
    setModeState(prev => {
      const next: ViewMode = prev === 'simple' ? 'advanced' : 'simple';
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      return next;
    });
  }, []);

  return { mode, setMode, toggle, isAdvanced: mode === 'advanced' };
}
