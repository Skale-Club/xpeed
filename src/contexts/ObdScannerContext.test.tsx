import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { listTripCopies, saveTripCopy, tripKey, type StoredTrip } from '@/lib/obd/trip-store';
import { ObdScannerProvider } from './ObdScannerContext';
import * as tripStore from '@/lib/obd/trip-store';
import { recordedSessionId } from '@/lib/recording-identity';
import { webcrypto } from 'node:crypto';

// Trip copies kept on the device are uploaded for the right user, one at a time and once each.

const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  selectedCarId: 'car-1' as string | null,
  cars: [{ id: 'car-1' }] as { id: string }[],
  ingestDelayMs: 0,
}));

const cloud = vi.hoisted(() => ({ checkpoint: vi.fn(async (_meta, samples) => samples.length), finalize: vi.fn(async (_trip: unknown): Promise<string> => { throw Error('Cloud finalization pending'); }), recover: vi.fn(async () => []), remove: vi.fn(async () => {}) }));
vi.mock('@/lib/obd/trip-cloud', () => ({ checkpointTrip: cloud.checkpoint, finalizeCloudTrip: cloud.finalize, recoverCloudTrips: cloud.recover, removeCloudTrip: cloud.remove }));
const ingest = vi.hoisted(() => vi.fn());
const deleteSession = vi.hoisted(() => vi.fn(async () => undefined));
const findSessionStartedAt = vi.hoisted(() => vi.fn(async () => null as string | null));

vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ cars: h.cars, selectedCarId: h.selectedCarId, selectedCar: { name: 'Prius' }, loading: false }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('@/hooks/use-csv-upload', () => ({ ingestSessionCsv: ingest }));
vi.mock('@/lib/db', () => ({ findSessionStartedAt, deleteSession }));

let idb: FakeIdb;

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  idb = installFakeIndexedDb();
  h.user = { id: 'u1' };
  h.selectedCarId = 'car-1';
  h.cars = [{ id: 'car-1' }];
  h.ingestDelayMs = 0;
  cloud.checkpoint.mockClear(); cloud.finalize.mockClear(); cloud.recover.mockClear(); cloud.remove.mockClear();
  ingest.mockReset();
  deleteSession.mockClear();
  findSessionStartedAt.mockReset();
  findSessionStartedAt.mockResolvedValue(null);
  // Like the real one: after storing the trip, the callback removes the device copy.
  ingest.mockImplementation(async (_file: File, _car: string, _name: string, _p: unknown, onStored?: (id: string) => Promise<void>) => {
    if (h.ingestDelayMs) await new Promise((r) => setTimeout(r, h.ingestDelayMs));
    await onStored?.('session');
    return { sessionId: 'session', rows: 1, flags: 0, dtcs: 0 };
  });
});

