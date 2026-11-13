import { describe, expect, it } from 'vitest';
import { buildSyntheticLap, exampleCorners } from '@/lib/sim/synthetic-lap';
import type { LapFile } from '@/lib/sim/lap-file';
import { sectorStrip } from '@/lib/sim/sector-strip';

const lap = (sectorsMs: number[] | undefined, extra: { valid?: boolean; outLap?: boolean } = {}): LapFile => {
  const built = buildSyntheticLap({ lengthM: 4200, corners: exampleCorners(), hz: 10, sectorsMs, ...extra }).lap;
  // The header time is what the sectors add up to, so the strip is not refused for a sum that does not match.
  return sectorsMs ? { ...built, header: { ...built.header, lap: { ...built.header.lap, timeMs: sectorsMs.reduce((s, v) => s + v, 0) } } } : built;
};

describe('the sector strip', () => {
  const mine = lap([31_000, 40_500, 28_000]); // 99.5 s
  const best = lap([31_400, 39_800, 27_600]); // 98.8 s

  it('puts both laps side by side with the difference of each sector', () => {
    const strip = sectorStrip(mine, best)!;
    expect(strip.sectors.map((s) => [s.sector, s.lapMs, s.referenceMs, s.deltaMs])).toEqual([
      [1, 31_000, 31_400, -400],
      [2, 40_500, 39_800, 700],
      [3, 28_000, 27_600, 400],
    ]);
  });

  it('colours the better of the two purple and the other yellow, in every sector', () => {
    const strip = sectorStrip(mine, best)!;
    expect(strip.sectors.map((s) => [s.lapTone, s.referenceTone])).toEqual([
      ['purple', 'yellow'],
      ['yellow', 'purple'],
      ['yellow', 'purple'],
    ]);
  });

  it('says what each lap left on the table, sector by sector and in all', () => {
    const strip = sectorStrip(mine, best)!;
    expect(strip.sectors.map((s) => s.lapLeftMs)).toEqual([0, 700, 400]);
    expect(strip.sectors.map((s) => s.referenceLeftMs)).toEqual([400, 0, 0]);
    expect(strip.lapLeftMs).toBe(1100);
    expect(strip.referenceLeftMs).toBe(400);
  });

  it('gives the theoretical best of the two laps and what it would take off the faster one', () => {
    const strip = sectorStrip(mine, best)!;
    expect(strip.theoreticalBestMs).toBe(31_000 + 39_800 + 27_600); // 98.4 s
    expect(strip.potentialGainMs).toBe(98_800 - 98_400);
  });

  it('is nothing when a lap has no sectors, or the laps have a different number of them', () => {
    expect(sectorStrip(lap(undefined), best)).toBeNull();
    expect(sectorStrip(mine, lap([50_000, 49_000]))).toBeNull();
  });

  it('colours nothing on a lap the game voided, which cannot be judged, and still shows its times', () => {
    const voided = lap([30_000, 40_000, 28_000], { valid: false });
    const strip = sectorStrip(voided, best)!;
    expect(strip.sectors.every((s) => s.lapTone === 'none')).toBe(true);
    expect(strip.sectors.every((s) => s.referenceTone === 'purple')).toBe(true);
    expect(strip.lapLeftMs).toBeNull();
    expect(strip.referenceLeftMs).toBe(0);
  });
});
