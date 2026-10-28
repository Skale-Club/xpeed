// Android app only: compare the installed build with the latest APK that CI
// published (.github/workflows/android-apk.yml) so the app can offer a
// one-tap update. Sideloaded apps can't update themselves silently.

import { isNativeApp } from '@/lib/obd/native-ble';

const RELEASE_API = 'https://api.github.com/repos/Skale-Club/xpeed/releases/tags/android-latest';
export const APK_URL = 'https://github.com/Skale-Club/xpeed/releases/download/android-latest/xpeed.apk';

/** CI writes "Build <run number> from …" in the release notes; the run number is also the versionCode. */
export function parseReleaseBuild(notes: string | null | undefined): number | null {
  const m = notes?.match(/Build (\d+)/);
  return m ? Number(m[1]) : null;
}

/** The newer build number, or null when up to date / not the Android app / offline. */
export async function findAppUpdate(): Promise<number | null> {
  if (!isNativeApp()) return null;
  try {
    const { App } = await import('@capacitor/app');
    const installed = Number((await App.getInfo()).build);
    const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const latest = parseReleaseBuild((await res.json()).body);
    return latest !== null && Number.isFinite(installed) && latest > installed ? latest : null;
  } catch {
    return null;
  }
}
