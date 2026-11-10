// Calls one of the edge functions on behalf of an api/* proxy: in this process when the app runs on
// its own backend (DATA_BACKEND=own), over HTTP to the Supabase project before the cutover.
import { functionRunner } from '../server/functions/invoke-hook';

export const ownBackend = () => process.env.DATA_BACKEND === 'own';

export async function callFunction(supabaseUrl: string | undefined, name: string, rest: string, init: RequestInit & { duplex?: string }): Promise<Response> {
  if (ownBackend()) {
    const run = functionRunner();
    if (!run) return new Response(JSON.stringify({ error: 'functions_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    return run(name, new Request('http://internal/', init as RequestInit), rest);
  }
  return fetch(`${supabaseUrl}/functions/v1/${name}${rest}`, init);
}
