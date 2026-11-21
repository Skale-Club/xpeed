# AGENTS.md - xpeed

<!-- journal-protocol:v1 -->
## Journal (mandatory)

This app's history (what it does, how each part was built, decisions and releases) lives in its Notion Journal. It replaces the old GSD/PAUL planning flow; `.planning/` and `.paul/`, if present, are a read-only legacy archive.

- Journal hub: https://app.notion.com/p/411b7a686121816a9858f5dc553e8608
- Journal Entries data source: collection://159b40f3-47aa-492c-a3b3-ee8028397b66
- Latest view: view://411b7a68-6121-81d7-aafd-000c0faa196e
- Entry prefix: XPD
- Rules (they win on any conflict): https://app.notion.com/p/411b7a68612181b3ac36f4ce2b2c3850 (skill: `app-journal`)

**Start of session:** fetch the hub and read Identity and Current State; list the latest 20 entries with Notion query-data-sources in `view` mode on the Latest view above (`page_size` 20; view mode has no plan quota) and read only titles and summaries; use `rows` mode with a filter only to narrow down (it has a plan quota); if a read fails, say so and continue from the code, never guess journal content; open only the entries you need; never read the whole database. Cross-check with the code: the code is the fact.

**End of every task that changed code, behavior, infrastructure or a decision:**
1. Create ONE entry in the data source above (one per logical unit of work, not per commit): `Title` = `YYYY-MM-DD — <imperative summary>`, `date:Date:start` (YYYY-MM-DD, with `date:Date:is_datetime` = 0), `Type`, `Area` (JSON array of existing options), `Status`, `Summary` (max 280 characters), `Agent`, `Model`, `Repo / Branch`, `Commits / PR`, `Tests` (what ran, or "Not run"), and `Decision ID` / `Decision Status` when a choice was made.
2. Body headings: Context · What changed · How it was built · Decisions and why · Tests and evidence · Not done / risks · Next.
3. If the app changed, rewrite the affected part of the hub's Current State. Read back what you wrote; never report a write you did not see.
4. Notion unavailable: append the full entry to `docs/journal/PENDING-NOTION.md` and tell the owner.

Journal records are in English. No secrets.
<!-- /journal-protocol -->

<!-- universal-rules:v1 -->
## Universal rules (read first)

