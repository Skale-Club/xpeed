# API v1: racing data (read side)

## Optional session coach

The session page offers an optional text coach using the existing chat UI and
`POST /api/fn/chat`. It starts off for every account on this browser. Enabling it
does not open a conversation or contact AI: the person opens the coach and sends
a question explicitly. Disabling it leaves capture, uploads, sessions and lap
analysis usable. Example mode hides it and cannot start a real coaching request.
Manually saved training goals, private setup versions and optional native
Companion text/dictation/speech are described below. Automatic live
interventions and structured exercise plans remain outside this increment.

Virtual requests carry `{ mode: "virtual", sessionId, conversationId, messageId,
message, language, accountId }`. New clients bind requests to the displayed
account; the server rejects a different authenticated account before any work.
The question must already exist as a user message in that
conversation. The server verifies the conversation and session belong to the
caller and match each other, then reads persisted history before that question.
Client history and telemetry claims are not used for Virtual coaching. Missing,
deleted or mismatched context returns `404 context_not_found`; database failures
return `503 unavailable`, before any quota is spent. There is no fallback to a
Real car or another session. Platform-funded requests reuse the daily chat quota;
failed provider requests return their quota unit. Personal-key requests do not
consume or refund platform quota (see provider selection below).

Session metadata covers the first 200 laps in driving order, with
explicit partial-coverage reporting for larger sessions. Only valid, plausible
laps outside pit laps contribute to `insightsFromLaps` (the same calculation as
the session-insights endpoint). Conditions that are missing remain unknown.
Instructions distinguish measured evidence, driver reports and hypotheses;
sector timing does not establish a particular braking point, corner trajectory
or exact setup adjustment.

Detailed driving evidence decodes at most two owned, identity-matching stored
laps: up to 8 MiB compressed / 24 MiB unpacked and 100,000 samples each. Practice
and qualifying use the best eligible lap in the inspected session as reference;
race/unknown contexts compare adjacent eligible laps. The source pair is named
explicitly and linked to the existing comparison screen. The shared comparison
core returns up to five corner losses and five findings about measured braking,
throttle, speed, gear and trajectory differences, when the channels exist.
Unknown coordinate frames withhold position-based conclusions; missing/gapped
inputs remain missing. Causes/confidence are heuristic rather than proof or
calibrated probabilities. Missing, corrupt, mismatched or oversized files leave
the metadata coach available with a driving-evidence limitation. Raw sample
arrays and storage paths are never included in model prompts.

Migration `20261118160000_virtual_coach_chat.sql` defaults legacy conversations
to `mode=real`. Virtual conversations have an immutable `sim_session_id`, no
`car_profile_id`, and owner-checked insert/update policies. Deleting a session
cascades to its coaching conversations and messages. Real chat lists remain
separate from each Virtual session's list. The opt-in is a versioned browser
preference scoped to the signed-in account, not an account-wide server setting.

Paid chat, trip-summary and fuel-receipt requests are disabled unless the server's `NODE_ENV` is
`production` (`503 development_disabled` otherwise). Development verification
uses a simulated provider; no paid AI or production database is required.

Checks: `npm run test:virtual-coach` (Node 24, esbuild and the existing
`.xpeed-audit-tools` PGlite dependency). On a light computer,
`XPEED_TEST_TOOLS_ROOT` can point to an existing checkout with these packages;
it does not install or change those dependencies. Measured on the Surface on
2026-11-18: the current focused Node and isolated SQL suite took 13.24 seconds.
React tests cover activation, context switches and late
responses; run them with the repository's normal Vitest dependencies.

## Optional training goals and evolution

After enabling the coach, the driver can explicitly open **Training goals** in
the session card. Until then the goals module and its reads stay unloaded. Goal
management makes no AI calls and works without an AI provider. Turning the
coach off hides the tools; existing goals remain saved. Account/session changes
and example mode reset the view and discard late responses. Cancelling a view
stops waiting for its result; an RPC already submitted can still finish.

Migration `20261118180000_virtual_training_goals.sql` exposes these
owner-checked RPCs through the existing database transport:

- `sim_coach_goals({p_session_id})`: `{goals,limit:20,truncated}` for this
  session's simulator/car/track. Each goal includes its baseline, latest
  eligible measurement, signed `delta` (latest minus baseline), and nullable
  `reached`. No eligible follow-up means no measured progress.
