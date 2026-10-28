// Android app only: compare the installed build with the latest APK that CI
// published (.github/workflows/android-apk.yml) so the app can offer a
// one-tap update. Sideloaded apps can't update themselves silently.
//
// The default APK loads the live site, so web changes reach it with every
// deploy; it only needs a new APK when the native side changed ("Native
// build" in the release notes). The offline APK carries the web app inside
// and needs every build.

import { isNativeApp } from '@/lib/obd/native-ble';

const RELEASE_API = 'https://api.github.com/repos/Skale-Club/xpeed/releases/tags/android-latest';
export const APK_URL = 'https://github.com/Skale-Club/xpeed/releases/download/android-latest/xpeed.apk';

/** CI writes "Build <run number> from …" in the release notes; the run number is also the versionCode. */
export function parseReleaseBuild(notes: string | null | undefined): number | null {
  const m = notes?.match(/(?:^|\.\s*)Build (\d+)/);
  return m ? Number(m[1]) : null;
}

/** "Native build <n>": the last build whose native side changed. */
export function parseNativeBuild(notes: string | null | undefined): number | null {
  const m = notes?.match(/Native build (\d+)/);
  return m ? Number(m[1]) : null;
}

/** The live-site APK shows the deployed site instead of a copy bundled in the app. */
function isLiveSiteApp(): boolean {
  return typeof window !== 'undefined' && !/^https?:\/\/localhost/.test(window.location.origin);
}

/** The build the installed app needs, given the release notes and which APK it is. */
export function requiredBuild(notes: string | null | undefined, liveSite: boolean): number | null {
  return liveSite ? parseNativeBuild(notes) ?? parseReleaseBuild(notes) : parseReleaseBuild(notes);
}

/** The newer build number, or null when up to date / not the Android app / offline. */
export async function findAppUpdate(): Promise<number | null> {
  if (!isNativeApp()) return null;
  try {
    const { App } = await import('@capacitor/app');
    const installed = Number((await App.getInfo()).build);
    const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const notes = (await res.json()).body as string | null;
    const needed = requiredBuild(notes, isLiveSiteApp());
    const latest = parseReleaseBuild(notes);
    return needed !== null && Number.isFinite(installed) && needed > installed ? latest ?? needed : null;
  } catch {
    return null;
  }
}
