import path from "path";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import baseConfig from "./vite.config";
import type { FuelEntry } from "./src/lib/fuel-ledger";

// Screen-test copy of the app: same code, but the Supabase client is swapped
// for an in-memory fake with sample data (src/harness/fake-supabase.ts) and a
// simulated Bluetooth car. Lets every screen be clicked through locally without
// touching the production database. Run: vite --config vite.harness.config.ts
export default defineConfig(async (env: ConfigEnv) => {
  const base = (typeof baseConfig === "function" ? await baseConfig(env) : baseConfig) as UserConfig;
  return {
    ...base,
    plugins: [...(base.plugins ?? []), {
      name: 'synthetic-fuel-ledger',
      configureServer(server) {
        // Local screen tests only. This ledger and the fake AI never contact production.
        const cars = new Map<string, FuelEntry[]>();
        const intents = new Map<string, FuelEntry>();
        // Synthetic Virtual data (the laps Xpeed Companion would have sent), so Overview, Sessions and Game cars have something to show.
        // Start the harness with HARNESS_NO_LAPS=1 to see the empty states instead.
        server.middlewares.use('/api/sim', (req, res, next) => {
          const path = (req.url ?? '/').split('?')[0];
          const empty = process.env.HARNESS_NO_LAPS === '1';
          res.setHeader('Content-Type', 'application/json');
          if (path === '/laps' && req.method === 'GET') {
            const lap = (n: number, game: string, track: string, car: string, timeMs: number, startedAt: string, valid = true) => ({
              id: `harness-${n}`, game, track, car, lapNumber: n, timeMs, valid, startedAt, sampleCount: 1000 + n, sizeBytes: 250_000,
              createdAt: new Date(Date.parse(startedAt) + timeMs + 5000).toISOString(), deviceName: 'Racing PC',
            });
            return res.end(JSON.stringify({ laps: empty ? [] : [
              lap(1, 'ac', 'Monza', 'Ferrari 499P', 101_250, '2026-11-12T18:00:00.000Z'),
              lap(2, 'ac', 'Monza', 'Ferrari 499P', 99_480, '2026-11-12T18:03:00.000Z'),
              lap(3, 'ac', 'Monza', 'Ferrari 499P', 92_000, '2026-11-12T18:06:00.000Z', false),
              lap(4, 'ac', 'Spa-Francorchamps', 'Ferrari 499P', 141_300, '2026-11-12T19:30:00.000Z'),
              lap(5, 'lmu', 'Bahrain', 'Toyota GR010', 110_900, '2026-11-11T15:00:00.000Z'),
              lap(6, 'lmu', 'Bahrain', 'Toyota GR010', 109_720, '2026-11-11T15:03:00.000Z'),
              lap(7, 'ac', 'Monza', 'Porsche 911 GT3 R', 105_000, '2026-11-08T12:00:00.000Z'),
            ] }));
          }
          if (path === '/devices' && req.method === 'GET') {
            return res.end(JSON.stringify({ devices: empty ? [] : [{ id: 'd1', name: 'Racing PC', created_at: '2026-11-01T00:00:00.000Z', last_seen_at: new Date().toISOString(), last_lap_at: null, revoked_at: null }] }));
          }
          return next();
        });
        server.middlewares.use('/api/fuel', async (req, res, next) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const carId = url.searchParams.get('carId');
          if (!carId) return next();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          const entries = cars.get(carId) ?? [];
          if (req.method === 'GET') return res.end(JSON.stringify({items: entries}));
          if (req.method === 'POST') {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            try {
              const body = JSON.parse(raw);
              if (body.action) { res.statusCode = 400; return res.end('{}'); }
              const intent = `${carId}:${req.headers['idempotency-key'] ?? crypto.randomUUID()}`;
              let entry = intents.get(intent);
              if (!entry) {
                entry = {...body, id: crypto.randomUUID()} as FuelEntry;
                cars.set(carId, [...entries, entry]);
                intents.set(intent, entry);
              }
              return res.end(JSON.stringify(entry));
            } catch { res.statusCode = 400; return res.end('{}'); }
          }
          if (req.method === 'DELETE') {
            cars.set(carId, entries.filter(entry => entry.id !== url.searchParams.get('id')));
            return res.end('{}');
          }
          res.statusCode = 405; res.end('{}');
        });
      },
    }],
    server: { ...base.server, port: 5010 },
    // The Virtual (racing games) side is built but not released: it is on here so its screens can be clicked through.
    define: { ...base.define, 'import.meta.env.VITE_ENABLE_VIRTUAL': JSON.stringify('true') },
    resolve: {
      ...base.resolve,
      alias: [
        { find: /^@\/components\/auth\/GoogleIdentityButton$/, replacement: path.resolve(__dirname, "./src/harness/FakeGoogleButton.tsx") },
        { find: /^@\/lib\/auth\/google$/, replacement: path.resolve(__dirname, "./src/harness/fake-google.ts") },
        { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "./src/harness/fake-supabase.ts") },
        { find: "@", replacement: path.resolve(__dirname, "./src") },
      ],
    },
  };
});
