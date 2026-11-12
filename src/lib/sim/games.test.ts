import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_GAME_NAMES, gameCoverUrl, gameName, loadGames, resetGamesCache } from './games';

const IDS = ['lmu', 'ac', 'acc', 'acr', 'acevo', 'ams2', 'pcars2', 'pcars3', 'ams1', 'rf1', 'rfactor1', 'r3e', 'f1', 'f124', 'f123', 'fm', 'fm7', 'fh4', 'fh5', 'wreckfest2', 'iracing'];

describe('gameName', () => {
  beforeEach(() => resetGamesCache());

  it('knows every id a lap file can carry', () => {
    for (const id of IDS) {
      expect(BUILT_IN_GAME_NAMES[id]).toBeTruthy();
      expect(gameName(id)).not.toBe(id.toUpperCase());
    }
  });

  it('names the specific ones', () => {
    expect(gameName('rfactor1')).toBe('Stock Car Extreme');
    expect(gameName('f1')).toBe('F1 25');
    expect(gameName('pcars2')).toBe('Project CARS 2');
    expect(gameName('r3e')).toBe('RaceRoom Racing Experience');
    expect(gameName('rf1')).toBe('rFactor');
    expect(gameName('ams1')).toBe('Automobilista');
  });

  it('falls back to the id uppercased for an unknown game', () => {
    expect(gameName('newgame')).toBe('NEWGAME');
  });
});

describe('loadGames', () => {
  beforeEach(() => resetGamesCache());
  afterEach(() => vi.unstubAllGlobals());

  it('overrides names, gives covers, and is cached', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ key: 'ac', title: 'AC From Server' }, { key: 'zz', title: 'Zed' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await loadGames();
    expect(gameName('ac')).toBe('AC From Server');
    expect(gameName('zz')).toBe('Zed');
    expect(gameName('lmu')).toBe('Le Mans Ultimate');
    expect(gameCoverUrl('ac')).toMatch(/\/api\/sim\/games\/ac\/cover$/);
    expect(gameCoverUrl('lmu')).toBeNull();
    await loadGames();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the built-in names when the fetch fails or the body is wrong', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(loadGames()).resolves.toEqual({});
    expect(gameName('rfactor1')).toBe('Stock Car Extreme');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await loadGames();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: 1 }) }));
    await loadGames();
    expect(gameName('ac')).toBe('Assetto Corsa');
    expect(gameCoverUrl('ac')).toBeNull();
  });
});
