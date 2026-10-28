import { describe, it, expect } from 'vitest';
import { findAppUpdate, parseReleaseBuild } from './app-update';

describe('app update check', () => {
  it('reads the build number CI writes in the release notes', () => {
    expect(parseReleaseBuild('Build 42 from feat/android-app @ 2d1e4b0. Install on Android: …')).toBe(42);
    expect(parseReleaseBuild('no number here')).toBeNull();
    expect(parseReleaseBuild(null)).toBeNull();
  });

  it('never reports an update outside the Android app', async () => {
    expect(await findAppUpdate()).toBeNull();
  });
});
