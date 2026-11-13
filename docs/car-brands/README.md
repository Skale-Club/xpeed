# Vehicle brand logo catalog

`public.car_brands` owns the logo bytes, names, aliases, SHA-256 and provenance. The app serves images from `/api/car-brands/<key>/logo`; it does not hotlink upstream files. This is independent of Xpeed's own mark in `branding/mark.svg`.

The initial catalog merges the pinned snapshots in `catalog.json`, keeping the first source when normalized names overlap:

- [Car Logos Dataset](https://github.com/filippofilip95/car-logos-dataset), revision `e334a4d2e8742108ba164c629dff5636576d3808`: 387 entries, sourced upstream from Carlogos.org and local additions. Its README describes the project as MIT licensed and explicitly reserves the logo owners' rights.
- [VehicleSpecs brand logos](https://github.com/vehiclespecs/brand-logos), revision `3f0929e70e0a9a2a502063edc4b3e5c0146cba74`: supplements names missing from the first source. Its LICENSE distinguishes the repository's MIT code/metadata from logo files, which retain their owners' rights.

These are third-party trademarks used to identify vehicle makes. Neither repository's code license grants ownership of those marks. Source URLs and exact revisions are retained per row and in the manifest. Logos are rasterized/resized to fit 256 × 256 PNGs with their original colors and proportions. No new or approximated marks are generated.

Coverage includes global current and historical marques, specialty manufacturers, and some tuners/subbrands from upstream. It is **not a claim to contain every brand ever made**. Unknown makes retain their text and a generic vehicle icon; they are not assigned a similar-looking brand. Exact matching ignores case, accents, spaces and punctuation; explicit aliases handle names such as VW and CAOA Chery. Do not merge distinct marques just because they share an owner (for example, Lexus and Toyota).

## Updating

Run `node scripts/import-car-brands.mjs` to reproduce the initial seed from the pinned versions. Network access is only needed for that import. This command does not connect to a database. It writes a checked-in SQL seed and a provenance/hash manifest; cached review PNGs go under ignored `.codex-local/car-brands/`.

For a later update, pin the new source commit and generate a **new** migration instead of changing an applied seed. Review new names, collisions and images. Add explicit aliases only where they mean the same marque. The seed uses `ON CONFLICT DO NOTHING` so rerunning it preserves curated database entries. Apply through the normal migration runner in development and the authorized release flow for production.

## Validation

`npm test -- src/lib/car-brands.test.ts src/lib/car-brands-route.test.ts src/components/car/CarBrandLogo.test.tsx` checks matching, API responses, and image fallbacks. `npm run typecheck` checks app/API/server integration.

For the real database check, create an empty disposable PostgreSQL 17 database named `xpeed_brands_test` on localhost and set `TEST_CAR_BRANDS_DATABASE_URL` to it. Run `npm run test:car-brands` once in that fresh database. It applies both migrations, decodes and checks all 423 PNGs against the manifest, repeats the seed while preserving curation, verifies read-only public access, and calls the real API through the own-PostgreSQL adapter. It does not load `.env` and refuses remote hosts or other database names. Destroy the disposable database afterward.
