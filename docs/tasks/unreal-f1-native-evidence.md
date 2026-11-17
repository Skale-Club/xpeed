# ACC, Rally and F1 native source evidence

2026-11-17 desktop follow-up for the **unreleased Companion 0.11.0** candidate. Overall acceptance is **PARTIAL**. This records read-only source access and offline export evidence. No game started or changed, no decryption keys sought, no complete package unpacked, and no huge archive hashed. Only bounded headers, indices and explicitly selected F1 spline fragments were read. Proprietary bytes and decoded trees stay under ignored `.codex-local/native-tracks/research-other/unreal-f1/`.

## Actual access results

| Title / installed Steam build | Measured source access | Geometry status / next gate |
| --- | --- | --- |
| ACC / 21257365 | Main 17.739 GB PAK has a valid version-11 footer and **encrypted index flag 1**. The declared index range fits inside the actual file. | Filename enumeration is blocked by the encrypted index in this observed package. Obtain a permitted readable developer export/index before identifying a track source; no keys searched or invented. Telemetry support does not resolve this source-access gate. |
| Assetto Corsa Rally / 25170642 | Actual IoStore v8 TOCs have flags 0x09, compressed/indexed and **not encrypted**. Bounded directory reads enumerate real stage maps, including AlsaceS2Munster. Selected map block metadata identifies Oodle compression and exact UCAS ranges. | Index access is proven. A stage map's cooked actor/mesh/spline serialization and a position-capable telemetry channel are still unproved. Do not unpack its entire 73.7 MB logical chunk merely to infer road widths. |
| F1 25 / 26566308 | Actual ERP v3 tables enumerate `AISplineData`, `TrackSpace` and `TrackInfoBinary`. Selected AISplineData/TrackSpace Zstandard fragments decode to complete, structurally validated little-endian BXML. | **Source-labelled white-line offsets, positions, normals and main/pit graph are proven**, separately from racing/track/runoff limits. Reader frame, physical line interpretation and annual/season-mode binding still require a real recorded-lap comparison. |

## ACC: exact footer blocker

`AC2/Content/Paks/AC2-WindowsNoEditor.pak` is 17,739,118,241 bytes. A 512-byte tail read contains the standard PAK magic at file offset 17,739,118,037. Its 221-byte version-11 footer starts at 17,739,118,020. The index offset is **17,724,127,572**, its length **8,592,272**, and declared SHA1 `e88e3a6eb114489641af83cd812de5e9e23c3af9`. The byte immediately before the magic is **1**, the index-encrypted flag; the preceding GUID field is zero. This proves encrypted index metadata, not that every payload is encrypted. No index or asset payload was read.

