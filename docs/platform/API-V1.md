# API v1: racing data (read side)

Base path `/api/sim/v1/`. Phase 1 of the platform (`PHASE-1-DATA-MODEL.md`). Code: `api/sim/v1.ts`; the queries are the
`sim_v1_*` functions of `supabase/migrations/20261113150000_sim_platform_model.sql`. Checks: `npm run test:sim-v1`. The social side (profiles, friends, shares, leaderboards, reports, privacy rights) is at the end of this file.

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
| 400 | `invalid_limit`, `invalid_cursor`, `invalid_game`, `invalid_track`, `invalid_car`, `invalid_session`, `invalid_valid`, `invalid_range` | the parameter named in the code is not valid |
| 401 | `unauthorized` | not signed in |
| 404 | `not_found` | no such path |
| 404 | `lap_not_found`, `session_not_found`, `track_not_found`, `car_not_found` | no such item for this person (also `GET /laps/<id>` and `DELETE /sessions/<id>`) |
| 405 | `method_not_allowed` | wrong method (`Allow` says which) |
| 503 | `unavailable` | the database or the files do not answer (`retryable: true`, `Retry-After`) |

## Objects

**Lap** `{ id, game, track: {id, name} | null, car: {id, name} | null, sessionId | null, lapNumber, timeMs, valid, startedAt,
sectorsMs: [int] | null, topSpeedKmh | null, fuelUsedL | null, inLap | null, outLap | null, sampleCount, sizeBytes, reduced,
formatVersion | null, createdAt, deviceName | null }`

**Session** `{ id, game, track: {id, name}, car: {id, name}, kind: "practice" | "qualifying" | "race" | "unknown",
origin: "companion" | "inferred", startedAt, endedAt, weather | null, airTempC | null, trackTempC | null, lapCount, bestLapMs | null }`
(`bestLapMs` is the fastest valid lap; a session is one car on one track.)

**Personal best (pb)** `{ game, track: {id, name}, car: {id, name}, bestMs, lapId, achievedAt, bestSectorsMs: [int] | null,
sectorLapIds: [uuid] | null }`: the fastest valid lap of the person on that track with that car; `achievedAt` is when the lap was driven.
`bestSectorsMs[i]` is the best time of sector `i + 1` over the person's **valid and plausible** laps on that track and car that have the
sector count most of those laps have (the majority count; the larger count wins a tie), and `sectorLapIds[i]` is the lap that holds it
(the earlier lap on a tie). A lap with a sector of 0 ms or less is not used. Both are `null` when no such lap has sectors. Example:
`"bestSectorsMs": [290, 380, 300], "sectorLapIds": ["<lap>", "<lap>", "<lap>"]`. They are computed by the database in the same
statement that pages the bests (`sim_sector_bests`, index `sim_laps_sector_bests`), not per item.

## Endpoints

### `GET /laps?game&track&car&session&valid&cursor&limit`
Laps, newest `startedAt` first. Filters: `game` (id such as `lmu`), `track` and `car` (catalog ids), `session` (session id),
`valid` (`true`/`false`/`1`/`0`). They combine. Answer `{ laps: [Lap], nextCursor }`.

### `GET /laps/<id>`
One lap's metadata, the same **Lap** object as an item of the list (`404 lap_not_found` for an unknown id or another person's lap). Use it
for a deep link that only has the lap id: it carries `track.id`, `car.id` and `sessionId`.

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

### `DELETE /sessions/<id>`
Deletes every lap of the session (rows and stored files) and the session itself in one database transaction; the personal bests
are recomputed from the laps that remain. Answer `200 { "deleted": <number of laps> }`. An unknown session, someone else's, or one that is
already gone is `404 session_not_found` (so a repeat is safe: nothing else changes). A file that cannot be removed is picked up by the orphan
sweeper. The overview cache of the person is dropped.

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
  bestPerCar: [{ car: {id, name, class | null}, lapCount, validLapCount, bestMs | null, lapId | null, achievedAt | null,
                 bestSectorsMs: [int] | null, sectorLapIds: [uuid] | null }] }  // fastest car first; the two sector fields as in a pb
