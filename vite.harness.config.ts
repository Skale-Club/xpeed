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
    resolve: {
      ...base.resolve,
      alias: [
        { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "./src/harness/fake-supabase.ts") },
        { find: "@", replacement: path.resolve(__dirname, "./src") },
      ],
    },
  };
});