Before working, read the owner's universal agent rules: `$HOME/Dev/skaleclub-apps/agents/RULES.md`
(GitHub: https://github.com/Skale-Club/skaleclub-apps/blob/main/agents/RULES.md).
They cover model routing (the session model plans and validates, cheaper models execute), machine awareness (Surface = light mode, `machine-check.ps1`), delivery estimates with no silent stalls, and the database, login, git and language decisions. Keep it light: they help, never block.
This file adds only what is specific to this repository.
<!-- /universal-rules -->

<!-- brand-rule:v1 -->
## The Xpeed logo: always the real one (mandatory)

The mark is `branding/mark.svg`. Every logo and icon in this project comes from that file. **Never invent, redraw, trace,
simplify, recolour or approximate it**, in any place (web app, Android, Windows app, documents, share images, tray icons,
placeholders, tests with images). A plain "X", an icon-library X, or a look-alike made "for now" is a defect.

- Web app: use `<BrandLogo />` (shows `/logo.svg`); no inline `<svg>` of your own.
- Image files: take them from what `npm run brand` generates (`public/logo.svg`, `public/icon-512.png`, ...). A new size or
  shape goes into `scripts/brand-assets.mjs`, not into a design tool.
- Code that must draw it (for example `xpeed-sim/src/icon.rs`): copy the points of `branding/mark.svg` and the colours and
  placement of `public/logo.svg` exactly, and add tests that read those files and fail on any difference.
- Before you finish anything that shows the logo, look at it next to `public/icon-512.png`.

Full rule, the list of surfaces and what the build checks: `branding/README.md`.
<!-- /brand-rule -->

## Approved design decisions are pinned (owner, 2026-11-19)

A look the owner approved is a decision, not a default: a "calibration", token pass or refactor keeps it exactly and
never swaps it for a value from another system (the site's Tailwind scale, a library default). Every approved value
lives in one token with the date, the commit and the reason in its comment, and a test pins it (value and, where it can,
the drawn pixels). Changing one is the owner's call, recorded in the Journal before the code. Lesson: the Companion's
near-square corner (2.5 px, the "square pill", 2026-11-12 `fec259a`) was replaced by the site's 4/6/8/10 radii in a
token pass (2026-11-16 `539eb8a`) with no test failing; it is now `R_CORNER` in `xpeed-sim/src/panel/tokens.rs`,
pinned by `one_near_square_corner`.


## A screen never slides sideways (owner, 2026-11-21)

No page, at any width, in any language, may be wider than the screen or move sideways on a phone. One long name was enough
(a car name on Sessions made the whole app pan and zoom out). The rule has two halves:

- **It cannot happen:** `src/index.css` cuts whatever sticks out at the edge of the app (`overflow-x: clip` on html, body and
  #root) and makes a grid with no column rule one shrinking column. `src/test/no-sideways.test.ts` pins both. Never remove them.
- **Nothing gets cut by accident:** text that can be long (names of cars, tracks, drivers, games; any translated label) must
  shrink, wrap or `truncate`. `truncate` only works when every parent may shrink: `min-w-0` on flex and grid children, and
  `max-w-full` on anything `inline-flex`. A table or chart wider than a phone scrolls inside its own `overflow-x-auto` box.

Before finishing any change to a screen, run `npm run check:phone` (needs the test app's sample data and Playwright; see the
head of `scripts/check-phone-width.mjs`). It opens every screen at 320, 360, 412, 768 and 1280 px in English, Portuguese and
Spanish and fails on anything past the screen's edge. A new screen goes into its route list; sample data with long names stays.

## One look for a game, a track and a car (owner, 2026-11-21)

The same thing looks the same on every Virtual screen. Wherever a screen names a game, a track or a car, its picture is
beside the name, drawn by the one shared component, in one of the shared sizes. Never write the name alone, and never
build a second drawing of the same thing.

| What is named | Its picture | Use |
| --- | --- | --- |
| A game | its cover | `GameCover` (the picture), `GameBadge` (a head or a card), `GameName` (inside a line of text) |
| A track | its layout | `TrackLayoutThumb` (by the track's id; a quiet placeholder of the same size when there is no layout) |
| A car | its brand's logo | `SimCarIdentity` |

Sizes live in `src/components/sim/identity-sizes.ts` (`CAR_LOGO`, `TRACK_THUMB`): a list row or a card takes the default,
a line of small text `size="line"`, a tight ranking `dense`; only a page header passes a bigger size by hand. A row that
says "what was driven" reads the same everywhere: the track's map, the track's name, then a quiet line with the car, the
game and when. Left as plain text on purpose: sentences, drop-down options, filter chips and the numbers of a summary tile.
`src/components/sim/identity.test.tsx` pins this (it lists every file that still writes a game's name by hand, with the reason).

## Simple first, from the top down (owner, 2026-11-21)

Xpeed is for a general public: simple and easy to read, with little jargon. Telemetry exists, but the balance leans to
simple. Two rules for every screen, the Virtual ones above all:

- **Order is importance.** From the top: what anybody understands and looks for first (the track with the lap on it, the
  best lap, whether you got faster, your place in the ranking, where the time goes in one plain sentence). Further down:
  the numbers. Last: the detail. Never put the most useful thing at the bottom (the lap analysis once had its track map
  under five tables).
- **Two levels.** The detail an enthusiast wants (sectors, corner tables, telemetry curves, game versions, recording notes)
  is the second level: inside `AdvancedFold` (`src/components/ui/advanced-fold.tsx`), closed until asked for. One choice is
  remembered for every fold, and "Advanced tools" in Settings opens them from the start. The Real side does the same with
  "Technical details" and "For the mechanic".
- **Plain words at the first level,** in the three languages: say what happened, not how it is stored ("The map has not
  arrived from the game yet", never "No compatible track geometry is available").

Applied so far: the lap analysis. The other Virtual screens follow one at a time, each shown to the owner (Journal:
XPD-D-SIMPLE-FIRST).
