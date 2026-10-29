# Xpeed

Vehicle profiles, OBD trip recording, deterministic diagnostics and an AI assistant. React 18, TypeScript, Vite, Supabase and Capacitor Android.

## Product

- Car profiles, CSV imports, trip history, charts and original log downloads.
- Bluetooth OBD recording, local backups and upload retries.
- Vehicle-specific rules, persistent problems and maintenance history.
- Trip summaries and chat via server-side OpenRouter. An administrator configures the key and model; no personal browser AI key is needed.
- Private photos and revocable shared reports. Photos are stored attachments; image understanding is not implemented.
- Read-only MCP tools with OAuth or user-issued tokens; installable PWA and Android live/offline variants.

## Local development

Use Node.js 22 (the CI runtime), npm and a configured Supabase environment:

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

The development port is **5000**. Configure at least:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
```

Deployed integrations may also need `VITE_APP_URL` and project settings. The publishable key is public; RLS and server authorization enforce access. Service-role keys, administrative script credentials and AI secrets belong only in trusted server/script environments. Never prefix secrets with `VITE_` or commit `.env`. Configure AI through admin settings and matching Edge Functions.

The 55 migrations pass replay in embedded PostgreSQL with synthetic Supabase auth/Storage compatibility tables. Hosted Supabase services still need staging validation. Read the [runbook](docs/revisao-2026-10-29/RUNBOOK.md) before preparing/upgrading an environment. Do not reset a remote database to resolve migration errors.

## Checks

```powershell
npm run typecheck  # frontend and api/; does not check Deno functions
npm run lint
$env:VITE_SUPABASE_URL='https://example.supabase.co'
$env:VITE_SUPABASE_PUBLISHABLE_KEY='test-placeholder'
npm test
npm run build
```

Placeholders support compilation and synthetic tests only. Production needs the real public project settings. Additional backend checks (Deno 2.9.6 on PATH, or `XPEED_DENO_BIN` pointing to its executable):

```powershell
npm run check:edge
npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.13
npm run test:sql
```

SQL tests run PostgreSQL entirely in memory, including migrated RLS policies and transactional rollback. They do not validate hosted Auth/Storage, external OAuth, paid AI or physical Bluetooth. See the [official Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/) and [PGlite documentation](https://pglite.dev/docs/).

For UI inspection without the production database:

```powershell
npx vite --config vite.harness.config.ts --host 127.0.0.1
```

The harness uses port **5010**, fake Supabase data and simulated Bluetooth. Unsupported RPCs return errors. It is not a migration or RLS simulator.

## Data and reprocessing

Main tables include `car_profiles`, `sessions`, `session_rows`, `session_flags`, `vehicle_issues`, `vehicle_issue_occurrences`, `chat_conversations`, `chat_messages`, maintenance/photo/share tables and `app_settings`. Definitions are in `supabase/migrations`; generated types still lag some tables.

Original CSVs stay in private Storage, with inline `source_csv` as fallback. Diagnostics use the full file; stored chart rows are reduced to at most 2,000. Known explicit external units are normalized before calculation; original downloads remain unchanged. Missing units, ambiguous exports and unknown sampling intervals need further policy.

Trip re-evaluation and the new recording-save path require **20261029110000_stabilize_processing.sql**. It was validated with rollback and applied to the configured production project on 2026-10-29; other environments must apply it before publishing this client. It also upgrades legacy integer processing versions to text without losing values or the previous default. Owner-checked transactions replace derived data atomically and preserve session identity. Unavailable functions fail without partial fallback writes. Paid AI summaries are retained but marked outdated after reprocessing; automatic regeneration is deferred. Problem reconciliation is best effort and preserves resolved/ignored decisions.

## Recording and recovery

The scanner backs up trips to IndexedDB and retries unfinished uploads. If durable storage fails, a finished trip stays in memory and automatic updates remain held until a durable copy exists. Leave the app open in that situation.

Automatic updates and failed-chunk recovery wait for recording/persistence to reach a safe point. Protected-page error boundaries keep scanner providers mounted and can navigate home without a full reload. This does not guarantee recovery after OS/browser process termination.

New recordings use a stable owner/car/millisecond identity, an exact CSV checksum and an atomic database completion receipt. A retry recognizes the same committed trip without replacing its ID or spending AI quota again. Ambiguous legacy trips are preserved alongside their local backups for review; no existing trip is preemptively deleted by its start time. Do not remove these backups or replace historical sessions in bulk. VIN switching and Android screen-off behavior still require physical-device validation.

## Publication

Automatic trips wait for movement when the vehicle reports speed; engine RPM is only a fallback when speed is unsupported. No recording samples or trip uploads are produced while waiting for movement. While stationary before a trip, sensor cycles are spaced by two seconds; after ECU shutdown the existing standby/backoff and wake-lock release apply. Android background recording uses the foreground notification service; force-stopping the app or OS process termination is not equivalent to standby and is not guaranteed to recover automatically.

Home links directly to Live, and tapping a speed/RPM dial opens a larger timeline. Live keeps a bounded, one-point-per-second history for up to 30 minutes without reducing raw trip sample resolution. Missing readings remain gaps. Adapters that truncate multi-PID replies fall back to individual PID requests. Live diagnostics retain the last 200 state/recording/fallback events locally; older events from before this logging existed cannot be reconstructed.

The Long-term trends menu reads saved trip summaries and groups measurements by month or year with duration-weighted averages, extrema and coverage counts. It creates no extra continuous telemetry table or server writes.

### OBD adapter transports

The Android APK supports ELM327-compatible serial adapters over BLE GATT and Bluetooth Classic SPP. The browser supports BLE only. Wi-Fi, USB and vendor-proprietary protocols are not implemented.

On Android, tap Connect, then choose a paired Classic adapter or Find Bluetooth LE adapter. Pair a Classic adapter opens Android Bluetooth settings; return to Xpeed and tap Connect again after pairing. The chosen transport is remembered for reconnection. Older APKs keep the BLE-only picker until the native update is installed.

Compatibility targets (transport implementation does not mean physical certification):

| Adapter family | Transport to use | Validation |
| --- | --- | --- |
| Veepeak OBDCheck BLE / BLE+ | BLE; Classic on dual-mode variants | User reported working on PC; Android retest pending |
| Vgate iCar Pro BLE, OBDLink CX, BLE variants of vLinker | BLE | Automated transport tests; physical tests pending |
| OBDLink MX+ / LX, Vgate BT3.0, Classic ELM327-compatible adapters | Android Classic SPP | Automated bridge tests; physical tests pending |

Select the exact model/transport; a Bluetooth name alone is not proof of ELM327 compatibility. BLE discovery requires notify/indicate and write characteristics. Classic uses the standard authenticated serial-port UUID with a bounded connection timeout. Connection failures show their underlying reason on Home and Scanner. Test first connection, ELM initialization, live data, trip save, screen off and reconnection on each real adapter before marking it validated.

`.github/workflows/android-apk.yml` checks types, lint and tests before signed builds. Main publishes `android-latest`; the configured feature branch creates artifacts. The live APK loads the configured production site; the offline variant bundles the web build. `CAP_SERVER_URL` selects the live-site variant during Capacitor sync.

Web CI and the APK workflow check Deno and PostgreSQL contracts for their checkout. External deployment gates and branch protection are separate settings and were not modified by the review.

## Supabase keepalive

- `supabase-keepalive.yml` runs every six hours and updates/checks a heartbeat with the URL and server-only service-role repository secrets.
- `supabase-keepalive-healthcheck.yml` checks heartbeat freshness daily.
- The current workflow **does not commit or push** `.github/keepalive-heartbeat`, contrary to the previous README. The need for repository-activity automation remains an operational decision; the existing local heartbeat file was preserved.

`npm run supabase:keepalive` and `npm run supabase:keepalive:verify` contact the configured database. Run only against the intended environment. The review did not run these scripts or change repository settings.

## Review

- [Baseline and findings](docs/revisao-2026-10-29/AVALIACAO.md)
- [Execution plan](docs/revisao-2026-10-29/PLANO-DE-EXECUCAO.md)
- [Changes, checks and pending decisions](docs/revisao-2026-10-29/EXECUCAO.md)
- [Staging and rollout runbook](docs/revisao-2026-10-29/RUNBOOK.md)
