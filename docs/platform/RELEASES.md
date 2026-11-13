# Releasing Xpeed Companion

Xpeed Companion (the Windows app, `xpeed-sim/`) is released by CI. Nobody builds or uploads an installer by hand.

## How a release happens

1. Change the code. For anything people will download, **bump `version` in `xpeed-sim/Cargo.toml`**
   (patch for fixes, minor for features).
2. Merge to `main`.
3. The workflow `.github/workflows/xpeed-sim.yml` runs. Job 1 (`xpeed-sim`) checks format, clippy and tests, builds the
   program and the installer (`xpeed-sim/installer/build.ps1`) and keeps it as a workflow artifact. On a **push to
   main only** (never on a pull request) job 2 (`release`) runs after it and publishes.

If the version was not bumped, nothing is overwritten: the run prints a notice "The version was not bumped" and the
public download keeps the previous version. Bump the version and merge again.

## The two kinds of release

| Release | Tag | Made | Holds |
| --- | --- | --- | --- |
| Immutable | `companion-v<version>`, e.g. `companion-v0.4.0` | once, the first time that version is released; never changed | the installer, `SHA256SUMS.txt`, `latest.json` |
| Rolling | `companion-latest` | updated by every newer version; marked as the repository's latest release | the same three files, always the newest version |

The rolling release is updated in this order, so a visitor never sees a broken state: the new installer, then
`SHA256SUMS.txt`, then `latest.json` (which names the installer), then the old installer is removed, then the notes are
rewritten. Its notes are: signed or "Unsigned build", the checksum, the download link, and the commit subjects since the
previous `companion-v*` tag (only commits that touch `xpeed-sim/`). It is updated only when its version is newer than what
the rolling release already has.

If `companion-v<version>` already exists, it is left exactly as it is. When it holds a different build of the same
version, the files of the *existing* release are what the rolling release gets, so the two can never disagree.

Signing is optional (see [SIGNING.md](SIGNING.md)). Without the repository secrets the build is released unsigned. The
hash is computed after signing, because signing changes the file.

The script that does this is `scripts/release-companion.ps1`; `-DryRun` writes the files to a folder and prints every `gh`
command without running any. It needs only the workflow's `GITHUB_TOKEN`.

## The files

`xpeed-companion-setup-<version>.exe`: the installer. `SHA256SUMS.txt`: `<sha256>  <file>` (works with `sha256sum -c`).

`latest.json`:

```json
{
  "version": "0.4.0",
  "build": "3bd8f29",
  "file": "xpeed-companion-setup-0.4.0.exe",
  "sha256": "<64 lowercase hex>",
  "size": 3145728,
  "releasedAt": "2026-11-13T16:20:18Z",
  "minVersion": "0.4.0",
  "notes": "",
  "signed": false
}
```

