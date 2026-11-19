# Condition-aware leaderboards (aids and tyres)

Status: proposed (2026-11-19). Nothing here is built yet.

## Why

Today a board is one track and one car (`sim_board` in `supabase/migrations/20261113170000_sim_social.sql`): a lap with TC 4, ABS 3,
automatic gears and the ideal line ranks next to a lap with every aid off, and a lap on soft tyres next to one on hards. RSR Live
Timing (Assetto Corsa, 2013 to 2025, now dormant) showed that the thing drivers valued most was comparing laps driven **in the same
conditions**: boards filtered by tyre and controller, and "PRO" boards with fixed aid rules. RSR trusted whatever its client sent (its
Imola leader drove a vJoy device with 550 % invalid laps); Xpeed already checks every lap file on the server, so it can do the same
idea with checks behind it.

## What exists today (checked in the code, 2026-11-19)

| Piece | State |
|---|---|
| Tyre compound | Read live by several readers (`Frame::tyre_compound`, `xpeed-sim/src/game.rs`), written in the lap header (`tyreCompound`, version 2), **dropped by the server**: `summarizeLap` (`api/sim/_summary.ts`) and `sim_ingest_lap` do not store it, and `sim_laps` has no column for it. |
| Aid settings (TC and ABS levels) | Read live for the dash only (`CarState::tc_level` / `abs_level`, `xpeed-sim/src/dash.rs:183`). **Not in the lap file.** Assetto Corsa (the original) reads none; Competizione, EVO, AMS2, RaceRoom, F1, Wreckfest 2 and LMU read them, all ASSUMED (the reader table in `game.rs`). iRacing, Forza and rFactor 1 give none. |
| Other aids (stability, auto clutch, auto blip, auto shifter, ideal line) | The Assetto Corsa shared-memory layout already lists `aidStability`, `aidAutoclutch`, `aidAutoBlip`, `autoShifterOn`, `idealLineOn` (`xpeed-sim/src/games/kunos.rs`), but nothing reads them into a `Frame`. |
| Aid acting right now | Recorded per sample as the channels `tc_active` and `abs_active` (`xpeed-sim/src/lapfile.rs:69`). This is what the server can check claims against. |
| Weather, air and track temperature, session kind | Stored on `sim_sessions`, not on the lap. |
| Sector times | `sim_laps.sector_ms`, so a "theoretical best" of a board can be worked out from stored data. |

## The plan, in phases

Each phase ships on its own and leaves the boards working.

### Phase 1: tyre boards (server and web only, no Companion release)

1. Migration: `ALTER TABLE sim_laps ADD COLUMN tyre_compound text CHECK (char_length(tyre_compound) BETWEEN 1 AND 40)`.
2. `summarizeLap` returns `tyreCompound`; `laps.ts` passes it to `sim_ingest_lap`; the function stores it.
3. Backfill: a bounded job (like the plausibility backfill) reads `tyreCompound` from the header of the files already stored. It
   reads headers only, oldest first, in batches, and can resume after a stop.
4. `sim_board`, `sim_leaderboard`, `sim_leaderboard_me` get `p_tyre text DEFAULT NULL` (null means every tyre). The board index gets
   a partner `(track_id, car_id, tyre_compound, user_id, time_ms, started_at, id) WHERE valid AND plausible IS TRUE AND NOT hidden`.
