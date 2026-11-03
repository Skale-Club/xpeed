/** Phone sign-in is configured at project level. Tenant logins are unaffected. */
export function beforeSignInPolicy(event) {
  if (event.data?.tenantId) return;
  const provider = event.additionalUserInfo?.providerId;
  if (!['google.com', 'phone'].includes(provider)) throw new Error('Sign in with Google or a text message');
  return { customClaims: { ...event.data.customClaims, role: 'authenticated' } };
}
