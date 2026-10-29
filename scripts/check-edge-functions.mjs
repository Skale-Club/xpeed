import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
const files = sources('supabase/functions').sort();
const runtime = process.env.XPEED_DENO_BIN || 'deno';
const common = ['--no-lock', '--no-config', '--node-modules-dir=none'];
for (const args of [['check', ...common, ...files], ['test', ...common, ...files.filter(file => file.endsWith('.test.ts'))]]) {
  const result = spawnSync(runtime, args, { stdio: 'inherit', shell: false });
  if (result.error) { console.error(`Deno unavailable: ${result.error.message}`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