- `sim_coach_goal_create({p_session_id,p_title,p_metric,p_target,p_notes})`:
  create a goal from an owned session with enough eligible baseline laps;
  returns its UUID. Names have 1–120 characters and notes at most 1,000.
- `sim_coach_goal_status({p_id,p_status})`: manually set `active`, `completed`
  or `archived`; returns false for an unavailable/foreign goal.
- `sim_coach_goal_delete({p_id})`: explicitly remove the owned goal and notes;
  returns false for an unavailable/foreign goal.

Metrics are `best_lap_ms` (integer 1,000–3,600,000), `consistency_ms` (integer
0–3,600,000) and `valid_lap_pct` (0–100). The UI accepts durations in seconds
and converts to milliseconds. Lower time/variation is better; higher valid
percentage is better. Best/consistency use valid, plausible non-pit laps.
Consistency requires at least three eligible laps within 7% of the best and
uses sample standard deviation. The percentage denominator includes every
timed non-pit lap inspected, including invalid/unverified laps; its numerator
uses only verified valid laps. It is deliberately not a claim about all
recorded distance or all driving time.

Measurements inspect the first 200 lap metadata rows in driving order and
explicitly flag partial coverage. Baselines are recomputed from surviving
source data. Progress uses the latest evaluable result among the twenty most
recent subsequent sessions of the same simulator/car/track/source-session
kind, started after both goal creation and the baseline session start. It
does not use earlier historical sessions or a lifetime best. Weather and
temperature labels are shown; matching fuel, tyres, setup and grip are not
assumed. A reached target is an observation and never automatically completes
a goal or proves that coaching caused an improvement.

There are at most twenty goals per simulator/car/track, including archived
goals, and one hundred per account. Creation uses an owner transaction lock
to enforce concurrent limits. The table and measurement/context helpers are
not directly accessible to anonymous/authenticated database roles. Public
goal RPCs obtain the actor from the verified application identity, validate
source ownership and do not accept a user ID. The server coach alone can
request explicitly owner-scoped context and includes at most three active
goals with bounded scalar measurements. Chat can advise around these goals;
it cannot create, update or complete them.

Deleting the source session cascades to its goals; deleting the account or
all Virtual sessions also erases them. The Virtual data download includes
`trainingGoals` without credential data. No application database migration
or production configuration is performed by the local tests. The combined
focused suite including the later setup/Companion contracts measured about
thirteen seconds on the Surface on 2026-11-18;
normal UI Vitest and full project checks remain release requirements.

## Private setup versions and consultation

**Car setups** is a separate explicitly opened tool in the opted-in session
coach. It loads only on request and makes no AI calls to manage the library.
The source session determines its simulator/car/track context; another account
or context cannot supply a parent or session association.

Migration `20261118190000_virtual_setup_versions.sql` adds owner-checked RPCs:

- `sim_setup_versions({p_session_id})`: `{versions,selectedVersionId,limit:20}`.
  A version has `{id,label,notes,parameters,parentId,createdAt,runs}`. `runs`
  contains at most three recent owned, explicitly associated sessions with
  bounded verified best-lap measurements, conditions and coverage.
- `sim_setup_create({p_session_id,p_label,p_notes,p_parameters,p_parent_id})`:
  save a new immutable snapshot, returning its UUID. Creating a version does
  not associate it with the session. A parent must belong to the same owner
  and simulator/car/track. Copying starts a new draft; the original survives.
- `sim_setup_attach({p_session_id,p_version_id})`: explicitly record the
  driver's setup declaration for this owned session; null removes it. Merely
  selecting a version for viewing does not change this association.
- `sim_setup_delete({p_id})`: explicitly delete the owned version. Its session
  associations are removed; derived snapshots retain their parameters and
  lose the deleted parent link.

Labels have 1–120 characters, notes at most 1,000. Parameters are 1–32 objects
`{name,value,unit}`, all strings, with name 1–60 characters, value 1–80 and unit
0–20. Names are unique ignoring case. Control characters are rejected, and
values are stored with their explicit units. The application does not infer
numeric meaning, convert simulator units, validate supported adjustment
ranges or import proprietary simulator setup files. Parameter differences
preserve names, values, unit changes, additions and removals.