5. `GET /leaderboard` and `/leaderboard/me` take `tyre=`; a new `GET /leaderboards/conditions?track&car` lists the compounds that
   have laps on that board, with counts (like RSR's "Slicks Soft (S) (2789)").
6. Web: a tyre chip row above the board (`LeaderboardScreen`), only when the board has two or more compounds. Compound names are
   shown as the game writes them, grouped by exact string within one game; no cross-game mapping.
7. The same phase adds the **theoretical best** line (the best of each sector across the board, and who drove it), from
   `sector_ms`, only when every counted lap has the same number of sectors.

### Phase 2: aids in the lap file (Companion release)

1. A new optional version 2 header field, following the `recorder` precedent (added to version 2 without a version bump):

   ```json
   "aids": {
     "tcMax": 0, "absMax": 0,
     "stability": 0, "autoShift": false, "autoClutch": false, "autoBlip": false, "idealLine": false
   }
   ```

   Each value is the **highest setting seen at any moment of the lap** (a driver who turns TC off for the last corner still has TC
   on that lap). A key is left out when the game does not give that aid; `tcMax: 0` means "the game said TC was off the whole lap".
   A car without the aid (its maximum is 0) writes 0. The server and the website ship first; the release gate
   (XPD-RELEASE-GATE-ANCESTOR) already holds the Companion back until the server contains the reader.
2. The lap cutter (`xpeed-sim/src/lapcut.rs`) keeps the running maximum of each aid over the lap and writes it in the header.
3. Assetto Corsa reader: read `aidStability`, `aidAutoclutch`, `aidAutoBlip` (static page), `autoShifterOn` (physics) and
   `idealLineOn` (graphics). Settle in a live capture what AC's physics `tc` and `abs` floats mean (the slip-ratio setting, or "acting
   now"). Until a fixture shows it, AC's TC and ABS stay unknown. Every new mapping is ASSUMED until `fixtures/README.md` has a live
   capture, as the reader tables require.
4. Other readers write `tcMax` and `absMax` from the levels they already read. iRacing, Forza and rFactor 1 write no `aids`.
5. Tests: per-reader frames, the cutter's maximum over a lap where an aid changes mid-lap, header write and read parity
   (Rust and TypeScript), and an older server reading a file with `aids` (an unknown key must not fail it).

### Phase 3: aid boards (server and web)

1. Migration: `sim_laps.aids jsonb` and `sim_laps.aid_class text CHECK (aid_class IN ('none', 'no_tc_abs', 'any', 'unknown'))`.
   The server works it out at ingest:
   - `none`: every aid the game reports is off, and at least TC and ABS are known;
   - `no_tc_abs`: TC and ABS are known and off (whatever the others are);
   - `any`: some aid is on;
   - `unknown`: TC or ABS is not known (every lap before phase 2, every iRacing lap).
2. A new plausibility check, `aids_consistent`: a lap that says `tcMax: 0` but has `tc_active` set in more than a few samples (the
   threshold goes in `PLAUSIBILITY`) is a contradiction. It does **not** make the lap implausible (it still ranks on the open board);
   it moves `aid_class` to `unknown` and is listed for moderators.
3. Boards get `p_aids text DEFAULT 'all'`: `all` (today's board), `no_tc_abs` (laps of class `no_tc_abs` or `none`), `none`. Laps
   of class `unknown` appear only on `all`. Index as in phase 1, on `aid_class`.
4. API: `aids=` on the board routes; `/leaderboards/conditions` also returns how many drivers each aid board has.
5. Web: an "Aids" chip row (All / No TC & ABS / No aids) next to the tyre chips. Each row shows small aid icons (TC, ABS, gears,
   line) with a tooltip, like RSR's row, from `aids`. The driver's own lap page shows the lap's aids.
6. Docs: `docs/platform/API-V1.md` (parameters, classes, the new check and its threshold), the reader tables in `game.rs`.

### Phase 4, later (not planned in detail)

- An improvement history per driver per board (every personal best over time). It needs no new data.
- A combined ranking over a fixed set of track and car pairs with fixed conditions (RSR's "PRO rank": the sum of times, with a
  penalty for a missing pair).
- Time-limited events with a fixed pair and fixed conditions.

## Left out on purpose

- **Hardware on public boards** (wheel, pedals, resolution, FOV). RSR showed it on every lap; it identifies people and does not
  change the comparison. Not collected.
- **Cross-game tyre mapping** ("soft" in one game is not "soft" in another).
- **Conditions as hard filters on session weather** (rain or dry, track temperature): a later phase if drivers ask. The values are
  already on `sim_sessions`.

## Decisions for the owner

1. The three aid boards and their names (All / No TC & ABS / No aids). Proposed decision: yes, as above.
2. Laps with unknown aids appear only on the open board. Proposed decision: yes; this is the honest reading for old laps and for
   iRacing.
3. Aid icons are visible on public board rows. Proposed decision: yes; they describe the lap, not the person, and the privacy model
   already shows the lap time and date to the same viewers.

## Risks

- Aid levels are reported by the game through the Companion, so a modified client can lie. The `tc_active` and `abs_active` check
  catches the common case (an aid that acts while it says it is off); it cannot catch a modified file whose channels are made up.
  Phases 1 and 3 are exactly as trustworthy as today's lap times.
- Most readers' aid mappings are ASSUMED. Until live captures confirm them, a game's aid board can be wrong in a systematic way, so
  aid boards should be switched on per game after its fixture, behind the per-game capability list.
- Filtered boards have fewer drivers. The chips appear only when a board actually has laps in more than one condition.

## Rough size

| Phase | Parts touched | Size |
|---|---|---|
| 1 | migration, ingest, backfill job, 3 SQL functions, 2 routes and 1 new route, board screen | about 2 days |
| 2 | lap header (Rust and TS), cutter, AC reader plus small changes in 6 readers, fixtures, Companion release | about 3 days, plus live captures per game |
| 3 | migration, ingest, plausibility check, SQL functions, routes, chips and row icons, docs | about 2 days |
