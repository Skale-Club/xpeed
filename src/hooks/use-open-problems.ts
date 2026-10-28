import { useEffect, useState } from 'react';
import { getIssuesForCar, type VehicleIssue } from '@/lib/db-issues';
import { isOpenProblem } from '@/lib/problems';

/**
 * The car's problems that still need attention (same list as the Problems
 * page). `refreshKey` reloads it, e.g. after a trip was saved.
 */
export function useOpenProblems(carId: string | null | undefined, refreshKey?: unknown) {
  const [problems, setProblems] = useState<VehicleIssue[]>([]);

  useEffect(() => {
    if (!carId) {
      setProblems([]);
      return;
    }
    let cancelled = false;
    getIssuesForCar(carId)
      .then((all) => { if (!cancelled) setProblems(all.filter(isOpenProblem)); })
      .catch((err) => console.warn('Could not load problems:', err));
    return () => { cancelled = true; };
  }, [carId, refreshKey]);

  return problems;
}
