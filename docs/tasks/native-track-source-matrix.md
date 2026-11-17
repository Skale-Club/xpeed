# Native track sources by simulator

Repository audit: 2026-11-16; desktop source investigation updated 2026-11-17 on `codex/native-tracks-completion`. Parent: [native track geometry](native-track-geometry.md). Companion 0.11.0 is an unreleased local candidate. **The full plan remains PARTIAL:** classification covers every capture ID; native geometry and live acceptance do not cover every game.

## Support and evidence

The capture CLI accepts **22 title identifiers**, including LMU's separate reader. Related titles share readers; they are not interchangeable installations or track versions. `sce` is a track-dump format identifier, not a capture identifier. Evidence: `xpeed-sim/src/main.rs`, `xpeed-sim/src/games/mod.rs`, and `xpeed-sim/src/lmu/`.

AC and Stock Car Extreme have automatic native source extraction with source-generation receipts invalidating changed local assets. EVO now has bounded KSP source reads and automatic private asphalt-cache generation for verified build/hashes/scene surfaces; it is not uploaded. Public stored maps cannot validate themselves against the current local installation. The dump CLI additionally accepts `sce`, `rf1`, `rfactor1` for an AIW, bounded pinned EVO AI/asphalt exports, offline `lmu-aiw`, and offline `f125-spline`. Source-generation receipts bind logical/resolved paths and source SHA checks, including junction retarget invalidation. CLI acceptance of an AIW does not prove another title's schema or live alignment.

| Game / capture IDs | Geometry implementation now | Source to inspect next / evidence | Concrete next gate |
| --- | --- | --- | --- |
| Assetto Corsa (`ac`) | `tracks/ac.rs`; automatic `content/tracks` lookup; qualified native basis uses XTRK v2 explicit boundaries, with labelled v1 tangent fallback for mods | `ai/fast_lane.ai`, optional `pit_lane.ai`, layout UI/map metadata; existing parser reads positions, elevation, distance, two side widths | Real-source corpus accepts 495/534 files including ten backups, with 39 refusals. Source/export checks pass; capture an actual AC lap for independent frame acceptance. AI widths are not certified white lines. |
| Stock Car Extreme (`rfactor1`) | `tracks/aiw.rs`; automatic `GameData/Locations` lookup; XTRK v2 stored-perpendicular boundaries preserve banking and gaps; dump format `sce` | AIW `wp_pos`, `wp_perp`, `wp_width`, `wp_path`, `wp_score`, branch links; optional GDB title | All 70 installed AIWs pass source/export validation, including stored vectors and pits. Capture a real SCE lap for frame/live acceptance; separate edge Y is not stored by XTRK v2. |
| Automobilista 1 (`ams1`), rFactor (`rf1`) | Shared telemetry reader; manual AIW parser reuse is only a candidate; no title-specific automatic discovery | Inventory each installation's own loose AIW/GDB. Do not substitute Stock Car Extreme assets | Separate real-file/schema/axis proofs for each title before adding lookup roots or automatic support. |
| Assetto Corsa EVO (`acevo`) | Bounded native KSP reader with automatic private asphalt cache; build/hash/scene pins and XTRK v2 explicit boundaries; no upload | Pinned build 25170311 source spline plus scene-classified asphalt, 2,135 road/552 pit samples; [pilot](acevo-native-track-pilot.md) and [mesh/runtime evidence](acevo-mesh-evidence.md) | Complete current live UI/raw-reader acceptance; finish/timing zone firing and white-line centre/edge remain unverified. Asphalt/AI limits are distinct. Keep build/hash/scene refusal and prove a second circuit separately. |
| Le Mans Ultimate (`lmu`) | Hash-pinned offline LMU AIW adapter emits XTRK v2; bounded MAS access probe proven; no automatic discovery | Actual build 25661166 LagunaSeca_2026 component 1.05: selected `LagunaSeca.AIW` extracted from `layoutLaguna.mas`; [schema, hashes and evidence](lmu-native-evidence.md) | Offline adapter validates all 718 main vertices and 258 linked pit points, preserving source cross-sections; `wp_pathinfo2` ideal line remains unknown. Prove reader frame with an actual lap before automatic support. |
| Automobilista 2 (`ams2`) | No accepted native geometry adapter | Actual Adelaide physics BFF header/table checked; plaintext table interpretation fails bounds, stock-table mode requires a version-specific decode; [evidence](ams2-wreckfest-native-evidence.md) | Decode one stock table with valid entry spans, then one physics/AI payload and its frame. PCARS-family telemetry does not prove asset compatibility. |
| Project CARS 2 (`pcars2`), Project CARS 3 (`pcars3`) | No native geometry parser; AMS2-family telemetry only | Inspect each title's installation and supplied SDK independently; archive extensions are only candidates | One source proof per title; compare source positions, handedness and layout variant to recorded laps. |
| Assetto Corsa Competizione (`acc`) | No native geometry adapter | Actual PAK v11 footer proves encrypted index flag 1; declared index range is valid; [source evidence](unreal-f1-native-evidence.md) | Obtain a permitted readable developer index/export, then establish source schema/frame and boundary meaning. No key search or AC extractor substitution. |
| Assetto Corsa Rally (`acr`) | No native geometry adapter; reader has no position channel | Actual unencrypted IoStore directories expose named stage maps; selected AlsaceS2Munster chunk/block/Oodle metadata proven; [evidence](unreal-f1-native-evidence.md) | Selectively decode stage actor/road schema and establish position telemetry/identity. Retain open topology; a UMAP name is not a road boundary. |
| F1 25 (`f1`); 24 (`f124`), 23 (`f123`) remain separate | F1 2025 Brazil has a hash-pinned offline XTRK v2 white-line adapter; no automatic matching. Older titles have no accepted source | Actual ERP/BXML contains signed labelled white-line offsets, full normals, 287 main/106 pit gates; [source/export evidence](unreal-f1-native-evidence.md) | Prove F1 2025 annual/season/layout identity and recorded-lap frame/timing. Obtain each older installation/source independently; never substitute a car trajectory. |
| Wreckfest 2 (`wreckfest2`) | No accepted native geometry adapter | Bounded Bag decode exposes actual SCNE/TCAT AI-border candidates with native paired XYZ and 64-byte v4 sector stride; [evidence](ams2-wreckfest-native-evidence.md) | Prove structural membership, complete v4/trailer semantics, scene transforms, layout/reverse topology and telemetry frame. Do not call the AI corridor asphalt. |
| RaceRoom (`r3e`) | No native geometry parser | Official `r3e-api` supplies telemetry and identity fields; no native geometry source is implemented here | Determine whether a permitted layout geometry source exists; reconcile track/layout identity and source version. |
| Forza Motorsport (`fm`), Motorsport 7 (`fm7`) | No native geometry parser | Official Data Out describes car position; inspect permitted native assets separately | Stable layout identity is a prerequisite: some packets only yield `Track #<ordinal>` or no track. No matching by circuit name alone. |
| Horizon 4 (`fh4`), 5 (`fh5`), 6 (`fh6`) | No native geometry parser; Forza-family telemetry | Installation/API investigation per title; event-specific native road source unproven | Identify event/route + version and open stages; an open-world driven trace is not a circuit boundary. |
| iRacing (`iracing`) | No native geometry parser | `games/iracing.rs` uses published position when present, otherwise velocity integration; its estimated lap is subsequently closed | Resolve absolute origin/frame and obtain a permitted native road source first. Do not use integrated/closure-adjusted laps as native alignment ground truth. |

