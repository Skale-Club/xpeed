# Journal entries waiting for Notion

Notion was unavailable when these were written. Copy each one into the Journal Entries data source
(collection://159b40f3-47aa-492c-a3b3-ee8028397b66), then delete it from this file.

---

## 2026-11-13 — Xpeed Companion 0.3.0: icon and version in the exe, no visible Sim anywhere, data folders migrated

- **Type:** Release · **Area:** General, i18n & UX, Infra & Deploy · **Status:** Done
- **Agent:** Claude Code · **Model:** Opus 5.5 orchestrating, Sonnet 5.5 subagents executing
- **Repo / Branch:** Skale-Club/xpeed / main = dev 452fe8a
- **Commits / PR:** a4c846a, 07a58eb, 857ffd1, 338d5d6, 452fe8a; merges 8468092, c223f81
- **Tests:** cargo test 471; vitest 975; tsc clean; CI (with test:sim), Xpeed Sim CI and Deploy to Coolify green on 452fe8a; installer 0.3.0 installed via WMI and checked (folders, Run key, scheme removed, Start menu, pairing kept)
- **Decision:** XPD-D-6 · Approved
- **Summary:** Companion exe now carries its icon and version info (0.3.0 + build stamp). Exe, installer, install and data folders, autostart and site URLs renamed from Sim to Companion with redirects and a data migration. A migration run from a sandboxed shell was caught and repaired.

### Context
The owner asked why the Companion opened without an icon and why the version never moved from 0.1.0. They then asked for "zera o git" and said everywhere it says Sim must now say Companion, all in this round.

### What changed
- **Icon and version.**
  - A `build.rs` draws the real mark into `xpeed.ico` and embeds it with a VERSIONINFO block ("Xpeed Companion") through `rc.exe`.
  - The build exports `XPEED_BUILD` (git short hash).
  - The demo panel gets icons, and the window classes carry the icon.
  - The version moved to 0.2.0, then to 0.3.0 for the rename.
  - The README now has a release rule: every installer that leaves the machine gets a new version. `build.ps1` warns when the version was not bumped.
- **No visible Sim.**
  - The exe is `xpeed-companion.exe`, the installer `xpeed-companion-setup-<v>.exe`, and the install folder `Programs\Xpeed Companion`.
  - The upgrade removes the old folder, the old shortcuts, the `xpeedsim` URL key and the "Xpeed Sim" Run value, keeping autostart on if it was on.
  - The data folders move: `%APPDATA%\Xpeed Sim` becomes `Xpeed Companion`, and `Documents\Xpeed Sim` becomes `Xpeed Companion`.
    - The move tries a rename first.
    - If the rename fails, it copies and checks the copy.
    - It never deletes the old folder after a copy.
    - The log is now `companion.log`.
  - Site: the Virtual screens are at `/virtual/...`, the Companion page at `/virtual/companion`, and the connect page at `/companion/connect/:id`. Every old `/sim` path redirects, keeping the id and the query. Stored routes are translated to the new paths.
  - Kept on purpose, because no one sees them: code identifiers, the `xpeed-sim/` folder, the crate name, the `/api/sim` endpoints and the network values.
- **Zera o git.** Another session had already aligned main and dev (5946ea7: car brand logos plus the Companion work). This round merged the icon branch and the two rename branches. main = dev = 452fe8a, deployed, with no extra branches or worktrees.

### How it was built
Three Sonnet subagents worked in worktrees: one on the icon and version, one on the rename in the app, and one on the rename on the site. Opus checked that the claimed tests existed, merged the branches and re-ran cargo and vitest. Opus then bumped the version, released, and installed through WMI.

### Decisions and why
- **XPD-D-6.** The data folders and the exe are renamed through an in-app migration, because the owner wants no visible Sim. The API paths stay `/api/sim`, so installed apps keep working.
- **Only commands that use the data migrate it.** Tool commands (make-icon, probe, inspect, track dump and the demo panel) never migrate. This is fix 452fe8a.

### Tests and evidence
- cargo test: 471 passed.
- vitest: 975 passed.
- CI (with test:sim), the Xpeed Sim workflow and the deploy are green. Production health is ok on 452fe8a.
- After installing 0.3.0 through WMI:
  - The log says "Xpeed Companion 0.3.0 (452fe8a) starting" and "paired … VANILDO-PC".
  - Laps go to `Documents\Xpeed Companion\Laps`.
  - `Programs` holds only `Xpeed Companion\xpeed-companion.exe`.
  - The Run key is "Xpeed Companion".
  - The `xpeedsim` key is gone.
  - The Start menu holds only `Xpeed Companion.lnk`.

### Not done / risks
- **Incident, repaired.**
  - What happened: `installer\build.ps1` runs the new exe (`make-icon`), and at first every command ran the migration. That run came from the Claude Desktop shell, which is subject to Store AppData virtualization. The move therefore put `%APPDATA%\Xpeed Sim` (pairing, covers, log) into `...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Xpeed Companion`, and the folder vanished from the real AppData.
  - Repair: the folder was copied back with robocopy, run through WMI (40 files, `config.json` included).
  - The package copy was left in place.
  - `Documents` is not virtualized, so it moved for real.
- The silent installer aborts at the AppMutex check when the old app is running. A normal install asks the person to close the app instead.

### Next
- A public download for the Companion installer.
- Remove the leftover copy in the Claude package cache, if the owner agrees.
