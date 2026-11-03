import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { ObdScannerProvider } from './ObdScannerContext';
import type { TripResult } from '@/hooks/use-obd-scanner';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import * as trips from '@/lib/obd/trip-store';
import { buildScannerCsv } from '@/lib/obd/session-csv';

const h = vi.hoisted(() => ({ end: null as null | ((trip: TripResult) => void), ingest: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ cars: [{ id: 'car', name: 'Car' }], selectedCarId: 'car', loading: false }) }));
vi.mock('@/hooks/use-obd-scanner', () => ({ useObdScanner: (options: { onTripEnd: typeof h.end }) => {
  h.end = options.onTripEnd;
  return { vin: null, status: 'idle', recording: null, connect: vi.fn(), linkOpen: false };
} }));
vi.mock('@/lib/obd/trip-cloud',()=>({ recoverCloudTrips:async()=>[], checkpointTrip:async()=>50, removeCloudTrip:async()=>{}, finalizeCloudTrip:async()=>null }));
vi.mock('@/hooks/use-wake-lock', () => ({ useScreenWakeLock: vi.fn() }));
vi.mock('@/lib/obd/elm327', () => ({ isBluetoothAvailable: () => false }));
vi.mock('@/lib/db', () => ({ findSessionStartedAt: async () => null }));
vi.mock('@/hooks/use-csv-upload', () => ({ ingestSessionCsv: h.ingest }));
let idb: FakeIdb;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  idb = installFakeIndexedDb();
  h.ingest.mockReset().mockImplementation(async (_file: File, _car: string, _name: string, _progress: unknown, onStored: () => Promise<void>) => {
    await onStored();
    return { sessionId: 'saved' };
  });
});
afterEach(() => { cleanup(); idb.uninstall(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uploads the complete memory copy when a failed final backup leaves a partial durable copy', async () => {
  const startedAt = new Date('2026-11-02T10:00:00Z');
  const samples = Array.from({ length: 91 }, (_, t) => ({ t, values: { Speed: t } }));
  const id = trips.tripKey(startedAt.getTime());
  await trips.saveTripCopy({ id, carId: 'car', userId: 'owner', startedAt: startedAt.getTime(), columns: ['Speed'], samples: samples.slice(0, 61) });
  vi.spyOn(trips, 'saveTripCopy').mockResolvedValueOnce(false);
  render(<ObdScannerProvider><div /></ObdScannerProvider>);
  const trip = { startedAt, endedAt: new Date(startedAt.getTime() + 90_000), columns: ['Speed'], samples, dtcs: [], faultCodes: { stored: [], pending: [], checked: false, modules: [], codeModules: {} } } as unknown as TripResult;
  await act(async () => h.end?.(trip));
  await waitFor(() => expect(h.ingest).toHaveBeenCalledTimes(1));
  const file = h.ingest.mock.calls[0][0] as File;
  expect(file.size).toBe(new Blob([buildScannerCsv(['Speed'], samples)]).size);
  expect(await trips.listTripCopies()).toEqual([]);
});
