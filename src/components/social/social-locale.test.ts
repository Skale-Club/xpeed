import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/locales/en.json';
import ptBR from '@/locales/pt-BR.json';
import esES from '@/locales/es-ES.json';

// The social screens write every sentence through t('social.…', 'English default'). These checks keep the three languages in step with
// the code, and keep a word out of everything a person can read: "Sim" (the old name of Xpeed Companion).

const root = join(process.cwd(), 'src');
const sourceFiles = [
  ...readdirSync(join(root, 'components/social')).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name)).map((name) => `components/social/${name}`),
  ...readdirSync(join(root, 'pages')).filter((name) => /^Social.*\.tsx$/.test(name)).map((name) => `pages/${name}`),
  'components/sim/SessionPage.tsx',
  'lib/mode-nav.ts',
];

const CALL = /\bt\(\s*'(social\.[^']+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g;
const used = new Map<string, string>();
for (const file of sourceFiles) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const match of text.matchAll(CALL)) used.set(match[1], match[2].replace(/\\'/g, "'"));
  for (const match of text.matchAll(/[iI]18nKey: '(social\.[^']+)'/g)) if (!used.has(match[1])) used.set(match[1], '');
}

const flat = (value: unknown, prefix = ''): Array<[string, string]> =>
  value && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => flat(inner, prefix ? `${prefix}.${key}` : key))
    : [[prefix, String(value)]];
const social = (locale: unknown) => new Map(flat((locale as { social: unknown }).social, 'social'));
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();

describe('the social sentences', () => {
  it('have sentences to check', () => {
    expect(used.size).toBeGreaterThan(200);
  });

  it('are in the three languages, with the same placeholders, and the English is the one the code says', () => {
    const locales = { en: social(en), 'pt-BR': social(ptBR), 'es-ES': social(esES) };
    const problems: string[] = [];
    for (const [key, fallback] of used) {
      for (const [name, map] of Object.entries(locales)) {
        const text = map.get(key);
        if (text === undefined) problems.push(`${name} has no ${key}`);
        else if (JSON.stringify(placeholders(text)) !== JSON.stringify(placeholders(locales.en.get(key) ?? fallback))) problems.push(`${name} ${key}: placeholders differ`);
        else if (text.trim() === '') problems.push(`${name} ${key} is empty`);
      }
      if (fallback && locales.en.get(key) !== fallback) problems.push(`en ${key} is not the default written in the code`);
    }
    expect(problems).toEqual([]);
  });

  it('have no key in the locale files that no screen uses', () => {
    const unused = [...social(en).keys()].filter((key) => !used.has(key));
    expect(unused).toEqual([]);
  });

  it('never write the word "Sim" where a person can read it', () => {
    const sentences = [...social(en).values(), ...social(ptBR).values(), ...social(esES).values(), ...used.values()];
    expect(sentences.filter((text) => /\bsim\b/i.test(text))).toEqual([]);
  });
});
