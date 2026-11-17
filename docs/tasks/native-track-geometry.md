# Native track geometry for every supported simulator

Canonical next-task record: https://app.notion.com/p/41bb7a686121817fb7dfdd4f71792d15

## Status and handoff
2026-11-16 update: the owner selected EVO as the pilot. An offline, hash-pinned Laguna Seca extraction and XTRK v2 sampled-boundary support are implemented for Companion 0.10.0. See [pilot evidence and limitations](acevo-native-track-pilot.md) and the Journal for operational release evidence. This establishes native AI-side geometry and historical-lap alignment; exact asphalt/white-line semantics, live-game acceptance and automatic discovery remain pending. Other game families are still queued.

Original handoff: the owner deferred this work on 2026-11-16 while switching computers, then resumed it on the desktop with EVO as the pilot. Do not start extraction or heavy builds on VANILDO-TABLET. The wider backlog still covers every simulator supported by Xpeed.

## Goal
Show the actual road geometry used by each game, aligned with recorded car positions, so drivers can inspect and compare racing lines accurately. Keep a heading-up perspective in the live Windows Companion and a top-down zoomable view on the website.

## Current baseline
Companion 0.9.0 is published with the approved dashboard redesign, a 32-degree moving perspective, a fixed upward marker, bottom fade, recorded trajectory and a session-best reference restricted to known practice/qualifying contexts. Website top-down analysis was restored. Source baseline is main/dev 6d37a55; the session closeout adds only handoff documentation and a portable prototype.
Native road layout extraction currently supports the AC and rFactor 1/Stock Car Extreme file families. Reading telemetry from a game does not mean its road geometry is supported.

## Required scope
1. Inventory every supported game and version directly from the reader registry and CLI. Current families include LMU; AC, ACC, EVO and Rally; AMS2/Project CARS 2/3; F1 23–25; Wreckfest 2; rFactor 1 family; RaceRoom; Forza; iRacing. Identify installed titles and variants on the desktop. Current CLI/reader identifiers: lmu, ac, acc, acr, ams2, pcars2, pcars3, wreckfest2, f1, f124, f123, acevo, rfactor1, ams1, rf1, iracing, r3e, fm, fm7, fh4, fh5, fh6. Treat aliases as identifiers, not additional distinct titles; verify their family mapping.
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
Package extraction is demonstrated by third-party projects; complete EVO road-boundary decoding is not yet proven in Xpeed. Inspect the actual desktop installation before promising exact geometry.

## Starting points in the repository
xpeed-sim/src/tracks/{auto,dump,ac,aiw,mod}.rs; maps.rs; perspective.rs; panel/perspective_paint.rs; dash.rs; game reader modules and source metadata. Website: src/lib/sim/ and src/components/sim/. Read the current Journal and repository instructions first.

## Acceptance criteria
- Every supported game has an evidence-backed source/support classification and a concrete next action if blocked.
- Each implemented game has real-file fixtures or sanitized permitted samples and a recorded-lap alignment check.
- Geometry closes correctly, handles finish wrap, alternate layouts/pits, variable width, height/bridges, missing data and updates without false joins.
- No mirrored maps, invented widths, visually patched asphalt or unexplained displacement. Accuracy thresholds are defined and measured against game data.
- Playback, live motion and website zoom show the car/trajectories in the correct position relative to road boundaries.
- CPU/memory and long-session behavior are checked on representative machines; unsupported geometry has an honest fallback.
- Targeted tests, native rendering, live-game checks on the desktop, and release CI pass before publishing.

## First action on the desktop
Pull dev, read this task and the linked Journal, run machine-check, inventory installed games/track assets, then produce the per-game source matrix and a real Laguna Seca extraction proof. Do not begin with another approximate mockup.