```

### `GET /cars/<id>`
```
{ car: { id, game, name, brand | null, class | null },
  totals: { lapCount, validLapCount, sessionCount, trackCount, bestLapMs | null, lastDrivenAt | null },
  progress: { lapsPerDay: [{ day, laps, validLaps }] },
  bestPerTrack: [{ track: {id, name}, lapCount, validLapCount, bestMs | null, lapId | null, achievedAt | null }] }  // by track name
```

### `GET /pbs?game&track&car&cursor&limit`
Personal bests, most recently achieved first. Answer `{ pbs: [pb], nextCursor }`. Each pb carries `bestSectorsMs` and `sectorLapIds` (see the object above).

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

### `GET /stats?range=7d|30d|90d|1y|all`
What the Overview dashboard shows, in one call, for the signed-in person (code: `api/sim/_stats.ts`; the numbers come from the database function
`sim_v1_stats`, migration `20261113194500_sim_stats.sql`; no lap file is read). `range` is `30d` when absent or empty; any other value that is not one of the five is
`400 invalid_range`. Cached for 20 seconds per person and range; an upload or a deletion by that person drops it (with the overview's).

A range is whole **UTC days ending today** (today included): `7d` is 7 days, `30d` 30, `90d` 90, `1y` 365, `all` starts at the person's first lap. The **previous
period** is the same number of days just before it (zeros for `all`, which has nothing before). A lap belongs to a day by its `startedAt` in UTC. Laps count
whatever their state (a hidden lap too, as in the person's own laps and sessions); "valid" means `valid` and a time above 0, as in the overview.
```
{ range: { key, from: "YYYY-MM-DD", to: "YYYY-MM-DD" (today), days },
  totals:   { laps, validLaps, sessions, timeMs, distanceM, personalBests, tracks, cars, games },
  previous: { same fields, for the period before },
  perDay: [{ day, laps, validLaps, timeMs, distanceM, sessions, personalBests, tracks, cars }],   // only days that have laps, oldest first
  heatmapDays: [{ day, laps }] | null,          // every day with laps in the last 365 days; null for 7d and 30d
  streak: { current, best, bestDay: { day, laps } | null },
  improvements: [{ lapId, trackId, trackName, carId, carName, game, timeMs, previousBestMs | null, savedMs | null, achievedAt }],
  pairs: [{ trackId, trackName, carId, carName, game, laps, bestPerDay: [{ day, bestMs }] }],
  breakdown: { games: [{ game, laps, validLaps }], tracks: [{ id, name, game, laps }], cars: [{ id, name, game, laps }] },
  consistency: [{ sessionId, startedAt, validLaps, spreadMs | null, cleanShare }] }
