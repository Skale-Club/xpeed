// esbuild plugin that lets the unchanged Supabase edge-function sources (Deno) be bundled into the
// Node server: the few imports that tied them to Deno or Supabase are replaced by server/functions/shims.
import { resolve } from 'node:path';

export const edgeFunctions = {
  name: 'edge-functions',
  setup(build) {
    const shim = (file) => resolve(process.cwd(), 'server/functions/shims', file);
    build.onResolve({ filter: /^https:\/\/deno\.land\/std@[^/]+\/http\/server\.ts$/ }, () => ({ path: shim('deno-http.ts') }));
    build.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\/supabase-js@2$/ }, () => ({ path: shim('supabase.ts') }));
    build.onResolve({ filter: /^npm:zod@/ }, (args) => build.resolve('zod', { resolveDir: process.cwd(), kind: args.kind }));
    // Anything else would fail at run time on the server, so fail the build instead.
    build.onResolve({ filter: /^(https?:|npm:|jsr:)/ }, (args) => ({
      errors: [{ text: `${args.importer} imports ${args.path}, which the server cannot provide. Add a shim in server/functions/shims and map it in scripts/esbuild-edge.mjs.` }],
    }));
  },
};
