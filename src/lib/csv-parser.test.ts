import { describe, expect, it } from 'vitest';
import { parseCSV } from './csv-parser';
import { sessionDuration, sessionTimes } from './session-time';
import { buildScannerCsv } from './obd/session-csv';

describe('CSV import boundaries', () => {
  it('round-trips scanner columns with delimiters, quotes and newlines', () => {
    const columns = ['Custom, "sensor"\nvoltage'];
    const csv = buildScannerCsv(columns, [{ t: 0, values: { [columns[0]]: 12.4 } }, { t: 1, values: { [columns[0]]: 12.5 } }]);
    const parsed = parseCSV(csv);
    expect(parsed.headers).toEqual(['Time (s)', ...columns]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0][columns[0]]).toBe(12.4);
  });

  it('ignores quoted commas when detecting a semicolon export', () => {
    const parsed = parseCSV('Time (s);"Sensor,a,b,c"\r0;3\r1;4');
    expect(parsed.headers).toEqual(['Time (s)', 'Sensor,a,b,c']);
    expect(parsed.rows[1]['Sensor,a,b,c']).toBe(4);
  });

  it.each(['Time (s),Speed,Speed\n0,10,20', 'Time (s),\n0,10', 'Time (s),Speed\n0,10,20', 'Time (s),"Speed\n0,10'])('rejects ambiguous or truncated data: %s', (csv) => {
    expect(() => parseCSV(csv)).toThrow();
  });

  it('detects timestamps labelled Time even when the first time is missing', () => {
    const parsed = parseCSV('\uFEFFTime,Speed (km/h)\n,0\n2026-11-02T10:00:00Z,10\n2026-11-02T10:00:10Z,20');
    expect(parsed.timeColumn).toEqual({ type: 'timestamp', key: 'Time' });
    expect(sessionTimes(parsed)[0]).toBe(null);
    expect(sessionDuration(parsed)).toBe(10);
  });

  it('treats invalid timestamp cells as gaps that can be stored safely', () => {
    const parsed = parseCSV('Time,Speed (km/h)\nN/A,0\n2026-11-02T10:00:00Z,10\ninvalid,20\n2026-11-02T10:00:20Z,20');
    expect(parsed.timeColumn?.type).toBe('timestamp');
    expect(parsed.rows.map((row) => row.Time)).toEqual([null, '2026-11-02T10:00:00.000Z', null, '2026-11-02T10:00:20.000Z']);
    expect(sessionDuration(parsed)).toBe(20);
  });

  it.each([['ms', 1000], ['min', 1 / 60], ['h', 1 / 3600]] as const)('converts %s to seconds', (unit, step) => {
    const parsed = parseCSV(`Time (${unit}),Speed (km/h)\n0,10\n${step * 10},20\n${step * 20},20`);
    expect(sessionDuration(parsed)).toBe(20);
    expect(sessionTimes(parsed)).toEqual([0, 10, 20]);
  });

  it('does not accept Infinity as a sensor number', () => {
    const parsed = parseCSV('Time (s),Speed (km/h)\n0,Infinity\n1,12');
    expect(typeof parsed.rows[0]['Speed (km/h)']).not.toBe('number');
  });
});
