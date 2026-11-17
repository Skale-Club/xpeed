# Native track geometry for every supported simulator

Canonical next-task record: https://app.notion.com/p/41bb7a686121817fb7dfdd4f71792d15

## Status and handoff

2026-11-17 desktop candidate: **PARTIAL — the full all-simulator plan is not complete.** Companion **0.11.0 is unreleased**, on `codex/native-tracks-completion`; this document records local implementation and evidence, not a production release or green release CI. The original required scope and acceptance criteria below remain in force.

The [source matrix](native-track-source-matrix.md) classifies all **22 capture IDs**: nine installed titles and thirteen not detected in the accessible metadata sources. One unavailable Steam library (D) remains explicit; not detected does not mean unsupported. Source access was investigated beyond container extensions. AC/SCE have automatic source extraction, EVO Laguna Seca GP has automatic private asphalt-cache generation from native KSP assets, and LMU Laguna/F1 2025 Brazil have separate pinned offline exports. Other families retain concrete source/access/schema/frame blockers.

EVO's same source-classified asphalt geometry now reaches the native perspective and the website's memory-only local XTRK selector, with strict title/layout identity and a coarse alignment rejection gate. This is separate from proving current live-reader/game behavior: the live EVO UI acceptance remains open while the showroom/menu state is resolved with the owner. Historical lap fixtures were not rewritten. AC/SCE recorded-lap acceptance is still missing; LMU/F1 reader frames and F1 annual/season identity remain unverified.

Original handoff: the owner deferred this work on 2026-11-16 while switching computers, then resumed it on the desktop with EVO as the pilot. The earlier Surface-only inventory is retained as historical evidence; it no longer describes the available desktop source investigation. Keep Surface work light under the machine rules.

## Goal
Show the actual road geometry used by each game, aligned with recorded car positions, so drivers can inspect and compare racing lines accurately. Keep a heading-up perspective in the live Windows Companion and a top-down zoomable view on the website.

## Current baseline

The unreleased 0.11.0 candidate extends the published 0.10.0 pilot; no publication is claimed here. Native layout code now includes:

- **AC:** qualified native basis produces XTRK v2 explicit cross-sections; mod files without that basis retain a labelled legacy v1 tangent fallback. Installed corpus: 534 files including ten backups, 495 accepted and 39 refused.
- **Stock Car Extreme:** XTRK v2 uses full stored perpendiculars, banked midpoint Y and explicit gaps; all 70 installed AIWs accepted. The combined corpus run took 163.56 seconds. SHA source-generation receipts and logical/resolved path identity invalidate changed assets and junction retargets; old public stored maps cannot validate the current installation.
- **EVO Laguna Seca GP:** bounded KSP reader, build/hash/scene pins and automatic private **asphalt** cache, 2,135 road rows and 552 pit samples. Ten ASPH actors supply 27,916 asphalt triangles; 78 classified assets total 90,646 triangles with kerbs/other paved classes separate. The 33 references on kerbs remain offset from asphalt (maximum 0.416507 m), not patched into it. See [mesh and runtime evidence](acevo-mesh-evidence.md).
- **LMU Laguna Seca:** distinct, exact-source-hash offline `lmu-aiw` adapter, 718 road/258 linked pit points, no invented ideal line or frame claim. See [LMU evidence](lmu-native-evidence.md).
- **F1 2025 Brazil:** distinct, exact-source-hash offline `f125-spline` adapter, 287 road/106 pit points and source-labelled white lines with signed offsets; annual/layout/frame association is unverified. See [ERP/BXML and export evidence](unreal-f1-native-evidence.md).

The approved native moving perspective, fixed upward marker and bottom fade are retained. Website analysis is top-down with zoom/pan/comparison; its local selector accepts geometry into memory without uploading game assets or importing lap files. Reference comparisons reject incompatible game/variant identities; automatic PB selection also rejects another car, while an explicit other-car comparison remains allowed. Context conditions are retained, new EVO recordings stamp `recorder.coordinateFrame`, and unknown/mismatched coordinate or build information is warned about. No historical recording migration or coordinate rewrite occurred.

## Acceptance state of this candidate

