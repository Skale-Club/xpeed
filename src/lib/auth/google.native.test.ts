import { afterEach, expect, it, vi } from 'vitest';

// Uses the real @capacitor/core and plugin: only the Android bridge is faked.
// Capacitor plugins are Proxies that answer to any property, including `then`,
// so a promise resolved with one never settles. A plain-object mock can't show it.
const answers: Record<string, unknown> = { useAppLanguage: {}, getCurrentUser: { user: null }, getIdToken: { token: 'id-token' } };

async function loadOnAndroid() {
  vi.resetModules();
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-key');
  vi.stubGlobal('androidBridge', { postMessage: () => {} });
  vi.stubGlobal('Capacitor', {
    PluginHeaders: [{ name: 'FirebaseAuthentication', methods: Object.keys(answers).map((name) => ({ name, rtype: 'promise' })) }],
    nativePromise: async (_plugin: string, method: string) => answers[method],
  });
  return import('./google');
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); answers.getCurrentUser = { user: null }; });

it('answers on Android when nobody is signed in, so the app can leave its loading screen', async () => {
  const { getAccessToken } = await loadOnAndroid();
  await expect(getAccessToken()).resolves.toBeNull();
}, 3000);

it('returns the native token on Android when someone is signed in', async () => {
  answers.getCurrentUser = { user: { uid: 'google-uid' } };
  const { getAccessToken } = await loadOnAndroid();
  await expect(getAccessToken()).resolves.toBe('id-token');
}, 3000);