## Coordinates, height and identity

These are **current reader mappings**, not measured geometry guarantees. The repository explicitly marks most mappings `ASSUMED` in `xpeed-sim/src/game.rs`. Its EVO live position checks do not complete the separate geometry/raw-reader/live acceptance gate.

| Family / implementation | Position entering Xpeed | Identity currently exposed / missing proof |
| --- | --- | --- |
| AC / ACC, `games/kunos.rs` | `carCoordinates` as given, Y up; Rally has none | Track; AC has configuration and length. ACC layout/source-version mapping still needs proof. |
| EVO, `games/acevo.rs` | Mean tyre-contact positions; `(-x,y,z)` | Track + configuration + cross-checked length. Private asphalt cache checks source hashes/scene manifest, available Steam build and source-generation stamp; live raw-reader/UI acceptance remains open. |
| AMS2 / PCARS, `games/ams2.rs` | `mWorldPosition` as given | Location + variation + length; native asset identity unproven. |
| rF1 family, `games/rfactor1.rs` | Raw `pos`, left-handed, Y up | Track name + length; no explicit variant. Aliases still require title-specific source identity. |
| LMU, `lmu/` | Raw `mPos`, left-handed | Scoring track name/length; offline Laguna source is build/component/hash-pinned, but binding it to recorded/live reader positions is unproved. |
| RaceRoom, `games/r3e.rs` | Raw `car_cg_location`, Y up | Track + layout + length; native asset version not recorded. |
| F1, `games/f1.rs` | Raw motion `worldPosition` | Resolved circuit ID + length; offline Brazil 2025 source is hash-pinned, while annual/season/layout and recorded-frame binding remain unverified. |
| Forza, `games/forza.rs` | Raw Data Out `Position`, Y up | Packet-dependent track ordinal; stable layout/source key missing. |
| Wreckfest 2, `games/wreckfest2.rs` | Raw `position` | Track + length; native source version/layout binding unproven. |
| iRacing, `games/iracing.rs` | Optional geographic fix converted relative to the first fix; otherwise estimated path; inspect sign/origin before overlay | Track/configuration/length from session YAML; absolute native origin not established. |

