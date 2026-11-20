# Track layout reliability package — 2026-11-20

Implemented on `codex/track-layout-reliability`, isolated from the owner's other work. This is an unreleased implementation and validation record. It does not certify every simulator or replace the running Companion.

## Corrected behavior

- Native camera selection now uses the canonical game ID rather than its display name. AC and iRacing reach their existing handedness correction. Recorded world coordinates remain unchanged. Regression tests cover actual reader → engine → dashboard propagation and both turn directions.
- Native layout extraction begins when a trusted track identity is available, including garage/loading/paused states. Per-request completion is polled independently of a new telemetry frame or lap closure. Track switches discard stale replies, including A → B → A. Temporary failures retry with bounded delays.
- The panel uses validated native geometry. Driving a lap no longer manufactures the road from the car's trajectory. Missing, loading, invalid and retrying sources have separate states. Motion still establishes the heading-up camera direction after about one metre; a parked first entry can show the waiting-for-direction message.
- AC uses its exact reported layout and SCE requires a unique source identity. Cache receipts include content hashes, requested/canonical paths, missing metadata dependencies and adapter generations. Ordinary Companion version changes no longer retire every receipt. Steam discovery supports registered/custom libraries.
- Duplicate/full-loop AC pit routes are omitted. AC/SCE pit proximity and branch traversal are bounded. Open paths remain open; authored sparse segments are not mistaken for telemetry teleports.
- Large AC lookup-grid tails are skipped by the geometry reader while the receipt streams the complete file hash. This fixes the input-size limitation, without accepting zero progress, invalid source geometry or mismatched UI metadata.

## Cloud and web coherence

The additive migration `20261120160000_sim_track_identity.sql` retains raw source names and explicit variants. New GP and Indy laps get distinct catalog identities, sessions, personal bests and Companion references. Existing unknown-variant history is preserved rather than guessed. Queued legacy retries remain deduplicated against their stored lap headers.

Layout selection is bound to the catalog UUID and exact source/variant, with opaque microsecond revisions for refresh. Account changes cancel downloads and discard stale results. Missing downloads can recover; unavailable local storage does not prevent an in-memory download from being drawn. Header identity and bounded gross coordinate alignment checks withhold mismatched road overlays.

The lap analysis places a larger map before the charts. A distance slider moves both recorded/reference position markers, the chart cursor and speed/throttle/brake readings. Zoom keeps the selected position visible. A driven trace is labelled as a trace when no native layout exists. Geometry errors have a retry action. Signed corner/line comparisons share the game coordinate convention and withhold unsupported frames or identities.

The published site was inspected read-only using owned AC/EVO sessions. AC had geometry but the map appeared below the charts. EVO showed a trace and a misleading promise that driving would supply geometry. The corrected UI was inspected in the isolated local example harness, including a 580 m cursor with both series. Evidence image: `.codex-local/track-validation/web-inspection.jpg`. The local harness uses synthetic example laps; it is not live-game acceptance.

## Verification

Fresh checks on this branch:

| Check | Result |
| --- | --- |
| Native unit suite | 1,159 passed; 16 environment/source-dependent tests ignored; 35.68 s |
| Native source module subset | 100 passed; 10 ignored; 2.17 s |
| Native fmt and Clippy, all targets with warnings denied | Passed |
| Focused web regression suite, 15 files | 250 passed; 140.67 s with one thread worker |
| TypeScript app/API/server | Passed |
| ESLint changed TypeScript/JavaScript | Passed, no warnings |
| Isolated API/database contracts | 53 Sim + 65 v1 + 38 social checks passed; 1,227 social responses scanned for leaks |
| Production web and server build | Passed using existing public build configuration; web 29.23 s |
| Installed AC census | 551 spline files inspected, including 10 backups; 518 accepted (496 closed, 22 open), 33 refused; final warm run 9.74 s |
| Installed SCE census | All 70 AIWs parsed; 21.27 s |
| Pinned private EVO cache | Passed; 2,135 centre points and 552 pit points |
| Actual High Force | All five prefixes read; all refused with `ai_dist_zero`; 1.06 s |
| Exact missing-source recovery | Source tests, including actual Union Island Freeroam, passed |

Earlier broad fork-worker web runs were interrupted after making no observable progress. The final thread-worker suite passed; no coverage claim is based on those interrupted runs. No production migration, deployment, upload, account mutation or paid AI call was performed by this validation.

## Remaining work and limits

The [22-game support register](simulator-track-support-2026-11-20.md) distinguishes working automatic adapters, offline source experiments and missing sources. Telemetry support is not native road support. ACC, Rally, AMS2, Wreckfest, LMU/F1 and other titles still require their documented source/schema/frame gates; they were not silently enabled.

Union Island Freeroam has no AI route. Its traffic route cannot replace it. A separately validated raster overview or selective KN5 road/scene adapter remains necessary. High Force's five installed routes have 66,468 zero-progress points each and a 102.32 km spatial chord total against 50 km UI metadata. The larger reader does not make them trustworthy roads. Accepted AC widths describe the AI corridor; 322 accepted files have source warnings and three have no usable widths. This is not an asphalt certification.

Current-game interactive cold start, left/right, pits, teleport and restart acceptance remains necessary in the built Companion. EVO's current raw-reader alignment remains a pilot check. The native nearest-vertex window is 50 m, so exceptionally sparse source paths need further segment-level projection work. EVO's private geometry stays outside the upload outbox; the website needs an explicitly supplied local layout for that source.

Historical variant regrouping needs a separate verified-header backfill and production approval. The outbox's server-scoped upload ledger still needs an account ownership/reconciliation design before resending existing files. Shared track-object replacement is not transactional with the database row; immutable object versions and safe orphan cleanup remain storage hardening work. The client now rejects identity/alignment mismatches, but that does not make storage replacement atomic.

Before release: integrate with the current development branch and retain the newer title handling; validate development/CI and interactive acceptance, obtain the owner's release authorization, then deploy the additive migration/web and publish a matching Companion. Do not overwrite the owner's unrelated checkout or running executable.

Estimate at implementation start: about 12:00 local, 80 minutes. Core verification finished before that estimate; final commit/journal timing is recorded in the Journal entry.