The library holds twenty versions per context and one hundred per account.
Direct table/private-helper access is denied to browser database roles.
Mutations take the same owner lock as racing-data erasure where needed. The
library survives session deletion; full Virtual-profile or account erasure
cascades to snapshots and associations. The Virtual privacy download includes
`setupVersions` and `sessionSetups`, scoped to the authenticated owner.

The shared chat becomes a setup consultant when an explicitly associated
snapshot exists. Server evidence includes that version, its surviving parent,
parameter changes and bounded associated runs, marked as **driver reports**.
An unassociated newest library version is never assumed to be in the car.
The model asks about the balance symptom, corner phase and conditions, separates
driving and mechanical hypotheses, and proposes one qualified experiment at a
time. It must not invent ranges/clicks, prescribe exact numerical targets from
unverified settings, claim that a time difference proves a setup effect, or
claim to apply/change settings. Simulator writes remain unavailable. Normal AI
billing still follows super-admin configuration.

## Optional Companion conversation and local speech

Companion 0.12.0 adds a Session Coach window from the connected Monitor. It
starts off every time it opens. Separately, `companion_coach_enabled` starts
false for every device. The signed-in Google owner can explicitly permit or
disable a non-revoked device on `/virtual/companion` through
`PATCH /api/sim/devices?id=<uuid>` with `{accountId,enabled}`. The actor must
match `accountId`; owner/device filters and current revocation are checked
on the server. Pairing alone does not enable AI, and a device bearer cannot
grant itself this permission. Revocation also clears the capability.

`GET /api/sim/coach` authenticates the existing hashed, non-revoked device
bearer and checks permission before returning up to twenty recent owned
sessions with laps attributed to that device. No default session is selected.
`GET /api/sim/coach?sessionId=<uuid>` returns the shared session conversation
and up to twelve text messages, each clipped to 1,500 characters. An optional
`pendingRequest` contains the admitted question's exact original message,
conversation and idempotency UUID, allowing native restart recovery without
another paid send. There is no AI call on opening, selecting, refreshing or
dictating.

`POST /api/sim/coach` accepts `{sessionId,conversationId?,idempotencyKey,
message,language?}`. The text is at most 2,000 UTF-16 units, HTTP body 16 KiB;
language is en/pt-BR/es-ES. The bridge pins the authenticated owner and saved
Virtual question, uses the shared chat handler and billing resolver, then
persists the assistant reply atomically. It does not mint Google tokens or
trust client history. The provider wait is bounded at 45 seconds; native HTTP
has a 90-second deadline, no redirects and a 128 KiB response bound.

Migration `20261118200000_companion_coach.sql` provides service-only device
scope, history, begin/finish and export functions. A persisted question UUID
admits only one dispatch; repeats return its cached reply, pending status or
terminal failure. Admission transactions serialize briefly per account, never
across the provider call. A different outstanding request returns `device_busy`
without admitting the new UUID; `request_pending` is reserved for the original
admitted request. There is at most one recent pending request per device and
six POSTs per minute. HTTP 409 distinguishes `device_busy`, `request_pending`
and `request_failed`; no automatic fresh UUID, retry or billing-source fallback
is performed. Unresolved old admissions remain uncertain even after the
two-minute busy window. Deleting their conversation erases those records.
Only a deliberate new question can start a new request.

Companion holds its UI draft/history in memory, with generation checks before
send and before display. Closing, disabling, session changes or re-pairing
discard stale results. An HTTP request already received can finish. No device
token appears in the View, logs or model prompt, and native errors do not expose
provider credential or credit details. Paid sends are disabled outside
production; local contracts use a simulated AI boundary.

Record performs bounded local Windows dictation into the draft; the driver
reviews it and presses Send explicitly. Speak answer reads the last answer
only on request. Neither action uploads audio or saves an audio file. The
fixed PowerShell scripts use installed Microsoft desktop System.Speech engines
matching the app language (en-US/pt-BR/es-ES); missing recognition/voice packs
leave text usable rather than selecting another language or paid service.
Controls currently use English; AI replies and speech select the app language.
Dictation has a 15-second wall-clock bound, speech 120 seconds. Text passes over
private stdin, never executable command interpolation. A private Windows
kill-on-close Job Object is assigned before an stdin handshake allows audio,
so failed assignment, closing or application exit cannot leave an orphan
microphone/speech process. The Stop voice control cancels only its own job.
API references: [recognition](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.recognize?view=netframework-4.8),
[speech](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.speak?view=netframework-4.8.1).

