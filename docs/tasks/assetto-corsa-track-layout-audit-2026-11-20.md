# Assetto Corsa track-layout failure investigation

Date: 2026-11-20. Scope: original Assetto Corsa first, following the owner's clarification. This is an investigation, not a runtime patch or release.

## Requested behavior and conclusion

The owner reports an empty track card on entering a session, a malformed map that grows while driving, and right turns drawn as left turns. The requested behavior is a layout read from the game, available without driving a reconnaissance lap. A learned driving trace must not silently replace it.

Two independent, confirmed runtime defects explain these symptoms:

1. The engine supplies the display name `Assetto Corsa` where the orientation selector expects the canonical ID `ac`. The existing mirror correction is bypassed in actual gameplay.
2. Native geometry extraction runs asynchronously, but the tracker only checks at identity change and a completed lap. Extraction completion wakes the uploader, not the tracker. During that gap, a partial driven trajectory is deliberately presented as the map.

There is also a source-coverage limit: the current AC adapter reads AI routes, not the KN5 road mesh or a branching road network. Some installed layouts have no AI route. Fixing the first two defects cannot supply those missing sources.

## Evidence boundary

- Inspected the active shared checkout on `feat/dashboard-preview`; existing unrelated work was preserved. Files relevant to the two primary defects had no working-tree diff during inspection.
- The running process was the local release executable under `.cargo-target/xpeed-sim/release`, started at 08:40 local. The log identifies it as `0.15.0 (245764c-dirty)`. Today's three AC lap headers independently carry that recorder build. This differs from the published 0.14.0 described in part of the Journal.
- Independently checked release commit `00c7bb4`: both the display-name call and ID-only mirror selector are present there too. This is not established only on an unreleased branch.
- Read local logs, seven exported AC layouts/receipts, three real AC recordings, and selected installed-source metadata. No game files were written, no proprietary files were added to the repository, no account/production records were changed, and no game was driven for this investigation.
- Exact source statements below are current code evidence; local data measurements establish those specific examples, not every mod or simulator.

## 1. Critical: right and left are reversed by an identifier mismatch

The complete chain is:

```text
KunosSource.game_id()   -> "ac"
KunosSource.game_name() -> "Assetto Corsa"
engine.handle_frame()  -> tracker.on_frame(source.game_name(), ...)
Tracker                -> Live.game = supplied string
track_card()           -> mirrored_ground(Live.game)
mirrored_ground()      -> matches only "iracing" | "ac"
actual runtime         -> mirrored = false
```

References: `xpeed-sim/src/games/kunos.rs:263,541`; `engine.rs:305`; `dash.rs:736`; `panel/dash_view.rs:825`; `perspective.rs:323–355`. The world-position radar calls the same selector with `live.game` in `panel/widgets.rs:1121`, exposing the same contract error where world-position radar is available.

The previous correction, commit `526f1f0`, introduced AC mirroring, but its test calls the selector with the literal `ac`. That proves the camera works when given an ID; it never proves the engine supplies that ID.

Independent executable reproduction compiled the current, unmodified `perspective.rs` as a Rust module, with only minimal track-structure stubs. It used the production `Camera::segment` method, not a rewritten projection:

| Input | Mirror | Screen X of physical right-hand point | Center X |
| --- | --- | --- | --- |
| Actual display name `Assetto Corsa` | false | 325.714 | 368.000 |
| Canonical control `ac` | true | 410.286 | 368.000 |

The camera is at `(0,0)`, moving toward `+Z`; the test point is `(-10,+50)` in AC's ground convention. The first result is left of the marker, the control is right. Today's recordings additionally show strong agreement between steering sign and signed X/Z turning (95.7–98.3% across selected moving-turn samples); these samples support the source/camera distinction without relabelling historical data.

Required correction: carry a canonical game ID separately from the display name through `Source → engine → Live → renderer`. Do not blindly replace every use of `Live.game`: saved dashboard selection, labels and relay also consume it. Keep recorded coordinates unchanged. A regression test must enter through a real source/engine contract and cover left and right turns.

## 2. High: extraction completion is invisible until a lap closes

The worker is created in `engine.rs:342–360`. The first driving frame sends `Seen { game, track, variant }` at `engine.rs:668–679`, then calls `handle_frame`. The tracker immediately tries `Store::start` on key change (`dash.rs:541–559`). A new layout or a receipt being regenerated may not exist yet.

The worker's ready callback only calls `shared.wake_uploader()`. The only subsequent call to `look_for_layout()` is inside `lap_closed()` (`dash.rs:876–889,1008–1018`). There is no ready event or bounded refresh for the active tracker. A short stint, a restart before the line, or free roam may never trigger that retry.

