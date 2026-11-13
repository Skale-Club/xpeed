# Vehicle presentations and shared brand identity

Home prefers a verified owner cutout, then an exact matching 3D model with a transparent PNG poster. A missing model, unknown year, failed catalog, or failed image has no generic vehicle substitute and reserves no empty space. Ordinary owner photographs remain available in My cars; Home only shows PNG/WebP owner images with meaningful alpha transparency verified through CORS-enabled canvas decoding.

## Library and initial coverage

The viewer is [`@google/model-viewer` 4.4.0](https://modelviewer.dev/), loaded dynamically only for a matching interactive model. Mouse dragging, keyboard controls, and touch rotation are native viewer features; `touch-action="pan-y"` preserves page scrolling. There is no automatic rotation. Posters cover loading, unavailable WebGL, or a failed GLB. Author/source and license links remain beside the asset.

The source library is [`pedrosoandre/carros`](https://github.com/pedrosoandre/carros), pinned at `2d18dfd9db96bbf0d9cffa949deaf7f571388cbf`. Its README still describes private installation, but the public GitHub API and pinned GLB URLs were checked and worked. We import files directly without executing its installer. Per-file GLB credits and the upstream model license document are preserved here.

Six reviewed entries are shipped initially:

| Make | Model | Supported model years |
| --- | --- | --- |
| Toyota | Prius | 2012 |
| Honda | Fit | 2016 |
| Nissan | Versa | 2010 |
| Hyundai | Santa Fe | 2020 |
| Kia | Soul | 2023 |
| Fiat | Stilo | 2001–2010 |

The upstream catalog contains some overly broad year ranges and model names that differ from the artist's source title. Our allowlist uses the individual source identity. In particular, the Prius file is a **2012** model and must not be presented as a 2010 Prius. The 2010 profile therefore gets no catalog preview in this initial batch. Regional body/trim variants require separate review; an unknown generation is not guessed.

## Storage and import

`public.vehicle_visuals` stores identities, year bounds, own asset paths, author/license/source and model hash. Static GLBs/PNGs are served by Xpeed at `/vehicle-visuals/`; the app never fetches these models from GitHub or a paid imagery API. Metadata is available at `/api/vehicle-visuals`. Public roles can read and cannot change the catalog. The normal migration runner applies schema and seed at release. The models are excluded from PWA precaching and fetched only when needed.

`node scripts/import-vehicle-visuals.mjs` downloads the six pinned attributed source files, validates CC BY 4.0 metadata, decodes meshopt compression and limits embedded textures to 512px. Browser rendering therefore needs no external decoder/CDN or additional WASM permission. The processed models total about 6.2 MiB; each is under 2 MiB. Exact source and processed hashes are in `catalog.json`. The files retain the source models' materials/colors; user paint recoloring is not implemented.

To recreate transparent posters, run the local harness with the catalog available, open Home with a matching model (for example the test Prius set to 2012) in agent-browser session `xpeed-3d-review`, and use `scripts/render-vehicle-posters.ps1 -BaseUrl http://127.0.0.1:5020`. This development helper uses the installed agent-browser CLI and the viewer's `toBlob()` export. It renders the same GLB on a transparent canvas. Review angles and model geometry before adding entries. Add later additions through new migrations; do not rewrite an applied seed.

## Virtual mode and Companion

The **same** `/api/car-brands` catalog supplies real cars, virtual session/comparison identity, and the Windows Companion dashboard. Virtual names match canonical brand/alias prefixes at word boundaries, with the longest actual match taking priority. Both web and Companion additionally recognize the explicit racing names GR010 and 499P. Unknown names stay generic, and stored lap identity/grouping is unchanged.

The Companion reads catalog metadata once per session, with a server-specific disk fallback, and fetches only the current make's PNG in a background thread. Downloads validate MIME, size, PNG signature and SHA-256. Changed car names trigger lookup; failures have a 30-second cooldown and one inflight request. Cached logos appear on light tiles beside the car in both dashboard layouts. No installer or running Companion was changed by this development task.

## Validation

Targeted Vitest covers matching, missing previews, alpha detection, viewer error fallback and virtual identity. App/API/server typecheck and targeted ESLint cover integration. Rust brand tests and a Windows-target check cover the Companion. Local browser validation used desktop and 390px mobile, actual mouse dragging and the viewer's synthetic touch-pointer gesture API.

`TEST_VEHICLE_VISUALS_DATABASE_URL` must name a fresh local disposable PostgreSQL 17 database `xpeed_visuals_test`. Run `npm run test:vehicle-visuals -- --posters`: it verifies both catalog migrations, read-only roles, API responses, exact year matching, local GLB hashes/embedded resources, and PNG alpha. It never loads `.env` and refuses non-local hosts or other database names. Estimated delivery was extended from 20 to 30 minutes when virtual/Companion logos were added.
