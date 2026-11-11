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

