// COLOR_TOKENS (src/lib/design-tokens.ts) mirrors src/index.css; these checks fail when the two drift.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, tokenColor } from './design-tokens';

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

describe('design tokens', () => {
  it.each(Object.entries(COLOR_TOKENS))('index.css declares --%s as %s', (name, value) => {
    expect(css).toContain(`--${name}: ${value};`);
  });

  it('keeps --primary equal to the brand colour', () => {
    expect(css).toContain(`--primary: ${COLOR_TOKENS.brand};`);
  });

  it('builds hsl strings, with optional alpha', () => {
    expect(tokenColor('brand')).toBe('hsl(54 88% 67%)');
    expect(tokenColor('brand', 0.5)).toBe('hsl(54 88% 67% / 0.5)');
  });
});
