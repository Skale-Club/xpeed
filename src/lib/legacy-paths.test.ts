import { describe, expect, it } from 'vitest';
import { currentRoute, legacyPathTarget } from './legacy-paths';

describe('legacyPathTarget', () => {
  it('maps every old path to its new one', () => {
    expect(legacyPathTarget('/sim')).toBe('/virtual');
    expect(legacyPathTarget('/sim/app')).toBe('/virtual/companion');
    expect(legacyPathTarget('/sim/connect/abc')).toBe('/companion/connect/abc');
    expect(legacyPathTarget('/sim/sessions')).toBe('/virtual/sessions');
  });
  it('ignores current and unrelated paths', () => {
    expect(legacyPathTarget('/virtual/sessions')).toBeNull();
    expect(legacyPathTarget('/simulator')).toBeNull();
    expect(legacyPathTarget('/')).toBeNull();
  });
});

describe('currentRoute', () => {
  it('translates an old stored route and keeps its query', () => {
    expect(currentRoute('/sim/sessions')).toBe('/virtual/sessions');
    expect(currentRoute('/sim/compare?a=1')).toBe('/virtual/compare?a=1');
  });
  it('leaves current routes alone', () => {
    expect(currentRoute('/virtual/compare?a=1')).toBe('/virtual/compare?a=1');
    expect(currentRoute('/fuel')).toBe('/fuel');
  });
});
