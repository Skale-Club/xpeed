import { useCallback, useEffect, useState } from 'react';
import { getIssuesForCar, type VehicleIssue } from '@/lib/db-issues';
import { isOpenProblem } from '@/lib/problems';

// Pages that change a problem (fixed, ignored, reopened) tell everyone who shows
// the list — the home card, the tab-bar badge — to load it again.
const listeners = new Set<() => void>();

export function notifyProblemsChanged() {
  listeners.forEach((fn) => fn());
}

interface State {
  carId: string | null;
  problems: VehicleIssue[] | null;
  failed: boolean;
}

const NONE: VehicleIssue[] = [];

/**
 * The car's problems that still need attention (same list as the Problems
 * page). `refreshKey` reloads it, e.g. after a trip was saved.
 *
 * `loading` and `error` matter: an empty list only means "all good" once it
 * has loaded without error. A refresh that fails keeps the last good list.
 */
export function useOpenProblems(carId: string | null | undefined, refreshKey?: unknown) {
  const [state, setState] = useState<State>({ carId: null, problems: null, failed: false });
  const [bump, setBump] = useState(0);

  useEffect(() => {
    const onChange = () => setBump((n) => n + 1);
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
  }, []);

  useEffect(() => {
    if (!carId) return;
    let cancelled = false;
    getIssuesForCar(carId)
      .then((all) => { if (!cancelled) setState({ carId, problems: all.filter(isOpenProblem), failed: false }); })
      .catch((err) => {
        console.warn('Could not load problems:', err);
        if (!cancelled) setState((prev) => ({ carId, problems: prev.carId === carId ? prev.problems : null, failed: true }));
      });
    return () => { cancelled = true; };
  }, [carId, refreshKey, bump]);

  // Try again after a failure: show "checking" again until the answer comes.
  const reload = useCallback(() => {
    setState((prev) => (prev.failed ? { ...prev, failed: false } : prev));
    setBump((n) => n + 1);
  }, []);

  if (!carId) return { problems: NONE, loading: false, error: false, refreshError: false, reload };
  const current = state.carId === carId ? state : null;
  const problems = current?.problems ?? null;
  return {
    problems: problems ?? NONE,
    loading: problems === null && !current?.failed,
    error: problems === null && !!current?.failed,
    refreshError: !!current?.failed,
    reload,
  };
}
