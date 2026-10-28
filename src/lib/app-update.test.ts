import { describe, it, expect } from 'vitest';
import { findAppUpdate, parseReleaseBuild, requiredBuild } from './app-update';

describe('app update check', () => {
  it('reads the build number CI writes in the release notes', () => {
    expect(parseReleaseBuild('Build 42 from feat/android-app @ 2d1e4b0. Install on Android: …')).toBe(42);
    expect(parseReleaseBuild('no number here')).toBeNull();
    expect(parseReleaseBuild(null)).toBeNull();
  });

  it('asks the live-site app to update only for native changes', () => {
    const notes = 'Build 57 from main @ abc1234. Native build 52 @ def5678. Install on Android: …';
    expect(parseReleaseBuild(notes)).toBe(57);
    expect(requiredBuild(notes, true)).toBe(52); // web changes since 52 arrive with the site
    expect(requiredBuild(notes, false)).toBe(57); // the offline APK needs every build
    // Older notes without the native number: every build counts
    expect(requiredBuild('Build 42 from main @ 2d1e4b0.', true)).toBe(42);
  });

  it('never reports an update outside the Android app', async () => {
    expect(await findAppUpdate()).toBeNull();
  });
});