Native AC/AIW preserve source-reference and banked midpoint elevation. EVO asphalt preserves measured midpoint Y; offline F1 preserves the full-vector white-line midpoint Y. This does not establish road-edge heights or banking: XTRK v2's explicit boundaries are planar X/Z. For every other family, telemetry height does not establish native road elevation. Never zero, mirror or fit stored lap coordinates to make a map appear aligned.

Installed build IDs are now recorded for nine titles below; actual LMU/F1 sources and AC/SCE/EVO investigations provide specific source evidence. Physical boundary semantics, complete layout coverage and redistribution rights remain separate, title-specific gates. The LMU source-only cycle proves neither a live frame nor physical asphalt. No distribution permission is inferred from an SDK, a local file, a modding guide or an archive extension. Keep new source/geometry evidence local; adding another title to the current automatic upload path requires an explicit source/distribution review.

## Desktop installation and source evidence (2026-11-17)

The fixed inventory processes every `libraryfolders.vdf` entry independently. The inaccessible middle `D:/SteamLibrary` reports `UNKNOWN` at `realpath`, with its metadata path and library key, while the later `S:/Games/Steam` is successfully enumerated (resolved to a network library). Accessible C/F/S libraries contain 22/13/38 manifests respectively and each manifest scan completed. `steamDiscoveryComplete=false` remains truthful because D is inaccessible. Current-user uninstall entries and Forza Store packages supplied no additional matching titles. D's library-list metadata advertises only duplicate AMS2/Wreckfest 2 IDs, but stale metadata is not proof of its current contents.

**Installed** means a Steam manifest and a present directory; it does not validate assets. **Not detected** means absent from the accessible metadata sources just described, not an unsupported title or a machine-wide proof of absence: unavailable D, unregistered/non-Steam/custom roots and other-user packages remain outside that conclusion. **Unknown** describes a source schema or coordinate contract still unproved; a container extension alone never proves geometry. All 22 capture IDs from `installed.rs` are represented individually:

