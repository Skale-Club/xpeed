import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
const sync = vi.hoisted(() => vi.fn(async (_id?: string) => undefined));
vi.mock('@/lib/problem-sync',()=>({syncSavedProblems:sync}));
const recordings = vi.hoisted(() => ({ hasRecordedReceipt: vi.fn(), storeRecordedSession: vi.fn() }));
vi.mock('@/lib/recorded-session', async (original) => ({ ...await original<typeof import('@/lib/recorded-session')>(), ...recordings }));

const db = vi.hoisted(() => ({
  createSession: vi.fn(),
  insertSessionRows: vi.fn(),
  insertSessionFlags: vi.fn(),
  uploadSessionCSV: vi.fn(),
  removeSessionCSV: vi.fn(),
  deleteSession: vi.fn(),
  getCarById: vi.fn(),
  storeSessionReport: vi.fn(),
  updateSessionVersioning: vi.fn(),
  updateSessionWithGeminiAnalysis: vi.fn(),
}));

vi.mock('@/lib/db', () => db);
vi.mock('@/lib/db-extras', () => ({ refreshParameterBaselines: vi.fn(async () => undefined) }));
vi.mock('@/lib/issue-reconciler', () => ({
  reconcileIssues: vi.fn(async () => undefined),
  syncAiWarnings: vi.fn(async () => undefined),
  syncFaultCodes: vi.fn(async () => undefined),
}));
vi.mock('@/lib/ai-client', () => ({ analyzeSessionById: vi.fn(async () => null) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) } },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ingestSessionCsv } from './use-csv-upload';

const CSV = 'Time,Engine RPM,Coolant Temp\n0,800,70\n1,900,72\n2,950,75\n';
// jsdom's File has no text(); the ingest only needs the name and the text.
const file = () => Object.assign(new File([CSV], 'xpeed-scan_2026-10-28 15-30-00.csv', { type: 'text/csv' }), {
  text: async () => CSV,
});
afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.clearAllMocks();
  recordings.hasRecordedReceipt.mockResolvedValue(false);
  recordings.storeRecordedSession.mockResolvedValue(true);
  db.getCarById.mockResolvedValue({ id: 'car-1', make: 'Toyota', model: 'Prius', year: 2010, engine_type: 'hybrid' });
  db.createSession.mockResolvedValue({ id: 's-1' });
  db.insertSessionRows.mockResolvedValue(undefined);
  db.insertSessionFlags.mockResolvedValue(undefined);
  db.uploadSessionCSV.mockResolvedValue('u1/car-1/file.csv');
  db.storeSessionReport.mockResolvedValue(undefined);
  db.updateSessionVersioning.mockResolvedValue(undefined);
  db.deleteSession.mockResolvedValue(undefined);
  db.removeSessionCSV.mockResolvedValue(undefined);
});

