# LMU native source access: Laguna Seca

2026-11-17 desktop evidence, Steam app 2399420 build **25661166**, in the **unreleased Companion 0.11.0** candidate. Acceptance is **PARTIAL**. This proves selective access to a real LMU AIW and a distinct hash-pinned offline XTRK v2 export. Automatic runtime discovery, physical asphalt limits and a telemetry overlay remain unvalidated.

## Provenance and access

Installed component `Installed/Locations/LagunaSeca_2026/1.05/lagunaseca_2026.mft` names `layoutLaguna.mas` and `shared.mas`; the component declares Studio 397, version 1.05. The installation namespace scan visited 1,580 entries without truncation and found no loose AIW; container payloads remained unexamined in that initial metadata scan.

The 15,553,244-byte `layoutLaguna.mas` has a 124-byte header followed by a 3,084-byte index. Applying the published MAS2 header transformations yields **`LMU100_MAS_2.90`**, distinct from the original tool's accepted `GMOTOR_MAS_2.90`. The decoded index has a 12-byte prefix and twelve 256-byte entries. Every declared payload range is consecutive and the last ends exactly at the package size. Header plus encoded index SHA256 is `5ce939b4a66f3eb765ae94ad4864da25d8b2381bb7fcffd880f8b4c0cadf0dfd`.

Only `LagunaSeca.AIW` was selected: offset 276,100, compressed length 186,227, uncompressed length 1,189,437. Its zlib stream reaches EOF at the declared length with no trailing data. Extracted AIW SHA256: `34e6fc0f21f982f33b579e16eac9079e44bba986a83edfb98a7b0aa009289c82`. The archive header/index is obfuscated using the published format constants; this selected payload is ordinary compressed text. This does not prove that other packages or payloads use the same encoding. A 128-byte sample of the component's base `assetsGMTs.mas` did not decode to this accepted variant; mesh access remains unknown, not proved encrypted.