| Capture ID | Steam app ID | Desktop installation / build | Source access and concrete next action |
| --- | --- | --- | --- |
| `lmu` | 2399420 | Installed / 25661166 | **Implemented pinned offline XTRK v2 adapter**, no automatic runtime support: 12-entry Laguna MAS index and selectively extracted AIW with 1,340 waypoints. Validated 718 main/258 linked pit points; source fidelity 0.000015234 m. Compare a real LMU lap before alignment claims. See [evidence](lmu-native-evidence.md). |
| `ac` | 244210 | Installed / 14923034 | **Implemented** qualified-basis XTRK v2 AI cross-sections, with labelled v1 fallback for mods. Installed corpus: 534 files (10 backups), 495 accepted/39 refused. Source-generation receipts invalidate changed local assets; road/white-line semantics remain a separate gate. |
| `acc` | 805550 | Installed / 21257365 | **Source-access blocked**: bounded footer proves PAK v11 encrypted index flag 1, with valid index offset/size. Need a permitted readable index/export; geometry schema/frame remain unknown. [Evidence](unreal-f1-native-evidence.md). |
| `acevo` | 3058630 | Installed / 25170311 | **Implemented pinned native KSP reader/private cache**, automatic locally with source stamp, build/hash pins and payload SHA. Default private/native geometry is scene-classified asphalt, 2,135 road/552 pit samples; AI limits remain a separate export. Source stamp/build/hash and logical/resolved path checks invalidate stale geometry. No automatic upload or live certification. |
| `acr` | 3917090 | Installed / 25170642 | **Readable source index**, not accepted geometry: unencrypted v8 IoStore enumerates stage maps; AlsaceS2Munster logical/chunk/Oodle ranges verified. Need cooked road/actor schema and position telemetry. [Evidence](unreal-f1-native-evidence.md). |
| `ams2` | 1066890 | Installed / 25391793 | **Stock-table decode blocked**: full namespace scan, 4,188 BFFs; actual ten-entry Adelaide physics table fails plaintext entry-range checks. Need version-specific bounded stock-table/payload proof, then source/frame classification. [Evidence](ams2-wreckfest-native-evidence.md). |
| `pcars2` | 378860 | Not detected | **Absent in checked metadata**, not unsupported. Obtain this title's installation/version and own source before testing shared-family assumptions. |
| `pcars3` | 958400 | Not detected | **Absent in checked metadata**. Independently establish its track source and build; AMS2 assets are not evidence. |
| `f1` | 3059520 | Installed / 26566308 | **Implemented pinned offline XTRK v2 white-line adapter**: real WEP ERP/BXML, 287 main/106 pit gates, seven signed-offset exceptions preserved; 0.000030477 m export error. Annual/season/layout/frame and timing remain unproved; no automatic matching. [Evidence](unreal-f1-native-evidence.md). |
| `f124` | 2488620 | Not detected | **Absent in checked metadata**. Obtain F1 24 sources separately; do not reuse F1 25 geometry by name. |
| `f123` | 2108330 | Not detected | **Absent in checked metadata**. Obtain F1 23 sources and layout/version contract separately. |
| `wreckfest2` | 1203190 | Installed / 26269701 | **Native AI-border candidate**: actual bounded SCNE/TCAT Bag decode yields 76/74 candidate sectors with paired XYZ; complete structural v4/trailer, scene transforms and route/frame proof remain open. Broad namespace scan remains partial. [Evidence](ams2-wreckfest-native-evidence.md). |
| `rfactor1` | 273840 | Installed / 976660 | **Implemented SCE AIW v2** stored-perpendicular/banked source cross-sections with gaps; all 70 installed files accepted. Source-generation receipts invalidate changed local assets. This ID is Stock Car Extreme, not rFactor. |
| `ams1` | 431600 | Not detected | **Absent in checked metadata**. Obtain this game's own AIW/GDB and lap before enabling title-specific automatic roots. |
| `rf1` | 339790 | Not detected | **Absent in checked metadata**. Current manual AIW parser is a candidate, but SCE source acceptance cannot substitute for rFactor installation/schema/frame proof. |
| `r3e` | 211500 | Not detected | **Absent in checked metadata**. Official API exposes telemetry/track-layout identity, no native boundaries in the inspected API; obtain an installation and permitted layout source. |
| `fm` | 2440510 | Not detected | **Absent in checked Steam/program/Forza Store metadata**. Obtain native source and stable layout key; Data Out position does not expose road edges. |
| `fm7` | Store only | Not detected | **Absent in checked program/Forza Store metadata**. Establish installation access and layout identity separately from Motorsport 2023. |
| `fh4` | 1293830 | Not detected | **Absent in checked metadata**. Obtain event/route source; do not close open-world traces into a circuit. |
| `fh5` | 1551360 | Not detected | **Absent in checked metadata**. Establish this title's own event/route/build and permitted geometry. |
| `fh6` | 2483190 | Not detected | **Absent in checked metadata**; the registry has no sourced Store package mapping for this ID. Verify installation and official identity rather than infer from FH5. |
| `iracing` | 266410 | Not detected | **Absent in checked metadata**. Obtain permitted native source and absolute position/frame proof; integrated/closure-corrected trajectories cannot provide that proof. |

Namespace-complete means directory entries were examined within the declared candidate patterns; it never means archive payloads were inventoried or all possible geometry formats excluded. F1 and Wreckfest broad scans are explicitly incomplete. Added ERP/RPCK/UCAS/UTOC metadata classification prevents those containers being silently omitted from focused reports. No game was launched, installed, or changed; no full package was unpacked or huge archive hashed. Local reports are ignored:

- `.codex-local/native-tracks/desktop-20261117-recovered.json` and `desktop-all22-20261117.json` (library and 22-ID installation evidence).
- `desktop-programs-20261117.json`, `desktop-packages-20261117.json` (additional metadata sources; the package report is empty when no matching Forza package exists).
- `desktop-other-sources-20261117.json` (bounded six-title source namespace scan).
- `research-other/focused-source-metadata.json`, `f1-brazil-erp-metadata.json`, `bounded-headers.json` (focused metadata/header probes; the exploratory nonexistent F1 Laguna directory is explicitly an error and supplies no source conclusion).
- [LMU evidence](lmu-native-evidence.md), [Unreal/F1 evidence](unreal-f1-native-evidence.md), and [AMS2/Wreckfest evidence](ams2-wreckfest-native-evidence.md) record actual access/schema findings, selective payload hashes and remaining gates.

