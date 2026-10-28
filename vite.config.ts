import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode, command }) => {
  // A production build without the Supabase settings compiles fine and then
  // breaks at runtime (and the Android workflow would publish a broken APK).
  // Fail the real build instead. Dev, tests (vitest.config.ts is separate) and
  // the screen-test harness (fake Supabase) are not affected.
  if (command === "build" && mode === "production" && !process.argv.some((a) => a.includes("harness"))) {
    const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
    const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"].filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(
        `Production build needs ${missing.join(" and ")} (set in the environment or in .env.production). ` +
          "Refusing to build an app that cannot reach Supabase.",
      );
    }
  }

  // Generated from branding/mark.svg with the other logos (`npm run brand`).
  const pwaIcons = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];

  return ({
  server: {
    host: "0.0.0.0",
    port: 5000,
    hmr: {
      overlay: false,
    },
    // Test files never run in the browser; without this, editing one
    // full-reloads the page (and drops a live Bluetooth OBD connection).
    watch: {
      ignored: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/src/test/**"],
    },
    // Proxy /api/mcp to the Supabase edge function during local development.
    // In production this route is handled by api/mcp.ts (Vercel Edge Function).
    proxy: {
      "/api/mcp": {
        target: (process.env.VITE_SUPABASE_URL ?? "") + "/functions/v1/xpeed-mcp",
        changeOrigin: true,
        rewrite: () => "",
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // "prompt": a new service worker waits until the app decides it is safe to
      // swap (see src/lib/pwa-update.ts: never mid-trip). The app registers the
      // worker itself via virtual:pwa-register in main.tsx, so no registerSW.js
      // is injected (it only registered once and never looked for updates).
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.ico", "robots.txt"],
      manifest: {
        name: "Xpeed",
        short_name: "Xpeed",
        description: "OBD2 diagnostics with AI-powered insights",
        theme_color: "#111214",
        background_color: "#111214",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: pwaIcons,
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // The new worker must NOT take over by itself: swapping assets under a
        // running trip recording (or half-loaded lazy chunks) is how stale-bundle
        // errors happen. src/lib/pwa-update.ts sends SKIP_WAITING when it is safe.
        skipWaiting: false,
        // First install only: lets the worker control the page that registered it.
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Logged-in Supabase REST responses are never cached: a cache keyed
            // by URL showed stale data on slow networks (NetworkFirst fell back
            // to it after 4 s) and kept one user's data around after logout.
            urlPattern: ({ url }) => url.hostname.endsWith(".supabase.co") && url.pathname.startsWith("/rest/"),
            handler: "NetworkOnly",
          },
          {
            // NHTSA VIN decoder.
            urlPattern: ({ url }) => url.hostname.endsWith("nhtsa.dot.gov"),
            handler: "CacheFirst",
            options: {
              cacheName: "nhtsa-vin",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        // Keep the SW out of `npm run dev` so HMR isn't fighting with caching.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Function form so only the real chart libraries land in the chart
        // chunk. With a fixed { recharts: ["recharts"] } list Rollup also put
        // shared helpers (clsx) in it, so the entry bundle imported the 440 KB
        // chart chunk and index.html preloaded it on every screen.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules[\\/](recharts|recharts-scale|d3-[^\\/]+|victory-vendor|internmap)[\\/]/.test(id)) return "recharts";
          if (/node_modules[\\/](clsx|tailwind-merge|class-variance-authority)[\\/]/.test(id)) return "vendor-utils";
          if (/node_modules[\\/]@radix-ui[\\/]/.test(id)) return "radix-ui";
          if (/node_modules[\\/]@supabase[\\/]/.test(id)) return "supabase";
          if (/node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector)[\\/]/.test(id)) return "i18n";
          return undefined;
        },
      },
    },
  },
  });
});
