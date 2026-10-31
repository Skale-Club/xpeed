import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getIssuesForCar, type VehicleIssue } from '@/lib/db-issues';
import { isOpenProblem } from '@/lib/problems';
import { queryClient } from '@/lib/query-client';
export function notifyProblemsChanged() { void queryClient.invalidateQueries({ queryKey: ['vehicle-issues'] }); }
export function useVehicleIssues(carId: string | null | undefined, refreshKey?: unknown) {
  const query = useQuery({ queryKey: ['vehicle-issues', carId], queryFn: () => getIssuesForCar(carId!), enabled: !!carId, retry:false }, queryClient);
  useEffect(() => { if (refreshKey && carId) void queryClient.invalidateQueries({ queryKey: ['vehicle-issues', carId] }, {cancelRefetch:false}); }, [carId, refreshKey]);
  return query;
}
const NONE: VehicleIssue[] = [];
export function useOpenProblems(carId: string | null | undefined, refreshKey?: unknown) {
  const query = useVehicleIssues(carId, refreshKey);
  const problems = useMemo(() => query.data?.filter(isOpenProblem) ?? NONE, [query.data]);
  return { problems, loading: !!carId && query.isPending, error: !!carId && query.isError && !query.data,
    refreshError: !!carId && query.isError, reload: query.refetch };
}
