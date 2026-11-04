// The Supabase edge functions, hosted inside this server. Their source stays where it is
// (supabase/functions/*) and is bundled unchanged: the few things that tied it to Deno or to
// Supabase (serve(), createClient(), zod from npm:, Deno.env) are swapped for the equivalents in
// ./shims at build time (scripts/esbuild-edge.mjs). Each function registers its handler with
// serve() while it is being loaded.
export type FunctionHandler = (request: Request) => Response | Promise<Response>;

const handlers = new Map<string, FunctionHandler>();
let loading = '';

/** Called by ./begin/<name>.ts right before that function's own module is evaluated. */
export function begin(name: string) { loading = name; }

export function register(handler: FunctionHandler) {
  if (!loading) throw new Error('serve() was called outside a function module');
  handlers.set(loading, handler);
}

export const functionNames = () => [...handlers.keys()];
export const hasFunction = (name: string) => handlers.has(name);

/**
 * Runs a function. The URL it sees is the one Supabase gave it (/functions/v1/<name>/<rest>),
 * because functions such as xpeed-oauth route on the part after their own name.
 */
export async function invokeFunction(name: string, request: Request, rest = ''): Promise<Response> {
  const handler = handlers.get(name);
  if (!handler) return new Response(JSON.stringify({ error: 'function_not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const url = new URL(request.url);
  const target = new URL(`/functions/v1/${name}${rest}${url.search}`, url.origin);
  const forwarded = new Request(target, request);
  try {
    return await handler(forwarded);
  } catch (error) {
    console.error(JSON.stringify({ event: 'function_failed', name, message: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }));
    return new Response(JSON.stringify({ error: 'function_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
