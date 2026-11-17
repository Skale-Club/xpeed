# EVO Laguna Seca mesh evidence

Source investigation and runtime follow-up on 2026-11-17 UTC, Steam build **25170311**. The unreleased **Companion 0.11.0** candidate now uses the validated scene-classified **asphalt** geometry by default in its automatic private Laguna Seca GP cache and native `RoadKind::Asphalt` rendering. The AI envelope remains a distinct source/export. The [original pilot](acevo-native-track-pilot.md) and initial experiments below are historical evidence; they do not certify current live-game behavior. Overall acceptance remains **PARTIAL**, not an all-game or production release claim.

## Actual source classification and transforms

Selective extraction used the existing pinned ACEvo.Package CLI 1.1.0 (`047fd596`) against `F:/SteamLibrary/steamapps/common/Assetto Corsa EVO/content.kspkg`. The installation was read only. Recovered descriptors came from the pilot. Sources and output stay ignored under `.codex-local/native-tracks/evo-mesh/`; no proprietary assets are committed.

`laguna_seca.scene` decodes as `SceneData` with 1,071 actors. The scene defines surface IDs and links each static mesh actor to a surface ID. In `SurfaceDefinitionData`, `ASPH_OLD` and `ASPH_MID` are `ColliderCategorySurface`, `isValidTrack=true`, and `SurfaceType_Asphalt` (proto3 enum default zero). `KERB` is `SurfaceType_Kerb`, `CURB` is `SurfaceType_Flat_Kerb`, and `WALL` has `ColliderCategoryWall`. These are source metadata classifications, not filename guesses. Some other surfaces, including concrete, also use the default Asphalt enum; the helper records the full definitions and reports missing extracted files rather than claiming complete coverage.

The selected road asphalt is in **static_mesh**, not **physics**. The latter directory contains wall collision meshes and box-ground collision. Ten selected actors reference `asphalt_mid.mesh`, `asphalt_norm001.mesh` through `asphalt_norm007.mesh`, plus `asphalt_norm002b.mesh` and `asphalt_norm002c.mesh`. Each actor is enabled, has no parent-container GUID, and has exact zero position/rotation and unit scale. Mesh positions therefore already share the scene frame. `MeshData.type` is Default (0), not Road (6); the actor/surface link establishes its role. These meshes have render materials and collision surface assignments, rather than `physics_only=true`.

The helper decodes LOD0 positions, triangle indices and batch materials directly and rejects invalid lengths, nonfinite vertices, index overflow and invalid material ranges. It refuses nonidentity or parented selected actors instead of guessing Euler rotation conventions. Coordinates apply the established reader reflection `(-x,y,z)` exactly once. Historical fixtures receive the same explicit correction in memory, without rewriting files or fitting a rotation, translation or scale.

Scene SHA-256: `56a268d2b8b8f70243e11e31c5633063f24e09c5f890786991c0b9f2a22e410c`. Layout scene: `274abf7ddba8e1fd39075ab4fc840475c2e288fb33bdb437f3f25bf89c9bce3b`. Descriptor: `cd58e72318538a7f0d7369beb883543d83334b365266095f84982d114f175922`. Individual mesh, ideal and lap hashes are in the local report.

## Measured triangles, elevation and widths

The selected meshes contain **27,916 triangles**, covering world Y **258.036499–313.566528 m**. Planar triangle containment and barycentric Y interpolation give:

| Positions | Inside selected asphalt | Absolute height error p95 on contained samples |
| --- | --- | --- |
| AI source, 2,135 samples | 2,102; 98.454% | 0.0000221 m |
| Invalid historical lap 1 | 9,919 / 10,861; 91.327% | 0.009773 m |
| Invalid historical lap 2 | 9,678 / 10,186; 95.013% | 0.008366 m |
| Valid historical lap 3 | 9,588 / 9,923; 96.624% | 0.009099 m |

These errors apply only where a sample is inside a selected triangle. Remaining points can be on kerbs or other unselected surfaces; containment is not a white-line-validity test. Valid lap maximum contained height error is 0.25424 m. The ideal line maximum is 0.002474 m. At source sample 1,425, at the high source section, source Y is 313.383453 m and mesh-interpolated Y is 313.383449 m. This proves agreement with the elevated asphalt surface; banking and separate edge heights still need a runtime representation.

Actual triangle intersections with planes perpendicular to source forward vectors produce 2,102 cross sections containing the ideal position, with 33 explicit unknown rows. Adjacent triangle intervals merge across at most 0.02 m seams. Selected-asphalt widths are median **12.2214 m**, p95 **24.3281 m**, maximum **33.9030 m**. These can include contiguous paved runoff; they are not white-line limits. Absolute differences from AI-envelope widths are median **0.10089 m**, p95 **11.0221 m**, maximum **22.3430 m**. Replacing AI sides wholesale would change semantics materially.

