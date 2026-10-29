import { describe, expect, it } from 'vitest';
import { parseCSV } from './csv-parser';
import { computeParameterSummaries, evaluateRules } from './insight-engine';
import { GENERIC_PETROL_RULES } from './default-rules/generic-petrol';
import { sessionDuration } from './session-time';

const coolant = GENERIC_PETROL_RULES.filter((r) => r.canonical_key === 'coolant_temp');
const csv = (header: string, values: string[]) => parseCSV(`${header}\n${values.join('\n')}`);

describe('diagnostics use physical units and elapsed time', () => {
  it('does not flag 194 Fahrenheit as 194 Celsius, and converts mph', () => {
    const parsed = csv('Time (s),Coolant (F),Vehicle speed (mph)', Array.from({ length: 40 }, (_, i) => `${i},194,60`));
    expect(evaluateRules(parsed, coolant)).toEqual([]);
    const summary = computeParameterSummaries(parsed);
    expect(summary.find((p) => p.canonical_key === 'coolant_temp')?.avg).toBeCloseTo(90);
    expect(summary.find((p) => p.canonical_key === 'vehicle_speed')?.avg).toBeCloseTo(96.56064);
  });

  it('produces the same critical alert for seconds and timestamps', () => {
    const seconds = csv('Time (s),Coolant (C)', ['0,120', '10,120', '20,120']);
    const timestamps = csv('Timestamp,Coolant (C)', ['2026-10-28T00:00:00Z,120', '2026-10-28T00:00:10Z,120', '2026-10-28T00:00:20Z,120']);
    expect(evaluateRules(timestamps, coolant)).toEqual(evaluateRules(seconds, coolant));
    expect(evaluateRules(seconds, coolant)[0]).toMatchObject({ severity: 'critical', evidence: { longest_streak_s: 20 } });
    expect(sessionDuration(timestamps)).toBe(20);
  });

  it('does not connect critical readings across missing sensor values', () => {
    const parsed = csv('Time (s),Coolant (C)', ['0,120', '10,', '20,120']);
    expect(evaluateRules(parsed, coolant)).toEqual([]);
  });

  it('uses irregular intervals and does not invent an extra interval after the last row', () => {
    const parsed = csv('Time (s),Coolant (C)', ['0,120', '2,120', '14,120']);
    expect(evaluateRules(parsed, coolant)).toEqual([]); // critical needs 15 actual seconds
  });

  it('rejects backward time instead of fabricating a duration', () => {
    const parsed = csv('Time (s),Coolant (C)', ['10,120', '0,120']);
    expect(() => evaluateRules(parsed, coolant)).toThrow(/chronological/);
  });

  it('converts declared units in long-format exports', () => {
    const parsed = csv('Time,PID,VALUE,UNITS', ['0,Coolant,194,F', '20,Coolant,194,F']);
    expect(computeParameterSummaries(parsed)[0]).toMatchObject({ canonical_key: 'coolant_temp', avg: 90, unit: '°C' });
  });

  it('refuses an unrecognized explicit temperature unit', () => {
    expect(() => csv('Time,Coolant (bananas)', ['0,120'])).toThrow(/Unsupported unit/);
  });
});
