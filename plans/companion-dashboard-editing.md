# Companion dashboards: workspaces you can edit, save and reset

Status (2026-11-19, night): **approved by the owner, being built overnight** on `feat/dashboard-catalog` (Opus orchestrates,
Sonnet writes, GitHub CI verifies: the Surface has no Rust toolchain). Follows `plans/companion-dashboard-catalog.md`.

## What the owner asked (2026-11-19)

1. **Modular panels:** the driver can rearrange the dashboard: move cards, change their size, add and remove them.
2. **Default workspaces, like Premiere / After Effects:** built-in dashboards for **Race**, **Qualifying**, **Hot lap** and
   **Practice**, each with the cards that make sense. A change can be **saved** into that workspace, and the workspace can always
   be **reset** to its default.

## Model

- A **workspace** = one of the four built-in dashboards. Its default layout is code (`panel/dashboards.rs`), per window shape
  (`Layout::{Classic, Ultrawide, Wide, Square, Portrait, Stack}`): rows of `(widget id, share)` with a row height.
- A **saved view** = the driver's layout for one workspace and one window shape, stored as data in
  `%APPDATA%\Xpeed Companion\dashboards.json` next to the per-game manual choice:
  `{ "manual": {...}, "views": { "race": { "wide": { "rows": [ { "h": 300, "cards": [["times", 1.0], ...] } ] } } } }`.
  Widget ids are the catalog's stable ids. Loading validates everything (unknown ids dropped, shares and heights clamped, a
  card twice dropped, an empty view ignored); a damaged file means defaults, never an error.
- The panel draws the saved view when there is one, else the default. A workspace with a saved view is marked **modified** (a dot
  after its name). **Reset** deletes the saved view of the workspace (all shapes, or only the current shape).
- "A card the game cannot fill is not there" still applies to saved views; edit mode shows such cards greyed so they can still be
  moved.
- The phone view follows the saved Portrait view (the relay already reads `rows_for`).
- Hot lap is the display name of the `time_trial` id (ids are a contract and never change).

## Edit mode (in the panel)

- Enter with **E** or the header's **Edit** button; leave with **Esc** (cancel) or **Save**.
- A toolbar over the cards: workspace name, **Save view**, **Cancel**, **Reset to default**, **Add panel**.
- **Move:** drag a card by its body: drop on another card to swap; drop on a card's left/right third to insert beside it; drop in a
  gap between rows (or above the first / below the last) to make a new row.
- **Resize width:** drag the boundary between two cards in a row (shares change, each card keeps a minimum).
- **Resize height:** drag the boundary under a row (each row keeps at least the tallest minimum of its cards).
- **Remove:** the × on each card. **Add:** a list of catalog widgets not in the view, appended to the last row (or a new row when
  the last row is full).
- Limits: at most 6 cards in a row and 12 rows; the centre card keeps its minimum size so **the gear stays big** (owner rule:
  the gear is never shrunk to make room for other things).
- Every edit is a pure function on the rows (`panel/edit.rs`), unit-tested; the window only maps the mouse to those functions.

## Default workspaces (review)

Each default is reviewed so the cards make sense for that kind of session, using every catalog widget including the ones the
panel upgrade added (inputs, lights): Race (flag, session, relative, standings, gaps, radar, fuel strategy, tyres and wear,
times, centre, lights), Qualifying (times, centre, sectors, delta bar, reference, standings, session, tyres, flag), Hot lap (delta
bar, times, sectors, reference, laps, centre, inputs, tyres, track), Practice (times, centre, inputs, laps, fuel, tyre wear,
sectors, tyres, track, lights). The phone layout of every workspace keeps the race test (a phone held upright must not fall back to
Classic).

## Steps (overnight)

0. Integrate the panel upgrade merged from `feat/panel-preview-artifact` (new cards in the catalog and the rows, serde on the new
   models, tests).
1. Saved views: data, load/validate/save/reset, modified flag, `rows_for` reads them (+ the phone relay).
2. Edit operations as pure functions (`panel/edit.rs`) with tests.
3. Edit mode UI: mouse, cursors, overlay, toolbar, add list, keys; preview screens of edit mode.
4. Workspace picker in the header (click the dashboard pill: the four workspaces with their modified dot, Reset), Hot lap name,
   default workspaces reviewed.
5. Verify in CI and the preview, record in the Journal.

## Not in scope tonight

Editing on the phone (it follows the Portrait view), sharing workspaces between computers or through the account, custom
(fifth, sixth...) workspaces, the track card redesign (deferred by the owner).
