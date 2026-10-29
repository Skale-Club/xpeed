import { describe, expect, it } from 'vitest';
import type { Session } from '@/types/session';
import { aggregateTrends, trendMetrics } from './long-term-trends';
const session = (at: string, avg: number | null, duration = 60): Session => ({
  session_start: at, uploaded_at: at, duration_seconds: duration,
  summary: { summaries: [{ canonical_key: 'vehicle_speed', label: 'Vehicle speed', unit: 'km/h', avg, min: avg == null ? null : 0, max: avg }] },
} as Session);
describe('long-term summaries', () => {
  it('weights by duration rather than giving a short trip the same weight as a long one', () => {
    const data = aggregateTrends([session('2026-01-01T12:00:00Z', 10, 60), session('2026-01-02T12:00:00Z', 30, 180)], 'vehicle_speed', 'month', 'UTC');
    expect(data).toEqual([{ period: '2026-01', trips: 2, covered: 2, avg: 25, min: 0, max: 30 }]);
  });
  it('retains zero readings but leaves absent months and measurements as gaps', () => {
    const data = aggregateTrends([session('2026-01-01T12:00:00Z', 0), session('2026-03-01T12:00:00Z', null)], 'vehicle_speed', 'month', 'UTC');
    expect(data[0].avg).toBe(0);
    expect(data[1]).toMatchObject({ period: '2026-02', trips: 0, avg: null });
    expect(data[2]).toMatchObject({ period: '2026-03', trips: 1, covered: 0, avg: null });
  });
  it('groups according to the configured timezone and works across years', () => {
    const data = aggregateTrends([session('2026-01-01T01:00:00Z', 20), session('2027-06-01T12:00:00Z', 40)], 'vehicle_speed', 'year', 'America/New_York');
    expect(data.map((row) => row.period)).toEqual(['2025', '2026', '2027']);
    expect(data[1].avg).toBeNull();
  });
  it('excludes invalid or wholly absent metrics from the selector', () => {
    const rows = [session('2026-01-01T00:00:00Z', 20), session('2026-01-01T00:00:00Z', null)];
    expect(trendMetrics(rows)).toEqual([{ key: 'vehicle_speed', label: 'Vehicle speed', unit: 'km/h' }]);
  });
});