afterEach(() => {
  cleanup();
  idb.uninstall();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const samples = (seconds: number) => Array.from({ length: seconds + 1 }, (_, t) => ({ t, values: { speed: 40 } }));
const copy = (startedAt: number, over: Partial<StoredTrip> = {}): StoredTrip => ({
  id: tripKey(startedAt), carId: 'car-1', userId: 'u1', startedAt, endedAt: startedAt + 90_000, columns: ['speed'], samples: samples(90), ...over,
});
const ingestedStarts = () => ingest.mock.calls.map((c) => (c[0] as File).name);
const mount = () => render(<ObdScannerProvider><div /></ObdScannerProvider>);

describe('trip copies on the device', () => {
  it('uploads only the signed-in user\'s copies', async () => {
    await saveTripCopy(copy(1_000_000));
    await saveTripCopy(copy(2_000_000, { userId: 'someone-else' }));
    // Older copies don't say who they belong to: theirs if the car is the user's, otherwise they wait
    await saveTripCopy(copy(3_000_000, { userId: undefined, carId: 'car-1' }));
    await saveTripCopy(copy(4_000_000, { userId: undefined, carId: 'a-car-of-another-account' }));
    mount();
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    expect(ingest.mock.calls.map((c) => c[1])).toEqual(['car-1', 'car-1']);
    const left = (await listTripCopies()).map((t) => t.startedAt);
    expect(left).toEqual([2_000_000, 4_000_000]);
  });

  it('sends a copy recorded before any car was chosen to the car chosen since, for its own user only', async () => {
    h.selectedCarId = 'car-1';
    await saveTripCopy(copy(1_000_000, { carId: null }));
    await saveTripCopy(copy(2_000_000, { carId: null, userId: 'someone-else' }));
    mount();
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(ingest.mock.calls[0][1]).toBe('car-1');
    expect((await listTripCopies()).map((t) => t.startedAt)).toEqual([2_000_000]);
  });

  it('uploads each copy once even when a retry starts while another is still going', async () => {
    h.ingestDelayMs = 80;
    await saveTripCopy(copy(1_000_000));
    await saveTripCopy(copy(2_000_000));
    await saveTripCopy(copy(3_000_000));
    mount();
    // Overlapping retries (connection back, timer): they work from lists made before earlier uploads finished.
    await new Promise((r) => setTimeout(r, 30));
    act(() => { window.dispatchEvent(new Event('online')); });
    await new Promise((r) => setTimeout(r, 60));
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(3), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(ingest).toHaveBeenCalledTimes(3);
    expect(new Set(ingestedStarts()).size).toBe(3);
    // Nothing that was already saved got deleted and saved again
    expect(deleteSession).not.toHaveBeenCalled();
    expect(await listTripCopies()).toEqual([]);
  });

  it('preserves an ambiguous legacy upload and its backup for review', async () => {
    findSessionStartedAt.mockResolvedValue('partial-session');
    await saveTripCopy(copy(1_000_000));
    mount();
    await waitFor(() => expect(findSessionStartedAt).toHaveBeenCalled());
    expect(ingest).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(await listTripCopies()).toHaveLength(1);
  });

  it('reuses the same owner-scoped identity if deleting the uploaded backup fails', async () => {
    await saveTripCopy(copy(1_000_000));
    vi.spyOn(tripStore, 'deleteTripCopy').mockResolvedValueOnce(false);
    mount();
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(await listTripCopies()).toHaveLength(1);
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    expect(ingest.mock.calls[0][6]).toEqual(ingest.mock.calls[1][6]);
    expect(ingest.mock.calls[0][6]).toMatchObject({ userId: 'u1' });
    expect(deleteSession).not.toHaveBeenCalled();
    await waitFor(async () => expect(await listTripCopies()).toEqual([]));
  });

  it('retries a recording cut off by a crash on every retry, not only the first one after start', async () => {
    mount();
    await new Promise((r) => setTimeout(r, 100)); // the first retry, with nothing to do
    expect(ingest).not.toHaveBeenCalled();
    // A crashed recording turns up (its backup was written meanwhile)
    await saveTripCopy(copy(1_000_000, { endedAt: undefined, samples: samples(120) }));
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(await listTripCopies()).toEqual([]);
  });

  it('drops a cut-off recording that was too short to be a trip, without uploading it', async () => {
    await saveTripCopy(copy(1_000_000, { endedAt: undefined, samples: samples(20) }));
    mount();
    await waitFor(async () => expect(await listTripCopies()).toEqual([]));
    expect(ingest).not.toHaveBeenCalled();
  });

  it('uploads nothing while nobody is signed in', async () => {
    h.user = null;
    await saveTripCopy(copy(1_000_000));
    mount();
    await new Promise((r) => setTimeout(r, 200));
    expect(ingest).not.toHaveBeenCalled();
    expect(await listTripCopies()).toHaveLength(1);
  });
});

it('recovers a failed final upload from cloud chunks before dropping the device copy', async () => {
  const trip = copy(Date.now() - 120000);
  await saveTripCopy(trip);
  ingest.mockRejectedValueOnce(new Error('direct database upload failed'));
  cloud.finalize.mockImplementationOnce(async value => {
    const stored = value as StoredTrip;
    return recordedSessionId(stored.userId!, stored.carId!, stored.id);
  });
  mount();
  await waitFor(() => expect(cloud.finalize).toHaveBeenCalledOnce());
  await waitFor(async () => expect(await listTripCopies()).toHaveLength(0));
  expect(cloud.checkpoint.mock.calls.some(call => (call[0] as { totalSamples?: number }).totalSamples === trip.samples.length)).toBe(true);
});
