import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Laps come only from Xpeed Companion. No Virtual screen may take a file by hand: no file input, no drop zone, no folder picker.
// (A render-based check of the same rule lives in each screen's own tests; this one reads the code of every Virtual screen.)

const root = join(process.cwd(), 'src');
const read = (dir: string, pick: (name: string) => boolean) =>
  readdirSync(join(root, dir))
    .filter((name) => pick(name) && !/\.test\./.test(name))
    .map((name) => ({ file: `${dir}/${name}`, text: readFileSync(join(root, dir, name), 'utf8') }));

const screens = [
  ...read('pages', (name) => /^Sim.*\.tsx$/.test(name)),
  ...read('components/sim', (name) => /\.tsx?$/.test(name)),
];

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a file input', /type\s*=\s*['"{]\s*['"]?file\b/i],
  ['a file input (createElement)', /createElement\(\s*['"]input['"]/],
  ['a drop handler', /\bonDrop\b|\bonDragOver\b|addEventListener\(\s*['"]drop['"]/],
  ['dataTransfer', /\bdataTransfer\b/],
  ['a folder picker', /webkitdirectory|showOpenFilePicker|showDirectoryPicker/],
];

describe('the Virtual screens', () => {
  it('has screens to scan', () => {
    expect(screens.length).toBeGreaterThan(10);
    expect(screens.some((entry) => entry.file.endsWith('SessionsList.tsx'))).toBe(true);
    expect(screens.some((entry) => entry.file.endsWith('CompareScreen.tsx'))).toBe(true);
  });

  for (const [what, pattern] of FORBIDDEN) {
    it(`do not contain ${what}`, () => {
      const found = screens.filter((entry) => pattern.test(entry.text)).map((entry) => entry.file);
      expect(found).toEqual([]);
    });
  }

  it('no longer carry the manual-import code', () => {
    const lib = readdirSync(join(root, 'lib/sim'));
    for (const gone of ['import-laps.ts', 'sample-laps.ts', 'account-laps.ts', 'sessions.ts', 'overview.ts']) expect(lib).not.toContain(gone);
    const library = readFileSync(join(root, 'lib/sim/library.ts'), 'utf8');
    expect(library).not.toMatch(/addLapFile|mergeLaps|listLaps/);
  });
});
