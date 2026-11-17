# Companion dashboard preview

Open `companion-live-preview.html` directly in a browser on any computer. It is a self-contained offline document: recorded telemetry, approximate road geometry, fonts, styles and scripts are embedded. Source links require a connection only when opened. No server or dependency installation is needed.

The dashboard plays a sanitized Assetto Corsa EVO recording from Laguna Seca. Pause/continue, replay, scrub and select 1×/2×/4× playback. Playback ends at the recorded lap's finish and starts paused when reduced motion is requested. Tyre values are unavailable in this historical recording and are shown as missing.

`companion-live-preview.fragment.html` preserves the editable conversation fragment. The standalone document was generated with the Visualize `render.py` wrapper; unused icon/tooltip scripts that would load remote resources were removed from that export. Its local state bridge remains. The full Chakra Petch font license is retained in both files.

## Geometry and provenance

This is an **approximate cross-game design preview**, not production native integration or an official extraction of the AC EVO track. The dark road surface is built from projected polygons; variable road borders come from a GT7 survey registered to an independent mapped centerline. Missing survey sections are interpolated and have dashed borders. The cyan driven trace comes from the actual EVO recording, with its historical x coordinate normalized to the current EVO reader convention. Elevation is omitted.

- GT7 borders: [original raw Laguna Seca survey](https://raw.githubusercontent.com/jbhoorasingh/gt7-datalogger-track-data/main/tracks/weathertech-raceway-laguna-seca.json), [source repository](https://github.com/jbhoorasingh/gt7-datalogger-track-data) — CC0.
- Centerline: [© OpenStreetMap contributors, Laguna Seca way 10464852](https://www.openstreetmap.org/way/10464852) — [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- Fonts: Chakra Petch — SIL Open Font License 1.1; embedded license notice included in the HTML.
- Recording: sanitized historical AC EVO lap 3, Audi R8 V10 performance quattro, 1:42.609; no invented reference lap or tyre measurements.

## Production boundary and next work

Companion v0.9.0 has a native live perspective renderer. Its automatic game-file track extraction currently supports Assetto Corsa (`ac`) and Stock Car Extreme (`rfactor1`, layout format game `sce`) only. It does not use this preview's GT7/OSM geometry.

Robust geometry acquisition for **all supported games** is future work to resume on the home desktop. Establish each source's geometry, road-width coverage, coordinate frame, provenance and licensing; preserve unknown spans instead of claiming approximate borders are exact. No new extraction implementation is included here.

The current CLI/reader game IDs are `lmu`, `ac`, `acc`, `acr`, `ams2`, `pcars2`, `pcars3`, `wreckfest2`, `f1`, `f124`, `f123`, `acevo`, `rfactor1`, `ams1`, `rf1`, `iracing`, `r3e`, `fm`, `fm7`, `fh4`, `fh5`, `fh6` (22). Reader-family aliases are not additional games.

Next task: [Notion handoff](https://app.notion.com/p/41bb7a686121817fb7dfdd4f71792d15), mirrored in [native-track-geometry.md](../tasks/native-track-geometry.md).

## Lightweight verification

Run `node docs/prototypes/validate-companion-preview.mjs` from the repository root. It executes the actual fragment script with a small fake DOM and checks playback controls, delayed host-state echoes, finite replay, reduced motion, and road projection at three widths and five lap positions. It needs no server or dependencies and writes no output files. This validates behavior and numerical geometry, not full browser layout or live-game accuracy.