```
- `totals.timeMs` is the sum of the lap times (laps with a time above 0). `distanceM` is the track length from the catalog times the laps driven (a track whose
  length is not known counts nothing), so it is an estimate: an out or invalid lap is a lap driven. `sessions` are the distinct sessions of the laps in the range.
  `personalBests` is how many valid laps in the range beat the best the person had before them on that track and car (see `improvements`).
- `perDay` also carries the per-day `sessions`, `personalBests`, `tracks` and `cars` (distinct counts) for the sparklines. The sum of each field over the days is the total
  (`sessions`, `tracks` and `cars` are counted over the whole range in `totals`, so they can be lower than that sum).
- `streak`: `current` is the run of consecutive UTC days with laps that ends **today or yesterday** (0 when the last lap is older), `best` the longest run ever; both
  look at the person's whole history, not only the range. `bestDay` is the day of the range with the most laps (the latest of equal days), null with no laps.
- `improvements`: the latest 10 personal-best improvements **in the range**, newest first. Every valid lap with a track and a car is compared with the fastest valid lap
  before it on that pair (by `startedAt`, then id, over the whole history, in one window function): a lap that is faster is an improvement, `previousBestMs` is that
  earlier best and `savedMs` the difference; the first valid lap on a pair is an improvement with both `null`. A lap that is not valid never is one and never sets
  the running best. `lapId` opens the lap analysis.
- `pairs`: the 4 track and car pairs with most laps in the range (ties by names), with the fastest valid lap of each day, oldest first (`[]` when no lap of the pair
  was valid). `breakdown.tracks` and `breakdown.cars` are the top 6 by laps in the range, `games` all of them.
- `consistency`: the latest 8 sessions that have laps in the range, **oldest first**. `spreadMs` is the sample standard deviation of the session's valid laps that are
  not in or out laps (null under 3 of them); `cleanShare` is those clean laps over all the session's laps in the range (0 to 1, 3 decimals); `validLaps` counts the valid laps.
- Nothing in the answer is an e-mail, a phone number, an account id, a device or a file path; other people's laps never enter.

## Upload side (unchanged contract, new behavior)

`POST /api/sim/laps` (device key) keeps its request and answers (`201 {id, duplicate:false}`, `200 {id, duplicate:true}`, ...).
New: the lap is linked to its track, car and session when it arrives; the file is written under a staging name and renamed
once whole, and the row, catalog, session and personal best are one database transaction (a failure leaves no row and no file;
`sweepOrphanLaps()` in `api/sim/_sweep.ts` removes files with no row). Refusals: `422 {"error":"quota","retryable":false}` when the
account would pass 20 GB of lap files (measured from `sim_laps.size_bytes`; the old 5000-lap cap is gone), `429` when one device
sends more than 60 laps a minute (counted in the database, so restarts and several instances share it).
The unversioned `GET /api/sim/laps` stays for the current site.

# Social side (profiles, friends, shares, leaderboards, reports, privacy rights)

Same base path, same rules as above (sign-in token only, `{ "error", "retryable" }`, cursor paging, CORS for the app: the allowed
methods now include `PATCH`). Code: `api/sim/_social.ts` (the signed-in endpoints), `api/sim/public.ts` (the one public endpoint),
`api/sim/_plausibility.ts`; the queries are the `sim_*` functions of `supabase/migrations/20261113170000_sim_social.sql`, callable by the
server only. Checks: `npm run test:sim-social`. What is public, what never is, and what export and delete cover:
`PRIVACY-MODEL.md`. **No answer of any endpoint below contains an e-mail, a phone number, the account's real name, a sign-in id or an
account id**; people are identified by `handle` and `displayName` only, and the suite scans every response for that.

Extra errors (all `{ "error", "retryable" }`):

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_body`, `invalid_request` | the body is not a JSON object / has a field this endpoint does not take, or none of the needed ones |
| 400 | `invalid_handle`, `reserved_handle`, `invalid_display_name`, `invalid_visibility` | profile fields |
| 400 | `invalid_status`, `invalid_scope`, `invalid_track`, `invalid_car`, `invalid_game`, `invalid_lap`, `invalid_session`, `invalid_expires`, `invalid_kind`, `invalid_reason`, `invalid_details`, `invalid_target`, `invalid_action`, `invalid_limit`, `invalid_cursor` | the parameter named in the code |
| 400 | `confirmation_required` | `DELETE /me/data` without the exact sentence |
| 403 | `forbidden` | an admin endpoint, and the person is not a moderator |
| 404 | `profile_not_found`, `handle_not_found`, `request_not_found`, `friend_not_found`, `share_not_found`, `target_not_found`, `report_not_found`, `lap_not_found`, `session_not_found`, `track_not_found`, `car_not_found` | nothing such for this person (a private, hidden, blocked or unknown handle all give the same one) |
| 409 | `handle_taken`, `already_friends`, `already_requested`, `blocked`, `already_reported`, `already_decided` | the state does not allow it |
| 422 | `friend_limit`, `pending_limit`, `share_limit`, `too_many_open_reports` | 200 friends, 50 pending requests, 100 live share links, 50 open reports |
| 429 | `too_many_requests`, `handle_change_limit` | a rate limit or the 3 handle changes in 30 days (`Retry-After`, `retryable: true`) |

