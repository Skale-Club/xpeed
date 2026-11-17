# Assetto Corsa EVO native geometry pilot

Status: offline pilot implemented on 2026-11-16, not released. Branch: `codex/acevo-native-track-pilot`. Parent task: [native track geometry](https://app.notion.com/p/41bb7a686121817fb7dfdd4f71792d15).

## Proven source and scope

The desktop installation is Steam app 3058630, build **25170311**. Its `content.kspkg` contains `content/tracks/laguna_seca/layouts/`:

| File | Evidence and use |
| --- | --- |
| `layout_laguna_seca.ideal_line.aisplinedata` | 2,135 spline positions and matching AI payloads; closed; length 3555.150719 m; source world Y 258.209442–313.383453 m. |
| `layout_laguna_seca.pitlane.aisplinedata` | 552 open-path positions; source length 1228.350109 m; side widths absent. |
| `layout_laguna_seca.trackcontrolpoints` | 52 named control points exactly coincide with source spline positions; used to investigate side conventions. |

Selected files were extracted with [ACEvo.Package CLI 1.1.0](https://github.com/Nenkai/ACEvo.Package) (source checkout `047fd596`). Schemas were recovered from the installed executable with [AC EVO Data Tools](https://github.com/Breakalien/ac-evo-data-tools), checkout `0fd4377b`. The CLI's list command briefly generated `content_files.txt` beside the archive; it was moved into the ignored research folder immediately. No original game files were changed.

Source ideal SHA-256: `b547920c27c1e5732567ad078213aa0cd3afe1b536e9f0ffc24dd22df915409e`.
Source pit SHA-256: `c3c81c4a4ce1f126eab78a695fde2e4099e4d1a5ea9599e2772e44e4aaaf03bf`.

The public extractor pins these hashes and the Laguna Seca identity. Changed assets require revalidation. Proprietary assets, recovered schemas, binaries and generated geometry remain under ignored `.codex-local/acevo-pilot/`; redistribution permission has not been established. Nothing is uploaded automatically by this pilot.

## Geometry and format

EVO positions are transformed exactly like the current reader: `(-source.x, source.y, source.z)`. Historical lap fixtures predate that correction, so validation reflects their x in memory; their files are unchanged. No fitted rotation, translation or scale is used.

Source `sides_0` corresponds to source left and `sides_1` to source right. After reflection they use the opposite sides of Xpeed's `(t.z,-t.x)` normal. The source forward vector defines each section. Negative side values at 27 positions are meaningful: the ideal line can lie outside the AI road-side envelope. They are preserved in the calculated boundary coordinates, never clamped.

The old midpoint/width representation would move some borders by **2.50 m** when recalculating normals. XTRK **v2** therefore preserves four explicit planar columns: `left_x,left_z,right_x,right_z`, point for point with the source line. V1 serialization remains byte-identical. Both the website reader and Companion projection use explicit boundaries when present; missing rows remain gaps. The native renderer fills its strip in one compound path to avoid per-quad antialias/transparency seams.

The source `point_length` is retained without rescaling. Its origin has not been proven to be the timing line. The source spline length is 3555.15 m whereas historical telemetry reports 3602 m; do not use their distance channels interchangeably without investigating this difference. Spatial overlay uses world positions.

## Measured evidence

`scripts/verify-acevo-track-pilot.py` independently decodes the source with its recovered descriptor and compares the Rust export, then projects three historical recordings onto source segments.

- Export: 82,172 bytes compressed, 2,135 boundary rows, 552 pit positions.
- Maximum exported boundary error against source-forward offsets: **0.0000214 m** (float32 rounding). This measures serialization, not physical track accuracy.
- Longest source step: 8.192 m; closing step: 4.927 m. Connecting samples is piecewise linear, not a recovered asphalt mesh.
- Valid lap 3: 9,923 samples; **0.897%** exceed the native side envelope by more than 0.5 m; maximum excess 0.827 m. Height error p95: 0.323 m.
- Invalid laps 1/2: 22.917% / 5.203% exceed that tolerance. These are observations, not map-error estimates.
- Control-point side values differ from AI payload sides: median 0.00132 m, p95 0.849 m, maximum 77.584 m. One authored control point has a 78.775 m side while its AI payload has 1.191 m. They support side orientation but **do not prove exact asphalt, kerb or white-line boundaries**.

Three native dashboard frames replay real lap positions with the extracted road. These exercise the actual projection and GDI renderer, not the live game's shared-memory reader. Local validation JSON, overview PNG, SVG and native PNGs remain in `.codex-local/acevo-pilot/`.

Verification: full native suite **831 passed, 7 ignored**; explicit local native replay **1 passed**; final targeted tracks suite **58 passed, 2 ignored**; web track/parser/library/analysis suites **83 passed**; TypeScript checks, targeted ESLint, `cargo fmt`, Clippy with warnings denied and diff checks passed. The actual Rust-generated v2 export also passed the website's strict TypeScript reader (2,135 points, 552 pit positions, one closed road run). Three native frames and the independent overview were inspected. Final read-only review found no correctness blockers. No release CI, live-game acceptance or production deployment was performed. Initial diagnosis estimate was 30 minutes; the offline pilot and checks took about 20 minutes, followed by journal closeout.

## Reproduce locally

Use `list-files` then `unpack-file` for the three paths above; never unpack the entire package or change the installed game. Recover descriptors from the installed executable into the ignored folder. Keep the optional pit file beside the ideal file with its original basename.

```powershell
cargo run --manifest-path xpeed-sim/Cargo.toml -- track-dump acevo .codex-local/acevo-pilot/extracted/content/tracks/laguna_seca/layouts/layout_laguna_seca.ideal_line.aisplinedata .codex-local/acevo-pilot/laguna-seca.xtrk.gz --preview .codex-local/acevo-pilot/laguna-seca.svg
python scripts/verify-acevo-track-pilot.py --descriptor .codex-local/acevo-pilot/acevo.desc --ideal .codex-local/acevo-pilot/extracted/content/tracks/laguna_seca/layouts/layout_laguna_seca.ideal_line.aisplinedata --controls .codex-local/acevo-pilot/extracted/content/tracks/laguna_seca/layouts/layout_laguna_seca.trackcontrolpoints --track .codex-local/acevo-pilot/laguna-seca.xtrk.gz --out .codex-local/acevo-pilot/validated --steam-build 25170311
$env:XPEED_EVO_PILOT_TRACK = (Resolve-Path .codex-local/acevo-pilot/laguna-seca.xtrk.gz).Path
$env:XPEED_SIM_PANEL_PNG = (Resolve-Path .codex-local/acevo-pilot/validated).Path
cargo test --manifest-path xpeed-sim/Cargo.toml native_evo_pilot_replays_real_lap_with_source_boundaries -- --ignored --nocapture
```

The verifier uses Python 3.11, protobuf, numpy, scipy and matplotlib. Its acceptance is an offline extraction/alignment gate: export error <1 mm, control-point positions <1 cm, median control-side difference <5 cm, source steps <10 m; at least one valid lap with <2% of samples outside by >0.5 m and height-error p95 <0.5 m. It does not certify the road mesh or live operation.

## Remaining acceptance

Inspect real physics/render mesh and white-line/kerb semantics, especially the disagreeing control points. Verify timing origin, source length and game-version identity. Capture current raw EVO telemetry and validate in the running game. Then add explicit local cache/discovery, stale-cache invalidation and permitted distribution policy before automatic integration. Other EVO circuits and simulator families remain unimplemented. Existing production and the old approximate OSM/GT7 visual prototype are unchanged.
