# AC and Stock Car Extreme source cross-sections

Offline extraction evidence, 2026-11-17. Implementation: `xpeed-sim/src/tracks/ac.rs` and `aiw.rs`. No game was launched and no live telemetry was captured. Original game assets were read only; local exports are under ignored `xpeed-sim/target/native-evidence/`.

## Sources and coordinate contract

Steam library: `F:/SteamLibrary`. Manifest 244210 identifies Assetto Corsa build **14923034**, installed in `assettocorsa`. Manifest 273840 identifies Stock Car Extreme build **976660**, installed in `Stock Car Extreme`. Only Automobilista 2 was found among the installed Automobilista/rFactor directory names; this work does not enable AMS1 or rFactor1 by inference.

Both readers retain source world metres, x/y/z unchanged, y up, and source travel order. No rotation, reflection, scaling or visual alignment was introduced. This is source/export fidelity evidence, not independent proof of the raw telemetry coordinate contract. AC map metadata remains the existing offline cross-check. SCE still needs a recorded real lap and verified telemetry track identity before an automatic match can be called proven.

AC version-7 `fast_lane.ai` detail records contain 18 float32 values: signed side offsets at indices 5/6, surface normal at 9/10/11 and forward at 13/14/15. The source left basis used here is `normalize(normal × forward)`, retaining its vertical component. Normal and forward must be finite, approximately unit length (0.9–1.1), approximately orthogonal (absolute dot product at most 0.1), upward-facing normal y at least 0.5, and forward aligned with local path travel (dot at least 0.8). At least 95% of samples must have usable bases for source-vector extraction. These checks qualify a source basis; they do not turn the AI envelope into a physical survey.

SCE AIW comments define `wp_perp` as the unit lateral vector; `wp_width` supplies road-left/right distances and separate far-left/right runoff distances. Only the road pair is used. Main-path points follow `WP_PTRS` from minimum `wp_score`, preserving the start-line ordering. Edges use the full stored vector: `wp_pos + left * wp_perp`, `wp_pos - right * wp_perp`. The dry line uses `wp_pos + wp_path[0] * wp_perp`. Horizontal re-normalization was removed, because it changes banked source cross-sections.

## Representation and uncertainty

Qualified sources emit existing XTRK v2 explicit boundary rows. The midpoint and its elevation come from the same source cross-section; widths become equal positive half-spans. Negative original side offsets are preserved, allowing the reference line to lie outside its envelope. Zero side offsets retain the existing unmeasured interpretation; absent/invalid sections remain four NaNs, with width NaNs and a warning. No gap is interpolated. Individual invalid SCE vectors also suppress the optional dry line instead of inventing positions.

AC files without sufficiently consistent source vectors retain the existing v1 tangent-derived approximation and now report that classification explicitly. Unknown widths still produce a reference line only. A structural read-only scan found 527 complete version-7 AC files, with 1,290,344 samples passing only the unit/orthogonality subset and 478,708 failing it; those figures include files the full extractor may refuse and are not acceptance totals. This explains why blanket source-vector trust would be incorrect for mods.

The output is a **sampled AI side envelope**, not recovered asphalt, white-line limits, kerbs, walls or runoff. XTRK v2 stores edge x/z only, so it does not independently represent edge heights or banking. Pit lanes retain the existing v1 width representation; this work does not claim precise explicit pit boundaries. Existing generic v1 parser/golden-fixture code was not changed.

## Actual installed acceptance and independent export comparison

Two ignored representative tests read six installed sources, export local v2 files, and check pack/unpack/pack equality. An independent Python check decoded the exported XTRK column sections, read the original AC binary or AIW text directly, followed the AIW chain, and recalculated every known edge using the formulas above without importing the Rust extractor. Maximum absolute x/z coordinate errors are float32 export rounding, not estimates of road accuracy. All were below the chosen **0.00025 m** export-fidelity threshold.

| Source | Explicit / total sections | Maximum edge error (m) | Source SHA-256 |
|---|---:|---:|---|
| AC Monza `monza/ai/fast_lane.ai` | 3749 / 3750 | 0.000061025 | `56704d910b4ab39540bd431f7007ff90bee8583651ee8629c6bdfe33aae2e55d` |
| AC Spa `spa/ai/fast_lane.ai` | 4468 / 4470 | 0.000060924 | `b1d3d636c0d59302fbb44d3f63ee92d8d1ea4678d5b74c7072f77bcded2e1834` |
| AC Imola `imola/ai/fast_lane.ai` | 3166 / 3166 | 0.000030514 | `aff2862f2194e2d3919d8eb0a4ae4485259228de06e52f70b8bbc89330c4d220` |
| AC Magione `magione/ai/fast_lane.ai` | 1754 / 1754 | 0.000015238 | `a2976adfe70b25da0a46ee6b09ab464650ea09161d9534aac526ab4210fba6b9` |
| SCE `Interlagos/InterlagosGP/InterlagosGP.AIW` | 851 / 851 | 0.000030254 | `8331ac1241da59bcd05e8862cd6618dae643255aa7bd0819d0d5904305e6558f` |
| SCE `BolognaHistoric/BolognaHistoric/bolognahistoric.AIW` | 951 / 951 | 0.000030508 | `65d45fc32348a4b4117b3e19e2faa983b443534d034e0b83dc6e88fbbd3e8488` |

Independent SCE dry-line errors: InterlagosGP 0.000030396 m; BolognaHistoric 0.000030420 m.

Unknown source bases were retained at AC Monza index 2743 and Spa indices 4018 and 4026. The stored normals are substantially non-orthogonal to their forward vectors; they are rejected rather than replaced by a path tangent. Their side distances are present, so these gaps specifically communicate an invalid source basis.

## Tests and reproduction

Executed sequentially from `xpeed-sim`:

```powershell
cargo test tracks::ac::tests -- --nocapture
cargo test tracks::aiw::tests -- --nocapture
$env:XPEED_AC_DIR='F:\SteamLibrary\steamapps\common\assettocorsa'
$env:XPEED_SCE_DIR='F:\SteamLibrary\steamapps\common\Stock Car Extreme'
$env:XPEED_TRACK_EVIDENCE_DIR="$PWD\target\native-evidence"
cargo test exports_representative_installed -- --ignored --nocapture --test-threads=1
```

Results: **15 AC tests passed**, **11 AIW tests passed**, **2 representative installed tests passed**. Synthetic additions cover signed offsets outside the source envelope, banked source vectors and midpoint elevation, degenerate/nonfinite bases, NaN gaps, labelled legacy fallback, a 62 km / 12,000-sample AC loop and a 20,000-waypoint nonrecursive AIW pointer chain. Existing malformed/truncated input and parser tests also passed. The first AC run exposed an existing assertion expecting no additional warnings; it was updated to accept the new explicit legacy-approximation warning, and the rerun passed.

After available memory recovered, the root agent ran `cargo test validates_every_installed -- --ignored --nocapture --test-threads=1`: both full installed corpus checks passed in 163.56 seconds. AC inspected 534 files (including 10 backups), accepted 495 (477 closed, 18 open, 472 with pits), and refused 39 with explicit diagnostics. Three accepted sources have no usable widths and remain line-only; 303 carry warnings, including labelled tangent approximations or explicit missing sections. SCE accepted all 70 files, with dry lines and pits. These are parser/source checks, not recorded-lap or live telemetry acceptance. Independent AC/SCE recorded laps and verified live track identities remain required before claiming that acceptance.