| Gate from the full plan | Current result | Remaining acceptance |
| --- | --- | --- |
| All supported games classified | **Complete inventory/classification**, 22 IDs; nine installed, thirteen not detected; D inaccessible | Source implementations remain title-specific; absence is not incompatibility. |
| Real native source/export | **Implemented and measured** for AC/SCE, pinned EVO Laguna, offline LMU Laguna and F1 Brazil | Recorded-lap frame tests missing for AC/SCE/LMU/F1; additional tracks/builds are not implied. |
| Road/limit semantics and topology | **Partial**: native cross-sections, graph/pit checks, signed offsets and gaps; EVO asphalt classes proven | Physical white-line centre/edge meaning, timing triggers, alternate-layout coverage and separate edge Y/banking remain open. No finish certification. |
| Native and web use of the same geometry | **Partial**: EVO asphalt private cache/native `Asphalt` road, memory-only XTRK chooser with identity/alignment gates; actual Rust asphalt (2,135), LMU (718) and F1 (287) exports passed the strict TS reader, each with one closed road run | Current live EVO UI/game acceptance and actual recorded-lap overlays remain separately tracked. Coarse alignment is not a survey. |
| Cross-session reference context | **Implemented automatic-PB guards** and new EVO recording frame metadata; explicit other-car comparisons remain allowed | Unknown historical context remains labelled; field capture/live acceptance is still needed. |
| Performance and long sessions | **Partial offline evidence**: three asphalt replay PNGs passed (1.34 s); real asphalt-cache check passed (3.46 s); 120,000-query repeat took 28.7131 s, 0.239 ms/query, maximum 193 strips/386 edges; isolated query-test peak working set 11.95 MiB | This is a 20-minute-equivalent query count, not a real-time drive or painting benchmark. RSS covers only the query-test process, not the whole Companion, game or mesh decode. Representative live CPU/memory and sustained rendering remain open. |
| Tests and release | **Local checks**: tracks 90 passed/eight ignored; final full native run 864 passed/fourteen ignored (878 total, 3.22 s), Clippy all targets passed; typecheck/lint passed with sixteen baseline warnings | Release CI and a final all-web green run are not claimed. Broad web run was 2,079 pass/one obsolete no-file-input assertion; the narrowed XTRK exception passes, and seven affected web test files pass 172 tests (9.52 s). Candidate is unreleased. |

## Required scope
1. Inventory every supported game and version directly from the reader registry and CLI. Current families include LMU; AC, ACC, EVO and Rally; AMS2/Project CARS 2/3; F1 23–25; Wreckfest 2; rFactor 1 family; RaceRoom; Forza; iRacing. Identify installed titles and variants on the desktop. Current CLI/reader identifiers: lmu, ac, acc, acr, ams2, pcars2, pcars3, wreckfest2, f1, f124, f123, acevo, rfactor1, ams1, rf1, iracing, r3e, fm, fm7, fh4, fh5, fh6. These identify 22 titles; shared reader families do not make their geometry interchangeable. `rfactor1` denotes Stock Car Extreme; `ams1` and `rf1` identify separate games. `sce` is the geometry dump identifier.
2. Build a source matrix per game: official API/SDK if available, game-owned track/layout/spline/mesh files, extraction feasibility, exact fields, coordinate frame, height, coverage, provenance, file version/hash, and remaining uncertainty. Explicitly mark unsupported sources; do not invent road width or label a driven trajectory as the road.
3. Prove one end-to-end extraction, using Laguna Seca EVO and an actual recorded lap as an initial case where available. Expand independently per game; another game's version of the same circuit is not the same geometry.
4. Read game assets without modifying the installed game. Extract only needed files, preserve original files, and convert the minimum geometry into Xpeed's existing track format/cache. Record local use and distribution constraints before choosing whether data stays local or can be uploaded/shared.
5. Preserve center/reference paths, actual left/right boundaries, variable widths, elevation where available, finish direction, pit lane and alternate layouts. Distinguish asphalt, kerbs, runoff and walls. Model gaps explicitly; never silently patch unknown sections.
6. Use stable game + track + variant + source-version identity. Verify units, axes, handedness and transforms against actual telemetry for each reader; do not change recorded source coordinates to fit a drawing. Invalidate stale caches after relevant game updates.
7. Connect the same validated geometry to the native live panel and website analysis. Preserve smooth camera motion, the larger fixed upward marker and bottom fade. Website needs zoom/pan and detailed lap/line comparison.
8. Support meaningful cross-session comparisons (practice/time trial/qualifying), with car/layout/version and session conditions retained. Reference choice depends on the objective; race must not automatically choose an unrelated all-time qualifying best.