Full Virtual export now includes owner-scoped coach chats alongside goals,
setup versions and session associations. Source-session/account erasure
cascades to native questions/replies. Native compilation, formatter/Clippy,
window interaction and real microphone/speaker acceptance are release gates;
PowerShell AST parsing does not establish that the native flow works.

## OpenRouter provider and billing selection

Only the Super-Admin Panel offers provider configuration. Ordinary users have
no key controls, provider selector or access to credential metadata. The default
is the platform key/model and platform quotas. A super admin can select a client
account and assign its personal OpenRouter key plus model; that client's
OpenRouter account bears the provider charges instead of consuming platform
quota. The setting applies to Real/Virtual chat, trip
summaries and fuel-receipt extraction; the chosen model still needs image and
structured-output capability for receipt extraction. A personal key does not
enable the Virtual coach, device permission or voice controls.

`POST /api/fn/ai-preferences` verifies the existing super-admin role on the
server before reading the request body or target data. Ordinary accounts get
`403 forbidden` for every action, including their own credentials. `accountId`
must match the authenticated administrator, and `targetAccountId` identifies
the client being configured. `{accountId,action:"accounts",cursor?}` returns
up to 100 account names/emails/IDs and `nextCursor`; this picker loads only when
the administrator opens the section. Other bodies are
`{accountId,targetAccountId,action:"status"}`,
`{accountId,targetAccountId,action:"save",mode:"global"}`, or
`{accountId,targetAccountId,action:"save",mode:"personal",model,apiKey?}`.
Omit `apiKey` to retain an existing encrypted key.
`{accountId,targetAccountId,action:"delete"}` explicitly removes the client's
stored key and returns it to platform mode. Switching the administrator or
target account aborts pending operations and clears the password input.
No credential metadata is loaded before a target is selected. Responses contain safe metadata
only (mode, saved-key presence/last four characters, model, global availability
and storage availability). Never paste credentials into a chat.

Migration `20261118170000_personal_ai_preferences.sql` stores service-only
AES-256-GCM ciphertext with fresh random nonces and account-bound associated
data. Authenticated/anonymous database roles cannot read or change the table.
Before enabling personal-key saving in production, configure a persistent
`AI_CREDENTIAL_ENCRYPTION_KEY` containing 32 random bytes in Base64 in the server
environment, never a `VITE_*` variable or committed file. Keep it with protected
server backups: replacing it requires a deliberate key-rotation migration or
an administrator re-entering the clients' personal keys. Missing encryption configuration disables
personal-key saving; decryption/storage failures stop the request.

The authorized Coolify deployment runs `scripts/ensure-ai-credential-key.mjs`
before restarting the app. It creates a hidden runtime-only secret when absent,
preserves existing keys without rotation, verifies metadata and logs no values.
The Coolify API token needs environment read/write permissions as well as deploy.

There is no automatic fallback between billing sources. Invalid personal keys,
insufficient personal credits, unsupported models and provider rate limits are
classified separately by the server; ordinary chat shows a generic assistant
failure without credential-management instructions. No provider account or
credit purchase is created by the app. Provider requests use OpenRouter's documented Bearer authentication:
https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.

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

**Personal best (pb)** `{ game, track: {id, name}, car: {id, name}, bestMs, lapId, achievedAt, previousBestMs: int | null, improvedByMs: int | null,
bestSectorsMs: [int] | null, sectorLapIds: [uuid] | null }`: the fastest valid lap of the person on that track with that car; `achievedAt` is when the lap was driven.
`previousBestMs` is the best the lap replaced: the fastest valid lap of the same track and car that was **driven before it** (by start time, not by when
it arrived), when that was slower than `bestMs`, and `improvedByMs` is the difference (`previousBestMs - bestMs`, always positive). Both are `null` for the
first valid lap on that track and car, and when an earlier lap was exactly as fast (a tie replaced nothing); an invalid lap is never a previous best.
They follow the laps that remain (deleting the best puts the earlier best back, with its own previous best) and come from the database in the same statement
that pages the bests (`sim_previous_best`, index `sim_laps_previous_best`), also in the items of `overview.latestPersonalBests`.
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

