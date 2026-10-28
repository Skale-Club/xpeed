# Leaving Vercel for Hetzner (and a new domain) — to do later

Status: **not started** (decided 2026-10-28: do it in the future, together with the domain change).
Today the app runs on Vercel at `https://xpeed.skale.club`. The backend (database, sign-in, edge
functions, AI) is Supabase and does not move.

## What is tied to Vercel

| Piece | Today | On Hetzner |
|---|---|---|
| Static site (`dist/`) | Vercel build on every push | Any web server; SPA fallback to `index.html` |
| `vercel.json` rewrites | `/manifest.webmanifest` → `/api/brand/manifest`, `/.well-known/oauth-*` → `/api/wellknown/*`, everything else → `index.html` | Same rules in a Caddyfile (or nginx) |
| `vercel.json` headers | CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, `immutable` cache for `/assets/*`, `no-cache` for `index.html` / `sw.js` / `workbox-*` | Same headers in Caddy |
| `api/` (Vercel Edge Functions) | `api/mcp.ts`, `api/oauth/{register,token,issue-code}.ts`, `api/wellknown/*.ts`, `api/brand/manifest.ts` — thin proxies to Supabase functions, Web-standard `Request → Response` | A small Node server (e.g. Hono) mounting the same handlers, or Caddy `reverse_proxy` rules to `<supabase>/functions/v1/...`. Keep forwarding the caller IP (`x-real-ip` / `x-forwarded-for`), the OAuth rate limit depends on it |
| `@vercel/analytics` (`src/App.tsx`) | Vercel-only page views | Remove, or self-hosted Umami/Plausible |
| Deploy | Vercel Git integration | GitHub Actions: build, then rsync or a Docker image to the server |
| HTTPS | Vercel | Caddy (automatic certificates) |

## What is tied to the domain `xpeed.skale.club`

- **Android app (APK):** `.github/workflows/android-apk.yml` builds the default APK with `CAP_SERVER_URL: https://xpeed.skale.club`. Installed apps keep opening that address until people install a new APK.
- **Per-origin browser data** does not move to a new domain: sign-in session, remembered Bluetooth adapter, settings, custom PIDs, installed PWA, and **trip copies not yet uploaded** (IndexedDB `xpeed-obd`).
- **Supabase Auth:** add the new domain to Site URL / Redirect URLs (Google sign-in, e-mail links).
- **Hard-coded addresses:** `src/lib/trips.ts` (`PRODUCTION_URL`, used in "send to the mechanic" links), the `install.computer` text in the three locale files, `HTTP-Referer` in `supabase/functions/{analyze-session,chat,ai-health}`, and `XPEED_APP_URL` (OAuth issuer for the MCP connector; falls back to `xpeed-skaleclub.vercel.app`). Connected MCP clients must reconnect after the issuer changes.
- **Links already sent** to mechanics use the old domain.

## Plan

1. One setting for the app address (e.g. `VITE_PUBLIC_URL` / `XPEED_APP_URL`) used by the site, the APK build and the edge functions; remove the hard-coded copies above.
2. Container: `Dockerfile` (build stage + Caddy) with a Caddyfile mirroring `vercel.json`, plus the small Node server for `api/`. Test it locally against production Supabase.
3. Server on Hetzner, DNS for the new domain, Supabase Auth redirect URLs, `XPEED_APP_URL` secret.
4. New APK pointing to the new domain (the app asks people to update).
5. Keep **both** domains serving the app for a while, so trip copies on the old origin get uploaded; then make `xpeed.skale.club` a permanent redirect to the new domain for some months (old APKs and shared links keep working).
6. Turn off the Vercel project.