The authored anomaly is now localized: control 36 / ideal sample 1,487 has `side_right=78.77484 m` and `side_left=10.894836 m`, whereas AI payload sides are `sides_1=1.191087 m`, `sides_0=10.645202 m`. The mesh cross-section span is **12.04829 m** at this location. The 77.58375 m control discrepancy therefore is not supported as the local contiguous selected-asphalt span. Keep the anomalous control value as authored evidence; do not use it as measured road width.

## Length and timing

The layout container has identity transforms and four closed authored splines:

| Authored spline | Nodes | Closed 3D polyline length |
| --- | --- | --- |
| `track_center_spline` | 715 | 3599.8961 m |
| `track_limits_left` | 705 | 3563.4756 m |
| `track_limits_right` | 725 | 3642.9491 m |
| `track_ideal_line` | 2,161 | 3557.2459 m |

Thus 3555.1507 m AI distance and 3602 m telemetry length describe different source paths/measurements. The authored center spline is within 2.104 m of the reported length; this supports an explanation, not an exact distance-channel conversion. The authored ideal line also differs from the sampled AI source and must not be silently substituted. The selected scenes and `.track` source do not establish the timing line or sector triggers. Start/finish origin remains unverified.

## Historical initial reproduction

Run `python scripts/inspect-acevo-mesh.py --self-test` for three synthetic checks. Full local inspection:

```powershell
python scripts/inspect-acevo-mesh.py --descriptor .codex-local/acevo-pilot/acevo.desc --scene .codex-local/native-tracks/evo-mesh/extracted/content/tracks/laguna_seca/laguna_seca.scene --layout-scene .codex-local/native-tracks/evo-mesh/extracted/content/tracks/laguna_seca/containers/layout_laguna_seca.scene --ideal .codex-local/acevo-pilot/extracted/content/tracks/laguna_seca/layouts/layout_laguna_seca.ideal_line.aisplinedata --controls .codex-local/acevo-pilot/extracted/content/tracks/laguna_seca/layouts/layout_laguna_seca.trackcontrolpoints --extracted .codex-local/native-tracks/evo-mesh/extracted --out .codex-local/native-tracks/evo-mesh/validated
```

Fresh outputs: `mesh-evidence.json` and `asphalt-cross-sections.json` (columns `left_x,left_z,right_x,right_z`, null rows for gaps, source provenance). They are local investigation artifacts, not XTRK exports or distributable game geometry. At this initial investigation step, full inspection took approximately 15 seconds with bounded per-point triangle arrays. Synthetic checks and Python compilation passed; game launch, runtime mesh integration and live acceptance had not yet occurred. Later runtime/cache integration is recorded below.

The initial next steps were kerb/other-surface classification, authored-limit checks and timing-source investigation. The follow-ups below now supply those offline source results; current raw-reader/live acceptance and precise timing firing remain open. Asphalt and AI/limit semantics remain separate.


## Follow-up: complete paved and kerb coverage

The remaining 20 scene actors with enum Asphalt were selectively extracted. They are eight `OUT` and twelve `CONCRETE` actors, including pit/box concrete and sensors; enum zero alone therefore does **not** distinguish road asphalt. All 30 enum-Asphalt actors total 34,779 triangles. They leave exactly the same 33 ideal-line gaps and valid-lap coverage as the ten main-asphalt files. Their wider paved areas change measured spans substantially (median 13.280 m, maximum 59.592 m), demonstrating why class boundaries must remain explicit.

A further 48 scene-linked actors cover 29 KERB, nine CURB, four DRAIN, five RUMBLE and one CNC_OLD surfaces. Their recovered categories are Kerb, Flat_Kerb and ExtraTurf, respectively. All 78 selected actors have identity transforms and mesh colliders (ColliderType_Mesh, default zero), and all selected files are now present. Together they contain **90,646 triangles**. Planar containment reaches **100% of the 2,135 AI samples** and **100% of the 9,923 valid-lap samples**. The closest-height classifications are:

| Input | ASPH_OLD | ASPH_MID | KERB | Maximum vertical difference |
| --- | --- | --- | --- | --- |
| AI source | 2,097 | 4 | 34 | 0.0000268 m |
| Valid historical lap 3 | 9,555 | 0 | 368 | 0.058101 m |