### `GET /sessions/<id>/insights`
The most useful findings of a session, worked out from the **stored lap metadata** (times, validity, in and out laps, sector times): one database call
(`sim_v1_session`), no lap file is read, so it is cheap enough for a home page. The corner analysis (brake points, speeds) needs the files and stays the site's job
(`src/lib/sim/use-work-on.ts` asks this first and reads the files only when this has nothing to say). `404 session_not_found` for an unknown session or
another person's; `GET` only. Code: `api/sim/_insights.ts`.
```
{ sessionId, source: "metadata",
  lapsUsed,            // valid, timed laps that were not in or out laps
  lapsConsidered,      // of those, the ones within 7 % of the best: what the averages are taken over
  summary: { bestLapMs | null, bestLapId | null, averageMs | null,
             consistencyMs | null,       // sample standard deviation of the considered laps; null with fewer than 3
             sectors: null | { count,     // null when no usable lap has sectors; the majority sector count wins (the larger on a tie)
                               bestMs: [int], bestLapIds: [uuid],      // the fastest time of each sector over the usable laps with that count, and who holds it
                               gainMs: [int],                         // the best lap's sector minus the best of that sector
                               theoreticalBestMs, theoreticalGainMs,  // the best lap with every sector at its best, and how much faster that is
                               spreadMs: [int] | null,                // standard deviation of each sector over the considered laps; null with fewer than 3
                               widest: { sector, stdDevMs } | null } },  // the sector that varies most (1-based)
  findings: [ { kind: "sectorGain", sector, gainMs, lapId }              // the sector where the best lap loses most to the best of that sector (at least 50 ms)
            | { kind: "sectorSpread", sector, stdDevMs, laps }           // the sector that varies most (at least 100 ms, and not the sector of the finding above)
            | { kind: "consistency", stdDevMs, laps } ] }                // the laps vary (at least 150 ms)
```
`findings` holds at most **two**, in that order of priority, and is empty when the session has fewer than 3 usable laps or nothing reaches its threshold. Times
are milliseconds (rounded), sectors count from 1. A lap with a sector of 0 ms or less has no sectors for this purpose.

### `DELETE /sessions/<id>`
Deletes every lap of the session (rows and stored files) and the session itself in one database transaction; the personal bests
are recomputed from the laps that remain. Answer `200 { "deleted": <number of laps> }`. An unknown session, someone else's, or one that is
already gone is `404 session_not_found` (so a repeat is safe: nothing else changes). A file that cannot be removed is picked up by the orphan
sweeper. The overview cache of the person is dropped.

### `GET /tracks?game&cursor&limit` and `GET /cars?game&cursor&limit`
The tracks (cars) the person has driven, most recently driven first.
Track item: `{ id, game, name, lengthM | null, lapCount, validLapCount, sessionCount, carCount, bestLapMs | null, lastDrivenAt, hasLayout: boolean,
layoutId: uuid | null }`. `hasLayout` is true when the person's Xpeed Companion has sent a track layout (`/api/sim/tracks`) for that track, and `layoutId` is that
layout (`GET /api/sim/tracks/<id>/file`; the newest when several match). The match is made by the database, by game and name like the site does
(`sim_layout_id`, `src/lib/sim/track-layout-match.ts`): same game (`rfactor1` laps match layouts filed under `sce`) and the track's name equal, ignoring case,
accents and punctuation, to the layout's track name, its track name with the layout variant, or its title. Only the person's own layouts count.
Car item: `{ id, game, name, brand | null, class | null, lapCount, validLapCount, sessionCount, trackCount, bestLapMs | null, lastDrivenAt }`.
Answers `{ tracks: [...], nextCursor }` and `{ cars: [...], nextCursor }`.

