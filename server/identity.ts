import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { VerifiedClaims } from './db';

// Google publishes the keys that sign Identity Platform (Firebase) ID tokens here.
const GOOGLE_KEYS = new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');

let defaultKeys: JWTVerifyGetKey | undefined;

export interface IdentityOptions {
  projectId?: string;
  /** Tests inject a local key set; production uses Google's. */
  keys?: JWTVerifyGetKey;
}

/**
 * Verifies the signature, expiry, issuer and audience of a Google ID token.
 * Returns null when anything is wrong, so callers can answer 401 without detail.
 */
export async function verifyIdentity(token: string, options: IdentityOptions = {}): Promise<VerifiedClaims | null> {
  const projectId = options.projectId ?? process.env.FIREBASE_PROJECT_ID ?? process.env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId || !token) return null;
  try {
    defaultKeys ??= createRemoteJWKSet(GOOGLE_KEYS, { cooldownDuration: 30_000 });
    const { payload } = await jwtVerify(token, options.keys ?? defaultKeys, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    return typeof payload.sub === 'string' && payload.sub ? (payload as VerifiedClaims) : null;
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
}

export async function identityFromRequest(request: Request, options?: IdentityOptions) {
  return verifyIdentity(bearerToken(request), options);
}
