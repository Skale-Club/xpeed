import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  native: false, send: vi.fn(), confirm: vi.fn(), clear: vi.fn(),
  nativeSend: vi.fn(), nativeConfirm: vi.fn(), nativeToken: vi.fn(),
  listeners: new Map<string, (event: unknown) => void>(), remove: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('firebase/app', () => ({ getApps: () => [], getApp: vi.fn(), initializeApp: () => ({}) }));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ useDeviceLanguage: vi.fn(), authStateReady: async () => {}, currentUser: null }),
  onIdTokenChanged: vi.fn(), GoogleAuthProvider: class {},
  RecaptchaVerifier: class { clear = h.clear; },
  signInWithPhoneNumber: h.send, signInWithPopup: vi.fn(), signOut: vi.fn(), updateProfile: vi.fn(),
}));
vi.mock('@capacitor-firebase/authentication', () => ({ FirebaseAuthentication: {
  useAppLanguage: async () => {}, setTenantId: async () => {},
  addListener: async (name: string, callback: (event: unknown) => void) => {
    h.listeners.set(name, callback);
    return { remove: async () => { h.listeners.delete(name); h.remove(name); } };
  },
  signInWithPhoneNumber: h.nativeSend, confirmVerificationCode: h.nativeConfirm,
  getCurrentUser: async () => ({ user: { uid: 'native-user' } }), getIdToken: h.nativeToken,
} }));

beforeEach(() => {
  vi.resetModules(); h.native = false; h.send.mockReset(); h.confirm.mockReset();
  h.clear.mockReset(); h.listeners.clear(); h.remove.mockReset(); h.nativeSend.mockReset();
  h.nativeConfirm.mockReset(); h.nativeToken.mockReset();
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-key'); vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'test.firebaseapp.com');
});
afterEach(() => { vi.unstubAllEnvs(); });

it('keeps a web confirmation bound to the phone that requested it', async () => {
  h.send.mockResolvedValue({ confirm: h.confirm });
  h.confirm.mockResolvedValue({ user: { uid: 'web-user' } });
  const auth = await import('./google');
  await auth.sendPhoneCode('+15555550123');
  await expect(auth.verifyPhoneCode('+15555550999', '123456')).rejects.toMatchObject({ code: 'auth/code-expired' });
  expect(h.confirm).not.toHaveBeenCalled();
  expect((await auth.verifyPhoneCode('+15555550123', '123456')).uid).toBe('web-user');
  expect(h.clear).toHaveBeenCalledTimes(1);
  auth.cancelPhoneChallenge();
});

it('cannot restore an abandoned web challenge when sending finishes later', async () => {
  let resolve!: (value: unknown) => void;
  h.send.mockReturnValue(new Promise((done) => { resolve = done; }));
  const auth = await import('./google');
  const request = auth.sendPhoneCode('+15555550123');
  auth.cancelPhoneChallenge();
  resolve({ confirm: h.confirm });
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await expect(auth.verifyPhoneCode('+15555550123', '123456')).rejects.toMatchObject({ code: 'auth/code-expired' });
});

it('uses native attestation and confirmation on Android, removing temporary listeners', async () => {
  h.native = true;
  h.nativeSend.mockImplementation(async () => h.listeners.get('phoneCodeSent')?.({ verificationId: 'native-challenge' }));
  h.nativeConfirm.mockResolvedValue({ user: { uid: 'native-user' } });
  h.nativeToken.mockResolvedValue({ token: 'native-google-token' });
  const auth = await import('./google');
  await auth.sendPhoneCode('+15555550123');
  expect(h.send).not.toHaveBeenCalled();
  expect(h.remove).toHaveBeenCalledTimes(3);
  expect((await auth.verifyPhoneCode('+15555550123', '123456')).uid).toBe('native-user');
  expect(h.nativeConfirm).toHaveBeenCalledWith({ verificationId: 'native-challenge', verificationCode: '123456' });
  expect(await auth.getAccessToken()).toBe('native-google-token');
  auth.cancelPhoneChallenge();
});