Rate limits (counted in the database, per person unless noted): profile changes 60 per 10 minutes; profile page lookups 120 a minute;
friend requests 30 an hour; new share links 30 an hour; reports 10 an hour; exports 5 an hour; deleting data 3 an hour; the public share
endpoints 120 reads a minute **per address**.

## Visibility rules

Each driver chooses `visibility` at any time: `public` (the default), `friends` or `private`. "Friend" means an accepted friendship.
A hidden profile (moderation) and a block (either direction) take a person out of every answer below as if they did not exist.

| What the viewer asks | `public` | `friends` | `private` | blocked pair or hidden |
|---|---|---|---|---|
| `GET /profiles/<handle>` | anyone signed in | the owner and their friends | the owner only | `404 profile_not_found` |
| the name in friend lists and requests | shown | shown to friends | never shown (`null`) | not listed |
| row on `leaderboard?scope=public` | yes | no | no | no |
| row on `leaderboard?scope=friends` (viewer is a friend) | yes | yes | no | no |
| the owner's own row on `scope=friends` | yes | yes | yes | no (hidden) |
| `POST /friends/requests {handle}` by a stranger | works | works | `404 handle_not_found`, same body as an unknown handle | `404 handle_not_found` |
| `POST /reports` against the profile or its laps | works | only if the reporter could see it | `404 target_not_found` | `404 target_not_found` |
| a share link the owner made | summary with name | summary with name | summary **without** driver | `404` (hidden) |

Laps count on any board, profile page or share only when they are `valid`, `plausible` and not `hidden`.

## Profile

**Own profile** `{ handle, displayName, visibility, createdAt, handleChangesLeft (0-3), handleChangesResetAt | null }`.
**Driver page** `{ handle, displayName, joinedAt, isMe, relation: "self" | "friend" | "requested" | "incoming" | "none", visibility (the owner only, else null),
gamesPlayed: [game], personalBestsCount, bestLaps: [{ lapId, game, track: {id, name}, car: {id, name}, timeMs, achievedAt }] }` (the 5 most
recent personal bests that count).

### `GET /profile`
`{ "profile": <own profile> }`. Created now when it does not exist: handle `driver_` plus six letters and digits (no look-alikes), display
name `Driver ` plus the first four of them in capitals, visibility `public`. Nothing is derived from the e-mail, the phone or the account's
name. The first uploaded lap creates it too.

### `PATCH /profile`
Body: any of `handle`, `displayName`, `visibility` (other fields are `400 invalid_request`; none is `400 invalid_request`).
Answer `{ "profile": <own profile> }`.
- `handle`: trimmed and lower-cased; 3 to 24 characters of `a-z0-9_`; not reserved (`admin`, `support`, `xpeed...`, `moderator...`, `staff...`,
  `driver`, `me`, `requests`, ... see `RESERVED_HANDLES` in `api/sim/_social.ts`); not taken (`409 handle_taken`, which is not counted).
  A change to the handle you already have is not a change. **3 changes per 30 days**: the 4th is `429 handle_change_limit` with
  `Retry-After` until the oldest of the three leaves the window. The generated handle is not a change.
- `displayName`: trimmed, 1 to 40 characters, no control or invisible formatting characters, nothing that looks like an e-mail address.
- `visibility`: `public`, `friends` or `private`; takes effect at once everywhere.

### `GET /profiles/<handle>`
`{ "profile": <driver page> }` as the table above allows, else `404 profile_not_found` (a handle that is not valid, a private profile, a
hidden one, a block and a handle nobody has are the same answer).