The local log corroborates the timing opportunity: Laguna's layout was first written at 14:20:33 UTC; the game then closed at 14:23:21 without a saved lap. Raul Boesel's payload already existed, but its receipt was updated at 14:13:42 UTC; the first saved lap followed at 14:16:59. These times do not measure the screen, but are consistent with the confirmed loading race.

Receipts require `extractorVersion == CARGO_PKG_VERSION` (`tracks/fresh.rs:80–93`). Every application version change therefore invalidates receipts, even when its geometry algorithm is unchanged. That can reintroduce the cold-start window after unrelated dashboard updates.

Required correction: request geometry as soon as a trustworthy track/variant identity exists, and notify the active tracker when the exact keyed geometry is ready. Load/validate away from the high-frequency reader loop, discard obsolete results after switching layouts, and distinguish loading, unavailable source, invalid source and ready states. Do not solve this with per-frame file hashing or blocking the telemetry reader.

## 3. High: a driven trajectory is deliberately used as the track

`dash.rs:618–634` adds current car coordinates approximately every 4 m and exposes `partial_map` after 30 points. `Live.map` selects `self.map.or(partial_map)` at `dash.rs:790`. This naturally starts empty, appears after roughly 116 m of evenly sampled movement, and grows only where the car has already driven.

It cannot describe the next unknown bend, road width, pit branch or unvisited road. There is no native road object for that fallback. A complete recorded trajectory can later be persisted as the map (`dash.rs:886–887,1000–1004`; `maps.rs:33–34`). This is existing behavior, not evidence that native extraction succeeded.

The perspective only has a useful future window when it has future geometry. With a growing trace, the vehicle is at its endpoint. That inherently cannot resemble the expected preloaded road ahead. Teleport gaps above 40 m are split by `PreparedPath`; this study does not claim every teleport is joined into a false chord.

Required correction: for the requested AC track card, do not promote a driven line into the layout. Keep telemetry as a separate optional overlay on validated source geometry. Missing geometry must produce an honest source/loading state, not a growing imitation of the track. Preserve the approved perspective styling and marker.

Even a ready native map currently requires motion to acquire a heading: `MotionHeading` derives it from at least 1 m of displacement (`perspective.rs:69–72`). This is a separate orientation-readiness state, not a reason to pretend the layout is missing. An immediate stationary perspective would require independently validated native heading or an agreed initial framing.

## 4. High source limitation: AI corridors are not the complete road network

`tracks/ac.rs` reads `fast_lane.ai` and optional `pit_lane.ai`. It uses native cross-section bases when sufficiently valid; otherwise it projects widths using path tangents. The result represents the authored AI corridor. Neither path proves asphalt edges, kerbs, barriers, junctions or the whole free-roam map.

All seven actual local exports parsed. Three have sampled v2 boundaries (Laguna Seca, Autocross Consuegra, Mirandopolis); four use v1 width projections (Raul Boesel, Forest Rally Stage 2, Curvelo, K1 northtrack). Raw corridor widths are uneven: Raul has median 13.50 m and maximum 79.25 m; Curvelo 12.35 m and 57.25 m; K1 9.70 m and 48.70 m. These maxima are not measured asphalt widths. They identify source sections requiring semantic/visual inspection before treating them as road. Arbitrary clamping or smoothing would hide the uncertainty.

The concrete failed layout in the log is `union_island/freeroam`. Its installed `ai` directory is empty. The current adapter refuses it because the required source is absent. Other Union Island variants have different AI routes and cannot substitute for freeroam.

A shallow installed-source census found 548 UI-bearing layout entries, 22 without the expected direct `fast_lane.ai`, including Union Island and Shutoko variants. The other 526 file hits are candidates, not parser or live-acceptance results.

Union Island does contain a pre-drawn `freeroam/map.png`, `data/map.ini`, model INIs and KN5 road/collision assets. Those provide further source options, not an implemented 3D layout reader. A calibrated image could support a separately verified top-down map; it does not deliver a heading-up road mesh. Full branching-road support needs a truthful mesh/network representation and per-source validation. Do not use a different route, another game or guessed widths as a shortcut.

## 5. Additional defects and limits