### `GET /tracks/<id>`
Any track in the catalog (a track the person never drove has zero totals and empty lists):
```
{ track: { id, game, name, lengthM | null, hasLayout: boolean, layoutId: uuid | null },   // the two layout fields as in a track item
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
  progress: { bestPerDay: [{ day, bestMs, lapId, track: {id, name} }],   // fastest valid lap of each day on each track, oldest day first (the latest 1000)
              lapsPerDay: [{ day, laps, validLaps }] },
  bestPerTrack: [{ track: {id, name}, lapCount, validLapCount, bestMs | null, lapId | null, achievedAt | null }] }  // by track name
```

`bestPerDay` has one entry per day **and track**: lap times of different tracks cannot be compared, so a chart of a car's progress draws the line of one
track (filter the entries by `track.id`).

### `GET /pbs?game&track&car&cursor&limit`
Personal bests, most recently achieved first. Answer `{ pbs: [pb], nextCursor }`. Each pb carries `bestSectorsMs` and `sectorLapIds` (see the object above).

### `GET /overview`
One cheap call for the home page, cached for 10 seconds per person (an upload or a deletion by that person drops their entry):
```
{ latestSessions: [Session]          // the 5 latest
  latestPersonalBests: [pb]          // the 5 most recently achieved (with previousBestMs and improvedByMs, as in /pbs)
  lapsPerGame: [{ game, laps, validLaps, sessions, lastDrivenAt }]   // most played first
  companion: { devices: [{ id, name, pairedAt, lastSeenAt | null, lastLapAt | null,      // paired computers, revoked ones left out
                           version | null, state | null, game | null, stateAt | null }],  // what the last heartbeat said (below); null before the first one
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
- `consistency`: the person's latest 8 sessions, **whatever the range** (a trend, so a week with one session still has something to show), **oldest first**. `spreadMs` is the sample standard deviation of the session's valid laps that are
  not in or out laps (null under 3 of them); `cleanShare` is those clean laps over all the session's laps in the range (0 to 1, 3 decimals); `validLaps` counts the valid laps (all of a session's laps count, not only those inside the range).
- Nothing in the answer is an e-mail, a phone number, an account id, a device or a file path; other people's laps never enter.

## Upload side (unchanged contract, new behavior)

`POST /api/sim/laps` (device key) keeps its request and answers (`201 {id, duplicate:false}`, `200 {id, duplicate:true}`, ...).
New: the lap is linked to its track, car and session when it arrives; the file is written under a staging name and renamed
once whole, and the row, catalog, session and personal best are one database transaction (a failure leaves no row and no file;
`sweepOrphanLaps()` in `api/sim/_sweep.ts` removes files with no row). Refusals: `422 {"error":"quota","retryable":false}` when the
account would pass 20 GB of lap files (measured from `sim_laps.size_bytes`; the old 5000-lap cap is gone), `429` when one device
sends more than 60 laps a minute (counted in the database, so restarts and several instances share it).
The unversioned `GET /api/sim/laps` stays for the current site.

### Heartbeat: `POST /api/sim/heartbeat` (device key)
Xpeed Companion 0.7.0 says it is running: on start, every 60 s, and at once when a game connects or goes away (at most one per 5 s).
Body `{ "version": "0.7.0", "state": "idle" | "waiting" | "connected", "game": "ams2" | null, "pendingLaps": 0 }`: four fields, strict
(`version` is `0.7.0` or `0.7.0-beta.1`; `game` is a lowercase id, required but may be `null`; `pendingLaps` is an integer >= 0, capped at 1,000,000,
checked and not kept); other fields are ignored; the body is at most 2 KB. It is one database call (`sim_device_heartbeat`, migration
`20261113200000_sim_heartbeat.sql`): it finds the device, counts the hit (30 a minute per device, in the database), and writes `last_seen_at = now()`,
`companion_version`, `last_state`, `last_game` and `last_state_at` (when the state or the game last *changed*). Answers `200 {"ok":true}`;
`401 unauthorized` for a missing, unknown or revoked key (nothing is written), `400 invalid_json | invalid_request | invalid_version | invalid_state |
invalid_game | invalid_pending_laps`, `413 too_large`, `429 too_many_requests` (`Retry-After`), `503 unavailable`; every refusal is `{ error, retryable }`.
A change of state or game drops the person's overview cache, so it shows at once. The site treats a computer as online when `lastSeenAt` is within
3 minutes. `GET /api/sim/devices` lists the same facts as `companion_version`, `last_state`, `last_game`, `last_state_at`. Checks: `npm run test:sim-v1`.

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
friend requests 30 an hour; new share links 30 an hour; reports 10 an hour; leaderboard catalog reads 60 a minute; exports 5 an hour; deleting data 3 an hour; the public share
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

**Own profile** `{ handle, handleChosen, displayName, visibility, createdAt, handleChangesLeft (0-3), handleChangesResetAt | null }`.
**Driver page** `{ handle, displayName, joinedAt, isMe, relation: "self" | "friend" | "requested" | "incoming" | "none", visibility (the owner only, else null),
gamesPlayed: [game], personalBestsCount, bestLaps: [{ lapId, game, track: {id, name}, car: {id, name}, timeMs, achievedAt }] }` (the 5 most
recent personal bests that count).

### `GET /profile`
`{ "profile": <own profile> }`. Created now when it does not exist: handle `driver_` plus six letters and digits (no look-alikes), display
name `Driver ` plus the first four of them in capitals, visibility `public`. Nothing is derived from the e-mail, the phone or the account's
name. The first uploaded lap creates it too. The generated handle is a placeholder: `handleChosen` is `false` until the person sends a
handle with `PATCH /profile`, and the site asks for a username before any Virtual screen while it is.

### `PATCH /profile`
Body: any of `handle`, `displayName`, `visibility` (other fields are `400 invalid_request`; none is `400 invalid_request`).
Answer `{ "profile": <own profile> }`.
- `handle`: trimmed and lower-cased; 3 to 24 characters of `a-z0-9_`; not reserved (`admin`, `support`, `xpeed...`, `moderator...`, `staff...`,
  `driver`, `me`, `requests`, ... see `RESERVED_HANDLES` in `api/sim/_social.ts`); not taken (`409 handle_taken`, which is not counted).
  A change to the handle you already have is not a change. The first handle sent (while `handleChosen` is `false`, even the generated one
  kept on purpose) is the person's choice: it sets `handleChosen` and is not counted. After that, **3 changes per 30 days**: the 4th is `429 handle_change_limit` with
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
- `GET /friends/requests/count`: `{ "incoming": <number> }`, how many people asked you to be friends and still wait: the people `GET /friends?status=incoming`
  would list (a hidden profile is not counted). One cheap call for a badge; asking does not create the profile; `GET` only (`405` otherwise).
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
  `{ shares: [Share + about], nextCursor }`, where each item also says what the link is about, with `null` where it does not apply:
  `trackName`, `carName` (the catalog's names), `lapMs` (a lap link: its time), `sessionKind` (`practice | qualifying | race | unknown`) and `lapCount` (a session link).
  `POST /shares` answers the plain **Share**.
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

### `GET /leaderboard?track&car&scope&game&tyre&limit&cursor`
`track` and `car` are catalog ids (required; a track of another game than `game` is `400 invalid_game`); `scope` is `public` (default) or
`friends`. The best valid, plausible, visible lap of every driver for that track and car, ranked by time. **Ties share a rank** (1, 2, 2, 4),
the earlier lap first; `gapMs` is the distance to the leader. Cursor paging, `limit` up to 100.

`tyre` limits the board to laps driven on one tyre compound, as the lap file header wrote it (`tyreCompound`: "Soft", "Medium", "Slick Soft (S)"...),
compared as the exact text within one game (no case folding, no mapping across games). Each driver's best lap **on that tyre** is ranked, and ranks and
gaps are of that tyre only. Absent or empty means every tyre (the board as it was). 1 to 40 characters without control characters, else
`400 invalid_tyre`. A lap whose file had no compound is on the every-tyre board only. A lap's compound is read from its header at upload; laps that arrived
before the server stored it are filled in by the `tyre_backfill` job (`docs/platform/STORAGE.md`), so a filtered board grows complete as it runs.
```
{ game, scope, tyre: string | null, track: { id, name, lengthM | null }, car: { id, name, class | null },
  entries: [{ rank, lapId, handle, displayName, timeMs, gapMs, achievedAt, isMe }], nextCursor }
