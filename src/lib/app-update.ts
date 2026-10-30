// Android app only: compare the installed build with the latest APK that CI
// published (.github/workflows/android-apk.yml) so the app can offer a
// one-tap update. Sideloaded apps can't update themselves silently.
//
// The default APK loads the live site, so web changes reach it with every
// deploy; it only needs a new APK when the native side changed ("Native
// build" in the release notes). The offline APK carries the web app inside
// and needs every build.

import { isNativeApp } from '@/lib/obd/native-ble';

export const OFFLINE_APK_URL = 'https://github.com/Skale-Club/xpeed/releases/download/android-latest/xpeed-offline.apk';
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
export function isLiveSiteApp(): boolean {
  return typeof window !== 'undefined' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

/** The build the installed app needs, given the release notes and which APK it is. */
export function requiredBuild(notes: string | null | undefined, liveSite: boolean): number | null {
  return liveSite ? parseNativeBuild(notes) : parseReleaseBuild(notes);
}

export interface ApkUpdate {
  installed: number; installedVersion: string; required: number | null;
  latest: number | null; available: boolean; bundled: boolean; downloadUrl: string;
}
let cached: { at: number; result: Promise<ApkUpdate | null> } | null = null;
/** Only verified native changes require the live-site APK to be reinstalled. */
export async function checkApkUpdate(force = false): Promise<ApkUpdate | null> {
  if (!isNativeApp()) return null;
  if (!force && cached && Date.now() - cached.at < 60000) return cached.result;
  const result = (async () => {
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      const installed = Number(info.build);
      if (!Number.isSafeInteger(installed) || installed < 1) return null;
      const bundled = !isLiveSiteApp();
      const status: ApkUpdate = { installed, installedVersion: info.version, required: null, latest: null, bundled,
        available: false, downloadUrl: bundled ? OFFLINE_APK_URL : APK_URL };
      if (navigator.onLine === false) return status;
      try {
        const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!res.ok) return status;
        const notes = (await res.json()).body as string | null;
        const needed = requiredBuild(notes, !bundled), latest = parseReleaseBuild(notes);
        return { ...status, required: needed, latest, available: needed !== null && needed > installed };
      } catch { return status; } // Installed version remains visible when offline.
    } catch { return null; }
  })();
  cached = { at: Date.now(), result };
  return result;
}
/** Compatibility for callers that only need the available APK build. */
export async function findAppUpdate(): Promise<number | null> {
  const status = await checkApkUpdate();
  return status?.available ? status.latest ?? status.required : null;
}
