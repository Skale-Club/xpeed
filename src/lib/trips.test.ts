import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '@/lib/i18n';
import {
  formatDistance, formatDuration, publicAppUrl, tripDistanceKm, tripProblems, tripTitle,
} from './trips';
import type { SessionFlag } from '@/types/session';

const session = (over: Record<string, unknown> = {}) => ({
  source_filename: 'xpeed-scan_2026-10-28 15-30-00.csv',
  session_start: '2026-10-28T18:30:00Z',
  uploaded_at: '2026-10-28T19:00:00Z',
  duration_seconds: 1800,
  summary: { summaries: [{ canonical_key: 'vehicle_speed', avg: 40 }] },
  ...over,
});

beforeAll(async () => {
  await i18n.changeLanguage('pt-BR');
});

describe('trip facts', () => {
  it('estimates distance from average speed and duration', () => {
    expect(tripDistanceKm(session() as never)).toBe(20);
    expect(tripDistanceKm(session({ summary: null }) as never)).toBeNull();
    expect(formatDistance(20, 'km')).toBe('20 km');
    expect(formatDistance(20, 'mi')).toBe('12 mi');
    expect(formatDistance(5, 'mi')).toBe('3.1 mi');
    expect(formatDistance(null, 'km')).toBeNull();
  });

  it('formats durations for people', () => {
    expect(formatDuration(1800)).toBe('30 min');
    expect(formatDuration(20)).toBe('1 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
    expect(formatDuration(0)).toBeNull();
  });

  it('names trips by date unless the user renamed them', () => {
    expect(tripTitle(session() as never, i18n.t, 'pt-BR')).toMatch(/^Viagem \d+ de out/);
    expect(tripTitle(session({ source_filename: 'Trip 28 Oct, 15:30' }) as never, i18n.t, 'pt-BR')).toMatch(/^Viagem /);
    expect(tripTitle(session({ source_filename: 'Ida pra praia' }) as never, i18n.t, 'pt-BR')).toBe('Ida pra praia');
  });
});

describe('tripProblems', () => {
  const flag = (canonical_key: string, severity: string, message = canonical_key) =>
    ({ canonical_key, severity, message }) as unknown as SessionFlag;

  it('keeps one entry per kind with the worst severity, plus fault codes', () => {
    const problems = tripProblems(
      [flag('coolant_temp', 'attention'), flag('coolant_temp', 'critical'), flag('engine_rpm', 'normal'), flag('stft_b1', 'attention')],
      ['P0420'],
    );
    expect(problems.map((p) => [p.canonical_key, p.severity])).toEqual([
      ['coolant_temp', 'critical'],
      ['stft_b1', 'serious'],
      ['dtc:P0420', expect.any(String)],
    ]);
    expect(tripProblems([], null)).toEqual([]);
  });
});

describe('publicAppUrl', () => {
  it('uses the current site on the web', () => {
    expect(publicAppUrl()).toBe(window.location.origin);
  });
});