```
`scope=public`: public profiles only, not hidden, not blocked either way with the caller. `scope=friends`: the caller (whatever their visibility)
and their accepted friends who are not private or hidden. `lapId` is the lap that counts, for `POST /reports`.

### `GET /leaderboard/me?track&car&scope&tyre`
Takes the same `tyre` as the board (and `400 invalid_tyre`): your place, `total` and neighbours are on that tyre's board.
```
{ game, scope, tyre, track, car, total, me: { rank, lapId, handle, displayName, timeMs, gapMs, achievedAt, isMe: true } | null,
  reason: null | "not_listed", neighbours: { above: [Entry], below: [Entry] } }
```
The two drivers above and the two below by position. `me` is `null` (reason `not_listed`) when the caller is not on that board: no valid plausible
lap, a profile that is not `public` (for `scope=public`) or hidden.

### `GET /leaderboards/catalog?kind&game&track&car&limit&cursor`
The tracks (or cars) that have at least one lap on the public board, so a person can open a board for one they never drove. `kind` is `track` (default) or
`car`; `game` narrows to one game; `car` narrows the tracks to those that car has public laps on and `track` narrows the cars to those with public laps on that
track. A lap counts only when it is what the public board counts: valid, plausible, not hidden, of a profile that is public and not hidden, and not of anybody who is
blocked either way with the caller. Alphabetical by name, then id; cursor paging, `limit` up to 100. Limited to 60 reads a minute per person.
```
{ kind: "track" | "car",
  items: [{ id, game, name, lapCount, lengthM | null }                      // a track
        | { id, game, name, lapCount, brand | null, class | null }],        // a car
  nextCursor }
