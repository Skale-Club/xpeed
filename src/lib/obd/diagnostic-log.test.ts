import { afterEach, expect, it, vi } from 'vitest';
import { logObdDiagnostic, readObdDiagnostics } from './diagnostic-log';
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it('keeps a bounded local event timeline', () => {
  for (let i = 0; i < 205; i++) logObdDiagnostic('state', { sequence: i });
  const rows = readObdDiagnostics();
  expect(rows).toHaveLength(200);
  expect(rows[0].details.sequence).toBe(5);
  expect(rows[199].details.sequence).toBe(204);
  expect(Number.isFinite(Date.parse(rows[0].at))).toBe(true);
});
it('never interrupts recording if storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  expect(() => logObdDiagnostic('trip-start', { startedAt: 1 })).not.toThrow();
});