The field ordering and encryption distinction were checked against the original [repak footer reader](https://github.com/trumank/repak/blob/355b5f62f51959c7cc6dd5a51708646ef483065d/repak/src/footer.rs) and [index reader](https://github.com/trumank/repak/blob/355b5f62f51959c7cc6dd5a51708646ef483065d/repak/src/pak.rs). The next gate is source access supplied through a permitted developer/export route; file extension and Unreal family alone do not establish any ACC road geometry.

## Rally: readable IoStore index, cooked geometry still open

Epic's [Zen Loader documentation](https://dev.epicgames.com/documentation/unreal-engine/zen-loader-in-unreal-engine?lang=en-US) distinguishes TOC metadata from UCAS chunk data, and its [FIoStoreReader API](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/FIoStoreReader?lang=en-US) exposes chunk enumeration and container flags. The original [retoc TOC/index implementation](https://github.com/trumank/retoc/blob/885a8dae740cb1ce1e41ff2e74f67f9f0c118237/retoc/src/lib.rs) supplies the inspected binary layout.

`acr/Content/Paks/pakchunk0-Windows.utoc` is 7,560,262 bytes. Its 144-byte header declares version 8, 20,121 entries, 490,287 compressed blocks, 65,536-byte logical block size, 10,061 perfect-hash seeds and flags 0x09. The directory index is **710,832 bytes at offset 6,366,526**, SHA256 `04bc0462d172dd9d30132d262bf793d6d0e7c6bf446cd28dd278429459637e05`. Parsed data contains 943 directory records, 16,206 file records and 14,607 strings; all reachable directory/file records were visited once with bounded names and valid entry indices. The directory plus declared per-entry metadata lands exactly at EOF.

The actual stage asset `acr/Content/Levels/AlsaceS2Munster.umap` maps to TOC entry 11042, logical offset 1,821,376,512 and logical size **73,708,488**. Its first block has UCAS offset **628,097,024**, compressed size **42,618**, uncompressed size **65,536**, method index 1 = **Oodle**. That stored range fits inside the actual 11,586,678,448-byte UCAS. The block payload was not read. Additional bounded indices from chunks 1/12/13/14/15 identify gameplay assets and Alsace shared materials, not a verified road spline.

No `repak`, `retoc` or `UnrealPak` executable was found on PATH or in the checked game Engine/Binaries/Win64 locations. This is a tooling observation, not proof that the game contains no other tools. Next: a selective cooked-package reader with the proper Oodle interface, the stage's actor/class schema and measured road/spline fields, followed by position-capable telemetry and an open-stage frame/identity proof. No shape is inferred from material names or a map thumbnail.

## F1 25: readable actual spline and white-line fields

The selected sources belong to **`2025_asset_groups`** in installed build 26566308. Active annual versus 2026 season mode was not observed. The source is not automatically assigned to every packet format, season, short layout or older F1 title. The current reader resolves Brazil as circuit ID 16 and preserves raw motion world position; that mapping alone does not prove this asset's coordinate frame.

The original [ERP reader](https://github.com/EgoEngineModding/Ego-Engine-Modding/blob/f3fe9ee0f6e8379c64bc4a29e1d1b586bba5d1c1/src/EgoEngineLibrary/Archive/Erp/ErpFile.cs), [resource layout](https://github.com/EgoEngineModding/Ego-Engine-Modding/blob/f3fe9ee0f6e8379c64bc4a29e1d1b586bba5d1c1/src/EgoEngineLibrary/Archive/Erp/ErpResource.cs), [fragment reader](https://github.com/EgoEngineModding/Ego-Engine-Modding/blob/f3fe9ee0f6e8379c64bc4a29e1d1b586bba5d1c1/src/EgoEngineLibrary/Archive/Erp/ErpFragment.cs) and compression enum were checked as primary format implementations. Local metadata parsing reads no resource payloads while enumerating entries:

| Actual relative file | File bytes | Metadata bytes / offset | Resource / fragment count | Metadata SHA256 |
| --- | ---: | --- | --- | --- |
| `2025_asset_groups/environment_package/tracks/brazil/brazil_common.erp` | 19,774,605 | 460,268 / 48 | 2,225 / 3,577 | `e17bd5d850ca39a3096f5aa89e53cd266a68f5a9d4da619f618b8b9c29e1a178` |
| Same folder, `wep/brazil_common.erp` | 74,782,090 | 1,023,195 / 48 | 5,368 / 8,278 | `3513899b808d787324bf3da3f127d0aae18e5fc1c49af5073ba074e7e8a04858` |

Every metadata entry ends at its declared boundary, all fragment ranges fit the file, counts match, and metadata consumption is exact. The WEP source contains `eaid://environment_package/tracks/brazil/ai/brazil_ai_track.aispline` and `brazil_ai_track.trackspacespline`.

Only three selected fragments were read, **35,390 compressed bytes total**. Compression ID 0x11 is Zstandard. The existing Node 24 decoder, capped at the declared output size plus one, produced exact lengths:

| Selected fragment | Offset / packed bytes | Decoded bytes / SHA256 |
| --- | --- | --- |
| AISplineData main | 1,029,500 / 26,622 | 304,194 / `a213971176184e152d112dc83d9e898492ccee71faf8d955d7bed6600194904f` |
| AISplineData auxiliary TSMD | 1,056,122 / 94 | 120 / `b69c76330331999f06f5103db873c766e9305392cb46c1914afd86346930dcb2` |
| TrackSpace main | 69,800,855 / 8,674 | 41,677 / `717bbe19c83e66f81285296b2f54d0a9efd16e629dfbbc57dc570bda500fad7d` |

Both main payloads are `0x01 BXML`. `scripts/inspect-ego-bxml.py` validates the little-endian records against the original [BXML reader](https://github.com/EgoEngineModding/Ego-Engine-Modding/blob/f3fe9ee0f6e8379c64bc4a29e1d1b586bba5d1c1/src/EgoEngineLibrary/Xml/XmlBinaryReader.cs) and [document writer](https://github.com/EgoEngineModding/Ego-Engine-Modding/blob/f3fe9ee0f6e8379c64bc4a29e1d1b586bba5d1c1/src/EgoEngineLibrary/Xml/XmlFile.cs). It checks record lengths, UTF-8 strings, duplicate attributes, nesting/node limits, closing records and the exact double end-of-document marker, consuming every byte. It caps input at 4 MiB and writes decoded proprietary trees only into ignored local storage without overwriting.

### Schema and geometry observations

The AI source root is `track name=default`. It contains **393 gates**, **394 links**, two routes and 3,325 waypoint offsets. Every gate has a 3D `position`, 3D `normal` and named scalar offsets. All 393 have `left_racing_limit`, `right_racing_limit`, `left_track_limit`, `right_track_limit`, `racing_line`, **`left_white_line` and `right_white_line`**. Only 287 have left/right runoff offsets. These are distinct source labels; none is substituted for another.

Track route link IDs 0–286 prove a closed directed graph containing exactly **287 main gates**. Pit links 287–393 join main gate 262 through **106 pit gates**, exiting at main gate 60. No pit closure is invented. Main gate normals have magnitudes [0.999999324, 1.000000615] and mean agreement **0.993461** with the geometric source right-side normal. Thus signed negative offsets point left in this source contract. Left white-line offsets range [-12.8711, **+0.316021**] and right offsets [**-0.150395**, 16.1099]; clamping either side at zero would move actual source boundaries. White-line span ranges [6.5388, 17.10978] m.

Source-only point placement is `gate_position + signed_offset * stored_normal`, preserving the full source vector. This establishes authored labelled cross-sections; whether a white-line offset denotes its centre or an edge, whether it is the game's legal surface, and its agreement with physical asphalt remain separate questions.

The main gate 3D chord length is **4216.539441 m**, with segment lengths [9.204832, 47.196316] m. TrackSpace independently contains **659 maintrack knots** (open 3D length 4288.661166 m; end gap 4.948911 m) and **126 pit_1 knots** (open length 1711.358341 m). These are different representations and lengths: do not stretch either, substitute one timing distance for the other, or assert the finish line from the first record. No committed F1 recorded-lap fixture was found in the checked fixture inventory, so no telemetry-frame proof is available yet.

### Checks and local reproduction

```powershell
python scripts/inspect-ego-bxml.py --self-test
python scripts/inspect-ego-bxml.py '.codex-local/native-tracks/research-other/unreal-f1/AISplineData-0.zstd.raw'
python scripts/inspect-ego-bxml.py '.codex-local/native-tracks/research-other/unreal-f1/TrackSpace-0.zstd.raw'
```

Eight synthetic BXML success/hostile-input checks pass. Both actual BXML documents parse completely. The ignored `probe.py` reproduces ERP metadata and IoStore directory parsing; `check-f1-source.py` independently checks the actual route graph, normals and signed offset statistics. These are research diagnostics, not general production archive readers. Source commit and reference-file SHA256 snapshots are saved in `source-commits.json` and `reference-code-sha256.json`.

Important artifacts in the local folder: `initial-probes.json`, `rally-index.json`, `rally-selected-map.json`, selected chunk `.index.json` files, `f1-index.json`, `f1-wep-index.json`, `f1-selected-compressed.json`, `f1-selected-decoded.json`, `ai-spline-tree.json`, `trackspace-tree.json`, and `f1-source-geometry-schema.json`. No proprietary fixture or decoded tree is committed.

## Delivered offline F1 source adapter

`xpeed-sim/src/tracks/f125_spline.rs` now implements the separate, manual `f125-spline` extraction path. Input is the selectively decoded AISplineData main BXML above, capped at 8 MiB and pinned to SHA256 `a213971176184e152d112dc83d9e898492ccee71faf8d955d7bed6600194904f`. It does not open an ERP, discover an installation, upload geometry or automatically match a recording. The exported title is Brazil, game `f1`, source `ego_white_line`, with variant `2025-source/season-layout-unverified` and an explicit raw source-world / telemetry alignment unverified frame.

The borrowed BXML reader enforces record/string/count/node/depth bounds, unique attributes, exact closing markers and full consumption. Known geometry declarations must match their actual counts; extra unknown metadata is skipped structurally. The main directed route requires one incoming/outgoing edge per member and exactly one closed cycle. The optional pit route must be one unique ordered chain with main-connected endpoints, no internal main traversal or repeated gates, and bounded proximity; invalid pit topology is omitted. No other route is promoted to a circuit.

Each measured white-line boundary is `gate_position + signed_white_line_offset * stored_normal`. Source normals are validated as right-pointing; the exported centre is the midpoint along the full stored vector, including Y. Signed offsets are preserved, never clamped. XTRK v2 stores explicit sampled X/Z edges, leaving full four-NaN gaps for unusable rows. The fast section uses only the actual source `racing_line` offset when every main row is usable; it is not a fitted or invented optimal trajectory. Pit positions remain an open path and pit widths remain unknown because this XTRK section cannot preserve banked native cross-sections.

Distance is cumulative main-gate 3D chords from the lowest gate ID, with the measured 4216.539441 m chord length. TrackSpace knots, real timing/finish origin and official nominal lap length are not substituted. Source-labelled white lines remain distinct from racing limits, track limits, runoff, asphalt edges and physical line centre/edge semantics.

Eight synthetic Rust suites are now covered by the passing aggregate tracks run (90 passed/eight ignored). The explicitly invoked real-file test also passed. The real source yielded **287 main points, 106 pit points**, every main boundary finite, a source racing-line section and an XTRK v2 round-trip. Independent direct source-coordinate calculations for all 287 boundary/midpoint-Y rows measured **0.000030477 m maximum float32 error**, below the 0.000040 m gate. All **seven signed-offset exceptions** were retained. Synthetic cases cover malformed BXML, duplicate/deep structures, counts, graph corruption, signed variable cross-sections/banked Y, invalid-row gaps, pit joins/proximity and hash/file-size refusal. The passing checks include explicit string/attribute/node-budget limits. The final full native run passed 864 tests/fourteen ignored, and Clippy passed for all targets.

```powershell
cargo test --manifest-path xpeed-sim/Cargo.toml tracks::f125_spline::tests -- --nocapture
cargo test --manifest-path xpeed-sim/Cargo.toml tracks::f125_spline::tests::real_verified_f1_brazil -- --ignored --nocapture
# Explicit offline CLI, after building Companion:
xpeed-sim/target/debug/xpeed-companion.exe track-dump f125-spline '.codex-local/native-tracks/research-other/unreal-f1/AISplineData-0.zstd.raw' '.codex-local/native-tracks/research-other/unreal-f1/brazil-source.xtrk' --preview '.codex-local/native-tracks/research-other/unreal-f1/brazil-source.svg'
```

The explicit F1 CLI export produced a 13,152-byte gzip XTRK; the actual 287-row export passed the strict TypeScript reader with one closed road run. These are export/import checks, not an accepted overlay. Automatic association requires actual Brazil telemetry, annual/season/layout identity, source invalidation and a measured coordinate/timing contract. No F1 recorded-lap fixture was available; this task proves native source/export fidelity, not live or physical-road accuracy.
