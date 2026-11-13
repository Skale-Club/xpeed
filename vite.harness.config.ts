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
        // Synthetic Virtual data (what Xpeed Companion would have sent), so Overview, Sessions, a session, Compare and Game cars have something
        // to show: the racing data API (docs/platform/API-V1.md) is faked in src/harness/sim-v1.ts, which is loaded through Vite so it can use the
        // app's own code and aliases. Start the harness with HARNESS_NO_LAPS=1 to see the empty states, HARNESS_API_DOWN=1 for the error state
        // (GET /api/sim/v1/__fail?on=1 and ?on=0 switch the outage on and off while it runs, to see "showing saved data").
        server.middlewares.use('/api/sim/v1', async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const mod = await server.ssrLoadModule('/src/harness/sim-v1.ts');
            let body: unknown;
            if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
            }
            const answer = await mod.answerV1(req.method ?? 'GET', url.pathname, Object.fromEntries(url.searchParams), body);
            res.statusCode = answer.status;
            if (answer.bytes) {
              res.setHeader('Content-Type', 'application/gzip');
              return res.end(Buffer.from(answer.bytes));
            }
            res.setHeader('Content-Type', 'application/json');
            return res.end(answer.json === undefined ? undefined : JSON.stringify(answer.json));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'harness_error', retryable: false, detail: String(error) }));
          }
        });
        // The social side's one public endpoint: a shared lap or session by its token (no sign-in). See src/harness/sim-social.ts.
        server.middlewares.use('/api/sim/public/share', async (req, res) => {
          try {
            const mod = await server.ssrLoadModule('/src/harness/sim-v1.ts');
            const answer = await mod.answerPublic((req.url ?? '/').split('?')[0]);
            res.statusCode = answer.status;
            if (answer.bytes) {
              res.setHeader('Content-Type', 'application/gzip');
              return res.end(Buffer.from(answer.bytes));
            }
            res.setHeader('Content-Type', 'application/json');
            return res.end(answer.json === undefined ? undefined : JSON.stringify(answer.json));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'harness_error', retryable: false, detail: String(error) }));
          }
        });
        server.middlewares.use('/api/sim', (req, res, next) => {
          const path = (req.url ?? '/').split('?')[0];
          const empty = process.env.HARNESS_NO_LAPS === '1';
          res.setHeader('Content-Type', 'application/json');
          if (path === '/tracks' && req.method === 'GET') return res.end(JSON.stringify({ tracks: [] }));
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