| Priority | Finding | Evidence / effect |
| --- | --- | --- |
| High | Failed extraction is never retried for that identity during the worker lifetime | `tracks/auto.rs:245–287` inserts the key into `tried` before success; engine sends on identity transition only. Temporary source unavailability becomes sticky. |
| Medium | Source dependency receipts omit validation metadata | `auto.rs:190` attests only fast/pit AI, while `ac.rs:480–552` also consults UI length/title and `map.ini`. Metadata-only changes do not invalidate that receipt. |
| Medium | Cached topology is conflated with completeness | `dash.rs:791` sets complete for every persisted map; `PreparedPath` may close an open source with endpoints within 40 m. Forest's actual endpoints are about 2.9 km apart, so that example is protected; the defect is latent for nearby open endpoints. |
| High, website | AC layout variant is dropped during lap ingestion | `api/sim/laps.ts:118` sends track name but not `header.track.variant`; current ingest resolves that base name. `sim_layout_id` in `20261120120000_sim_catalog_titles.sql:43–57` may choose the newest layout regardless of variant. GP/Indy can share a catalog track and select the wrong geometry. Its alias join also uses game/display name instead of catalog UUID, allowing same-title mods to borrow another track's map. These defects are separate from the Companion mirror bug. |
| Medium, website | Transient errors become sticky absence | `garage-queries.ts:95–110` catches download/read errors as `null`, caches success indefinitely and disables retry. `use-track-layouts.ts:17–21` also syncs only once per hook and suppresses failure. A failed request can continue looking like no map. |

The broad native-source matrix still classifies other simulators as partial/experimental. It should not be read as a promise that every telemetry reader has a native geometry reader. This study deliberately finishes AC diagnosis first.

## Independent real-lap checks

No mirroring, scaling or translation was applied. Nearest authored AI-point distances use every finite recorded X/Z sample; they are driving-line offsets, not road reconstruction error:

| Recording | Samples | Median / p95 distance to AI line |
| --- | --- | --- |
| Raul Boesel, lap 1 | 10,745 | 1.91 / 4.46 m |
| Raul Boesel, lap 2 | 10,466 | 1.66 / 4.26 m |
| Laguna Seca, lap 1 | 10,436 | 1.25 / 4.97 m |

The overlays align in the source world. These examples argue against rewriting the lap positions to cure the screen inversion. They do not prove every source border is physically correct.

Local-only evidence is in `.codex-local/track-audit-20261120/`: `measure.py`, `measurements.json`, `ac-real-overlays.png`, `mirror_probe.rs`, and `layout-identity-probe.mjs`. Generated geometry/media remain ignored; the report commits no proprietary fixtures.

## Verification performed

- Compiled and executed the independent camera reproduction against the unmodified production module: reproduced wrong-side display for the runtime name and correct-side projection for canonical ID.
- Executed six focused web test files (`track-file`, `track-layout-match`, `local-track`, `account-tracks`, `TrackMap`, `LapAnalysis`): **89 passed**, 23.52 s.
- Ran the nine perspective tests from an existing local native test binary: **9 passed, 1 ignored**. This was a cached build, not a fresh whole-application build. Its existing AC orientation test passes despite the runtime defect, illustrating the coverage gap.
- Ran `node --test scripts/test-inventory-native-tracks.mjs`: **11 passed**.
- Re-ran a PGlite reproduction importing the actual repository SQL function bodies into an in-memory minimal schema: GP/Indy resolved to the same catalog ID and selected Indy with GP length; two distinct same-title catalog rows both selected the stock Indy layout. All reproduction assertions passed; no production database was accessed.
- Read the actual local export headers, receipts and recording headers, produced independent overlays, and cross-checked the release commit's two mismatching statements.
- No fresh game drive, interactive screen acceptance, production account query, installer rebuild or publication was performed.

## Remediation order and acceptance

1. **Canonical identity and orientation:** add a separate stable game ID, update camera/radar consumers and add integration regressions using real source identity. Both physical left and right turns must land on their corresponding screen sides.
2. **Native geometry lifecycle:** deliver extraction-ready/error state to the current tracker without waiting for a lap. Test an empty cache, a stale receipt, a warm cache, switching tracks during extraction, transient failure and shutdown.
3. **Remove the misleading AC fallback:** no native-source state may become a learned road. Loading/unavailable/direction readiness must be distinct. A clean cold-cache session must obtain its source layout before crossing a finish line or driving the whole circuit.
4. **Source fidelity:** verify AI cross-sections and conspicuous width outliers against installed source and real overlays; preserve missing spans. For AI-less layouts, implement and validate an appropriate game-owned source separately, including open/branch topology. Do not claim a flat image is 3D road geometry.
5. **Website identity and recovery:** preserve variants through ingestion/catalog selection and make transient layout failures recoverable; add GP/Indy and same-title mod collision cases.
6. **Live release acceptance:** drive at least one stock circuit, one installed mod, and one AI-less/open case; check from first entry, with independent left/right observations and the actual installed binary. Record build, source identity and cache state. Synthetic green tests alone are insufficient.

The investigation is complete. Runtime fixes and release acceptance remain outstanding. No approval or implementation completion is implied by these recommendations.
