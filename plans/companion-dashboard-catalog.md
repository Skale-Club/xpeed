# Companion dashboards: a widget catalog, dashboards per session, and the phone view

Status (2026-11-19): **approved; phases 1 to 4 built** on `feat/dashboard-catalog` (phase 4: rivals from RaceRoom, rF1 family, AMS2/PCARS, F1, iRacing, LMU, AC EVO, ACC; Wreckfest 2 waits for its participant packet layouts; radar from world positions or iRacing's spotter; nothing live-tested) (phase 3: LMU still gives only the car count, its generated layout lacks place, end time and max laps; class position only where the game gives it, RaceRoom and iRacing, until phase 4) (CI green, not merged, not released). The owner decided: a modular catalog, dashboards made from it, no OBS
overlays, the phone view as a PWA planned in parallel, and **every game the Companion reads is in scope, not only iRacing**. The
proposals under "Owner decisions" were accepted as written ("tudo ok", 2026-11-19).

## Why

A competing product for iRacing sells "19 overlays and tools in one app": phone and tablet screens over Wi-Fi, digiflags, a
telemetry coach, tyre strategy, a fuel calculator, relatives, standings by class, the delta to the fastest lap, a spotter and a
radar. The Xpeed Companion has **one** dashboard with seven fixed cards. The owner wants each of those tools as an entry in a
**catalog** of widgets, so dashboards (race, qualifying, practice, time trial…) can be assembled from it now and changed later
without new code paths. OBS overlays are out of scope (owner, 2026-11-19).

## What exists today (checked in the code, 2026-11-19)

| Piece | State |
|---|---|
| Cards | `Pane` in `xpeed-sim/src/panel/layout.rs`: `Times`, `Centre`, `Fuel`, `Tyres`, `Laps`, `Track`, `Alerts`. A closed enum. |
| Dashboards | One. Fixed rows per window shape (`Layout::{Classic, Ultrawide, Wide, Square, Portrait, Stack}`, `WIDE_ROWS`, …), all `&'static`. |
| "A card the game cannot fill is not there" | Driven by `Caps` (`xpeed-sim/src/game.rs`, one bit per field group, `Source::caps`), read in `layout.rs` (`caps.has(Caps::RPM)`, …). |
| Model and painting | Already split: `panel/model.rs` (`DashModel`, `TyresModel`, `LapsModel`…, plain data, `Clone + PartialEq`, **not serializable**) and the GDI painters (`dash_view.rs`, `paint.rs`). `serde_json` is a dependency, `serde` derive is not. |
| Session kind | `SessionKind::{Practice, Qualifying, Race, Unknown}` (`xpeed-sim/src/lapfile.rs:75`), on `Frame::session_kind`. **There is no time trial / hotlap kind.** |
| Player data on `Frame` | Timing, car inputs, fuel and capacity, four tyres, sectors, weather, temperatures, compound, G, aids, damage, and `flag: Option<Flag>` (`Green, Yellow, Blue, White, Black, Chequered`). |
| Missing from `Frame` | Race position (overall and in class), session time or laps remaining, total laps. |
| Rivals | **None are read.** The readers touch rival arrays (iRacing `CarIdx`, AMS2 `mParticipantInfo`, F1 Participants/LapData, LMU scoring) only to find the player's own car. |
| Delta | To the best lap of the current run only (`dash.rs`). The device cannot fetch other laps: `GET /api/sim/laps/<id>/file` is for the signed-in person, not the device key. |
| Coach | The Session Coach: after the session, a chat over an uploaded session (`src/coach.rs`). Nothing live. |
| Phone | The `Portrait` and `Stack` layouts exist, but only inside the Windows window. No network listener. The Xpeed web app is also a Capacitor app (`capacitor.config.ts`, `android/`). |
| Live validation | The iRacing reader has **never run with the game open** (`src/games/iracing.rs`, top). Several others are still unconfirmed. |

## Invariants every phase keeps

1. **A widget the game cannot fill is not shown, and the others take its room.** A dashboard is a wish list, not a promise.
2. **One near-square corner** (`R_CORNER`, test `one_near_square_corner`), the square-block bars, and the real Xpeed mark.
3. **Every widget is drawn in the CI design preview** (`writes_the_design_preview_page`) and shown to the owner in the side pane
   for approval before it counts as done.
4. **No widget counts as working for a game until a live `.xcap` capture confirms it** (`capture` / `replay`, `fixtures/`).
5. English first in the UI, Portuguese and Spanish through `src/text.rs`.

## The catalog

Each widget gets a stable id (written in config files and later sent to the phone, so it never changes), a name, the `Caps` it
needs, its sizes, and the dashboards that use it by default. "Bucket" says where its data comes from:
**A** = today's `Frame`; **B** = new player-only fields; **C** = a new rivals layer in the readers.

| Id | Widget | Bucket | Needs | Default in |
|---|---|---|---|---|
| `times` | Lap time, delta, last, best (exists) | A | `LAP_TIME`, `LAST_LAP` | all |
| `centre` | Gear, speed, revs, pedals, wheel (exists) | A | `SPEED`, `RPM`, `GEAR`… | all |
| `fuel` | Fuel, water and oil (exists) | A | `FUEL` | race, practice |
| `tyres` | Four tyres from above (exists) | A | tyre caps | all |
| `laps` | Laps table (exists) | A | `LAST_LAP` | practice, time trial |
| `track` | Live track map (exists) | A | `POSITION` or `DIST` | all |
| `alerts` | Lit alerts, electronics, damage (exists) | A | car-state caps | race, practice |
| `flag` | **Digiflag**: the flag as a full colour block | A (+C for blue-flag reason) | flag cap | race, qualifying |
| `fuel_calc` | **Fuel calculator**: per lap (average and last), laps left in the tank; fuel to the end once B lands | A, then B | `FUEL`, laps | race |
| `tyre_trend` | **Tyre strategy**: wear per lap, laps left on this set, temperature window | A | tyre wear caps | race, practice |
| `sectors` | Sector times vs best, theoretical best | A | sectors | qualifying, time trial |
| `delta_bar` | Big delta bar to a chosen reference | A | `DIST` | qualifying, time trial |
| `session` | Position, class position, time or laps left | B | new caps | race, qualifying |
| `delta_ref` | Delta to the personal best (all sessions) or the **fastest Xpeed lap on this board** | A + server | new route | time trial, qualifying |
| `relative` | **Relative**: cars just ahead and behind on track, with gaps | C | rivals | race |
| `standings` | **Standings by class** | C | rivals | race, qualifying |
| `gaps` | Gap to the car ahead and behind, trend over laps | C | rivals | race |
| `radar` | **Spotter/radar**: cars alongside | C, per game | rivals with world position, or the game's left/right signal | race |
| `coach_live` | Live coach hints (braking point, corner vs best) | A + coach | best-lap trace | practice, time trial |

Radar is a capability, not a promise: some games give other cars' world positions, some only a left/right signal (iRacing's
`CarLeftRight`), some neither. The catalog shows `radar` only where the reader can fill it.

