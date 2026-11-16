---
name: simhub-bridge
description: Control SimHub on the owner's PC without the mouse, through SimHub's built-in web API (127.0.0.1:8888) and its JSON settings files. Use whenever a task touches SimHub, sim rig tuning (ShakeIt, motion, Control Mapper, dashboards, LEDs), the simhub MCP server (sim-racing/simhub-mcp), Driver Sim, or the SimHub bridge of the local Xpeed app (collector). Holds the full route map, how to turn on the APIs that ship disabled, the safe change-and-revert procedure, and the traps found in testing.
---

# SimHub bridge

Findings from real tests on the owner's PC, SimHub **9.13.3**, 2026-11-10. Re-check on any other version.
Full spec: Notion, hub "Driver Sim — 00 START HERE", page **08 — Local Xpeed app: SimHub bridge spec**
(https://app.notion.com/p/414b7a6861218102a463e375e945e54d). Decision: **DS-ADR-002** (the bridge becomes a module
of the local Xpeed app; `sim-racing/simhub-mcp` is the prototype and test bench). Log every test run in page 03
(Build Journal) with what ran and what was Not Run.

## Where things are

| What | Where |
|---|---|
| Program | `C:\Program Files (x86)\SimHub\SimHubWPF.exe` (process `SimHubWPF`) |
| Web server | `http://127.0.0.1:8888` (listens on **all interfaces**: other LAN devices can reach it) |
| Settings | `C:\Program Files (x86)\SimHub\PluginsData\` (`PluginsActivation.json`, `Common\*.json`, per-game folders, SimHub's own `_Backups`) |
| Logs | `C:\Program Files (x86)\SimHub\Logs\SimHub.txt` (shows which plugins were created at start) |
| Route list source | `SimHub.Plugins.Web.dll` (75 `/api/...` strings; re-extract after updates) |
| MCP prototype | `sim-racing/simhub-mcp/server.mjs`, registered as MCP server `simhub` (local config of this repo) |

MCP tools: `simhub_status`, `simhub_api_get` (reads), `simhub_api_action` (state changes SimHub exposes as GET),
`simhub_api_post` (POST actions), `simhub_list_settings`, `simhub_read_setting`, `simhub_write_setting`
(refuses while SimHub runs; auto-backup to `sim-racing/simhub-mcp/.backups/`).

## Features that ship DISABLED

| Feature | Symptom when off | Turn on |
|---|---|---|
| Control Mapper | `GET api/ControlMapper/GetRoles2` → HTTP 500 ("Cannot return null…") | `PluginsActivation.json`: `SimHub.Plugins.OutputPlugins.ControlRemapper.ControlMapperPlugin` → `"IsEnabled": true` |
| Motion API | every `api/Motion/*` and `api/Devices/*` → 404, WebSocket upgrade → 404 | **both**: `PluginsActivation.json` `SimHub.Plugins.Motion.MotionPlugin` → `true`, **and** `Common\MotionPlugin.GeneralSettingsV2.json` `"ApiEnabled": true` |

Turning any of these on is a settings change: **ask the owner first**, and turn it back off afterwards unless told to keep it.

## Route map (what was tested)

- **Always on (tested):** `api/getgamedata`, `GetGameDataSimple`, `GetGameDataUpdates`, `GetProperty/{name}`
  (e.g. `DataCorePlugin.CurrentGame`, `DataCorePlugin.GameRunning`), `EvaluateStringFormula?formula=2*21` → `42`,
  `Dashboards/GetDashboards`, `GetSessionLapsHistory`, `GetLedsData`. Also `GetLeaderboarddata`,
  `GetPlayerLeaderboarddata`, `Getaheadbehinddata` (not checked with a game running).
- **Control Mapper (plugin on, tested):** `GetRoles2` → 29 buttons (ShiftUp/Down, DRS, TC±, ABS±, Horn, PitLimiter,
  Gear1–8, …) and 4 axes (Clutch, Throttle, Brake, Handbrake). `POST StartRole` / `StopRole` with form
  `roleName`, `ownerId` → `"OK"`; unknown role → `"KO"`. Others: `GetRoles`, `StartAxisRole`, `StopAxisRole`,
  `TriggerRole`, `TriggerButtonRole`, `StartButtonRole`.
- **Motion (plugin on + ApiEnabled, tested):** SimHub's own docs page at `api/Motion/ApiIndex` (read it first).
  Reads: `GetMotionDevices`, `GetMotionDevice/{id?}`, `CurrentDeviceState`, `ProfileDetails` (has `Levels.MotionGlobalGain`,
  `MotionSmoothing`, `HapticGain`, collection gains), `GetLastPose[?display=true]`, `GetLicencesStatus`.
  **Actions are plain GET:** `SetCurrentProfileGain/{MotionGlobal|Haptic|BeltTensioner}/{v}`,
  `SetCurrentProfileGlobalSmoothing/{v}` (both tested, return `"ok"`), `Enable|DisableMotion`, suspend, force-unpark,
  hop-in, `CalibrateSensor`, `ActivateProfile/{id}`, `ActivatePreset/{code}`, per-effect
  `SetEffectGain|Smoothing|Enabled|Isolated|PresetOverride/{id}/{v}`, `SetCollectionGain/{id}/{v}`,
  `ResetPositionCounters`. Not tested: anything needing a real motion device (state was `NotConfigured`).
- **Motion WebSocket (tested):** `ws://127.0.0.1:8888/api/Motion/RealTimeWS`; send
  `{"id":"x1","action":"/api/Motion/CurrentDeviceState","params":null}`, reply `{"id":"x1","data":{…}}`; also pushes
  events (e.g. `motion-effect-changed`). Node 22+ has a global `WebSocket`.
- **Devices (behind the Motion API in this version):** `Devices/List` (was empty), `Details/{id}`,
  `EnableDevice/{id}`, `DisableDevice/{id}`.
- **Not tested:** `TriggerAction/{actionName}`, `TriggerInput/{inputName}`, `ExternalInput/Press|Release`,
  `StreamDeckInput/Press|Release`.
- **No API found** for ShakeIt, wheel force feedback or LED settings: files only.

Licence on this PC: SimHub free (licence not valid), Motion licence not installed. Unknown which features that blocks.

## Safe change-and-revert procedure

1. **Read before you change.** Record the current value (e.g. `ProfileDetails` before a gain change).
2. **API change:** call the action, read again to verify, then put the old value back and verify again.
3. **Settings file change:**
   1. Back up the file (and a full copy of `PluginsData` before the first change of a session).
   2. Close SimHub gracefully: `(Get-Process SimHubWPF).CloseMainWindow()` and wait for the process to exit
      (about 3 s). Never edit while it runs: it rewrites settings on exit.
   3. Edit, validate the JSON.
   4. Start it: `Start-Process "C:\Program Files (x86)\SimHub\SimHubWPF.exe" -WorkingDirectory "C:\Program Files (x86)\SimHub"`;
      the web server answers about 4 s later. Check the log for the plugins created.
4. **Revert** the same way and prove it: compare hashes with the backup, and check the symptom is back (e.g. 404).
5. Expect SimHub to create or rewrite some of its own files on close (window positions, plugin settings): that is
   normal, not our edit. A fresh install has few settings files until SimHub first closes.

## Traps found in testing

- **Serialize calls.** Handling requests in parallel let a read overtake the action before it (read showed 75 right
  after setting 60). The MCP server now runs one request at a time; the local app must do the same.
- **Windows PowerShell 5.1 + JSON arrays:** `ConvertFrom-Json` on a top-level array plus `Where-Object` misbehaves,
  and `Set-Content -Encoding UTF8` adds a BOM (SimHub accepted it). Prefer a small Node script for edits.
- **Quoting:** inline `node -e` inside PowerShell broke on quotes; write the script to a file and run it.
- **Git Bash mangles Windows paths** in arguments (a `..\..\Windows\…` test line vanished). Drive MCP tests from a
  Node script that spawns the server, not from shell pipes.
- SimHub's errors come back as large HTML pages; keep only the `titleerror` message.
- Writing under Program Files worked without elevation on this PC; not guaranteed on others.

## Security rules

- Talk only to `127.0.0.1`. Never forward or expose port 8888.
- The Motion settings hold an `ApiToken`. It was not needed from 127.0.0.1; not tested from another machine.
  Do not print or copy it.
- Keep the route allow-list split into reads and actions; never call outside it.
