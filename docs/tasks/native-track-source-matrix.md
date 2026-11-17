# Native track sources by simulator

Repository audit: 2026-11-16, baseline `9699197` / Companion 0.10.0. Parent: [native track geometry](native-track-geometry.md). This is an implementation queue, not a declaration that every game supplies road geometry.

## Support and evidence

The capture CLI accepts **22 title identifiers**, including LMU's separate reader. Related titles share readers; they are not interchangeable installations or track versions. `sce` is a track-dump format identifier, not a capture identifier. Evidence: `xpeed-sim/src/main.rs`, `xpeed-sim/src/games/mod.rs`, and `xpeed-sim/src/lmu/`.

Only AC and Stock Car Extreme have automatic file discovery today (`tracks/auto.rs::file_game`). The dump CLI additionally accepts `sce`, `rf1`, `rfactor1` for an AIW, and the manually extracted, hash-pinned EVO Laguna Seca pilot. CLI acceptance of an AIW does not prove another title's schema or live alignment.

| Game / capture IDs | Geometry implementation now | Source to inspect next / evidence | Concrete next gate |
| --- | --- | --- | --- |
| Assetto Corsa (`ac`) | `tracks/ac.rs`; automatic `content/tracks` lookup; v1 derived edges | `ai/fast_lane.ai`, optional `pit_lane.ai`, layout UI/map metadata; existing parser reads positions, elevation, distance, two side widths | Select one installed track/layout; record build and file hashes; compare source cross-sections to exported edges and an actual lap. AI widths are not proven white lines. |
| Stock Car Extreme (`rfactor1`) | `tracks/aiw.rs`; automatic `GameData/Locations` lookup; dump format `sce` | AIW `wp_pos`, `wp_perp`, `wp_width`, `wp_path`, `wp_score`, branch links; optional GDB title | Validate a real AIW, source perpendiculars, pits and actual lap; audit v1 midpoint/normal reconstruction against source edges. |
| Automobilista 1 (`ams1`), rFactor (`rf1`) | Shared telemetry reader; manual AIW parser reuse is only a candidate; no title-specific automatic discovery | Inventory each installation's own loose AIW/GDB. Do not substitute Stock Car Extreme assets | Separate real-file/schema/axis proofs for each title before adding lookup roots or automatic support. |
| Assetto Corsa EVO (`acevo`) | Offline Laguna Seca pilot only, XTRK v2 explicit boundaries; no automatic discovery | Pinned build 25170311 `.aisplinedata` plus control points; [pilot evidence](acevo-native-track-pilot.md) | Current raw-reader/live-game acceptance; investigate mesh/white lines and timing origin; then a second circuit and update invalidation. Keep the hash refusal. |
| Le Mans Ultimate (`lmu`) | No native geometry parser | Inspect installed track package metadata and any permitted AIW/mesh tooling. Studio 397's rFactor 2 AIW documentation is a research lead, not LMU format proof | Prove access to one specific LMU layout without modifying assets, then inspect its schema and coordinate frame before considering parser reuse. |
| Automobilista 2 (`ams2`) | No native geometry parser | Installed `Support/SharedMemory/.../SharedMemory.h` supports telemetry investigation; inventory track assets separately | Identify one accessible native layout/boundary source and its version. Shared-memory compatibility with PCARS does not prove asset compatibility. |
| Project CARS 2 (`pcars2`), Project CARS 3 (`pcars3`) | No native geometry parser; AMS2-family telemetry only | Inspect each title's installation and supplied SDK independently; archive extensions are only candidates | One source proof per title; compare source positions, handedness and layout variant to recorded laps. |
| Assetto Corsa Competizione (`acc`) | No native geometry parser; AC `.ai` extractor is not enabled | Installed track packages / developer-exposed geometry, if available; telemetry is in `games/kunos.rs` | Establish an accessible source and its boundary meaning. A shared-memory family does not justify reusing AC road files. |
| Assetto Corsa Rally (`acr`) | No native geometry parser; current reader has no car position | Source and position channel both unproven in this repository | First establish position-capable telemetry and stage identity; retain open stages, never close them as circuits. |
| F1 25 (`f1`), 24 (`f124`), 23 (`f123`) | No native geometry parser | EA UDP specifications describe motion/session telemetry; investigate native geometry separately for each release | Map circuit ID + version + layout, then find a genuine boundary source; motion samples alone remain a driven trajectory. |
| Wreckfest 2 (`wreckfest2`) | No native geometry parser | Existing telemetry adapter plus installation asset inventory; source geometry schema unproven | Prove a source for one layout, including alternate routes, gaps and open/closed topology. |
| RaceRoom (`r3e`) | No native geometry parser | Official `r3e-api` supplies telemetry and identity fields; no native geometry source is implemented here | Determine whether a permitted layout geometry source exists; reconcile track/layout identity and source version. |
| Forza Motorsport (`fm`), Motorsport 7 (`fm7`) | No native geometry parser | Official Data Out describes car position; inspect permitted native assets separately | Stable layout identity is a prerequisite: some packets only yield `Track #<ordinal>` or no track. No matching by circuit name alone. |
| Horizon 4 (`fh4`), 5 (`fh5`), 6 (`fh6`) | No native geometry parser; Forza-family telemetry | Installation/API investigation per title; event-specific native road source unproven | Identify event/route + version and open stages; an open-world driven trace is not a circuit boundary. |
| iRacing (`iracing`) | No native geometry parser | `games/iracing.rs` uses published position when present, otherwise velocity integration; its estimated lap is subsequently closed | Resolve absolute origin/frame and obtain a permitted native road source first. Do not use integrated/closure-adjusted laps as native alignment ground truth. |

