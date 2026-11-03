import { beforeUserSignedIn, HttpsError } from 'firebase-functions/v2/identity';
import { beforeSignInPolicy } from './policy.mjs';

export const xpeedBeforeSignIn = beforeUserSignedIn({ maxInstances: 3, minInstances: 0 }, (event) => {
  try { return beforeSignInPolicy(event); }
  catch { throw new HttpsError('permission-denied', 'Use Google or a text message to sign in to Xpeed.'); }
});
