import { describe, it, expect, vi, beforeEach } from 'vitest';

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

beforeEach(() => {
  vi.clearAllMocks();
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
