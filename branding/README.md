# The Xpeed mark: one source, never redrawn

**The mark is `branding/mark.svg`. Every logo and icon in this project comes from that file, and nothing else.**
Nobody (person, agent, tool) invents, redraws, traces, simplifies, recolours or "approximates" it. Not in a hurry, not
for a small icon, not because the real one is awkward to load. If a place needs the logo, it gets the real one by one
of the ways below.

This page exists because a look-alike (a plain black "X" on a yellow square) was once drawn for the Windows app's tray
icon instead of using the real mark. It was caught by the owner, not by us. The checks at the end are there so that
it is caught by the build next time.

## What the mark is

| | |
| --- | --- |
| Shape | The polygon in `branding/mark.svg` (viewBox `0 0 657.39 657.39`): a chunky X whose four arms end in square cuts. It is **not** a thin X, not a lucide `X`, not text. |
| Tile | Rounded square, `rx` = 22% of the side, colour `#F5E663` (the app's `--primary`). |
| Mark colour | `#111214` (the app's `--background`), placed as in `public/logo.svg`: `translate(87.04 87.04) scale(0.5140...)` inside 512 x 512. |
| Status dots (Xpeed Sim tray only) | A small coloured dot with a white ring in the bottom-right corner, drawn **over** the real logo. The logo itself is never altered. |

## Where every logo comes from

`npm run brand` (`scripts/brand-assets.mjs`) regenerates all of these from `branding/mark.svg`:

- `public/logo.svg`, `public/favicon.ico`, `public/apple-touch-icon.png`, `public/icon-192.png`, `public/icon-512.png`,
  `public/icon-maskable-512.png`, `public/og-image-default.png`;
- the Android launcher icons and splash screens under `android/`.

## How to put the logo somewhere new

1. **In the web app:** render `<BrandLogo />` (`src/components/BrandLogo.tsx`, which shows `/logo.svg`), or `<BrandLockup />`
   for the logo with the name. Do not paste an inline `<svg>` of your own.
2. **As an image file** (a store listing, a document, a share card): take it from the generated files above
   (`public/icon-512.png` is the large one). If a new size or shape is needed, add it to `scripts/brand-assets.mjs`
   and run `npm run brand`. Do not export it from a design tool by hand.
3. **In code that has to draw it** (no image can be loaded, for example the Windows tray icon of Xpeed Sim, which draws
   at the size Windows asks for): copy the **points of `branding/mark.svg`** and the colours and placement of
   `public/logo.svg` into the code, exactly, and add tests that read those two files and fail if the copy differs.
   `xpeed-sim/src/icon.rs` is the model: its tests compare the points, the colours and the placement with the files, and
   compare the drawing with `public/icon-512.png` pixel by pixel.
4. **Changing the mark itself:** edit `branding/mark.svg`, run `npm run brand`, and update every code copy (3) until its
   tests pass. The tests tell you which copy is out of date.

## What is checked by the build

- `src/lib/brand.test.ts`: `public/logo.svg` carries the points of `branding/mark.svg` and the two colours of
  `scripts/brand-assets.mjs`; `BrandLogo` and `index.html` use `/logo.svg`; the PWA icons are the sizes the manifest
  says.
- `xpeed-sim/src/icon.rs` tests: the drawn mark equals the file's points, the placement and colours equal
  `public/logo.svg`, and the 512 px drawing matches `public/icon-512.png`.
- The Xpeed Sim workflow also runs when `branding/mark.svg`, `public/logo.svg` or `public/icon-512.png` change.

A new place that draws the mark itself must come with the same kind of test. A review that finds a hand-made logo
sends it back, whatever the reason it was made.
