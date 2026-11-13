import { describe, expect, it } from 'vitest';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { hasSyncedLayout } from '@/lib/sim/track-layout-match';

const layout = (extra: Partial<AccountTrack>): AccountTrack => ({
  id: 'l1', game: 'lmu', trackName: 'Monza', variant: null, title: null, lengthM: 5793, size: 1000, updatedAt: '2026-11-10T00:00:00.000Z', ...extra,
});

describe('which tracks have a layout Xpeed Companion sent', () => {
  it('matches by game and name, ignoring case, accents and punctuation', () => {
    expect(hasSyncedLayout([layout({})], { game: 'lmu', name: 'Monza' })).toBe(true);
    expect(hasSyncedLayout([layout({ trackName: 'MONZA' })], { game: 'lmu', name: 'monza' })).toBe(true);
    expect(hasSyncedLayout([layout({ trackName: 'Autódromo José Carlos Pace' })], { game: 'lmu', name: 'Autodromo Jose Carlos Pace' })).toBe(true);
    expect(hasSyncedLayout([layout({ trackName: 'Spa-Francorchamps' })], { game: 'lmu', name: 'Spa Francorchamps' })).toBe(true);
  });

  it('does not match another game, another track or an empty name', () => {
    expect(hasSyncedLayout([layout({})], { game: 'ac', name: 'Monza' })).toBe(false);
    expect(hasSyncedLayout([layout({})], { game: 'lmu', name: 'Spa-Francorchamps' })).toBe(false);
    expect(hasSyncedLayout([layout({})], { game: 'lmu', name: '  ' })).toBe(false);
    expect(hasSyncedLayout([], { game: 'lmu', name: 'Monza' })).toBe(false);
  });

  it('matches the name with its layout variant, or its title', () => {
    expect(hasSyncedLayout([layout({ trackName: 'Monza', variant: 'GP' })], { game: 'lmu', name: 'Monza GP' })).toBe(true);
    expect(hasSyncedLayout([layout({ trackName: 'monza_gp', title: 'Autodromo di Monza' })], { game: 'lmu', name: 'Autodromo di Monza' })).toBe(true);
  });

  it('reads a game the way its layouts are filed (Stock Car Extreme layouts are filed as sce)', () => {
    expect(hasSyncedLayout([layout({ game: 'sce', trackName: 'Interlagos' })], { game: 'rfactor1', name: 'Interlagos' })).toBe(true);
  });
});
