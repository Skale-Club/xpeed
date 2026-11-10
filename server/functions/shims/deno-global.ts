// The only part of the Deno global the edge functions use is Deno.env.get(). Supabase gave them
// its own URL and keys; here those names answer with fixed stand-ins that the createClient shim
// recognizes, and every other name is read from the server's environment.
export const SERVICE_KEY = 'xpeed-own-backend-service';
const STAND_INS: Record<string, string> = {
  SUPABASE_URL: 'https://own-backend.invalid',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_ANON_KEY: 'xpeed-own-backend-anon',
};

const env = {
  get(name: string): string | undefined {
    if (name in STAND_INS) return STAND_INS[name];
    // The functions call the app by this name; the server knows it as PUBLIC_APP_URL.
    if (name === 'XPEED_APP_URL') return process.env.XPEED_APP_URL || process.env.PUBLIC_APP_URL || undefined;
    return process.env[name];
  },
};

(globalThis as { Deno?: unknown }).Deno = { env };
