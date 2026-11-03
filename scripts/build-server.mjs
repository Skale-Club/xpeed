import { build } from 'esbuild';
await build({entryPoints:['server/index.ts'],outfile:'build/server/index.mjs',bundle:true,platform:'node',target:'node24',format:'esm',tsconfig:'tsconfig.app.json',sourcemap:false});
