import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth, onIdTokenChanged, GoogleAuthProvider,
  RecaptchaVerifier, signInWithPhoneNumber, signInWithPopup,
  signOut, updateProfile, signInWithCredential,
  type Auth, type ConfirmationResult,
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';

export interface IdentityUser { uid: string }
let nativeReady: Promise<void> | undefined;
async function nativeAuth() {
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
  nativeReady ??= (async () => {
    await FirebaseAuthentication.useAppLanguage();
  })();
  await nativeReady;
  return FirebaseAuthentication;
}

let auth: Auth | undefined;
let confirmation: { phone: string; result: ConfirmationResult } | undefined;
let nativeVerification: { phone: string; id: string } | undefined;
let captcha: RecaptchaVerifier | undefined;
let captchaNode: HTMLDivElement | undefined;
let phoneGeneration = 0;
let cancelNativeRequest: (() => void) | undefined;

export function getGoogleAuth(): Auth {
  if (auth) return auth;
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  if (!apiKey || !projectId || !authDomain) {
    throw Object.assign(new Error('Google Cloud authentication is not configured'), { code: 'auth/configuration-not-found' });
  }
  const app = getApps().length ? getApp() : initializeApp({
    apiKey, projectId, authDomain, appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  auth = getAuth(app);
  auth.useDeviceLanguage();
  return auth;
}

export async function getAccessToken(): Promise<string | null> {
  // Public reports and the landing page must work before Google is configured.
  if (!import.meta.env.VITE_FIREBASE_API_KEY) return null;
  if (Capacitor.isNativePlatform()) {
    const native = await nativeAuth();
    if (!(await native.getCurrentUser()).user) return null;
    return (await native.getIdToken()).token;
  }
  const instance = getGoogleAuth();
  await instance.authStateReady();
  return instance.currentUser?.getIdToken() ?? null;
}

export function observeGoogleUser(callback: (user: IdentityUser | null) => void, error: (error: Error) => void) {
  if (!Capacitor.isNativePlatform()) return onIdTokenChanged(getGoogleAuth(), callback, error);
  let active = true;
  let changed = false;
  let handle: { remove: () => Promise<void> } | undefined;
  void (async () => {
    const native = await nativeAuth();
    handle = await native.addListener('authStateChange', ({ user }) => {
      changed = true; if (active) callback(user);
    });
    if (!active) { await handle.remove(); return; }
    const { user } = await native.getCurrentUser();
    if (active && !changed) callback(user);
  })().catch((cause) => { if (active) error(cause); });
  return () => { active = false; void handle?.remove(); };
}

function clearCaptcha() {
  captcha?.clear(); captcha = undefined;
  captchaNode?.remove(); captchaNode = undefined;
}

export function cancelPhoneChallenge() {
  ++phoneGeneration;
  cancelNativeRequest?.();
  confirmation = undefined; nativeVerification = undefined; clearCaptcha();
}

export async function sendPhoneCode(phone: string) {
  cancelPhoneChallenge();
  const generation = phoneGeneration;
  if (Capacitor.isNativePlatform()) {
    const FirebaseAuthentication = await nativeAuth();
    // Native attestation replaces reCAPTCHA in Android's WebView.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const handles: { remove: () => Promise<void> }[] = [];
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        cancelNativeRequest = undefined;
        void Promise.all(handles.map((handle) => handle.remove()));
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('SMS request timed out')), 120_000);
      cancelNativeRequest = () => finish(new DOMException('Phone sign-in cancelled', 'AbortError'));
      const listen = async (handle: Promise<{ remove: () => Promise<void> }>) => {
        const result = await handle;
        if (settled) await result.remove(); else handles.push(result);
      };
      void (async () => {
        await listen(FirebaseAuthentication.addListener('phoneCodeSent', (event) => {
          if (generation !== phoneGeneration) return;
          nativeVerification = { phone, id: event.verificationId }; finish();
        }));
        await listen(FirebaseAuthentication.addListener('phoneVerificationCompleted', () => finish()));
        await listen(FirebaseAuthentication.addListener('phoneVerificationFailed', (event) => finish(Object.assign(new Error(event.message), { code: event.code }))));
        if (settled) return;
        await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: phone });
      })().catch(finish);
    });
    return;
  }
  const instance = getGoogleAuth();
  clearCaptcha();
  captchaNode = document.createElement('div');
  document.body.appendChild(captchaNode);
  const challenge = new RecaptchaVerifier(instance, captchaNode, { size: 'invisible' });
  captcha = challenge;
  try {
    const result = await signInWithPhoneNumber(instance, phone, challenge);
    if (generation !== phoneGeneration) throw new DOMException('Phone sign-in cancelled', 'AbortError');
    confirmation = { phone, result };
  } finally { if (captcha === challenge) clearCaptcha(); }
}

export async function verifyPhoneCode(phone: string, code: string) {
  if (Capacitor.isNativePlatform() && nativeVerification?.phone === phone) {
    const native = await nativeAuth();
    const result = await native.confirmVerificationCode({ verificationId: nativeVerification.id, verificationCode: code });
    if (!result.user) throw new Error('Phone sign-in failed');
    return result.user;
  }
  if (confirmation?.phone !== phone) throw Object.assign(new Error('Request a new code'), { code: 'auth/code-expired' });
  return (await confirmation.result.confirm(code)).user;
}

export async function signInWithGoogle(): Promise<IdentityUser> {
  if (Capacitor.isNativePlatform()) {
    const native = await nativeAuth();
    const result = await native.signInWithGoogle();
    if (!result.user) throw new Error('Google returned no identity');
    return result.user;
  }
  return (await signInWithPopup(getGoogleAuth(), new GoogleAuthProvider())).user;
}

export async function signInWithGoogleIdToken(token: string): Promise<IdentityUser> {
  return (await signInWithCredential(getGoogleAuth(), GoogleAuthProvider.credential(token))).user;
}

export async function signOutGoogle() {
  cancelPhoneChallenge();
  if (auth) await signOut(auth);
  if (Capacitor.isNativePlatform()) {
    await (await nativeAuth()).signOut();
  }
}

export async function updateDisplayName(name: string) {
  if (Capacitor.isNativePlatform()) { await (await nativeAuth()).updateProfile({ displayName: name }); return; }
  const user = getGoogleAuth().currentUser;
  if (!user) throw new Error('Not signed in');
  await updateProfile(user, { displayName: name });
}
