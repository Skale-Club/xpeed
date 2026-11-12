// Names (and covers) of the sim games, by the lowercase id a lap or track file carries in `header.game`.
// The built-in table keeps the site readable offline and before the list loads; the server list
// (GET /api/sim/games, public) overrides the names and adds the covers. A failed fetch never throws.
import { useEffect, useState } from 'react';
import { publicAppUrl } from '@/lib/trips';

export const BUILT_IN_GAME_NAMES: Readonly<Record<string, string>> = {
  lmu: 'Le Mans Ultimate',
  ac: 'Assetto Corsa',
  acc: 'Assetto Corsa Competizione',
  acr: 'Assetto Corsa Rally',
  acevo: 'Assetto Corsa EVO',
  ams2: 'Automobilista 2',
  ams1: 'Automobilista',
  pcars2: 'Project CARS 2',
  pcars3: 'Project CARS 3',
  rf1: 'rFactor',
  rfactor1: 'Stock Car Extreme',
  r3e: 'RaceRoom Racing Experience',
  f1: 'F1 25',
  f124: 'EA SPORTS F1 24',
  f123: 'EA SPORTS F1 23',
  fm: 'Forza Motorsport',
  fm7: 'Forza Motorsport 7',
  fh4: 'Forza Horizon 4',
  fh5: 'Forza Horizon 5',
  wreckfest2: 'Wreckfest 2',
  iracing: 'iRacing',
};

export interface GameInfo {
  title: string;
  /** Absolute URL of the cover image. */
  coverUrl: string;
}

let loaded: Record<string, GameInfo> = {};
let pending: Promise<Record<string, GameInfo>> | null = null;
const listeners = new Set<() => void>();

/** Test hook: forgets what was loaded. */
export function resetGamesCache(): void {
  loaded = {};
  pending = null;
}

/** The name of a game: the server's title when the list has loaded, else the built-in one, else the id uppercased. */
export function gameName(id: string): string {
  return loaded[id]?.title ?? BUILT_IN_GAME_NAMES[id] ?? id.toUpperCase();
}

/** The cover URL of a game, or null while the list has not loaded (or the game is not in it). */
export function gameCoverUrl(id: string): string | null {
  return loaded[id]?.coverUrl ?? null;
}

/** The games the server lists, cached for the session. Resolves to what is known (empty) when it cannot be read. */
export function loadGames(): Promise<Record<string, GameInfo>> {
  if (Object.keys(loaded).length > 0) return Promise.resolve(loaded);
  if (pending) return pending;
  const request = (async () => {
    try {
      const base = publicAppUrl();
      const response = await fetch(`${base}/api/sim/games`);
      if (!response.ok) return loaded;
      const body = (await response.json()) as { games?: Array<{ key?: unknown; title?: unknown }> };
      if (!Array.isArray(body.games)) return loaded;
      const next: Record<string, GameInfo> = {};
      for (const game of body.games) {
        if (typeof game?.key !== 'string' || !game.key) continue;
        next[game.key] = {
          title: typeof game.title === 'string' && game.title ? game.title : BUILT_IN_GAME_NAMES[game.key] ?? game.key.toUpperCase(),
          coverUrl: `${base}/api/sim/games/${encodeURIComponent(game.key)}/cover`,
        };
      }
      loaded = next;
      listeners.forEach((notify) => notify());
      return loaded;
    } catch {
      return loaded;
    } finally {
      pending = null;
    }
  })();
  pending = request;
  return request;
}

/** For components: loads the list once and re-renders when it arrives. Returns the lookups. */
export function useGames(): { name: (id: string) => string; cover: (id: string) => string | null } {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const notify = () => setVersion((v) => v + 1);
    listeners.add(notify);
    void loadGames();
    return () => {
      listeners.delete(notify);
    };
  }, []);
  return { name: gameName, cover: gameCoverUrl };
}