## Friends

**Friend** `{ handle, displayName | null, status: "accepted" | "incoming" | "outgoing" | "blocked", since }`.

- `GET /friends?status&limit&cursor`: `status` is `accepted` (default), `incoming`, `outgoing` or `blocked` (the people you blocked). Newest
  first. `{ friends: [Friend], nextCursor }`.
- `POST /friends/requests` `{ "handle": "..." }`: `201 { friend }` (status `outgoing`), or `200 { friend }` with status `accepted` when that
  person had already asked you. `404 handle_not_found` for an unknown, hidden or private handle and for a person who blocked you;
  `400 invalid_target` for yourself; `409 already_friends`, `already_requested`, `blocked` (you blocked them); `422 friend_limit` (200),
  `pending_limit` (50 requests sent and waiting).
- `POST /friends/requests/<handle>/accept`: `200 { friend }` (also `422 friend_limit` when either of you is at 200).
  `POST /friends/requests/<handle>/decline`: `204`. `404 request_not_found` when that person has no request to you.
- `DELETE /friends/<handle>`: `204`. Either side removes a friendship; the sender withdraws a request; the blocker lifts their block.
  `404 friend_not_found` otherwise (a person you cannot unblock because they blocked you is also this).
- `POST /friends/<handle>/block`: `200 { friend }` with status `blocked`. Whatever there was (friendship, request) is replaced. The blocked
  person is told nothing: they cannot see, find, ask or be listed with you. A private or unknown handle you have no relation with is
  `404 handle_not_found`.

## Share links

**Share** `{ id, kind: "lap" | "session", lapId | null, sessionId | null, createdAt, expiresAt | null, revokedAt | null, active }`.

- `POST /shares` body `{ "lapId" | "sessionId": "<uuid>", "expiresInDays"?: 1-365 }` (exactly one of the two ids; your own lap or session,
  not a hidden lap): `201 { share, token, path }`. `token` is 43 URL-safe characters (32 random bytes), **shown only here**: the database
  keeps its sha256. `path` is `/api/sim/public/share/<token>`; the page that people open is the site's to design. `422 share_limit` at 100 live links.
- `GET /shares?limit&cursor`: your links, newest first, revoked and expired ones included (`active: false`); never the token.
  `{ shares: [Share], nextCursor }`.
- `DELETE /shares/<id>`: revokes it (`204`, also when it was already revoked); at once for everybody. `404 share_not_found` for someone else's.
- Deleting the lap or the session deletes its links.

### Public: `GET /api/sim/public/share/<token>` (no sign-in, no cookies)
```
lap:     { kind: "lap", createdAt, expiresAt | null, driver: { handle, displayName } | null,
           lap: { id, game, track: { name, lengthM | null }, car: { name, class | null }, lapNumber, timeMs, valid, startedAt, sectorsMs | null, topSpeedKmh | null } }
session: { kind: "session", createdAt, expiresAt | null, driver,
           session: { game, track, car, kind, startedAt, endedAt, weather | null, airTempC | null, trackTempC | null, lapCount, bestLapMs | null,
                      laps: [{ id, lapNumber, timeMs, valid, startedAt, sectorsMs | null, topSpeedKmh | null }] } }   // at most 500 laps
```
`driver` is `null` when the owner's profile is `private`. Never an e-mail, an account id, a device, a file path or the lap's identity.
`GET /api/sim/public/share/<token>/file/<lapId>`: the lap file, exactly the gzip bytes (`application/gzip`,
`Cache-Control: private, max-age=31536000, immutable`), for a lap the link covers (the lap itself, or any lap of the linked session).
Unknown, malformed, revoked and expired tokens, hidden laps and profiles, and laps the link does not cover are all
`404 { "error": "not_found", "retryable": false }`. `429 too_many_requests` past 120 reads a minute from one address. CORS as the rest.