Built-in dashboards (data, not code): **Race**, **Qualifying**, **Practice**, **Time trial**. The one shown is picked from
`Frame::session_kind`, can be switched by hand (header button and a key), and the choice is remembered per game.

## The plan, in phases

Each phase ships on its own, keeps the panel working, and goes through the preview + owner approval.

### Phase 1: the catalog and dashboards as data (no new widgets)
1. Replace the closed `Pane` set with a **widget registry**: id, name, `Caps` needed, minimum and preferred size, painter. The seven
   current cards become the first seven entries. The layout must look identical: pinned by the existing preview and panel tests.
2. **Dashboards as data**: a dashboard = an id, a name, and per window shape the rows of widget ids with their shares (what
   `WIDE_ROWS` & co. are today). Four built-ins in code; user copies in `%APPDATA%\Xpeed Companion\dashboards.json` later.
3. Pick by session kind, switch by hand, remember per game. Add `SessionKind::TimeTrial` where a game reports it (hotlap modes),
   written to the lap file only if the format allows it (check `FORMATO-DE-VOLTA.md`; otherwise panel-only).
4. Make each widget's model **serializable** (`serde` derive on the model types), with a JSON snapshot test per widget. This
   is the contract the phone view will read (phase 6).

### Phase 2: widgets from today's data (bucket A)
`flag`, `fuel_calc` (without "to the end"), `tyre_trend`, `sectors`, `delta_bar`. Pure functions in `dash.rs` with unit tests, fed by
recorded fixtures. Each one goes into the dashboards of the table above.

### Phase 3: player session data (bucket B)
Add position, class position, session time and laps left to `Frame`, with new `Caps` bits, **in every reader that has them** (see
the per-game table). Then the `session` widget and "fuel to the end" in `fuel_calc`.

### Phase 4: the rivals layer (bucket C)
1. A new `Field` snapshot next to `Frame`: per car its index, name, class, position, class position, lap, lap-distance share,
   last and best lap, in pits, gaps when the game gives them, and world position where given. Read at a lower rate than the
   player's car (a few Hz). Class position and missing gaps are **computed in one shared place**, never per reader.
2. **Every reader that has rivals**, in the order of how much the game gives (least work per widget first): RaceRoom,
   rFactor 1 family (SCE, AMS1, rF1), LMU, AMS2 / PCARS2 / PCARS3, F1 23–25, iRacing, AC EVO, ACC, Wreckfest 2.
   AC and Forza give no rivals: their rival widgets simply do not appear.
