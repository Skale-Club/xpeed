# API v1: racing data (read side)

Base path `/api/sim/v1/`. Phase 1 of the platform (`PHASE-1-DATA-MODEL.md`). Code: `api/sim/v1.ts`; the queries are the
`sim_v1_*` functions of `supabase/migrations/20261113150000_sim_platform_model.sql`. Checks: `npm run test:sim-v1`.

## Rules for every call

- **Signed in as the person**: `Authorization: Bearer <sign-in token>`. A missing token, a bad token or a Companion device key is `401`.
  Everyone sees only their own laps, sessions, personal bests and progress. The track and car catalogs are shared.
- **CORS** for the app's own origins, like the rest of `/api/sim` (answers vary by `Origin`; `OPTIONS` is `204`).
- **Errors** are always `{ "error": "<code>", "retryable": <bool> }`. `retryable` is true for an outage (`503`, which carries
  `Retry-After`), false for everything a retry cannot fix.
- **Paging** (laps, sessions, tracks, cars, pbs): `limit` 1 to 100 (default 50; a larger number is read as 100) and
  `cursor`, the opaque `nextCursor` of the previous page. Answers are `{ "<list>": [...], "nextCursor": "<string>" | null }`;
  `null` means the last page. A cursor is only a place in the list: do not build or read one.
- Times are ISO 8601 UTC with milliseconds (`2026-11-10T12:00:00.000Z`); durations are milliseconds; days are UTC (`2026-11-10`).
- Ids are UUIDs. A path with an id that is not a UUID is `404 not_found`.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_limit`, `invalid_cursor`, `invalid_game`, `invalid_track`, `invalid_car`, `invalid_session`, `invalid_valid` | the parameter named in the code is not valid |
| 401 | `unauthorized` | not signed in |
| 404 | `not_found` | no such path |
| 404 | `lap_not_found`, `session_not_found`, `track_not_found`, `car_not_found` | no such item for this person |
| 405 | `method_not_allowed` | wrong method (`Allow` says which) |
| 503 | `unavailable` | the database or the files do not answer (`retryable: true`, `Retry-After`) |

## Objects

**Lap** `{ id, game, track: {id, name} | null, car: {id, name} | null, sessionId | null, lapNumber, timeMs, valid, startedAt,
sectorsMs: [int] | null, topSpeedKmh | null, fuelUsedL | null, inLap | null, outLap | null, sampleCount, sizeBytes, reduced,
formatVersion | null, createdAt, deviceName | null }`

**Session** `{ id, game, track: {id, name}, car: {id, name}, kind: "practice" | "qualifying" | "race" | "unknown",
origin: "companion" | "inferred", startedAt, endedAt, weather | null, airTempC | null, trackTempC | null, lapCount, bestLapMs | null }`
(`bestLapMs` is the fastest valid lap; a session is one car on one track.)

**Personal best (pb)** `{ game, track: {id, name}, car: {id, name}, bestMs, lapId, achievedAt }`: the fastest valid lap of the
person on that track with that car; `achievedAt` is when the lap was driven.

## Endpoints

### `GET /laps?game&track&car&session&valid&cursor&limit`
Laps, newest `startedAt` first. Filters: `game` (id such as `lmu`), `track` and `car` (catalog ids), `session` (session id),
`valid` (`true`/`false`/`1`/`0`). They combine. Answer `{ laps: [Lap], nextCursor }`.

### `GET /laps/<id>/file`
The stored lap file, exactly the gzip bytes the Companion sent (`application/gzip`,
`Cache-Control: private, max-age=31536000, immutable`). Same as `GET /api/sim/laps/<id>/file`.

### `DELETE /laps/<id>`
Deletes the lap and its file, `204` with no body. The session's counters and the personal best are recomputed from the laps that
remain (a session left with no laps is removed). Same as `DELETE /api/sim/laps/<id>`.

### `GET /sessions?game&track&car&cursor&limit`
Sessions, newest `startedAt` first. Answer `{ sessions: [Session], nextCursor }`.

### `GET /sessions/<id>`
`{ session: Session, laps: [Lap] }` with the laps in driving order (at most 2000).

### `GET /tracks?game&cursor&limit` and `GET /cars?game&cursor&limit`
The tracks (cars) the person has driven, most recently driven first.
Track item: `{ id, game, name, lengthM | null, lapCount, validLapCount, sessionCount, carCount, bestLapMs | null, lastDrivenAt }`.
Car item: `{ id, game, name, brand | null, class | null, lapCount, validLapCount, sessionCount, trackCount, bestLapMs | null, lastDrivenAt }`.
Answers `{ tracks: [...], nextCursor }` and `{ cars: [...], nextCursor }`.

### `GET /tracks/<id>`
Any track in the catalog (a track the person never drove has zero totals and empty lists):
```
{ track: { id, game, name, lengthM | null },
  totals: { lapCount, validLapCount, sessionCount, carCount, bestLapMs | null, lastDrivenAt | null },
  progress: { bestPerDay: [{ day, bestMs, lapId, car: {id, name} }],   // fastest valid lap of each day, oldest first
              lapsPerDay: [{ day, laps, validLaps }] },                  // oldest first; the latest 1000 days with laps
  bestPerCar: [{ car: {id, name, class | null}, lapCount, validLapCount, bestMs | null, lapId | null, achievedAt | null }] }  // fastest car first
```

### `GET /cars/<id>`
```
{ car: { id, game, name, brand | null, class | null },
  totals: { lapCount, validLapCount, sessionCount, trackCount, bestLapMs | null, lastDrivenAt | null },
  progress: { lapsPerDay: [{ day, laps, validLaps }] },
  bestPerTrack: [{ track: {id, name}, lapCount, validLapCount, bestMs | null, lapId | null, achievedAt | null }] }  // by track name
```

### `GET /pbs?game&track&car&cursor&limit`
Personal bests, most recently achieved first. Answer `{ pbs: [pb], nextCursor }`.

### `GET /overview`
One cheap call for the home page, cached for 10 seconds per person (an upload or a deletion by that person drops their entry):
```
{ latestSessions: [Session]          // the 5 latest
  latestPersonalBests: [pb]          // the 5 most recently achieved
  lapsPerGame: [{ game, laps, validLaps, sessions, lastDrivenAt }]   // most played first
  companion: { devices: [{ id, name, pairedAt, lastSeenAt | null, lastLapAt | null }],   // paired computers, revoked ones left out
               lastLap: Lap | null }                                                     // the lap received most recently
  storage: { lapCount, usedBytes, limitBytes } }                      // limitBytes: 20 GB
```

## Upload side (unchanged contract, new behavior)

`POST /api/sim/laps` (device key) keeps its request and answers (`201 {id, duplicate:false}`, `200 {id, duplicate:true}`, ...).
New: the lap is linked to its track, car and session when it arrives; the file is written under a staging name and renamed
once whole, and the row, catalog, session and personal best are one database transaction (a failure leaves no row and no file;
`sweepOrphanLaps()` in `api/sim/_sweep.ts` removes files with no row). Refusals: `422 {"error":"quota","retryable":false}` when the
account would pass 20 GB of lap files (measured from `sim_laps.size_bytes`; the old 5000-lap cap is gone), `429` when one device
sends more than 60 laps a minute (counted in the database, so restarts and several instances share it).
The unversioned `GET /api/sim/laps` stays for the current site.
