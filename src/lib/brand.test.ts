// The Xpeed mark has one source, branding/mark.svg (see branding/README.md). These checks fail when a copy of it
// drifts: the generated logo, the places that show it, and the icon sizes the PWA manifest promises.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`"${start}" not found`);
  const rest = text.slice(from + start.length);
  return rest.slice(0, rest.indexOf(end));
};
const pngSize = (path: string) => {
  const bytes = readFileSync(resolve(root, path));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

const points = (svg: string) => between(svg, 'points="', '"').trim().split(/\s+/);

describe('the Xpeed mark', () => {
  it('is in public/logo.svg exactly as branding/mark.svg has it', () => {
    const source = points(read('branding/mark.svg'));
    expect(source.length).toBe(26);
    expect(points(read('public/logo.svg'))).toEqual(source);
  });

  it('is drawn with the two colours of the brand script, on the rounded tile', () => {
    const script = read('scripts/brand-assets.mjs');
    const yellow = between(script, "const YELLOW = '", "'");
    const dark = between(script, "const DARK = '", "'");
    expect([yellow, dark]).toEqual(['#F5E663', '#111214']);
    const logo = read('public/logo.svg');
    expect(logo).toContain(`fill="${yellow}"`);
    expect(logo).toContain(`<g fill="${dark}"`);
    expect(between(logo, 'rx="', '"')).toBe('112.64');
  });

  it('is shown by the one component, from the one file', () => {
    expect(read('src/components/BrandLogo.tsx')).toContain('src="/logo.svg"');
    expect(read('index.html')).toContain('href="/logo.svg"');
  });

  it('has the icon sizes the PWA manifest promises', () => {
    expect(pngSize('public/icon-192.png')).toEqual([192, 192]);
    expect(pngSize('public/icon-512.png')).toEqual([512, 512]);
    expect(pngSize('public/icon-maskable-512.png')).toEqual([512, 512]);
  });

  it('is documented where the next person will look', () => {
    expect(read('branding/README.md')).toContain('never redrawn');
    const agents = read('AGENTS.md');
    expect(agents).toContain('brand-rule:v1');
    expect(agents).toContain('branding/README.md');
  });
});