3. Widgets `relative`, `standings`, `gaps`, then `radar` where the game gives positions or a left/right signal.
4. Gate: a live capture with rivals for each game before its widgets are switched on.

## Per-game support (from the readers and their layouts, 2026-11-19)

**R** = in the repo's layouts or docs; **K** = from the game's SDK as known, not yet in the repo. Nothing here is live-tested.

| Game (reader) | Position / time / laps left | Rivals array | Gaps given | Class position | Radar | Flags |
|---|---|---|---|---|---|---|
| RaceRoom (`r3e.rs`) | R, all | R, 128 cars, the richest | R, ahead/behind | R, given | xyz (R) | R, rich, sector yellows |
| SCE / AMS1 / rF1 (`rfactor1.rs`) | R | R, 64 cars, about 2 Hz | R, next/leader | computed | xyz + lateral (R) | R, global + sector yellow |
| LMU (`lmu/`) | R/K | R, 104 cars, about 5 Hz | K | computed | xyz (K) | R, blue / yellow (more in struct) |
| AMS2 / PCARS2 / PCARS3 (`ams2.rs`) | R | R, 64 cars | computed | computed | xyz (R) | R, per car |
| F1 23–25 (`f1.rs`) | R | R, 22 cars (UDP) | R, ahead/leader | single class | xyz (R) | R, per car + marshal zones (K) |
| iRacing (`iracing.rs`) | K | K, 64 cars (`CarIdx*`) | computed | K, given | **native left/right only** (no xyz) | K, rich |
| AC EVO (`acevo.rs`) | R | xyz + ids only | R, the player's | ✗ | xyz (R) | R, rich |
| ACC (`kunos.rs`) | K | xyz + ids only (names and standings need its Broadcasting API, K) | ✗ (API) | ✗ (API) | xyz (R) | R/K |
| Wreckfest 2 (`wreckfest2.rs`) | R | R, separate packets | R, ahead/behind | ✗ | xyz (K) | R, player |
| Assetto Corsa (`kunos.rs`) | K | ✗ | ✗ | ✗ | ✗ | R, player |
| Forza (`forza.rs`) | position only (R) | ✗ | ✗ | ✗ | ✗ | ✗ |

Radar needs a per-game axis and heading rule (axes differ; ACC and AC EVO give no heading, so it comes from motion), and
LMU and rF1 scoring are too slow for a smooth radar on their own.

### Phase 5: references from the server
A device-key route that returns a reference lap (the personal best, or the fastest lap on this board within the leaderboard's
rules) as a distance-indexed trace, cached on disk. Widgets `delta_ref` and, later, `coach_live`. Privacy: another driver's
trace only where the boards already make their laps public (`api/sim/_social.ts`).

### Phase 6: the phone view (PWA), in parallel from phase 1 on
- **6.0 Spike + owner decision (start now, no dependency).** Browser rules decide the design:
  a PWA served over HTTPS cannot open plain `ws://` to a LAN address (mixed content), and a page served by the Companion over plain
  HTTP is not a secure context, so it cannot install as a PWA. The options:
  1. **Peer-to-peer (WebRTC data channel)** with signalling through the Xpeed server. Both ends are already signed in to the
     same account, so no QR code is needed; the data stays on the local network; works from the HTTPS PWA. *Recommended.*
  2. **Cloud relay** through the Xpeed server. Simplest, but adds internet latency (fine for a dash, not for a radar) and server load.
  3. **The existing Capacitor app**, which can talk to the LAN directly. Not a PWA, but already installed on phones.
- **6.1** The Companion side: off by default, every connection authenticated, a visible "phone connected" state in the panel; on
  the LAN, expect the Windows firewall prompt. Streams the phase 1 JSON models at 10–20 Hz.
- **6.2** The web side: a dashboard route in the Xpeed PWA that renders the same widget ids from the same models, using the same
  row definitions as `Portrait` / `Stack` so the two renderers do not drift. Phone picks its dashboard independently of the PC.
- **6.3** Later: digiflag alone on a phone or tablet as a full-screen flag.

## Owner decisions needed

1. **The built-in dashboards**: Race, Qualifying, Practice, Time trial. Anything to add or drop?
2. **Phone transport** (6.0): peer-to-peer, cloud relay, or the Capacitor app.
3. ~~Which games get rivals first~~: decided, every game that has them (owner, 2026-11-19).
4. **Where dashboards are edited**: on the Xpeed website (synced to the Companion) or inside the Companion. Proposed: the website,
   after phase 4; until then only the built-ins plus hand switching.
5. **Delta to the fastest**: the fastest Xpeed lap on the board (needs phase 5), or only personal bests.
6. **Live tests**: for each game, the owner drives once with `xpeed-companion capture <game>` before its phase 3–4 widgets are
   switched on (iRacing has never been run with the game open).

## Not in scope

OBS overlays (owner, 2026-11-19). Paid voice or AI for a live coach.
