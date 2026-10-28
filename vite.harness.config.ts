import path from "path";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import baseConfig from "./vite.config";

// Screen-test copy of the app: same code, but the Supabase client is swapped
// for an in-memory fake with sample data (src/harness/fake-supabase.ts) and a
// simulated Bluetooth car. Lets every screen be clicked through locally without
// touching the production database. Run: vite --config vite.harness.config.ts
export default defineConfig(async (env: ConfigEnv) => {
  const base = (typeof baseConfig === "function" ? await baseConfig(env) : baseConfig) as UserConfig;
  return {
    ...base,
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
