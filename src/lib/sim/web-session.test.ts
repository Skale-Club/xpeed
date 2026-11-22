import { afterEach, describe, expect, it } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import webSession, { CODE_TTL_MS, customToken, forgetCodes, issueCode, redeemCode, serviceAccountFrom } from '../../../api/sim/web-session';
import { forgetLimits } from '../../../api/sim/_shared';

afterEach(() => { forgetCodes(); forgetLimits(); });

async function account() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const json = JSON.stringify({ type: 'service_account', project_id: 'proj', client_email: 'signer@proj.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) });
  return { json, spki: await exportSPKI(publicKey) };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://xpeed.test/api/sim/web-session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the Companion window sign-in', () => {
  it('reads the service account as JSON or base64, and nothing else', async () => {
    const { json } = await account();
    expect(serviceAccountFrom({ FIREBASE_SERVICE_ACCOUNT: json })).toMatchObject({ projectId: 'proj', clientEmail: 'signer@proj.iam.gserviceaccount.com' });
    expect(serviceAccountFrom({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(json).toString('base64') })?.projectId).toBe('proj');
    expect(serviceAccountFrom({})).toBeNull();
    expect(serviceAccountFrom({ FIREBASE_SERVICE_ACCOUNT: '{"client_email":"x"}' })).toBeNull();
    expect(serviceAccountFrom({ FIREBASE_SERVICE_ACCOUNT: 'not json' })).toBeNull();
  });

  it('signs a Firebase custom token for the uid', async () => {
    const { json, spki } = await account();
    const token = await customToken(serviceAccountFrom({ FIREBASE_SERVICE_ACCOUNT: json })!, 'firebase-uid');
    const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(spki, 'RS256'), {
      issuer: 'signer@proj.iam.gserviceaccount.com',
      audience: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload).toMatchObject({ uid: 'firebase-uid', sub: 'signer@proj.iam.gserviceaccount.com', claims: { role: 'authenticated' } });
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(3600);
  });

  it('a code works once and only for two minutes', () => {
    const code = issueCode('uid-1', 1000);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemCode(code, 1001)).toBe('uid-1');
    expect(redeemCode(code, 1002)).toBeNull();
    const late = issueCode('uid-2', 1000);
    expect(redeemCode(late, 1000 + CODE_TTL_MS)).toBeNull();
    expect(redeemCode('x'.repeat(43))).toBeNull();
  });

  it('trades a code for a token the page can sign in with', async () => {
    const { json } = await account();
    const code = issueCode('uid-9');
    const response = await webSession(post({ code }), { FIREBASE_SERVICE_ACCOUNT: json });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; uid: string };
    expect(body.uid).toBe('uid-9');
    expect(body.token.split('.')).toHaveLength(3);
    // Used once: the same code again is gone.
    expect((await webSession(post({ code }), { FIREBASE_SERVICE_ACCOUNT: json })).status).toBe(410);
  });

  it('refuses what is not a code, other methods, and a server with no service account', async () => {
    const { json } = await account();
    expect((await webSession(post({ code: 'short' }), { FIREBASE_SERVICE_ACCOUNT: json })).status).toBe(400);
    expect((await webSession(post({}), { FIREBASE_SERVICE_ACCOUNT: json })).status).toBe(400);
    expect((await webSession(new Request('https://xpeed.test/api/sim/web-session'), {})).status).toBe(405);
    // The Companion asking with its key: nothing to sign with yet.
    const asked = await webSession(post({}, { Authorization: 'Bearer xpd_key' }), {});
    expect(asked.status).toBe(503);
    expect(await asked.json()).toEqual({ error: 'not_configured' });
  });
});
