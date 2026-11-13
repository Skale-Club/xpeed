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

## How the Companion will use it for updates

The program asks `GET /api/companion/latest` (on start and once a day). If `version` is newer than its own, it offers the
update; if its own version is older than `minVersion`, it says the update is required. It downloads `downloadUrl`,
compares the file's SHA-256 with `sha256` (and `size`), and only then runs the installer. Because `downloadUrl` is a stable
path on the site, the program never needs to know where the files are stored. (The program side is built separately.)
