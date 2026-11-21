import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_KEY, isCompanionShell, resetCompanionShell } from './companion-shell';

const open = (search: string) => window.history.replaceState(null, '', `/virtual/sessions${search}`);

describe('companion shell mode', () => {
  beforeEach(() => { window.sessionStorage.clear(); resetCompanionShell(); open(''); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('is off by default', () => {
    expect(isCompanionShell()).toBe(false);
  });

  it('is on when the user agent says XpeedCompanion', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Edg/130 XpeedCompanion/0.18.0');
    expect(isCompanionShell()).toBe(true);
  });

  it('?shell=companion turns it on and survives losing the query string', () => {
    open('?shell=companion');
    expect(isCompanionShell()).toBe(true);
    expect(window.sessionStorage.getItem(SHELL_KEY)).toBe('companion');
    open('');
    expect(isCompanionShell()).toBe(true);
  });

  it('?shell=off clears it', () => {
    open('?shell=companion');
    isCompanionShell();
    open('?shell=off');
    expect(isCompanionShell()).toBe(false);
    expect(window.sessionStorage.getItem(SHELL_KEY)).toBeNull();
    open('');
    expect(isCompanionShell()).toBe(false);
  });

  it('falls back safely when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(isCompanionShell()).toBe(false);
    open('?shell=companion');
    expect(isCompanionShell()).toBe(true);
    open('');
    expect(isCompanionShell()).toBe(true); // kept in memory
    open('?shell=off');
    expect(isCompanionShell()).toBe(false);
  });
});
