import { useMemo } from 'react';
import { useLapLibrary } from '@/hooks/use-lap-library';
import { mergeLaps, useAccountLaps, type LapEntry } from '@/lib/sim/account-laps';

/** Every lap the person has: the ones in the account and the ones kept on this device, each lap once. */
export function useSimLaps() {
  const library = useLapLibrary();
  const account = useAccountLaps(library.userId);
  const serverLaps = account.data;
  const laps = useMemo<LapEntry[]>(
    () => (library.userId ? mergeLaps(library.userId, library.laps, serverLaps ?? []) : []),
    [library.userId, library.laps, serverLaps],
  );
  // The device decides readiness: the account is a bonus that may be slow or unreachable.
  const settled = library.status !== 'loading' && !account.isLoading;
  return { laps, serverLaps: serverLaps ?? [], library, status: library.status, settled, userId: library.userId };
}
