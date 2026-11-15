import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en.json';
import ptBR from '@/locales/pt-BR.json';
import esES from '@/locales/es-ES.json';
import { gunzipLap } from '@/lib/sim/lap-file';
import { compareCorners } from '@/lib/sim/corner-compare';
import { BUILT_IN_GAME_NAMES } from '@/lib/sim/games';
import type { V1Lap, V1Overview, V1Session, V1SessionInsights, V1Stats } from '@/lib/sim/v1-client';
import { DEMO_STORAGE_KEY, enterDemo, isDemoMode, leaveDemo } from './mode';
import { answerDemo, answerLayouts, example, resetExample } from './index';

afterEach(() => {
  leaveDemo();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const ok = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
  const answer = await answerDemo('GET', path, params);
  expect(answer.status).toBe(200);
  return answer.json as T;
};

describe('the switch', () => {
  it('is off to begin with, is kept in sessionStorage (so it ends with the tab) and nowhere else', () => {
    expect(isDemoMode()).toBe(false);
    enterDemo();
    expect(isDemoMode()).toBe(true);
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toBe('1');
    expect(localStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
    leaveDemo();
    expect(isDemoMode()).toBe(false);
    expect(sessionStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
  });

  it('keeps working when sessionStorage throws: it is on for as long as the page lives', () => {
    const broken = () => { throw new DOMException('blocked', 'SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(broken);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(broken);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(broken);
    expect(() => enterDemo()).not.toThrow();
    expect(isDemoMode()).toBe(true);
    expect(() => leaveDemo()).not.toThrow();
    expect(isDemoMode()).toBe(false);
  });
});

describe('the example account', () => {
  it('has two games, four tracks, four cars and nine sessions over three weeks', async () => {
    const overview = await ok<V1Overview>('/overview');
    expect(overview.lapsPerGame.map((game) => game.game).sort()).toEqual(['ac', 'ams2']);
    expect(overview.lapsPerGame.every((game) => BUILT_IN_GAME_NAMES[game.game])).toBe(true);
    const tracks = await ok<{ tracks: Array<{ name: string; hasLayout?: boolean }> }>('/tracks');
    expect(tracks.tracks.map((track) => track.name).sort()).toEqual(['Imola', 'Interlagos', 'Monza', 'Spa-Francorchamps']);
    expect(tracks.tracks.every((track) => track.hasLayout)).toBe(true);
    const cars = await ok<{ cars: Array<{ name: string }> }>('/cars');
    expect(cars.cars).toHaveLength(4);
    const sessions = await ok<{ sessions: V1Session[] }>('/sessions');
    expect(sessions.sessions).toHaveLength(9);
    const days = sessions.sessions.map((session) => (Date.now() - Date.parse(session.startedAt)) / 86_400_000);
    expect(Math.max(...days)).toBeLessThan(23);
    expect(Math.min(...days)).toBeGreaterThan(0);
  });

  it('has no computer paired and nobody real in it', async () => {
    const overview = await ok<V1Overview>('/overview');
    expect(overview.companion.devices).toEqual([]);
    const text = JSON.stringify([overview, await ok('/sessions'), await ok('/tracks'), await ok('/cars')]);
    expect(text).not.toMatch(/@|Racing PC/);
  });

  it('has voided, out and in laps, and sectors that add up to the lap', async () => {
    const { laps } = await ok<{ laps: V1Lap[] }>('/laps', { limit: '100' });
    expect(laps.length).toBeGreaterThan(60);
    expect(laps.some((lap) => !lap.valid)).toBe(true);
    expect(laps.some((lap) => lap.outLap)).toBe(true);
    expect(laps.some((lap) => lap.inLap)).toBe(true);
    for (const lap of laps) expect(lap.sectorsMs!.reduce((sum, ms) => sum + ms, 0)).toBe(lap.timeMs);
  });

  it('gets faster from one session to the next on the same track and car', async () => {
    const { sessions } = await ok<{ sessions: V1Session[] }>('/sessions');
    const byPair = new Map<string, V1Session[]>();
    for (const session of sessions) byPair.set(`${session.track.id}|${session.car.id}`, [...(byPair.get(`${session.track.id}|${session.car.id}`) ?? []), session]);
    const repeated = [...byPair.values()].filter((list) => list.length > 1);
    expect(repeated.length).toBeGreaterThanOrEqual(3);
    for (const list of repeated) {
      const oldestFirst = [...list].sort((p, q) => Date.parse(p.startedAt) - Date.parse(q.startedAt));
      oldestFirst.slice(1).forEach((session, i) => expect(session.bestLapMs!).toBeLessThan(oldestFirst[i].bestLapMs!));
    }
  });

  it('fills the dashboard: tiles, trends, personal bests, a streak and findings for what to work on', async () => {
    const stats = await ok<V1Stats>('/stats', { range: '30d' });
    expect(stats.totals.validLaps).toBeGreaterThan(50);
    expect(stats.totals.personalBests).toBeGreaterThan(3);
    expect(stats.perDay.length).toBeGreaterThanOrEqual(8);
    expect(stats.improvements.length).toBeGreaterThan(0);
    const { sessions } = await ok<{ sessions: V1Session[] }>('/sessions');
    const insights = await Promise.all(sessions.map((session) => ok<V1SessionInsights>(`/sessions/${session.id}/insights`)));
    expect(insights.filter((entry) => entry.findings.length > 0).length).toBeGreaterThan(0);
  });

  it('has a lap file for every lap, and Compare finds real corner differences between two laps of a session', async () => {
    const { sessions } = await ok<{ sessions: V1Session[] }>('/sessions');
    const detail = await ok<{ session: V1Session; laps: V1Lap[] }>(`/sessions/${sessions[0].id}`);
    // The early laps of a session are the rougher ones and the late laps the cleaner ones: the corners differ between them.
    const clean = detail.laps.filter((lap) => lap.valid && !lap.inLap && !lap.outLap).sort((p, q) => p.lapNumber - q.lapNumber);
    const files = await Promise.all([clean[clean.length - 1], clean[0]].map(async (lap) => {
      const answer = await answerDemo('GET', `/laps/${lap.id}/file`, {});
      expect(answer.status).toBe(200);
      return gunzipLap(answer.bytes!);
    }));
    expect(files[0].header.sampleCount).toBeGreaterThan(500);
    const comparison = compareCorners(files[1], files[0]);
    expect(comparison.corners.length).toBeGreaterThanOrEqual(4);
    expect(comparison.corners.some((corner) => corner.dominantCause !== 'none')).toBe(true);
  });

  it('answers a plain 404 for what it does not know: the social side and unknown laps are plain 404s', async () => {
    expect((await answerDemo('GET', '/leaderboard', {})).status).toBe(404);
    expect((await answerDemo('GET', '/profile', {})).status).toBe(404);
    expect((await answerDemo('GET', '/laps/nope/file', {})).status).toBe(404);
  });

  it('is built once, and again after a reset', () => {
    const first = example();
    expect(example() === first).toBe(true);
    resetExample();
    expect(example() === first).toBe(false);
  });

  it('serves the shape of each circuit as the layouts the account holds', async () => {
    const list = await answerLayouts('/api/sim/tracks');
    const tracks = (list!.json as { tracks: Array<{ id: string; game: string }> }).tracks;
    expect(tracks).toHaveLength(4);
    expect(new Set(tracks.map((track) => track.game))).toEqual(new Set(['ac', 'ams2']));
    const file = await answerLayouts(`/api/sim/tracks/${tracks[0].id}/file`);
    expect(file!.bytes!.length).toBeGreaterThan(100);
    expect(await answerLayouts('/api/sim/tracks/other/file')).toBeNull();
  });
});

describe('what the example costs a person who never opens it', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
  const sources = files(join(process.cwd(), 'src')).map((path) => ({ path: path.replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

  it('is loaded on demand: the made-up account is only ever reached through a dynamic import', () => {
    // A static import of the account (not of mode.ts, which is the few lines of the switch) would put it in the main bundle.
    const statics = sources.filter(({ path, text }) =>
      !path.includes('/src/lib/sim/demo/') && !path.includes('/src/harness/') && /^\s*import[^'"\n]*from\s+['"]@\/lib\/sim\/demo(\/index)?['"]/m.test(text));
    expect(statics.map((entry) => entry.path)).toEqual([]);
    const dynamic = sources.filter(({ text }) => /import\(\s*['"]@\/lib\/sim\/demo['"]\s*\)/.test(text)).map((entry) => entry.path.split('/src/')[1]).sort();
    expect(dynamic).toEqual(['lib/sim/account-tracks.ts', 'lib/sim/v1-client.ts']);
  });

  it('keeps the switch file free of the account and the generator', () => {
    const mode = sources.find(({ path }) => path.endsWith('/src/lib/sim/demo/mode.ts'))!.text;
    expect(mode).not.toMatch(/from '\.\/(index|fake-server|insights|track-fixture)'|synthetic-lap|fake-server/);
  });

  it('has no test-only dependency (vitest, testing library, test helpers) in what it ships', () => {
    for (const { path, text } of sources.filter((entry) => entry.path.includes('/src/lib/sim/demo/'))) {
      expect(text, path).not.toMatch(/from ['"](vitest|@testing-library\/[a-z-]+|@\/test\/[^'"]+)['"]/);
    }
  });
});

describe('the texts of the example', () => {
  const flat = (o: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const demo = (locale: Record<string, unknown>) => flat((locale as { demo: Record<string, unknown> }).demo).sort();

  it('are one `demo` block, the last of the file, in all three languages with the same keys', () => {
    for (const locale of [en, ptBR, esES]) {
      expect(Object.keys(locale).at(-1)).toBe('demo');
      expect(demo(locale)).toEqual(demo(en));
    }
    expect(demo(en)).toEqual(['banner', 'chip', 'leave', 'notPartBody', 'notPartTitle', 'see', 'seeHint', 'unavailable', 'unavailableBody']);
  });

  it('are translated (not copies of the English) and never show the word Sim', () => {
    for (const locale of [ptBR, esES]) {
      const block = (locale as unknown as { demo: Record<string, string> }).demo;
      for (const key of Object.keys(block)) expect(block[key], key).not.toBe((en as unknown as { demo: Record<string, string> }).demo[key]);
    }
    for (const locale of [en, ptBR, esES]) expect(JSON.stringify((locale as unknown as { demo: unknown }).demo)).not.toMatch(/\bSim\b/);
  });

  it('keep one kind of line ending in each locale file (CRLF on a Windows checkout, LF on CI: never mixed)', () => {
    for (const name of ['en', 'pt-BR', 'es-ES']) {
      const text = readFileSync(join(process.cwd(), 'src', 'locales', `${name}.json`), 'utf8');
      const lines = text.split('\n').slice(0, -1);
      const crlf = lines.filter((line) => line.endsWith('\r')).length;
      expect(crlf === 0 || crlf === lines.length, name).toBe(true);
    }
  });
});
