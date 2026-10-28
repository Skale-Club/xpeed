import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import ptBR from '@/locales/pt-BR.json';
import esES from '@/locales/es-ES.json';
import i18n, { i18nReady } from '@/lib/i18n';

const flat = (o: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('locales', () => {
  // There is no per-key English fallback (see lib/i18n.ts), so a key missing in
  // one language would show up as a raw key. Keep all three in step.
  it('have identical key sets', () => {
    const base = flat(en).sort();
    expect(flat(ptBR).sort()).toEqual(base);
    expect(flat(esES).sort()).toEqual(base);
  });
});

describe('lazy language loading', () => {
  it('changeLanguage resolves after the new language is loaded', async () => {
    await i18nReady;
    await i18n.changeLanguage('pt-BR');
    expect(i18n.resolvedLanguage).toBe('pt-BR');
    expect(i18n.hasResourceBundle('pt-BR', 'translation')).toBe(true);
    const key = flat(ptBR)[0];
    expect(i18n.t(key)).not.toBe(key);
    await i18n.changeLanguage('es-ES');
    expect(i18n.hasResourceBundle('es-ES', 'translation')).toBe(true);
    await i18n.changeLanguage('en');
    expect(i18n.t(key)).not.toBe(key);
  });
});