## Plausibility

The server checks every lap file when it arrives, inside the same transaction as the ingest, and stores `sim_laps.plausible` and a small
`plausibility` document `{ "v": 1, "failed": [{ "check", "detail": {...} }] }`. A lap that fails is **kept** (the upload is accepted) but never ranks.
Laps that arrived before the check have `plausible = null` and rank nowhere until their files are read: the server does it by itself (job
`plausibility_recheck`, below) and `POST /admin/recheck` does it on demand.

**The `plausibility_recheck` job** (`server/jobs.ts`, on by default, `PLAUSIBILITY_RECHECK=false` turns it off; needs the database): the first run is
1 to 5 minutes after the server starts (random, so instances do not start together), then every 24 hours. A run calls the recheck 200 laps at a time until
nothing remains or 3 minutes are spent (checked before each batch), and logs one JSON line
`{"event":"job_done","job":"plausibility_recheck","ms":...,"checked":..,"plausible":..,"implausible":..,"remaining":..}`. A batch that settles nothing ends the run, an
unreadable file is marked `file_unreadable` (implausible) so it is never tried again, and a run never overlaps another.

| Check | Fails when | Threshold |
|---|---|---|
| `sector_sum` | the header's sector times do not add up to the lap time (skipped with no sectors) | more than 50 ms apart |
| `elapsed_time` | the span of the `t` channel is not the lap time | more than 0.5 % of the lap time apart |
| `distance` | the span of the `dist` channel is not the track length (skipped when the header has no length or the file no `dist`) | more than 3 % of the length apart |
| `speed_range` | any `speed` sample (m/s) is above 150 (540 km/h) or below 0 (skipped with no `speed`; NaN samples are ignored) | above 150 or below 0 |
| `sample_count` | `sampleCount` is not what `sampleRateHz` times the lap time gives | more than 15 % of that, and more than 3 samples |
| `time_gap` | two consecutive `t` samples are more than 2 s apart, or `t` goes backwards | more than 2 s, or any step below 0 |
| `file_unreadable` | (recheck only) the stored file cannot be read | |

## Leaderboards

### `GET /leaderboard?track&car&scope&game&limit&cursor`
`track` and `car` are catalog ids (required; a track of another game than `game` is `400 invalid_game`); `scope` is `public` (default) or
`friends`. The best valid, plausible, visible lap of every driver for that track and car, ranked by time. **Ties share a rank** (1, 2, 2, 4),
the earlier lap first; `gapMs` is the distance to the leader. Cursor paging, `limit` up to 100.
```
{ game, scope, track: { id, name, lengthM | null }, car: { id, name, class | null },
  entries: [{ rank, lapId, handle, displayName, timeMs, gapMs, achievedAt, isMe }], nextCursor }
```
`scope=public`: public profiles only, not hidden, not blocked either way with the caller. `scope=friends`: the caller (whatever their visibility)
and their accepted friends who are not private or hidden. `lapId` is the lap that counts, for `POST /reports`.

### `GET /leaderboard/me?track&car&scope`
```
{ game, scope, track, car, total, me: { rank, lapId, handle, displayName, timeMs, gapMs, achievedAt, isMe: true } | null,
  reason: null | "not_listed", neighbours: { above: [Entry], below: [Entry] } }
```
The two drivers above and the two below by position. `me` is `null` (reason `not_listed`) when the caller is not on that board: no valid plausible
lap, a profile that is not `public` (for `scope=public`) or hidden.

## Reports

### `POST /reports`
Body `{ "kind": "profile" | "lap", "handle" (profile) | "lapId" (lap), "reason": "cheating" | "offensive_name" | "impersonation" | "spam" | "other",
"details"?: up to 300 characters (no control characters) }`. `201 { report: { id, status: "open", createdAt } }`.
One **open** report per reporter and target (`409 already_reported`; a decided report frees the pair); at most 50 open per person
(`422 too_many_open_reports`); not yourself (`400 invalid_target`); a target the reporter could not see is `404 target_not_found`.

