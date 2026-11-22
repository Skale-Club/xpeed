// POST /api/sim/web-session: the Companion's own window signs the site in as the account it is connected to, so a person who
// is connected in the Companion never meets a second sign-in on the site's pages inside it (shared/design/companion-shell.md,
// "Sign-in", stage 2).
//
// Two steps, so the device key never reaches the page and the page never holds anything that lasts:
//   1. The Companion (Authorization: Bearer <device key>) asks for a code: { code }, single use, two minutes.
//   2. The page inside the Companion sends { code } (no key) and gets { token, uid }: a Firebase custom token for the
//      account's existing Google identity, which it hands to signInWithCustomToken.
//
// The custom token is signed with the Firebase service account in FIREBASE_SERVICE_ACCOUNT (its JSON, or the JSON in
// base64). Without it the first step answers 503 not_configured and the page shows its normal sign-in.
// A custom token never makes an account: it is only issued for an identity that already exists (the database's
// register_google_user refuses a custom sign-in it does not know, migration 20261122120000).
import { randomBytes } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { openBackend } from '../_backend';
import { bearer, clientIp, reply, sha256Hex, tooMany } from './_shared';

/** How long a code may wait for the page. */
export const CODE_TTL_MS = 2 * 60 * 1000;
/** Firebase accepts a custom token for at most one hour; the page uses it at once. */
const TOKEN_TTL_S = 10 * 60;
const AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
/** Codes waiting at most at once (each lives two minutes; this only stops a flood from growing memory). */
const MAX_WAITING = 2000;

export interface ServiceAccount { clientEmail: string; privateKey: string; projectId: string }

/** The service account from the environment, or null when it is missing or not a service account's JSON. */
export function serviceAccountFrom(env: NodeJS.ProcessEnv = process.env): ServiceAccount | null {
  const raw = (env.FIREBASE_SERVICE_ACCOUNT ?? '').trim();
  if (!raw) return null;
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    const value = JSON.parse(text) as { client_email?: unknown; private_key?: unknown; project_id?: unknown };
    const clientEmail = typeof value.client_email === 'string' ? value.client_email : '';
    const privateKey = typeof value.private_key === 'string' ? value.private_key.replace(/\\n/g, '\n') : '';
    const projectId = typeof value.project_id === 'string' ? value.project_id : env.FIREBASE_PROJECT_ID ?? env.VITE_FIREBASE_PROJECT_ID ?? '';
    if (!clientEmail || !privateKey.includes('PRIVATE KEY') || !projectId) return null;
    return { clientEmail, privateKey, projectId };
  } catch {
    return null;
  }
}

/** A Firebase custom token for `uid` (https://firebase.google.com/docs/auth/admin/create-custom-tokens#create_custom_tokens_using_a_third-party_jwt_library). */
export async function customToken(account: ServiceAccount, uid: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await importPKCS8(account.privateKey, 'RS256');
  // role=authenticated: what the sign-in hook gives Google and phone sign-ins, which a custom sign-in does not pass through.
  return new SignJWT({ uid, claims: { role: 'authenticated' } })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.clientEmail)
    .setSubject(account.clientEmail)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_S)
    .sign(key);
}

// Codes waiting for the page, by their hash. One server process answers for the whole app (as for the pairing codes and the
// live relay); a restart forgets them, and the Companion simply asks again.
const waiting = new Map<string, { uid: string; expires: number }>();

/** Keeps a code for `uid` and returns it. */
export function issueCode(uid: string, now = Date.now()): string {
  for (const [hash, entry] of waiting) if (entry.expires <= now) waiting.delete(hash);
  if (waiting.size >= MAX_WAITING) waiting.delete(waiting.keys().next().value as string);
  const code = randomBytes(32).toString('base64url');
  waiting.set(sha256Hex(code), { uid, expires: now + CODE_TTL_MS });
  return code;
}

/** The uid of a code that is still waiting, once: a code read is gone. */
export function redeemCode(code: string, now = Date.now()): string | null {
  const hash = sha256Hex(code);
  const entry = waiting.get(hash);
  waiting.delete(hash);
  return entry && entry.expires > now ? entry.uid : null;
}

/** Tests: forget every code. */
export const forgetCodes = () => waiting.clear();

const isCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export default async function webSession(req: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  const account = serviceAccountFrom(env);
  const key = bearer(req);

  // Step 2: the page trades its code for a custom token.
  if (!key) {
    const wait = tooMany(`web-session:redeem:${clientIp(req)}`, 30, 60_000);
    if (wait) return reply({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });
    let body: { code?: unknown };
    try { body = await req.json() as { code?: unknown }; } catch { return reply({ error: 'bad_request' }, 400); }
    if (!isCode(body?.code)) return reply({ error: 'bad_request' }, 400);
    const uid = redeemCode(body.code);
    if (!uid) return reply({ error: 'expired' }, 410);
    if (!account) return reply({ error: 'not_configured' }, 503);
    try {
      return reply({ token: await customToken(account, uid), uid });
    } catch (error) {
      console.error(JSON.stringify({ event: 'web_session_sign_failed', message: error instanceof Error ? error.message : 'unknown' }));
      return reply({ error: 'unavailable' }, 503);
    }
  }

  // Step 1: the Companion asks for a code with its device key.
  if (!account) return reply({ error: 'not_configured' }, 503);
  const backend = openBackend(env);
  if (!backend) return reply({ error: 'unavailable' }, 503);
  try {
    const who = await backend.service.rpc('sim_authenticate_device', { p_token_hash: sha256Hex(key) });
    if (who.error) throw who.error;
    const device = who.data as { user_id?: string; device_id?: string } | null;
    if (!device?.user_id || !device.device_id) return reply({ error: 'unauthorized' }, 401);

    const wait = tooMany(`web-session:${device.device_id}`, 20, 60_000);
    if (wait) return reply({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });

    // The account's Google identity in this Firebase project (an account with several sign-in methods has one per method;
    // any of them is the same account).
    const identities = await backend.service.from('google_auth_identities')
      .select('subject')
      .eq('account_id', device.user_id)
      .eq('issuer', `https://securetoken.google.com/${account.projectId}`)
      .eq('tenant_id', '')
      .order('subject')
      .limit(1);
    if (identities.error) throw identities.error;
    const subject = (identities.data as { subject?: string }[] | null)?.[0]?.subject;
    // An account from before Google sign-in (or another project) has no identity a custom token could sign in as.
    if (!subject) return reply({ error: 'no_identity' }, 404);
    return reply({ code: issueCode(subject) });
  } catch (error) {
    console.error(JSON.stringify({ event: 'web_session_failed', message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown' }));
    return reply({ error: 'unavailable' }, 503);
  }
}