## Coordinates, height and identity

These are **current reader mappings**, not measured geometry guarantees. The repository explicitly marks most mappings `ASSUMED` in `xpeed-sim/src/game.rs`. Its EVO live position checks do not complete the separate geometry/raw-reader/live acceptance gate.

| Family / implementation | Position entering Xpeed | Identity currently exposed / missing proof |
| --- | --- | --- |
| AC / ACC, `games/kunos.rs` | `carCoordinates` as given, Y up; Rally has none | Track; AC has configuration and length. ACC layout/source-version mapping still needs proof. |
| EVO, `games/acevo.rs` | Mean tyre-contact positions; `(-x,y,z)` | Track + configuration + cross-checked length. Pilot asset hashes/build are documented; automatic version binding is absent. |
| AMS2 / PCARS, `games/ams2.rs` | `mWorldPosition` as given | Location + variation + length; native asset identity unproven. |
| rF1 family, `games/rfactor1.rs` | Raw `pos`, left-handed, Y up | Track name + length; no explicit variant. Aliases still require title-specific source identity. |
| LMU, `lmu/` | Raw `mPos`, left-handed | Scoring track name/length; asset/layout/build binding unproven. |
| RaceRoom, `games/r3e.rs` | Raw `car_cg_location`, Y up | Track + layout + length; native asset version not recorded. |
| F1, `games/f1.rs` | Raw motion `worldPosition` | Resolved circuit ID + length; no geometry version binding. |
| Forza, `games/forza.rs` | Raw Data Out `Position`, Y up | Packet-dependent track ordinal; stable layout/source key missing. |
| Wreckfest 2, `games/wreckfest2.rs` | Raw `position` | Track + length; native source version/layout binding unproven. |
| iRacing, `games/iracing.rs` | Optional geographic fix converted relative to the first fix; otherwise estimated path; inspect sign/origin before overlay | Track/configuration/length from session YAML; absolute native origin not established. |

Native AC and AIW preserve source reference elevation; EVO preserves spline Y. This does not establish road-edge heights or banking: XTRK v2's explicit boundaries are planar X/Z. For every other family, telemetry height does not establish native road elevation. Never zero, mirror or fit stored lap coordinates to make a map appear aligned.

Except for the pinned EVO case, installed game builds, source hashes, physical boundary semantics, complete layout coverage and redistribution rights remain **unverified** in this task. No distribution permission is inferred from an SDK, a local file, a modding guide or an archive extension. Keep new source/geometry evidence local; adding another title to the current automatic upload path requires an explicit source/distribution review.

## Lightweight installation inventory

`scripts/inventory-native-tracks.mjs` uses Node's standard library. Steam manifests supply app ID, name, install folder and build ID; a manifest without its directory is not proof of an installed game. External Steam libraries are read from `libraryfolders.vdf`. Custom Steam roots and explicit game directories cover nonstandard Steam and non-Steam installs.

Start on the desktop with metadata only (no game extraction or build):

