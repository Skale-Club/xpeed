import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n, { i18nReady } from '@/lib/i18n';
import en from '@/locales/en.json';
import ptBR from '@/locales/pt-BR.json';
import esES from '@/locales/es-ES.json';
import { BUILT_IN_GAME_NAMES } from '@/lib/sim/games';
import { GAME_SETUP, SETUP_ENGLISH, setupGames, setupSentence, setupText, type SetupKind } from '@/lib/sim/game-setup';

const LANGUAGES = ['en', 'pt-BR', 'es-ES'] as const;
const KINDS = Object.keys(SETUP_ENGLISH) as SetupKind[];

beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
});

/** The ids of every game the Windows app waits for (`PROGRAMS` in xpeed-sim/src/games/mod.rs), plus Le Mans Ultimate. */
function companionGameIds(): string[] {
  const source = readFileSync(resolve(__dirname, '../../../xpeed-sim/src/games/mod.rs'), 'utf8');
  const block = /pub const PROGRAMS[^=]*=\s*&\[([\s\S]*?)\n\];/.exec(source)?.[1] ?? '';
  const ids = [...block.matchAll(/\("[^"]+",\s*"([a-z0-9_]+)",/g)].map((match) => match[1]);
  return [...new Set([...ids, 'lmu'])];
}

describe('the table of what to turn on in each game', () => {
  it('has an instruction for every game Xpeed Companion supports, and every game with a name', () => {
    const supported = companionGameIds();
    expect(supported.length).toBeGreaterThan(15);
    for (const game of [...supported, ...Object.keys(BUILT_IN_GAME_NAMES)]) {
      expect(GAME_SETUP[game], `${game} has no setup`).toBeDefined();
    }
    // The public page lists exactly the games the site can name.
    expect(setupGames().sort()).toEqual(Object.keys(BUILT_IN_GAME_NAMES).sort());
  });

  it('says it in the three languages, never as a raw key, never the English one for the others', async () => {
    for (const game of Object.keys(GAME_SETUP)) {
      await i18n.changeLanguage('en');
      const english = setupText(i18n.t, game);
      expect(english, game).toBeTruthy();
      expect(english).not.toMatch(/companionSite\.|\{\{/);
      for (const language of ['pt-BR', 'es-ES']) {
        await i18n.changeLanguage(language);
        const other = setupText(i18n.t, game);
        expect(other, `${game} ${language}`).toBeTruthy();
        expect(other, `${game} ${language}`).not.toBe(english);
        expect(other).not.toMatch(/companionSite\.|\{\{/);
      }
    }
    expect(setupText(i18n.t, 'no-such-game')).toBeNull();
  });

  it('has the same kinds in every locale file, and the Formula 1 year in each of them', () => {
    for (const locale of [en, ptBR, esES]) {
      const setup = (locale as unknown as { companionSite: { setup: Record<string, string> } }).companionSite.setup;
      expect(Object.keys(setup).sort()).toEqual([...KINDS].sort());
      expect(setup.f1).toContain('{{year}}');
      for (const kind of KINDS) expect(setup[kind].trim().length, kind).toBeGreaterThan(10);
    }
  });

  it('names the setting to turn on, per game, in the wording of the game', async () => {
    const say = (game: string) => setupText(i18n.t, game);
    expect(say('ams2')).toContain('Options > System > Use Shared Memory');
    expect(say('ams2')).toContain('Project CARS 2');
    expect(say('pcars2')).toContain('Shared Memory');
    expect(say('lmu')).toContain('Settings > Gameplay > Enable external plugins');
    expect(say('f1')).toContain('Settings > Telemetry Settings > UDP Telemetry');
    expect(say('f1')).toContain('Port 20777');
    expect(say('f1')).toContain('UDP Format 2025 (or 2026 with the Season Pack)');
    expect(say('f124')).toContain('UDP Format 2024');
    expect(say('f123')).toContain('UDP Format 2023');
    expect(say('fm')).toContain('UDP Race Telemetry > Data Out');
    expect(say('fm')).toContain('Port 5301');
    for (const horizon of ['fh4', 'fh5', 'fh6']) expect(say(horizon)).toContain('Settings > HUD and Gameplay > Data Out');
    expect(say('wreckfest2')).toContain('"enabled" to 1');
    expect(say('rfactor1')).toContain('rFactorSharedMemoryMap');
    // The games that need nothing say what starts their data instead.
    for (const game of ['ac', 'acc', 'acr', 'acevo', 'r3e']) expect(say(game)).toMatch(/nothing to turn on, start a session/);
    expect(say('iracing')).toMatch(/nothing to turn on/);
    // The menu path stays in the game's own words in every language.
    await i18n.changeLanguage('pt-BR');
    expect(say('ams2')).toContain('Options > System > Use Shared Memory > Yes');
    await i18n.changeLanguage('es-ES');
    expect(say('lmu')).toContain('Settings > Gameplay > Enable external plugins');
  });

  it('makes a sentence of a fragment', () => {
    expect(setupSentence('turn on Options > System > Shared Memory')).toBe('Turn on Options > System > Shared Memory.');
    expect(setupSentence('  ')).toBe('');
  });
});