describe('recorded CSV commits are idempotent', () => {
  const identity = { sessionId: 'stable-recording', userId: 'u1' };
  it('recognizes a committed trip before uploading or spending AI again', async () => {
    recordings.hasRecordedReceipt.mockResolvedValue(true);
    const stored = vi.fn();
    const result = await ingestSessionCsv(file(), 'car-1', undefined, undefined, stored, undefined, identity);
    expect(result.sessionId).toBe(identity.sessionId);
    expect(stored).toHaveBeenCalledWith(identity.sessionId, false);
    expect(db.uploadSessionCSV).not.toHaveBeenCalled();
    expect(db.createSession).not.toHaveBeenCalled();
    expect(recordings.storeRecordedSession).not.toHaveBeenCalled();
  });
  it('publishes original and all derivatives through one transaction', async () => {
    const stored = vi.fn();
    const exact = { ...identity, startedAt: '2026-10-28T22:30:00.123Z' };
    await ingestSessionCsv(file(), 'car-1', undefined, undefined, stored, undefined, exact);
    expect(recordings.storeRecordedSession).toHaveBeenCalledTimes(1);
    const args = recordings.storeRecordedSession.mock.calls[0];
    expect(args[7].ruleset_id).toBe('toyota-prius-g3');
    expect(args[0]).toEqual(exact);
    expect(args[4]).toBe(exact.startedAt);
    expect(args[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(args[7]).toMatchObject({ rows: expect.any(Array), flags: expect.any(Array), summary: expect.any(Object), report: expect.any(Object) });
    expect(db.insertSessionRows).not.toHaveBeenCalled();
    expect(db.insertSessionFlags).not.toHaveBeenCalled();
    expect(stored).toHaveBeenCalledWith(identity.sessionId, true);
  });
  it('keeps the backup and never deletes the identity after a lost transaction response', async () => {
    recordings.storeRecordedSession.mockRejectedValue(new Error('network response lost'));
    const stored = vi.fn();
    await expect(ingestSessionCsv(file(), 'car-1', undefined, undefined, stored, undefined, identity)).rejects.toThrow(/lost/);
    expect(stored).not.toHaveBeenCalled();
    expect(db.deleteSession).not.toHaveBeenCalled();
    expect(db.removeSessionCSV).not.toHaveBeenCalled();
  });
  it('marks a receipt committed by another attempt as already saved', async () => {
    recordings.storeRecordedSession.mockResolvedValueOnce(false);
    const stored = vi.fn();
    await ingestSessionCsv(file(), 'car-1', undefined, undefined, stored, undefined, identity);
    expect(stored).toHaveBeenCalledOnce();
    expect(stored).toHaveBeenCalledWith(identity.sessionId, false);
  });
});

describe('ingestSessionCsv keeps the phone copy until the trip is really saved', () => {
  it('calls onStored once everything is in the database', async () => {
    const onStored = vi.fn();
    const result = await ingestSessionCsv(file(), 'car-1', undefined, undefined, onStored);
    expect(result.sessionId).toBe('s-1');
    expect(onStored).toHaveBeenCalledTimes(1);
    expect(onStored).toHaveBeenCalledWith('s-1');
    expect(db.deleteSession).not.toHaveBeenCalled();
  });

  it('does NOT call onStored when the rows fail to save, and rolls the trip back', async () => {
    db.insertSessionRows.mockRejectedValueOnce(new Error('Failed to save trip data: timeout'));
    const onStored = vi.fn();
    await expect(ingestSessionCsv(file(), 'car-1', undefined, undefined, onStored)).rejects.toThrow(/timeout/);
    expect(onStored).not.toHaveBeenCalled();
    expect(db.deleteSession).toHaveBeenCalledWith('s-1');
  });

  it('does NOT call onStored when the flags fail to save', async () => {
    db.insertSessionFlags.mockRejectedValueOnce(new Error('Failed to save trip flags: denied'));
    const onStored = vi.fn();
    await expect(ingestSessionCsv(file(), 'car-1', undefined, undefined, onStored)).rejects.toThrow(/denied/);
    expect(onStored).not.toHaveBeenCalled();
    expect(db.deleteSession).toHaveBeenCalledWith('s-1');
  });

  it('does NOT call onStored when the trip row itself is refused', async () => {
    db.createSession.mockRejectedValueOnce(new Error('Failed to save the trip: row-level security'));
    const onStored = vi.fn();
    await expect(ingestSessionCsv(file(), 'car-1', undefined, undefined, onStored)).rejects.toThrow(/row-level security/);
    expect(onStored).not.toHaveBeenCalled();
    expect(db.insertSessionRows).not.toHaveBeenCalled();
  });
});

describe('ingestSessionCsv and the stored CSV', () => {
  it('keeps the CSV out of the sessions row when storage took it', async () => {
    await ingestSessionCsv(file(), 'car-1');
    const args = db.createSession.mock.calls[0];
    expect(args[7]).toBe('u1/car-1/file.csv'); // source_file_path
    expect(args[8]).toBeNull(); // source_csv
  });

  it('falls back to the sessions row only when the storage upload failed', async () => {
    db.uploadSessionCSV.mockRejectedValueOnce(new Error('Failed to upload CSV file: denied'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingestSessionCsv(file(), 'car-1');
    const args = db.createSession.mock.calls[0];
    expect(args[7]).toBeNull();
    expect(args[8]).toBe(CSV);
    warn.mockRestore();
  });
});

it('retries durable problem work when a prior trip receipt is recognized',async()=>{
 sync.mockRejectedValueOnce(new Error('offline'));
 const identity={sessionId:'retry-alerts',userId:'u1'};
 await ingestSessionCsv(file(),'car-1',undefined,undefined,undefined,undefined,identity);
 recordings.hasRecordedReceipt.mockResolvedValue(true);
 await ingestSessionCsv(file(),'car-1',undefined,undefined,undefined,undefined,identity);
 expect(sync.mock.calls.filter(([id])=>id===identity.sessionId)).toHaveLength(2);
});
it('commits the complete fault inspection with the original recording',async()=>{
 const faultCodes={stored:[],pending:['P0300'],permanent:['P0420'],checked:true,complete:false,modules:['7E0']};
 await ingestSessionCsv(file(),'car-1',undefined,undefined,undefined,faultCodes,{sessionId:'pending',userId:'u1'});
 expect(recordings.storeRecordedSession.mock.calls[0][7].summary.faultCodes).toEqual(faultCodes);
});
it('does not acknowledge an imported trip until its durable issue job can be queued',async()=>{
 db.updateSessionVersioning.mockRejectedValueOnce(new Error('version commit failed'));
 const onStored=vi.fn();
 await expect(ingestSessionCsv(file(),'car-1',undefined,undefined,onStored)).rejects.toThrow(/version commit failed/);
 expect(onStored).not.toHaveBeenCalled();
 expect(db.deleteSession).toHaveBeenCalledWith('s-1');
});
