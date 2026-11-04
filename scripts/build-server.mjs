import { build } from 'esbuild';
// `pg` is CommonJS: the ESM bundle needs a require() of its own. pg-native is an optional extra we do not use.
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
await build({entryPoints:['server/index.ts'],outfile:'build/server/index.mjs',bundle:true,platform:'node',target:'node24',format:'esm',tsconfig:'tsconfig.app.json',sourcemap:false,banner:{js:banner},external:['pg-native']});