`build` is the short commit; `minVersion` is the oldest version that may keep running (raise it only for an update that
must not be skipped; the script's `-MinVersion`); `signed` is true when CI signed the program and the installer.

## The endpoints (public, no sign-in)

- `GET /api/companion/latest` answers
  `{"version","build","downloadUrl","sha256","size","releasedAt","minVersion","signed"}`. `downloadUrl` is always this
  site's own `/api/companion/download`, built from the server's configured public address (never from the request's Host).
  The server reads `latest.json` from `COMPANION_RELEASE_BASE` (default
  `https://github.com/Skale-Club/xpeed/releases/download/companion-latest`), checks every field strictly, and keeps the
  answer for 5 minutes. If GitHub cannot be reached it serves the last good answer; with none, it answers
  `503 {"error":"unavailable","retryable":true}` with `Retry-After`.
- `GET /api/companion/download` answers `302` to `<COMPANION_RELEASE_BASE>/<file named in latest.json>` with
  `Cache-Control: public, max-age=300`. That is the one stable link the site and the program use, so it survives a new
  file name or a change of domain. The redirect can only point inside the configured base.
- The public page is `/companion` (download button, version, checksum, steps, supported games, FAQ).

Server code: `api/companion/`. Checks: `npm run test:companion-release`.

## How the Companion updates itself

From version 0.6.0 the program updates itself. Code: `xpeed-sim/src/update.rs` (the rules), `src/tray.rs` (the flow),
`installer/xpeed-sim.iss` (the installer's side). Because `downloadUrl` is a stable path on the site, the program never needs
to know where the files are stored.

### The flow

1. **Check.** 30 seconds after it starts, and every 6 hours after that (or when the person picks "Check for updates" in the
   tray menu), a background thread, looked after by the supervisor like the other workers, asks
   `GET <server>/api/companion/latest`. `<server>` is the paired server, or `https://xpeed.skale.club` when the computer is
   not paired (`config::DEFAULT_SERVER`, the one place to change when the domain becomes xpeed.app; the pairing's saved
   server always wins). A failure (no network, a status that is not 200, an answer that does not pass the checks below) is
   one line in `companion.log`; the next try is at the next interval. Nothing is shown and no dialog opens.
2. **Trust nothing.** The answer must be at most 64 KB; every field present; `version` and `minVersion` exactly `a.b.c`
   (and `minVersion` not above `version`); `build` and `releasedAt` short text; `sha256` 64 lower-case hex digits; `size` a
   whole number from 1 byte to 200 MB; `signed` true or false; `downloadUrl` an HTTPS address on the same host and port as the
   server it came from. A version that is not newer than the running one (the same, or older) is ignored: no downgrade, never
   the same version twice. If the running version is older than `minVersion` the update is **required**: it is shown in red,
   and still waits for the games to close.
3. **When it installs.** "Update automatically" (tray menu, on by default) lets the program start by itself, only when no
   supported game is running and no car is being driven on the panel. "Update now" (tray menu or the Monitor tab's button)
   is the person's word and ignores the toggle and the lap view, but not a running game: it then shows a balloon
   ("Close your game to update to 0.6.0. Nothing is lost.") and the update waits. A waiting automatic update is looked at
   again each time something changes (a game closing), so it goes when the game has closed. A game counts as running when
   a reader says so or its program is in the list of running processes (checked again at the last moment, after the
   download). The choice is kept in `config.json` as the optional field `"autoUpdate": false`; a file without the field,
   or with a value that is not true or false, means on. With no pairing there is no file to keep it in, and the choice lasts
   until the program closes.
4. **Download.** To `%TEMP%\Xpeed Companion update\xpeed-companion-setup-<version>.exe.part`, HTTPS only, with a size cap,
   never sending the device key or cookies. The file name is made by the program (the version is checked), never taken from
   the server. The size and SHA-256 of the bytes are checked against the answer; they are renamed to `.exe` only if both
   match, and the file is checked once more before it runs. A mismatch deletes the file and logs it; the program's own
   attempts then wait 30 minutes (the person's "Update now" does not wait).
5. **Install.** The program closes (tray, readers and uploader stopped, so no lap is lost: laps are files in the laps folder
   and the pairing is `config.json`, neither of which the installer touches), frees its single-copy name, and starts
   `<installer> /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /UPDATE=1`, detached.
   Before it, it writes `updating` (the target version) next to `config.json`.
6. **The installer** (same `AppId`, same folder, so it upgrades in place) waits up to 20 s for the old copy's name to be
   free (`InitializeSetup`), replaces the files, and starts the new version (a `[Run]` line that only a `/UPDATE=1` setup
   takes). If the installer stops or is refused, `DeinitializeSetup` starts the installed program again, so an update that
   did not happen never leaves the tray empty. If the installer cannot be started at all, the program starts itself again.
7. **After.** The new version reads `updating`: if it matches the running version, one balloon says "Xpeed Companion was
   updated to 0.6.0"; if not, the log says the update did not complete. Leftover installers in the download folder are
   removed.

### The allowlist

A download goes to the server's own origin (scheme, host, port) or, over HTTPS on port 443, to `github.com`,
`objects.githubusercontent.com` and `release-assets.githubusercontent.com` (where GitHub keeps a release's files; the site's
`/api/companion/download` redirects there). Every address is checked before it is asked, at most 3 redirects are followed,
relative redirects only on the same origin, and anything else (another host, a look-alike like `github.com.evil.example`, a
user name in the address, another port, plain HTTP, no scheme) is refused. Plain HTTP is accepted only when the server itself
is `localhost`, `127.0.0.1` or `[::1]` (development).

### What an old Companion must do

Versions before 0.6.0 do not check or update. **Install 0.6.0 once by hand** (the `/companion` page's download); from then on
updates are automatic. The 0.6.0 installer upgrades the old one in place (same `AppId`).

### What it does not do

It does not verify a signature of the installer (`signed` in `latest.json` is read but not required: signing is optional, see
[SIGNING.md](SIGNING.md)). The SHA-256 comes from the same server, so it protects against a corrupted or swapped file on
GitHub, not against a compromised Xpeed server. It never updates while a game runs, not even a required update.
