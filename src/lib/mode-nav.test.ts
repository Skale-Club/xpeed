import { describe, expect, it } from 'vitest';
import { carPath, sessionPath, trackPath } from '@/lib/sim/routes';
import { NAV, TABS } from '@/lib/mode-nav';
import { isActivePath } from '@/lib/modes';

describe('the Virtual navigation', () => {
  it('lists Overview, Sessions, Compare, Tracks, Cars and Companion, in that order', () => {
    expect(NAV.virtual.map((item) => item.to)).toEqual([
      '/virtual', '/virtual/sessions', '/virtual/compare', '/virtual/tracks', '/virtual/cars', '/virtual/companion',
    ]);
  });

  it('keeps the three everyday places in the phone tab bar and the rest under "More"', () => {
    expect(TABS.virtual.map((item) => item.to)).toEqual(['/virtual', '/virtual/sessions', '/virtual/compare']);
    const menu = NAV.virtual.map((item) => item.to);
    for (const tab of TABS.virtual) expect(menu).toContain(tab.to);
  });

  it('keeps the entry of the list highlighted on the page of one session, one track or one car', () => {
    const active = (pathname: string) => NAV.virtual.filter((item) => isActivePath(item.to, pathname)).map((item) => item.to);
    expect(active(sessionPath('abc'))).toEqual(['/virtual/sessions']);
    expect(active(trackPath('abc'))).toEqual(['/virtual/tracks']);
    expect(active(carPath('abc'))).toEqual(['/virtual/cars']);
    // The home entry matches only itself.
    expect(active('/virtual')).toEqual(['/virtual']);
  });

  it('names the pages of one track and one car under their lists', () => {
    expect(trackPath('t 1')).toBe('/virtual/tracks/t%201');
    expect(carPath('c1')).toBe('/virtual/cars/c1');
  });
});