```powershell
node scripts/inventory-native-tracks.mjs --out .codex-local/native-tracks/steam-inventory.json
# Use --steam-root for a custom Steam client location:
node scripts/inventory-native-tracks.mjs --steam-root 'D:/Steam' --out .codex-local/native-tracks/custom-steam.json
```

After choosing the exact installed titles, inventory their candidate sources:

```powershell
node scripts/inventory-native-tracks.mjs --game 'ac=F:/SteamLibrary/steamapps/common/assettocorsa' --game 'lmu=F:/SteamLibrary/steamapps/common/Le Mans Ultimate' --out .codex-local/native-tracks/source-candidates.json
```

Use fresh output names: the tool refuses to overwrite reports or write into game/Steam/library trees. Paths are examples; choose actual manifest installation paths. It records file metadata only for candidate AI/spline/control files and separately classifies package containers. It does not decode, hash, extract, validate or upload them. A package name is not proof of its contents. Candidate scans are bounded; errors, skipped links and limit/depth truncation must remain visible. No candidate found in a partial scan is not an unsupported-source conclusion. Reports contain machine-local paths and stay in ignored `.codex-local/`.

Targeted verification: `node --test scripts/test-inventory-native-tracks.mjs`, also wired into web CI. Tests use temporary fake Steam/game trees, never the owner's game assets. Atomic report publication requires filesystem hard-link support; unsupported destinations fail without publishing a partial report.

## Proposed next implementation order

1. **Desktop evidence run:** collect exact installations/builds, then select one real-file and lap pair for AC and Stock Car Extreme. Audit preservation of native cross-sections before expanding automatic support. Check Automobilista 1 and rFactor separately.
2. **EVO completion:** current raw-reader capture, live overlay, mesh/white-line semantics and timing origin; then investigate a second circuit without removing the known-source guard.
3. **Next source investigation:** LMU first, then AMS2/PCARS. Their existing world-position readers make alignment experiments possible; native geometry availability is still unproven. Change this order if the installed-source inventory gives stronger evidence elsewhere.
4. **Remaining families:** one source/access/identity proof for ACC, Rally, each F1 release, Wreckfest 2, RaceRoom, each Forza title and iRacing. Mark unavailable sources explicitly and retain an honestly labelled trajectory fallback where positions exist.

Each implementation case needs game/track/layout/build + SHA256 provenance, exact position/direction transform, measured side/boundary semantics, reference/edge elevation limitations, timing origin, pits/topology/gaps, stale-cache behavior, independent source/export comparison, a recorded-lap alignment gate, native rendering, website import and live acceptance. Do not generalize EVO's measured tolerances as physical accuracy for another game's source.

## Source references

- Repository facts: `xpeed-sim/src/games/mod.rs`, `main.rs`, `game.rs`, individual readers, `tracks/{auto,dump,ac,aiw,acevo}.rs`; website XTRK reader `src/lib/sim/track-file.ts`.
- [Studio 397 modding resources](https://www.studio-397.com/modding-resources/) and [rFactor 2 Track AI Tutorial](https://docs.studio-397.com/display/DG/Track%2BAI%2BTutorial): first-party AIW/track workflow, **not LMU compatibility evidence**.
- [EA F1 25 / 2026 Season Pack UDP specifications](https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-2026-season-pack-udp-specification/12187347): separate telemetry protocol revisions are published together; check the selected annual/season mode before reuse.
- [Forza Motorsport Data Out](https://support.forza.net/hc/en-us/articles/21742934024211-Forza-Motorsport-Data-Out-Documentation): car telemetry, not a native road-boundary export.
- [RaceRoom official API](https://github.com/kwstudios-sweden/r3e-api): telemetry header; existing reader pins commit `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb`.

## Session evidence

2026-11-16: resumed on VANILDO-TABLET with 0.6 GB free. Source/registry inspection and lightweight inventory work only; no extraction, native build, game launch or new geometry validation. The default metadata inventory found no app manifests in either standard Steam root; both roots reported missing metadata/directories. This is not a desktop installation inventory. Local report: ignored `.codex-local/native-tracks/surface-20261116.json`. All nine inventory tests passed in 0.72 seconds (zero skipped), including Windows symlink/junction cases; `git diff --check` passed. Desktop-only `xpeed-native-tracks` skill/toolkit is documented in the Notion guide but is not installed in this checkout's machine profile.
