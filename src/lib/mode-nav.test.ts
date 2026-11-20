import { describe, expect, it } from 'vitest';
import { carPath, sessionPath, trackPath } from '@/lib/sim/routes';
import { ADMIN_ITEM, ADVANCED_ITEMS, NAV, SETTINGS_ITEM, TABS, groupNav, matchPlaces, trailEntry } from '@/lib/mode-nav';
import { isActivePath } from '@/lib/modes';

describe('the Virtual navigation', () => {
  it('lists Overview, Sessions, Leaderboards, Friends, Tracks and Cars, in that order', () => {
    expect(NAV.virtual.map((item) => item.to)).toEqual([
      '/virtual', '/virtual/sessions', '/virtual/leaderboards', '/virtual/friends', '/virtual/tracks',
      '/virtual/cars',
    ]);
  });

  it('keeps the three everyday places in the phone tab bar and the rest under "More"', () => {
    expect(TABS.virtual.map((item) => item.to)).toEqual(['/virtual', '/virtual/sessions', '/virtual/leaderboards']);
    const menu = NAV.virtual.map((item) => item.to);
    for (const tab of TABS.virtual) expect(menu).toContain(tab.to);
  });

  it('keeps the entry of the list highlighted on the page of one session, one track or one car', () => {
    const active = (pathname: string) => NAV.virtual.filter((item) => isActivePath(item.to, pathname)).map((item) => item.to);
    expect(active(sessionPath('abc'))).toEqual(['/virtual/sessions']);
    expect(active(trackPath('abc'))).toEqual(['/virtual/tracks']);
    expect(active(carPath('abc'))).toEqual(['/virtual/cars']);
    // A lap's analysis is opened from a lap, so it sits under Sessions.
    expect(active('/virtual/compare')).toEqual(['/virtual/sessions']);
    // The home entry matches only itself.
    expect(active('/virtual')).toEqual(['/virtual']);
  });

  it('names the pages of one track and one car under their lists', () => {
    expect(trackPath('t 1')).toBe('/virtual/tracks/t%201');
    expect(carPath('c1')).toBe('/virtual/cars/c1');
  });
});

describe('the sidebar groups (Dashboards 2027, phase 2, 2026-11-20)', () => {
  it('splits each mode into short titled groups, each in one piece', () => {
    expect(groupNav(NAV.real).map((s) => [s.group, s.items.map((i) => i.to)])).toEqual([
      ['car', ['/', '/live']],
      ['health', ['/trends', '/issues', '/codes']],
      ['records', ['/history', '/fuel', '/maintenance']],
      ['garage', ['/cars']],
    ]);
    expect(groupNav(NAV.virtual).map((s) => s.group)).toEqual(['driving', 'community', 'garage']);
    for (const mode of ['real', 'virtual'] as const) {
      const groups = groupNav(NAV[mode]).map((s) => s.group);
      expect(new Set(groups).size).toBe(groups.length);
    }
  });

  it('puts entries with no group (Scanner, Settings) in one untitled section at the end', () => {
    const sections = groupNav([...NAV.real, ...ADVANCED_ITEMS, SETTINGS_ITEM]);
    expect(sections[sections.length - 1]).toEqual({ group: null, items: [...ADVANCED_ITEMS, SETTINGS_ITEM] });
  });
});

describe('the top bar trail and "Go to…"', () => {
  it('names the menu entry of the page, the admin pages included', () => {
    expect(trailEntry('virtual', sessionPath('abc'))?.to).toBe('/virtual/sessions');
    expect(trailEntry('real', '/issues')?.to).toBe('/issues');
    expect(trailEntry('real', '/settings')?.to).toBe('/settings');
    expect(trailEntry('real', '/admin/design')).toBe(ADMIN_ITEM);
    expect(trailEntry('virtual', '/nowhere')).toBeNull();
  });

  it('finds places by any part of the name, ignoring case and accents', () => {
    const places = [{ label: 'Saúde do carro' }, { label: 'Problemas' }, { label: 'Viagens' }];
    expect(matchPlaces(places, 'saude').map((p) => p.label)).toEqual(['Saúde do carro']);
    expect(matchPlaces(places, 'AGENS').map((p) => p.label)).toEqual(['Viagens']);
    expect(matchPlaces(places, '  ')).toHaveLength(3);
    expect(matchPlaces(places, 'xyz')).toEqual([]);
  });
});