The valid-lap height error p95 is **0.010481 m**. The 33 prior uncovered AI points are accounted for by kerb triangles; one additional point selects a closer kerb over overlapping asphalt. Invalid laps remain partly outside the paved/kerb selection (94.844% and 95.769% containment). This is physical-surface coverage, not lap validity or white-line containment. Historical fixtures remain unchanged.

The helper now supports `--surface-types 0,1,2,5` and records source IDs/counts and uncovered indices. Outputs for this run are under `.codex-local/native-tracks/evo-mesh/optimized/`. An exact 20 m bounding-box grid reduced the complete run to **14.994 seconds**. Independent comparison with the original exhaustive triangle pass produced identical containment, classification and height results, and **zero coordinate difference** in all 2,135 cross sections. Observed Python working set during exhaustive processing was 117.7 MB. The historical 0.02 m seam merging in those exploratory JSON cross sections is not the runtime policy below.

## Follow-up: authored limits and timing source

The authored limit splines carry explicit `track_limits_left` and `track_limits_right` tags, in addition to `Spline`. All 705/725 nodes are Linear (enum zero), with no road markers. After the reader reflection swaps sides, authored left matches the Xpeed AI right boundary with planar nearest-segment error median **0.01022 m**, p95 **0.21283 m**, max **0.87347 m**. Authored right matches AI left with median **0.00723 m**, p95 **0.21331 m**, max **0.90431 m**. They strongly corroborate the AI side envelope; they remain distinct from measured outer asphalt and from a certified painted white line. Comparison detail is in local `authored-limit-comparison.json`.

`containers/timelines_laguna_seca.scene` is the actual timing-zone source: one enabled `ZoneData.Timelines` actor, three four-point strips, actor translation `(-311.650787,259.238007,-211.277740)`, zero actor rotation and unit scale. Its parent container in the main scene is identity. Point position fields are local to this actor; adding the authored translation, then reflecting X, aligns the strips without fitting. Scene SHA-256: `56038d3e384e3dd2546f9f2864a2dfe2d422cd837aa97faac0ab06b6ce018c9b`.

The AI line crosses the three strips' geometric transverse center lines at source distances **1383.379647 m**, **2258.809678 m**, and **16.729816 m**. The third strip is near recorded lap boundaries: valid lap 3's first/last points are 1.186/1.288 m from its transverse center line; the other strips are over 590 m away. This supports the third strip's finish designation. The recovered Timelines schema carries no explicit finish flag/sector IDs, and the exact engine entry/exit firing edge is unverified. The geometric 16.73 m offset proves that the AI sample origin should not be silently called the timing origin. The 3602 m track metadata, 3599.896 m authored center path and 3555.151 m AI path still must not be interchanged or rescaled.

## Runtime surface decoder

`xpeed-sim/src/tracks/acevo_surface.rs` contains only the verified scene hash and 78 `(path,hash,surface ID,class)` manifest rows, plus a bounded decoder and geometry algorithm. No proprietary positions, indices or output geometry are committed. The scene hash pins the established actor transforms and source classifications; every requested mesh hash is checked before decoding. Changed assets refuse extraction.

The optional API accepts an open read-only package plus **raw** source positions and forwards. `SurfaceGeometry` returns raw asphalt boundary coordinates, midpoint Y, signed-reference gap distances, closest source-surface/Y samples and separate class bands. `Asphalt` means only the ten ASPH_OLD/ASPH_MID actors; the twenty CONCRETE/OUT actors are `OtherPaved`. Kerb, FlatKerb and ExtraTurf remain distinct. Raw positive-normal/negative-normal edges require both X reflection and side swapping at the reader boundary.

Triangle intervals merge only on overlap/touch within **0.0001 m** numerical tolerance and within the same class. An ideal reference on a kerb may select the nearest compatible asphalt interval within 3 m, preserving its offset; this does not union the kerb into asphalt. Unknown asphalt rows remain four NaNs. Separate neighboring class bands retain source Y. Vertical compatibility rejects surfaces more than 1 m from the reference; bridge-layer tests prevent an overhead surface from extending the ground road.

Bounds include 8 MiB per asset, 500,000 total triangles, 2,000,000 grid references, 65,536 grid cells, 8,192 reference samples, 100,000,000 candidate tests and 100,000 output bands. Extraction belongs in offline/background cache creation, never per-frame painting. The initial decoder exposed asphalt as an explicit choice. In the current candidate, automatic private-cache generation now chooses this scene-classified asphalt extractor; AI-envelope export remains separately labelled. This work does not establish redistribution permission or live-reader acceptance.

