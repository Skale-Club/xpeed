// Writes shared/design/icons.json: the Lucide icons the Companion draws (its own screens, the Virtual menu and Settings), as the
// very shapes lucide-react draws them, so the Companion's sidebar shows the site's icons and not look-alikes.
// Run `npm run design:icons` after changing an icon in shared/design/nav.json or upgrading lucide-react;
// src/lib/shared-design.test.ts fails until the file matches.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAV = join(root, 'shared/design/nav.json');
const OUT = join(root, 'shared/design/icons.json');
const LUCIDE = join(root, 'node_modules/lucide-react');

/** `CarFront` -> `car-front`, the name of its file in lucide-react. */
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase();

/** The icon's elements (`[tag, attributes]`, without React's `key`), read from lucide-react's own module. */
function iconNode(name) {
  const source = readFileSync(join(LUCIDE, 'dist/esm/icons', `${kebab(name)}.js`), 'utf8');
  const start = source.indexOf(`createLucideIcon("${name}", `);
  if (start < 0) throw new Error(`lucide-react has no icon ${name}`);
  const from = source.indexOf('[', start);
  const to = source.indexOf(');\n', from);
  const node = vm.runInNewContext(`(${source.slice(from, to)})`);
  return node.map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs;
    return [tag, rest];
  });
}

/** What icons.json holds, built fresh from nav.json and the installed lucide-react. */
export function buildIcons() {
  const nav = JSON.parse(readFileSync(NAV, 'utf8'));
  const names = [...nav.companion, ...nav.virtual, nav.settings].map((entry) => entry.icon);
  const icons = {};
  for (const name of [...new Set(names)].sort()) icons[name] = iconNode(name);
  const version = JSON.parse(readFileSync(join(LUCIDE, 'package.json'), 'utf8')).version;
  return { lucide: version, icons };
}

export const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, serialize(buildIcons()));
  console.log(`wrote ${OUT}`);
}