## Lightweight installation inventory

`scripts/inventory-native-tracks.mjs` uses Node's standard library. Steam manifests supply app ID, name, install folder and build ID; a manifest without its directory is not proof of an installed game. External Steam libraries are read from `libraryfolders.vdf`; one failed library does not suppress later entries. `steamDiscoveryComplete` and per-library error path/code retain partial-discovery evidence. Custom Steam roots and explicit game directories cover nonstandard Steam and non-Steam installs.

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

1. **AC/SCE acceptance:** installed corpus/source cross-sections and source-generation invalidation are measured; capture recorded-lap frame/live acceptance. AMS1/rFactor were not detected and remain separate title cases.
2. **EVO completion:** resolve the owner-assisted showroom/menu state and observe current live raw-reader/render alignment. Asphalt cache/native/web source use is implemented; white-line interpretation and precise timing firing remain open. Prove a second circuit separately.
3. **Offline adapters:** capture LMU Laguna/F1 Brazil laps for frame/timing acceptance; keep F1 annual/layout identity explicit. LMU ideal-line schema remains unknown; F1 uses the actual source racing_line field. Continue AMS2 stock-table and Wreckfest structural scene-route gates; PCARS/RaceRoom/rFactor installations were not detected.
4. **Remaining families:** resolve ACC permitted index access, Rally cooked schema/position telemetry, older F1 title installations, and each not-detected family's own source/identity proof. Mark unavailable sources explicitly and retain an honestly labelled trajectory fallback where positions exist.

Each implementation case needs game/track/layout/build + SHA256 provenance, exact position/direction transform, measured side/boundary semantics, reference/edge elevation limitations, timing origin, pits/topology/gaps, stale-cache behavior, independent source/export comparison, a recorded-lap alignment gate, native rendering, website import and live acceptance. Do not generalize EVO's measured tolerances as physical accuracy for another game's source.

## Source references

- Repository facts: `xpeed-sim/src/games/mod.rs`, `main.rs`, `game.rs`, individual readers, `tracks/{auto,dump,ac,aiw,acevo}.rs`; website XTRK reader `src/lib/sim/track-file.ts`.
- [Studio 397 modding resources](https://www.studio-397.com/modding-resources/) and [rFactor 2 Track AI Tutorial](https://docs.studio-397.com/display/DG/Track%2BAI%2BTutorial): first-party AIW/track workflow, **not LMU compatibility evidence**.
- [EA F1 25 / 2026 Season Pack UDP specifications](https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-2026-season-pack-udp-specification/12187347): separate telemetry protocol revisions are published together; check the selected annual/season mode before reuse.
- [Forza Motorsport Data Out](https://support.forza.net/hc/en-us/articles/21742934024211-Forza-Motorsport-Data-Out-Documentation): car telemetry, not a native road-boundary export.
- [RaceRoom official API](https://github.com/kwstudios-sweden/r3e-api): telemetry header; existing reader pins commit `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb`.
- [Original MAS2 index reader](https://github.com/nlhans/MAS2Extract/blob/f26563f1713ca7596d9baa580205a0fbfdc18611/MAS2Extract/MAS2Reader.cs): format research reference pinned by the bounded LMU diagnostic; the actual LMU variant and selected AIW are independently recorded above.
- [Open Madness Track Tools, original author documentation](https://github.com/ohyeah2389/Open-Madness-Track-Tools/blob/master/README.md): distinguishes AI waypoint authoring and cooked collision geometry. Its BFF creator does not implement encrypted BFF support; this is a tooling limitation, not proof that the observed installed BFF is encrypted or readable.

## Historical session evidence

2026-11-16: resumed on VANILDO-TABLET with 0.6 GB free. Source/registry inspection and lightweight inventory work only; no extraction, native build, game launch or new geometry validation. The default metadata inventory found no app manifests in either standard Steam root; both roots reported missing metadata/directories. This is not a desktop installation inventory. Local report: ignored `.codex-local/native-tracks/surface-20261116.json`. All nine inventory tests passed in 0.72 seconds (zero skipped), including Windows symlink/junction cases; `git diff --check` passed. Desktop-only `xpeed-native-tracks` skill/toolkit is documented in the Notion guide but is not installed in this checkout's machine profile.

2026-11-17 desktop follow-up: recovered S after the failed D library, inventoried all 22 IDs, bounded six installed-title source scans and selectively extracted one actual LMU AIW. Eleven Node inventory tests and seven synthetic bounded MAS/AIW checks pass. See the desktop evidence and LMU document above; the Surface-only limitation no longer describes this investigation.