Initial decoder verification completed against the installed read-only package: **five synthetic Rust tests passed**, and the explicit ignored real-source test passed in **4.02 seconds** (debug build, package reads included). It classified all 2,135 reference positions and produced 2,135 separate asphalt boundary rows. Exactly 33 references lie outside asphalt, with maximum nearest-asphalt offset **0.416507 m**; their kerb samples remain distinct. Maximum source-point Y difference after float32 output is **0.00003052 m**. The midpoint-Y field is the average of selected edge heights; actual reference-point surface Y is available separately.

The independent Python dynamic-protobuf decoder reproduced every Rust asphalt section using only the 27,916 ASPH_OLD/ASPH_MID triangles: maximum boundary coordinate error **0.00002066 m**, edge-average Y error **0.00001526 m**, gap-distance error **0.000000014 m**. These are float32 export differences, not physical survey errors. The comparison is repeatable with `--runtime-json`; the helper now also has five synthetic tests. Runtime JSON SHA-256: `08723550d8def905de349efcf2acdb4a198a188ed35d16f025cf6cc4f50d5e5e`.

```powershell
$env:XPEED_EVO_SURFACE_PACKAGE = 'F:\SteamLibrary\steamapps\common\Assetto Corsa EVO\content.kspkg'
$env:XPEED_EVO_SURFACE_OUTPUT = Join-Path (Get-Location) '.codex-local/native-tracks/evo-mesh/runtime-surfaces.json'
cargo test --manifest-path xpeed-sim/Cargo.toml tracks::acevo_surface::tests
cargo test --manifest-path xpeed-sim/Cargo.toml tracks::acevo_surface::tests::real_source_surfaces_match_independent_local_geometry -- --ignored --nocapture
python scripts/inspect-acevo-mesh.py --descriptor .codex-local/acevo-pilot/acevo.desc --scene .codex-local/native-tracks/evo-mesh/extracted/content/tracks/laguna_seca/laguna_seca.scene --layout-scene .codex-local/native-tracks/evo-mesh/extracted/content/tracks/laguna_seca/containers/layout_laguna_seca.scene --ideal .codex-local/acevo-pilot/extracted/content/tracks/laguna_seca/layouts/layout_laguna_seca.ideal_line.aisplinedata --extracted .codex-local/native-tracks/evo-mesh/extracted --runtime-json .codex-local/native-tracks/evo-mesh/runtime-surfaces.json --out .codex-local/native-tracks/evo-mesh/runtime-verification
```

## Current cache, native and web integration

The unreleased candidate now calls the native bounded KSP/surface reader during background private-cache creation. The actual Laguna Seca GP result is **2,135 asphalt road rows and 552 pit samples**. Cache receipts bind the source package, pinned scene/mesh manifest, available Steam build and logical/resolved source identity; changed builds/assets, receipt/payload hashes or junction retargets invalidate the cache. Geometry stays local and is not automatically uploaded. X reflection and source-side swapping occur exactly once.

The same XTRK v2 geometry reaches native `RoadKind::Asphalt` rendering and the website's memory-only local geometry chooser. The chooser checks title/layout identity and rejects a coarse trajectory mismatch; it neither uploads proprietary assets nor changes historical lap coordinates. An actual 2,135-row Rust asphalt export passed the strict TypeScript reader with one closed road run. Reference/midpoint Y is retained, but planar XTRK boundary columns still cannot store independent left/right edge Y or full banking.

Local integration checks passed: three native asphalt replay PNGs in **1.34 s**, and actual automatic private asphalt-cache creation in **3.46 s**. A **120,000-query** projection benchmark took **28.3406 s** (0.236 ms/query), with at most **193 strips / 386 edges**. Its query count is equivalent to twenty minutes at 100 Hz; this is **not** a twenty-minute real-time drive or a painting benchmark. Initial Python source-coverage checks and the Rust replay/cache checks test different stages and retain their own measurements above. A later isolated RSS repeat completed 120,000 queries in **28.7131 s** (0.239 ms/query), measured peak process working set **11.95 MiB**, CPU time **28.296875 s** and outer wall time **29.27 s**, with the same 193-strip/386-edge maximum. Memory covers only this query-test process, not the whole Companion, running game or mesh extraction.

The final local native suite passed **864 tests**, with fourteen ignored (878 total, 3.22 s), and Clippy passed for all targets. These aggregate checks include the later adapters; they do not replace the actual source-specific measurements above. The broader plan remains partial. Current EVO live UI/raw-reader acceptance is pending resolution of the owner's showroom/menu state; precise timeline firing, physical white-line centre/edge meaning, separate edge-height representation, additional builds/tracks and distribution rights remain open. No production publication or release-CI success is claimed.
