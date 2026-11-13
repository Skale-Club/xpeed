# Phase 1 — the racing data model

Goal: track, car and session become real entities, so personal bests, progress and rankings are computed by the
server instead of guessed in the browser. Everything is additive: installed Companions keep working, and no existing
row or file is dropped or rewritten except to fill the new columns.

## Entities (new tables)

| Table | What it holds |
|---|---|
| `sim_track_catalog` | One row per game + track: `id`, `game` (→ `sim_games.key`), `slug`, `name`, `length_m` |
| `sim_track_alias` | Every spelling a game or Companion version has sent: `game`, `alias_norm` → `track_id` |
| `sim_car_catalog` | One row per game + car: `id`, `game`, `slug`, `name`, `brand`, `class` |
| `sim_car_alias` | Same idea as track aliases, for cars |
| `sim_sessions` | `id`, `user_id`, `game`, `track_id`, `car_id`, `kind` (practice, qualifying, race, unknown), `started_at`, `ended_at`, `weather`, `air_temp_c`, `track_temp_c`, `lap_count`, `best_lap_ms`, `origin` (companion, inferred) |
| `sim_personal_bests` | `user_id`, `track_id`, `car_id`, `best_ms`, `lap_id`, `achieved_at`, kept by a trigger on lap insert and delete |

`sim_laps` gains: `track_id`, `car_id`, `session_id`, `sector_ms int[]`, `top_speed_kmh`, `fuel_used_l`, `in_lap`,
`out_lap`, `format_version`, `reduced boolean`. The free-text `game`, `track_name`, `car_name` stay as sent.

Names are normalized (lower case, no accents or punctuation, collapsed spaces) into `alias_norm`. An unknown name
creates a catalog row and an alias on the fly, so a new game or car never blocks an upload. An admin can later merge
two catalog rows by pointing one alias at the other.

## Ingest

`POST /api/sim/laps` keeps its contract. After validating the file the server:
1. resolves track and car through the aliases (creating rows when new);
2. assigns the session: the Companion's `sessionId` when the file carries one (format v2), else the same rule the site
   used (same game, track and car, gap under 30 minutes);
3. extracts the summary columns (sector times, top speed, fuel used, in and out lap);
4. updates the personal-best row when the lap is valid and faster;
5. stores the file as before.

All of it in one database transaction around the row inserts; the file write stays first and an orphan sweeper removes
files with no row.

## Backfill (one migration, reversible by ignoring the new columns)

For every existing lap: derive catalog rows from the distinct (game, track_name) and (game, car_name), link the laps,
group them into inferred sessions, fill personal bests. It only inserts and updates the new columns.

## API v1 (read side)

`/api/sim/v1/...`, cursor-paged (`limit` up to 100, `cursor`), filterable, with the same error shape everywhere:
`{ "error": "code", "retryable": bool }`.

- `GET laps?game&track&car&session&valid&cursor&limit`
- `GET sessions?game&track&car&cursor&limit` and `GET sessions/<id>` (with its laps)
- `GET tracks`, `GET tracks/<id>` (progress: best over time, laps per day, best per car), `GET cars`, `GET cars/<id>`
- `GET pbs?game&track&car`
- `GET overview` (recent sessions, recent bests, games played, Companion status): one cheap call for the home page

The unversioned `/api/sim/laps` GET stays for the current site until the new pages replace it, then is removed.

## Storage

`FileStore` already hides the disk behind an interface. Add an S3-compatible implementation chosen by environment
(`STORAGE_DRIVER=s3` plus endpoint, bucket and keys), so moving to Cloudflare R2, Backblaze B2 or Hetzner needs no code
change. Retention: laps older than 90 days that are not a personal best and not marked are reduced to 10 Hz by a
background job (`reduced = true`); the summary columns keep the full-detail numbers.

## Lap format v2 (Companion 0.5)

Header adds: top level `sessionId`, `sessionKind`, `weather`, `airTempC`, `trackTempC`, `tyreCompound`, and inside `lap`
`inLap`, `outLap` (next to the `sectorsMs` that was already there), for every game that publishes them. Channels add
(ids are lower case with underscores, because a channel id must match `^[a-z][a-z0-9_]{0,31}$`): `tyre_temp_*` (°C),
`tyre_press_*` (kPa), `tyre_wear_*` (ratio, tread left), `brake_temp_*` (°C) with `fl fr rl rr`, `g_lat`, `g_long` (g),
`damage_body` (ratio), `drs` (0 not allowed, 1 allowed, 2 open), `tc_active`, `abs_active` (0 or 1). The reader accepts
v1 and v2; the writer writes v2. Golden vectors for both are kept in the tests. The full spec, with how each game fills
it and how the session id and the in and out laps are decided, is
`docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md`.

## Site

The manual upload paths disappear (Sessions, Compare, Tracks). The browser library becomes a cache keyed by the
server's lap id, filled when a lap is opened. Lists come from API v1 and never read lap files.

## Done when

A new lap arrives already linked to its session, track and car; an account with 10,000 laps opens its lists in under a
second; no screen accepts a file.
