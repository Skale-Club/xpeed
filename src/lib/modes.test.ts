import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODES_KEY, MODE_HOME, currentMode, isActivePath, modeEntryPath, modeOfPath, normalizeModes, readModes, rememberMode,
  rememberModeRoute, virtualBuildEnabled, writeModes,
} from './modes';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe('the Virtual build switch', () => {
  it('is off unless the build turns it on', () => {
    expect(virtualBuildEnabled()).toBe(false);
    vi.stubEnv('VITE_ENABLE_VIRTUAL', 'true');
    expect(virtualBuildEnabled()).toBe(true);
    vi.stubEnv('VITE_ENABLE_VIRTUAL', 'yes');
    expect(virtualBuildEnabled()).toBe(false);
  });
});

describe('normalizeModes', () => {
  it('puts Real first, drops repeats and unknown entries', () => {
    expect(normalizeModes(['virtual', 'real', 'real', 'boat'], true)).toEqual(['real', 'virtual']);
  });
  it('never leaves nobody with nothing to open', () => {
    expect(normalizeModes([], true)).toEqual(['real']);
    expect(normalizeModes(null, true)).toEqual(['real']);
    expect(normalizeModes('virtual', true)).toEqual(['real']);
  });
  it('allows racing games alone when Virtual exists', () => {
    expect(normalizeModes(['virtual'], true)).toEqual(['virtual']);
  });
  it('drops Virtual while it is not built, and falls back to Real', () => {
    expect(normalizeModes(['real', 'virtual'], false)).toEqual(['real']);
    expect(normalizeModes(['virtual'], false)).toEqual(['real']);
  });
});

describe('the stored choice', () => {
  beforeEach(() => vi.stubEnv('VITE_ENABLE_VIRTUAL', 'true'));

  it('is Real only until someone chooses', () => {
    expect(readModes('u1')).toEqual(['real']);
    expect(readModes(null)).toEqual(['real']);
  });
  it('is kept per user, never shared between accounts on one browser', () => {
    writeModes('u1', ['real', 'virtual']);
    expect(readModes('u1')).toEqual(['real', 'virtual']);
    expect(readModes('u2')).toEqual(['real']);
  });
  it('survives damaged storage', () => {
    localStorage.setItem(`${MODES_KEY}:u1`, '{not json');
    expect(readModes('u1')).toEqual(['real']);
  });
  it('does not bring Virtual back when the build switch is off', () => {
    writeModes('u1', ['real', 'virtual']);
    vi.stubEnv('VITE_ENABLE_VIRTUAL', 'false');
    expect(readModes('u1')).toEqual(['real']);
  });
  it('writes nothing for nobody', () => {
    expect(writeModes(null, ['virtual'])).toEqual(['virtual']);
    expect(localStorage.length).toBe(0);
  });
});

describe('paths and modes', () => {
  it('tells which mode a path is in', () => {
    expect(modeOfPath('/')).toBe('real');
    expect(modeOfPath('/history')).toBe('real');
    expect(modeOfPath('/session/abc')).toBe('real');
    expect(modeOfPath('/virtual')).toBe('virtual');
    expect(modeOfPath('/virtual/sessions')).toBe('virtual');
    expect(modeOfPath('/simulator')).toBe('real');
  });
  it('treats Settings, Admin and onboarding as shared', () => {
    for (const path of ['/settings', '/admin', '/onboarding']) expect(modeOfPath(path)).toBeNull();
  });
  it('marks one menu entry active, not its parent', () => {
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/', '/history')).toBe(false);
    expect(isActivePath('/virtual', '/virtual')).toBe(true);
    expect(isActivePath('/virtual', '/virtual/sessions')).toBe(false);
    expect(isActivePath('/virtual/sessions', '/virtual/sessions')).toBe(true);
    expect(isActivePath('/history', '/history/2')).toBe(true);
    expect(isActivePath('/history', '/historyx')).toBe(false);
  });
});

describe('the current mode and where each mode reopens', () => {
  it('follows the path when the person has that mode', () => {
    expect(currentMode(['real', 'virtual'], '/virtual/tracks')).toBe('virtual');
    expect(currentMode(['real', 'virtual'], '/history')).toBe('real');
  });
  it('keeps the last mode on shared pages, if still available', () => {
    rememberMode('virtual');
    expect(currentMode(['real', 'virtual'], '/settings')).toBe('virtual');
    expect(currentMode(['real'], '/settings')).toBe('real');
  });
  it('falls back to the first mode the person has', () => {
    expect(currentMode(['virtual'], '/history')).toBe('virtual');
    expect(currentMode(['real'], '/virtual')).toBe('real');
  });
  it('reopens the last screen of a mode, or its first screen', () => {
    expect(modeEntryPath('real')).toBe('/');
    expect(modeEntryPath('virtual')).toBe('/virtual');
    rememberModeRoute('real', '/fuel?month=3');
    rememberModeRoute('virtual', '/virtual/compare');
    expect(modeEntryPath('real')).toBe('/fuel?month=3');
    expect(modeEntryPath('virtual')).toBe('/virtual/compare');
  });
  it('translates an old stored /sim route to the new address', () => {
    sessionStorage.setItem('xpeed.route.virtual', '/sim/sessions');
    expect(modeEntryPath('virtual')).toBe('/virtual/sessions');
  });
  it('knows the new Virtual and Companion paths', () => {
    expect(MODE_HOME.virtual).toBe('/virtual');
    expect(modeOfPath('/virtual/companion')).toBe('virtual');
    expect(modeOfPath('/companion/connect/abc')).toBeNull();
  });
  it('does not remember a screen under the wrong mode', () => {
    rememberModeRoute('real', '/virtual/compare');
    expect(modeEntryPath('real')).toBe('/');
  });
});
