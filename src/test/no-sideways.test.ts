import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// "A screen never slides sideways" (owner rule, 2026-11-21; AGENTS.md). On a phone, one thing wider than the screen (a long car name on
// Sessions) made the whole page pan and zoom out. jsdom has no layout engine, so what is pinned here is the contract in the code: the global
// rules of src/index.css that make it impossible, and the shape of the pieces that caused it. The real measurement, in a browser, on every
// screen, at phone widths and in three languages, is `npm run check:phone` (scripts/check-phone-width.mjs).

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
/** The CSS with comments and line breaks out of the way. */
const css = source('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
/** The declarations of the first rule with this selector. */
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at === -1 ? null : css.slice(at + selector.length + 2, css.indexOf('}', at)).trim();
};

describe('a screen never slides sideways', () => {
  it('cuts what sticks out at the edge of the app, without turning the page into a scroll box (sticky headers keep working)', () => {
    expect(rule('html')).toContain('overflow-x: hidden');
    expect(css).toMatch(/@supports \(overflow: clip\) \{ html, body, #root \{ overflow-x: clip; \} \}/);
    // `hidden` on body or #root would make them scroll boxes: the sticky header and day headings would stop sticking.
    expect(css).not.toMatch(/(^|[ ,}])(body|#root)[^{}]*\{[^}]*overflow(-x)?: hidden/);
  });

  it('makes a grid with no column rule one column that shrinks with the screen', () => {
    expect(rule('.grid')).toBe('grid-template-columns: minmax(0, 1fr);');
    // In the base layer, so `grid-cols-*` (the utilities, which come later) still win.
    const base = css.indexOf('.grid {');
    expect(base).toBeGreaterThan(css.indexOf('@layer base'));
    expect(base).toBeLessThan(css.indexOf('@layer components'));
  });

  it('does not break words in two to make them fit (it split the "Speed" title of a Home chart)', () => {
    expect(css).not.toMatch(/(^|[ ,}])(html|body|#root|\*)[^{}]*\{[^}]*(overflow-wrap|word-break)/);
  });

  it('gives every inline row that is meant to shrink a width limit (without one, the name inside is never cut short)', () => {
    // `inline-flex min-w-0` says "this may shrink", but an inline box is as wide as its content unless `max-w-full` stops it.
    for (const file of ['src/components/sim/SimCarIdentity.tsx', 'src/components/sim/session/Hero.tsx', 'src/components/sim/garage/TrackBoard.tsx']) {
      const rows = source(file).match(/className=[{"'`][^>]*\binline-flex\b[^>]*/g) ?? [];
      const shrinking = rows.filter((row) => /\bmin-w-0\b/.test(row));
      expect(shrinking.length, file).toBeGreaterThan(0);
      for (const row of shrinking) expect(row, file).toMatch(/\bmax-w-full\b/);
    }
  });

  it('has the browser check wired as `npm run check:phone`', () => {
    expect(JSON.parse(source('package.json')).scripts['check:phone']).toBe('node scripts/check-phone-width.mjs');
  });
});
