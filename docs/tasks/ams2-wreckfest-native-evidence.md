# AMS2 and Wreckfest 2 native-source evidence

Checked on the owner's desktop on 2026-11-17. This is a source probe, not a declaration of production geometry support. No game was started, installation modified, large archive unpacked, or geometry uploaded. The probe reads at most 8 MiB per selected file and caps Bag output at 8 MiB. Private decoded samples and full results stay under ignored `.codex-local/native-tracks/research-other/`.

## Reproduce

```powershell
python scripts/inspect-ams2-wreckfest-native.py --ams2 'F:\SteamLibrary\steamapps\common\Automobilista 2' --wreckfest2 'F:\SteamLibrary\steamapps\common\Wreckfest 2'
```

Synthetic hostile-input checks run without installed games or network access:

```powershell
python scripts/inspect-ams2-wreckfest-native.py --self-test
```

They cover valid literal and overlapping-backreference blocks, malformed headers, truncated block prefixes, invalid block lengths, truncated length extensions/literals/backreferences, invalid backreference offsets, and input/output caps. Truncation fails with `ValueError` before indexing or struct decoding. The self-test uses small output caps to exercise both pre-allocation limits.

The script emits metadata, bounds and schema candidates only. It does not export vertices or modify installed files. Its `aisc` record probe deliberately supports only the observed one-route version-4 case; it is not a general scene reader.

## Automobilista 2: container proved; geometry blocked

Steam app 1066890, installed build 25391793. Selected source: `Pakfiles/Tracks/Adelaide_Modern_Physics.bff`, 2,656,234 bytes, SHA-256 `8044fe3845fbeb150b48ce3775bdfe1feee7e5675d4fb1631ce339f09276c815`.

The file has ` KAP` magic, version word `0x10400004`, archive name `Adelaide_Modern_Physics`, a ten-entry count and a 420-byte table. These outer fields agree with the original author's [Open Madness Track Tools BFF writer](https://github.com/ohyeah2389/Open-Madness-Track-Tools/blob/4a74958a24e99e8b4376e5fe60aeaf7f4259b663/TrackPacker/bff_creator.py), which explicitly writes **unencrypted** BFF files. Its record layout is 42 bytes. Applying that plaintext record interpretation to this stock table produces out-of-file payload spans for all ten records. This is an explicit validation failure, not an empty archive.

