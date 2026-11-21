// shared/design/ is the one place for what the website and the Companion must show alike (the menu, its icons). These checks
// fail when one side would drift: an icon changed in nav.json or a lucide-react upgrade without `npm run design:icons`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script, without types
import { buildIcons, serialize } from '../../scripts/design-icons.mjs';
import sharedNav from '../../shared/design/nav.json';
import { ADVANCED_ITEMS, NAV, NAV_ICONS, SETTINGS_ITEM } from '@/lib/mode-nav';

const root = join(__dirname, '../..');

describe('shared design', () => {
  it('has icons.json exactly as lucide-react draws the icons the Companion uses', () => {
    const written = readFileSync(join(root, 'shared/design/icons.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(written, 'run npm run design:icons').toBe(serialize(buildIcons()));
  });

  it('builds the site menu from nav.json, in its order', () => {
    expect(NAV.virtual.map((e) => e.to)).toEqual(sharedNav.virtual.map((e) => e.to));
    expect(NAV.real.map((e) => e.to)).toEqual(sharedNav.real.map((e) => e.to));
    expect(ADVANCED_ITEMS.map((e) => e.to)).toEqual(sharedNav.advanced.map((e) => e.to));
    expect(SETTINGS_ITEM.to).toBe(sharedNav.settings.to);
    for (const entry of [...sharedNav.real, ...sharedNav.virtual, ...sharedNav.advanced, sharedNav.settings]) {
      expect(NAV_ICONS[entry.icon], entry.icon).toBeDefined();
    }
  });

  it('names every Virtual and Settings label in all three languages', () => {
    for (const file of ['en.json', 'pt-BR.json', 'es-ES.json']) {
      const locale = JSON.parse(readFileSync(join(root, 'src/locales', file), 'utf8'));
      for (const entry of [...sharedNav.virtual, sharedNav.settings]) {
        const value = entry.i18nKey.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], locale);
        expect(typeof value, `${file}: ${entry.i18nKey}`).toBe('string');
      }
    }
  });
});