## Moderation (admin only)

Moderators are decided by the app's own server-side check (`is_admin_user()`, run as the signed-in person): anyone else gets `403 forbidden`.

- `GET /admin/reports?status=open|dismissed|actioned|all&limit&cursor` (default `open`), newest first: `{ reports: [Report], nextCursor }` with
  `Report { id, kind, status, reason, details | null, createdAt, decidedAt | null, reporter: {handle, displayName}, target }`; `target` is
  `{ handle, displayName, visibility, hidden }` for a profile, `{ lapId, game, track, car, timeMs, plausible, hidden, owner: {handle, displayName} }`
  for a lap, `null` when it is gone.
- `POST /admin/reports/<id>` body `{ "action": "dismiss" | "action" | "unhide", "hideTarget"?: bool }`: `dismiss` closes it with nothing done;
  `action` marks it actioned and, with `hideTarget: true`, **hides the profile or the lap** (it disappears from every social answer; the owner
  still has their own laps); `unhide` shows the target again (and dismisses an open report). `200 { report }`; `409 already_decided`.
- `GET /admin/laps/<id>`: `{ lap: { id, game, track, car, lapNumber, timeMs, valid, startedAt, sectorsMs, topSpeedKmh, sampleCount, sizeBytes,
  formatVersion, createdAt, marked, plausible, plausibility, hidden }, owner: { handle, displayName, visibility, hidden } | null,
  onLeaderboard, reports: [{ id, status, reason, createdAt }] }`. `plausibility.failed` lists the checks and the numbers.
- `POST /admin/recheck` body `{ "limit"?: 1-200 }` (default 50): reads the files of laps with no verdict and fills it in; unreadable files become
  `file_unreadable`. `{ checked, plausible, implausible, remaining }`. Run it until `remaining` is 0 after the migration.

## Privacy rights

### `GET /me/export`
One JSON file (`Content-Disposition: attachment; filename="xpeed-virtual-data.json"`), at most 5 an hour:
```
{ format: "xpeed-virtual-export", version: 1, exportedAt,
  profile: { handle, displayName, visibility, createdAt, updatedAt } | null,
  friends: [{ handle, status: "accepted" | "incoming" | "outgoing" | "blocked", since }],        // by handle only
  sessions: [Session], laps: [Lap + { marked, plausible, plausibility }], personalBests: [{ game, track, car, bestMs, lapId, achievedAt }],
  devices: [{ id, name, pairedAt, lastSeenAt, lastLapAt, revokedAt }], shares: [Share], trackLayouts: [{ id, game, track, variant, title, lengthM, sizeBytes, updatedAt }],
  reportsMade: [{ kind, reason, details, status, createdAt }],
  lapFiles: [{ lapId, sizeBytes, path: "/api/sim/v1/laps/<id>/file" }], trackLayoutFiles: [{ id, sizeBytes, path: "/api/sim/tracks/<id>/file" }] }
```
The files are not inside the document: each `path` is downloaded with the same sign-in. No e-mail (the person's or anyone's), no device key or its hash,
no share token, no other person's data.

### `DELETE /me/data` body `{ "confirm": "delete my racing data" }`
Exactly that sentence, else `400 confirmation_required`. Deletes, in one transaction, the person's laps, sessions, personal bests, track layouts, share links,
friendships, the reports they made and the reports about them, handle history, profile, devices, pairing codes and link requests, then removes
their lap and track files. It does **not** delete the account. `200 { deleted: { laps, sessions, trackLayouts, shares, friendships, reports, devices, profile } }`.
Afterwards nothing of theirs is reachable or listed: their handle is a `404`, their share links are `404`, their device keys are `401`, they are on no board
and in nobody's friend list. A new use of the Virtual API starts a new, generated profile.
