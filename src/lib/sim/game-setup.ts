// What to turn on in each racing game for Xpeed Companion to receive its data: ONE table, used by the computer's card on the Companion page
// ("Automobilista 2 is open but not sending data: ...") and by the public /companion page. The Windows app says the same thing in its own panel and
// in one tray notice (xpeed-sim/src/text.rs, `Msg::Setup`): when a wording changes, change both.
//
// Each instruction is a lower-case fragment with no final full stop, so it reads after a colon on the card; `setupSentence` makes a sentence of it
// for the page. Menu names stay in the game's own (English) wording in every language. Games with nothing to turn on say what starts their data.
import type { TFunction } from 'i18next';
import { BUILT_IN_GAME_NAMES } from '@/lib/sim/games';

export type SetupKind =
  | 'ams2' | 'pcars' | 'auto' | 'iracing' | 'lmu' | 'f1' | 'forzaMotorsport' | 'forzaMotorsport7' | 'horizon' | 'wreckfest2' | 'rfactor';

export interface GameSetup {
  kind: SetupKind;
  /** Values the wording needs (the F1 games each want the format of their own year). */
  params?: Record<string, string | number>;
}

/** Every supported game (the ids a lap or a heartbeat carries) and the setup it needs. */
export const GAME_SETUP: Readonly<Record<string, GameSetup>> = {
  ams2: { kind: 'ams2' },
  pcars2: { kind: 'pcars' },
  pcars3: { kind: 'pcars' },
  ac: { kind: 'auto' },
  acc: { kind: 'auto' },
  acr: { kind: 'auto' },
  acevo: { kind: 'auto' },
  r3e: { kind: 'auto' },
  iracing: { kind: 'iracing' },
  lmu: { kind: 'lmu' },
  f1: { kind: 'f1', params: { year: 2025 } },
  f124: { kind: 'f1', params: { year: 2024 } },
  f123: { kind: 'f1', params: { year: 2023 } },
  fm: { kind: 'forzaMotorsport' },
  fm7: { kind: 'forzaMotorsport7' },
  fh4: { kind: 'horizon' },
  fh5: { kind: 'horizon' },
  fh6: { kind: 'horizon' },
  wreckfest2: { kind: 'wreckfest2' },
  rfactor1: { kind: 'rfactor' },
  ams1: { kind: 'rfactor' },
  rf1: { kind: 'rfactor' },
};

/** The English wording of each kind (the default of its locale key `companionSite.setup.<kind>`). */
export const SETUP_ENGLISH: Readonly<Record<SetupKind, string>> = {
  ams2: 'turn on Options > System > Use Shared Memory > Yes (if it lists formats, pick Project CARS 2), then Save',
  pcars: 'turn on Shared Memory in the game\'s options, in the Project CARS 2 format',
  auto: 'nothing to turn on, start a session and get on track',
  iracing: 'nothing to turn on, get in the car and start a session',
  lmu: 'turn on Settings > Gameplay > Enable external plugins (restart the game if nothing changes)',
  f1: 'turn on Settings > Telemetry Settings > UDP Telemetry, with Broadcast Mode off, IP 127.0.0.1, Port 20777 and UDP Format {{year}}',
  forzaMotorsport: 'turn on Settings > Gameplay & HUD > UDP Race Telemetry > Data Out, with IP 127.0.0.1, Port 5301 and Packet Format Dash',
  forzaMotorsport7: 'turn on Settings > HUD and Gameplay > Data Out, with IP 127.0.0.1, Port 5301 and Format Dash',
  horizon: 'turn on Settings > HUD and Gameplay > Data Out, with IP 127.0.0.1 and Port 5301',
  wreckfest2: 'open the game\'s telemetry config.json, set "enabled" to 1 (IP 127.0.0.1, port 23123) and restart the game',
  rfactor: 'put the rFactorSharedMemoryMap plugin in the game\'s Plugins folder and start the game again',
};

/** The games the page lists, in the order of its game list: every game with a name that Xpeed Companion supports. */
export function setupGames(): string[] {
  return Object.keys(GAME_SETUP).filter((game) => game in BUILT_IN_GAME_NAMES);
}

/** What to do for `game`, as a lower-case fragment in the person's language; null for a game this table does not know. */
export function setupText(t: TFunction, game: string): string | null {
  const setup = GAME_SETUP[game];
  if (!setup) return null;
  return t(`companionSite.setup.${setup.kind}`, { defaultValue: SETUP_ENGLISH[setup.kind], ...setup.params });
}

/** A fragment as a sentence: first letter up, a full stop at the end. */
export function setupSentence(fragment: string): string {
  const text = fragment.trim();
  return text ? `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}.` : text;
}