The original format implementation is [nlhans/MAS2Extract, MAS2Reader.cs at f26563f](https://github.com/nlhans/MAS2Extract/blob/f26563f1713ca7596d9baa580205a0fbfdc18611/MAS2Extract/MAS2Reader.cs). The diagnostic reads its published constants as data, verifies source SHA256 `681bf4f022c7b548b7b5b76e1e299bd5cfbc2bfb60a85a39d788b7c703bed3ba`, and never executes that source. No upstream source or proprietary asset is committed. [Studio 397's track structure documentation](https://docs.studio-397.com/display/DG/Track%2BStructure) describes the related rFactor 2 MAS/AIW packaging; the actual LMU file above supplies the compatibility evidence.

## Observed schema and coordinate evidence

The AIW declares 1,340 waypoints and `lap_length=3590.354736`. Observed fields include `wp_pos`, `wp_perp`, `wp_normal`, `wp_width`, `wp_dwidth`, `wp_score`, `WP_PTRS`, `wp_branchID`, plus five indexed `wp_pathinfo2`, `wp_oriantation` and `wp_pathflags` records per waypoint. **There is no `wp_path`**. Its `definepath` declarations name FASTEST, LEFT, RIGHT, BLOCK and FAST1. The meanings of the four `wp_pathinfo2` values need an independent proof before deriving a racing line.

Source comments identify `wp_width` as road left/right and far left/right; `wp_dwidth` distinguishes collision and cut corridors. These are authored AI/limit envelopes, not a surveyed asphalt or white-line boundary. [Studio 397's AI tutorial](https://docs.studio-397.com/display/DG/Track%2BAI%2BTutorial) separately describes main, collision and cut corridors; its semantics must not be collapsed into one road mesh.

A separate source-only diagnostic followed branch-zero `WP_PTRS.next`: **718** vertices form one closed cycle, all branch zero. Branch one has 402 vertices; other branch IDs exist and must not be joined into the circuit. The main cycle's 3D chord length is 3590.356268 m, 0.001532 m from the declared length. Main source XYZ bounds are X [-401.7826, 383.5904], Y [-15.5642, 39.3715], Z [-494.7530, 480.0583]. Left/right widths range [0.975, 10.725] and [1.750, 9.900] m. Perpendicular vector magnitude ranges [0.999938, 1.000067]; mean dot agreement with the planar `(dz,-dx)` normal is 0.998135. These checks support internal units, cross-sections and travel order; they do not independently prove LMU reader handedness, world origin or live alignment. No LMU recorded-lap fixture was available for comparison.

## Reproduce without modifying the game

Fetch the pinned original reader source into ignored local storage, then run the bounded probe:

```powershell
Invoke-WebRequest 'https://raw.githubusercontent.com/nlhans/MAS2Extract/f26563f1713ca7596d9baa580205a0fbfdc18611/MAS2Extract/MAS2Reader.cs' -OutFile '.codex-local/native-tracks/research-other/MAS2Reader.cs'
python scripts/inspect-lmu-mas.py --reader-source '.codex-local/native-tracks/research-other/MAS2Reader.cs' --self-test
python scripts/inspect-lmu-mas.py 'F:/SteamLibrary/steamapps/common/Le Mans Ultimate/Installed/Locations/LagunaSeca_2026/1.05/layoutLaguna.mas' --reader-source '.codex-local/native-tracks/research-other/MAS2Reader.cs' --extract-aiw LagunaSeca.AIW --out-dir '.codex-local/native-tracks/research-other/fresh-laguna'
```

Use actual manifest paths and a fresh output directory. The probe accepts only the observed LMU variant, caps index reads at 4 MiB and one explicitly selected AIW at 16 MiB compressed/uncompressed, rejects malformed ranges/counts/decompression and unsafe output names, refuses overwrites, and only extracts under this checkout's ignored `.codex-local`. Package metadata, not an entire large archive hash, binds this experiment. Seven synthetic success/hostile-input checks pass; the actual selected AIW reproduced the hash above.

Local artifacts: `.codex-local/native-tracks/research-other/lmu-laguna-index.json`, `lmu-laguna-access-v2.json`, `lmu-laguna-schema.json`, and `verified-laguna-v2/LagunaSeca.AIW`. Branch counting tolerates indentation; the independent next-pointer topology diagnostic establishes 718 main-cycle vertices. Proprietary files remain local.

## Offline adapter and verification

`xpeed-sim/src/tracks/lmu_aiw.rs` is a separate adapter, not a call to SCE's extractor. Its public `extract(&Path)` bounds the input to 16 MiB and refuses every AIW hash except the verified source above. It identifies game `lmu`, source `lmu_aiw`, component `LagunaSeca_2026/1.05`, and an explicit **source-world / telemetry alignment unverified** frame. No rotations, reflections, fitting or telemetry corrections are applied.

The adapter requires the declared total count, validates all pointer bounds, reciprocal main links, one closed cycle containing every main vertex, point spacing, declared 3D length and circular source-score agreement. It chooses the lowest-scored main waypoint as the distance origin, recording geometric cumulative distance; that does not prove the actual timing line. It exports each measured cross-section directly from signed `wp_width` and full stored `wp_perp`, shifts the midpoint using that same 3D vector (retaining banked Y), and leaves a full four-NaN boundary gap for unusable vectors/widths. The ideal line is absent: `wp_pathinfo2` is not reinterpreted as rF1 `wp_path`.

The 402 branch-one vertices are not one pit path. A unique main-connected chain contains **258** points (source indices 718–975); its interior links are reciprocal and all points pass the proximity gate. The other 144 branch-one extension vertices are excluded. Other branches/stalls are never joined. Pit widths remain NaN because the XTRK pit section cannot preserve these banked source cross-sections without replacing them with tangent-derived widths.

Targeted Rust verification:

```powershell
cargo test --manifest-path xpeed-sim/Cargo.toml tracks::lmu_aiw::tests -- --nocapture
cargo test --manifest-path xpeed-sim/Cargo.toml tracks::lmu_aiw::tests::real_verified_lmu_laguna -- --ignored --nocapture
```

Six synthetic test suites passed: count/graph/length/score corruption and disconnected cycles; signed variable widths/banked elevation; explicit invalid-row gaps; structurally validated nearby branch-one pits with detached extensions and unknown widths; bounded file/hash refusal; title/source/frame identity and no fabricated ideal line. The separately invoked local real-source test passed: 718 main points, 258 pit points, all measured main boundaries finite, XTRK v2 round-trip preserving title/frame identity. An independently calculated source-edge/midpoint-Y comparison over all 718 rows measured **0.000015234 m maximum float32 export error** (gate 0.000040 m). An actual 718-row Rust LMU export also passed the strict TypeScript reader with one closed road run. This is export/parser fidelity, not a recorded-lap overlay, physical-road or live-game accuracy.

## Remaining acceptance gate

Capture an actual LMU Laguna Seca lap and prove its reader frame against the source before enabling automatic discovery. Keep pits, collision/cut envelopes, source build/component version and cache invalidation explicit. Mesh classification, white lines, banking, distribution rights and live-game acceptance remain open.