Stock bytes at offsets `0x12c..0x12f` are `00 02 00 00`. The original [Luigi Auriemma QuickBMS reader](https://aluigi.altervista.org/bms/nfsshift.bms), script 0.2.5, treats byte `0x12d == 2` as RC4 mode and version 4 as an additional Project CARS-specific path. That reader's existence does not establish AMS2 compatibility; no decrypted table or payload was accepted here. OMTT's plaintext writer alone cannot read this observed stock table.

**Result:** accessible track-specific physics container, but no accepted AIW, collision mesh, border coordinates, material categories or world frame. Do not label this as native geometry support. Next gate is an AMS2-version-specific, bounded stock-table decode with every entry span checked, followed by one selectively decoded physics/AI payload. Then establish telemetry alignment on a recorded lap. A Project CARS family relationship is not proof of compatible geometry.

## Wreckfest 2: native AI-border candidate found in the small SCNE

Steam app 1203190, installed build 26269701. Selected files are under `data/art/levels/track01_1/`.

| Source | Stored / decoded bytes | Observed result |
|---|---:|---|
| `route1.scnh` | 5,402 / 23,879 | Bag wrapper 7; editor/prop scene references, no `airt` marker in this file |
| `route1rev.scnh` | 5,617 / 24,987 | Bag wrapper 7; no `airt` marker in this file |
| `track01_1.scne` | 4,850 / 7,937 | Bag wrapper 10; `airt` v3, one `aisc` v4, 76 candidate sectors |
| `track01_1.tcat` | 5,067 / 11,573 | Bag wrapper 7; `airt` v3, one `aisc` v4, 74 candidate sectors |

The `airt` location is found by a byte-marker scan, so matching records remain candidates until a full scene parser establishes structural membership. Marker presence and plausible values alone are not proof of accepted geometry.

SCNE SHA-256: `c479ae8ea1ab3b8c9c74e5c1ca6f644e66517e09cae01a47861c6d14cbfe15cf`. TCAT SHA-256: `8e77fae758926acedfda341bc0540b4565d610edbdcbd9bdf6e2d73ebc05f542`.

Decompression follows the published wrapper and LZ4 control flow in the original author's [bag-decompress source](https://github.com/gmazy/bag-decompress/blob/7ad3feb0c5b30d7e1ff18e093a2431420cf83e7c/source/main.c). Wrapper 7/10 blocks have an eight-byte prefix. The probe validates block/input/output bounds and backreferences; it neither invokes the original executable nor writes decompressed assets into the installation.

The original [Wreckfest Toolbox scene importer](https://github.com/gmazy/wreckfest_toolbox/blob/e03a57aa739c860a7721224bf417c454b8c755df/addons/io_import_wreckfest/__init__.py), function `make_airoutes`, identifies `airt` and `aisc`, reads left/right XYZ endpoints and four fractions describing safe/racing lines, and distinguishes main/alternate routes. It swaps native Y/Z only for Blender display. It does **not** establish asphalt boundaries. Its published WF2 loop consumes a different record size from the installed `aisc` v4 sample, so it cannot be reused unchanged.

The installed candidate has a consistent **64-byte sector stride**: six endpoint floats, eight intervening floats, and two remaining 32-bit words whose meanings are not established here. Every candidate float is finite. Both selected files give the same native horizontal endpoint bounds:

- X: -148.354 to 50.780.
- Z: -262.821 to 82.023.
- Paired endpoint distances: approximately 34.0–48.0 metres.

SCNE Y spans 1.576–5.794; TCAT Y spans -0.768–3.592. Their first paired X/Z endpoints agree while their Y values differ. Counts also differ. This is concrete evidence against blindly treating TCAT and scene routes as interchangeable, especially for heights or route closure. At each candidate array end, the next structure includes the same `tszo` tag (stored reversed as `ozst`) after the observed 32-byte trailer prefix. Complete trailer semantics are not decoded.

**Geometry meaning:** paired native AI corridor boundaries are a strong source candidate, with explicit left/right samples retained. They are not surveyed asphalt edges or a collision mesh. Do not shrink them into tangent widths, infer a road surface from the fractions, or assume that a closed race route follows simply from nearby endpoints.

**Frame:** XYZ are preserved as stored. The small Y range and wider X/Z ranges agree with the author's native Y-up/display-axis convention, but there is no accepted recorded-telemetry overlay yet. No handedness, rotation, scale adjustment or world transform is inferred. Scene placement and any parent transform still require proof.

**Result:** one concrete, bounded native AI-border schema candidate; not yet an accepted XTRK adapter. Required gates are a complete installed-v4 record/trailer decode, scene-to-track identity and transforms, start/end/closure semantics, alternate/reverse routing, and a real telemetry comparison. `route1.scnh` and `route1rev.scnh` being prop scenes does not prove the game lacks separate route data. The 31 MB `track01_base.scne` and 19 MB terrain were not opened by this probe.

## Scope and next decision

AMS2 remains blocked at its stock table. Wreckfest 2 advances from “loose files exist” to “bounded AI endpoint candidate in native SCNE/TCAT”; it remains blocked for production until topology, record semantics and frame alignment pass. Neither result justifies adding these games to an automatic public geometry uploader or treating AI envelopes as asphalt.

## Verification of this probe

`--self-test` passed: two valid blocks, twelve hostile inputs, and literal/match output caps. The bounded installed-file command also completed successfully after the parser cleanup; it reproduced the sizes, counts and bounds above. These are local probe checks, not a published or production parser test suite.
