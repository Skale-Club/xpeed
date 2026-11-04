import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

// `npm run dev` serves the same /api/db and /api/storage the production server does, against
// DATABASE_URL (the development database) and a local folder, so the app can run with
// VITE_DATA_API=true without a second process.
function dataApiForDev(mode: string): Plugin {
  return {
    name: "xpeed-data-api",
    apply: "serve",
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), "");
      for (const key of ["DATABASE_URL", "DATABASE_SSL", "FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID", "STORAGE_DIR", "STORAGE_SECRET"]) {
        if (env[key] && !process.env[key]) process.env[key] = env[key];
      }
      if (!process.env.DATABASE_URL) return;
      // Development only: files stay in the project folder and links are signed with a fixed key.
      process.env.STORAGE_DIR ??= path.resolve(process.cwd(), ".dev-files");
      process.env.STORAGE_SECRET ??= "development-only-secret";
      const mount = (prefix: string, load: () => Promise<(request: Request) => Promise<Response>>) =>
        server.middlewares.use(prefix, async (req, res) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const headers = new Headers();
            for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
            const hasBody = req.method !== "GET" && req.method !== "HEAD";
            // Connect strips the mount path from req.url; the route needs the full path.
            const response = await (await load())(new Request(`http://${req.headers.host}${prefix}${req.url ?? ""}`, {
              method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
            }));
            res.statusCode = response.status;
            response.headers.forEach((value, name) => res.setHeader(name, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "unavailable", detail: error instanceof Error ? error.message : "unknown" }));
          }
        });
      mount("/api/db", async () => ((await server.ssrLoadModule("/server/db-route.ts")) as typeof import("./server/db-route")).createDbRoute());
      mount("/api/storage", async () => ((await server.ssrLoadModule("/server/storage-route.ts")) as typeof import("./server/storage-route")).createStorageRoute());
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode, command }) => {
  // A production build without the Supabase settings compiles fine and then
  // breaks at runtime (and the Android workflow would publish a broken APK).
  // Fail the real build instead. Dev, tests (vitest.config.ts is separate) and
  // the screen-test harness (fake Supabase) are not affected.
  if (command === "build" && mode === "production" && !process.argv.some((a) => a.includes("harness"))) {
    const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
    const missing = [
      "VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY",
      "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_AUTH_DOMAIN",
      "VITE_GOOGLE_CLIENT_ID",
    ].filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(
        `Production build needs ${missing.join(" and ")} (set in the environment or in .env.production). ` +
          "Refusing to build an app without its database and Google Cloud login configuration.",
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
    dataApiForDev(mode),
    VitePWA({
      // "prompt": a new service worker waits until the app decides it is safe to
      // swap (see src/lib/pwa-update.ts: never mid-trip). The app registers the
      // worker itself via virtual:pwa-register in main.tsx, so no registerSW.js
      // is injected (it only registered once and never looked for updates).
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.ico", "robots.txt", "logo.svg", "placeholder.svg", "apple-touch-icon.png"],
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
