import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = env.VITE_SUPABASE_URL ?? '';
  const iconBase = supabaseUrl
    ? `${supabaseUrl}/storage/v1/object/public/app-icons`
    : '';

  const pwaIcons = iconBase
    ? [
        { src: `${iconBase}/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${iconBase}/icon-512.png`, sizes: '512x512', type: 'image/png' },
        { src: `${iconBase}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: `${iconBase}/apple-touch-icon.png`, sizes: '180x180', type: 'image/png' },
      ]
    : [{ src: '/favicon.ico', sizes: '64x64 32x32 24x24 16x16', type: 'image/x-icon' }];

  return ({
  server: {
    host: "0.0.0.0",
    port: 5000,
    hmr: {
      overlay: false,
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
      registerType: "autoUpdate",
      // Emit an external registerSW.js instead of an inline <script>, so the
      // strict CSP (script-src 'self') doesn't block service-worker registration.
      injectRegister: "script",
      includeAssets: ["favicon.ico", "robots.txt"],
      manifest: {
        name: "Xpeed",
        short_name: "Xpeed",
        description: "OBD2 diagnostics with AI-powered insights",
        theme_color: "#141414",
        background_color: "#141414",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: pwaIcons,
        share_target: {
          action: "/import",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            files: [{ name: "csv", accept: ["text/csv", ".csv"] }],
          },
        },
      },
      workbox: {
        // Don't try to precache the giant Recharts chunk on first paint.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Force the new SW to take control of all open tabs immediately so
        // updates land without requiring a second reload after the SW fetches
        // them. Without these flags, "autoUpdate" still leaves stale assets
        // running until every tab is closed.
        skipWaiting: true,
        clientsClaim: true,
        // Avoid SW returning a stale index.html on hard refresh.
        cleanupOutdatedCaches: true,
        // Share target POST handler runs before Workbox routes.
        importScripts: ["/sw-share-target.js"],
        runtimeCaching: [
          {
            // Cache Supabase REST reads for offline session viewing.
            urlPattern: ({ url }) => url.hostname.endsWith(".supabase.co") && url.pathname.startsWith("/rest/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-reads",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 },
            },
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
        manualChunks: {
          // Recharts is the single biggest chunk (~390KB). Keep it isolated so
          // it loads on demand for chart-heavy routes only.
          recharts: ["recharts"],
          // shadcn/Radix primitives.
          "radix-ui": [
            "@radix-ui/react-accordion", "@radix-ui/react-alert-dialog",
            "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-select", "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip", "@radix-ui/react-popover",
            "@radix-ui/react-toast",
          ],
          supabase: ["@supabase/supabase-js"],
          i18n: ["i18next", "react-i18next", "i18next-browser-languagedetector"],
        },
      },
    },
  },
  });
});
