/// <reference types="vite-plugin-pwa/client" />
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";
import { i18nReady } from "./lib/i18n";
import { installPreloadErrorReload, startPwaUpdates } from "./lib/pwa-update";

// When a new Vercel deployment lands, hashed JS chunks from the previous build
// are no longer served and lazy-imported routes fail. Reload to pick up the new
// index.html - at most once per 5 minutes so a chunk that keeps failing cannot
// put the app in a reload loop.
installPreloadErrorReload();

// Register the service worker and keep an always-open app up to date
// (periodic update checks; the swap waits until no trip is being recorded).
if (import.meta.env.PROD) {
  startPwaUpdates(registerSW);
}

// Render once the starting language is loaded (locale files load on demand),
// so the first paint is never raw translation keys. A failed load still renders.
const mount = () => createRoot(document.getElementById("root")!).render(<App />);
i18nReady.then(mount, mount);