```
`lapCount` is the number of such laps (not drivers; not the caller's own private ones). It is the only thing said about anybody. `400 invalid_kind`, `invalid_game`,
`invalid_track`, `invalid_car`, `invalid_limit`, `invalid_cursor`; `429 too_many_requests`. Use the `id`s with `GET /leaderboard`.

### `GET /leaderboards/conditions?track&car&scope&game&tyre`
What one board is made of: the tyre compounds that have laps on it, and its theoretical best. `track`, `car` (catalog ids, required), `scope`, `game` and `tyre` are
read exactly as `GET /leaderboard` reads them, and the answer follows **exactly the same visibility rules** as that board (the same SQL function decides which laps
a board can show): valid, plausible, not hidden laps of profiles that are not hidden; `scope=public` only public profiles not blocked either way, `scope=friends`
the caller and accepted friends. Limited to 60 reads a minute per person (its own counter, the same limit as the catalog). `400 invalid_track`, `invalid_car`,
`invalid_scope`, `invalid_game`, `invalid_tyre`; `404 track_not_found`, `car_not_found`; `429 too_many_requests`.
```
{ game, scope, tyre: string | null, track: { id, name }, car: { id, name },
  tyres: [{ compound, drivers }],
  theoreticalBest: { timeMs, sectors: [{ index, ms, handle }] } | null }
```
- `tyres` always covers the whole board, whatever `tyre` says (so a screen can keep its chips while one is chosen): every compound with the number of drivers
  who have a counted lap on it, most drivers first, then by name. Laps without a compound add nothing here. A screen shows the chips only with two or more.
- `theoreticalBest` is the fastest of each sector over **every lap the board can show** (not only each driver's best lap, since a best sector is often not on
  the best lap), limited to `tyre` when it is given, and who drove it (`handle`; a tie goes to the earlier lap). `index` counts sectors from 1 and `timeMs` is
  the sum of the sector times, which no lap has to equal. It is `null` unless **every** counted lap has the same number of sectors, at least two, all above zero
  (a lap with no sectors, or a different count, would make the sum meaningless), and `null` when no lap is counted.

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
- `GET /admin/problems?status=open|resolved|all&source=site|companion&limit` (default `open`, both sources, up to 200): the groups of error reports
  from the site and from Xpeed Companion (first-party error tracking, `docs/operations/alerts.md`), newest first:
  `{ problems: [{ id, source, fingerprint, firstSeen, lastSeen, count, last24h, message, stack, route, version, agent, worker, affectedUsers,
  resolvedAt, reopenedCount }] }`. `affectedUsers` is a count: nobody is named.
- `POST /admin/problems/<id>` body `{ "resolved": true | false }`: marks the group resolved (or open again). `200 { id, resolvedAt }`; `404 problem_not_found`.
  A resolved group reopens by itself when it happens again after the resolution.

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