## Prototype evidence and limitations
The reviewed portable prototype is in docs/prototypes/companion-live-preview.html, with its original fragment, source note and local validator alongside it. It uses historical recorded EVO telemetry (historical x normalized), an OSM centerline and CC0 GT7 border surveys. Missing survey spans were interpolated and shown with dashed borders. It demonstrates appearance only: it is not an official EVO map, is not meter-accurate analysis and has not been integrated as native EVO geometry.
The owner accepted the direction but explicitly noticed road patches. The production acceptance target is to replace approximation with a complete, validated game-specific source and fix rendering seams; do not just smooth the driver's trace.

## Initial research leads
- [ACEvo.Package](https://github.com/Nenkai/ACEvo.Package): list and selectively extract content.kspkg files.
- [AC EVO Data Tools](https://github.com/Breakalien/ac-evo-data-tools): game protobuf schemas and track file families, including aisplinedata, extended_splinedata.bin and track_layout.
- [GT7 survey used only in the prototype](https://github.com/jbhoorasingh/gt7-datalogger-track-data).
The historical released pilot proved the sampled AI envelope. The current unreleased candidate additionally reads scene-classified asphalt and preserves separate kerb/other-surface evidence; authored limit splines and timing zones corroborate parts of the source contract without certifying painted white lines or the engine firing edge. Inspect each installation/build before expanding support.

## Starting points in the repository
xpeed-sim/src/tracks/{auto,dump,ac,aiw,acevo,acevo_surface,local,fresh,lmu_aiw,f125_spline,mod}.rs; maps.rs; perspective.rs; panel/perspective_paint.rs; dash.rs; game reader modules and source metadata. Website: src/lib/sim/ and src/components/sim/. Read the current Journal and repository instructions first.

## Acceptance criteria
- Every supported game has an evidence-backed source/support classification and a concrete next action if blocked.
- Each implemented game has real-file fixtures or sanitized permitted samples and a recorded-lap alignment check.
- Geometry closes correctly, handles finish wrap, alternate layouts/pits, variable width, height/bridges, missing data and updates without false joins.
- No mirrored maps, invented widths, visually patched asphalt or unexplained displacement. Accuracy thresholds are defined and measured against game data.
- Playback, live motion and website zoom show the car/trajectories in the correct position relative to road boundaries.
- CPU/memory and long-session behavior are checked on representative machines; unsupported geometry has an honest fallback.
- Targeted tests, native rendering, live-game checks on the desktop, and release CI pass before publishing.

## Next concrete actions

1. Complete the owner-assisted live EVO menu/showroom transition and observe the native road with current raw-reader telemetry. Record the actual UI outcome; replay screenshots do not close this gate.
2. Capture AC and SCE recorded laps for source-frame acceptance; capture LMU Laguna and F1 Brazil laps to establish their raw frame and timing contract, retaining F1 annual/season/layout identity. Keep the offline exports separate until these checks pass.
3. Continue the documented source blockers: ACC permitted readable index/export; Rally cooked stage/road schema and position telemetry; AMS2 stock BFF table decode; Wreckfest 2 structural v4 route/trailer/topology. Obtain installations for the thirteen not-detected IDs before making title-specific support claims. See [matrix](native-track-source-matrix.md), [Unreal/F1 sources](unreal-f1-native-evidence.md) and [AMS2/Wreckfest sources](ams2-wreckfest-native-evidence.md).
4. Complete the final all-web rerun, live acceptance and requested release CI after the candidate is frozen; the full native suite and Clippy already pass locally. Publication remains a separate authorized release step; this document does not declare every game finished.
