import { afterEach } from 'vitest';
import { queryClient } from '@/lib/query-client';
afterEach(() => queryClient.clear());
import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Screens wait on the simulated adapter (fault codes per module, VIN); under a
// full parallel run that can take more than the default second.
configure({ asyncUtilTimeout: 5000 });

// Tests run as a phone, where "always on" is available (see lib/device.ts).
Object.defineProperty(navigator, "userAgent", {
  configurable: true,
  value: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
