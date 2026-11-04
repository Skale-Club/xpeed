// What the unchanged edge-function sources import. At build time these specifiers are replaced by
// ./shims (scripts/esbuild-edge.mjs); here they only let the type checker read those sources.
declare module 'https://deno.land/std@0.224.0/http/server.ts' {
  export function serve(handler: (request: Request) => Response | Promise<Response>, options?: unknown): void;
}
declare module 'https://esm.sh/@supabase/supabase-js@2' {
  // The functions cast results themselves (`as any`); the real typing lives in the database.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createClient(url: string, key: string, options?: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SupabaseClient = any;
}
declare module 'npm:zod@3.23.8' {
  export * from 'zod';
}
declare const Deno: { env: { get(name: string): string | undefined } };
