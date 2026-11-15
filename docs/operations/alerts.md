# Alerts: what tells the owner that something is wrong

Written 2026-11-13, after the 2026-11-10 incident (a copy script overwrote production). The scripts are now
guarded (see `db/guard-destructive.mjs` and `docs/database/README.md`); this page is about being told when
the site is down, and about what breaks for people (section 3) and the disk filling up (section 4).

## 1. Uptime check (live once merged to `main`)

`.github/workflows/uptime.yml` runs every 5 minutes (and on demand: Actions > Uptime > Run workflow).

- It calls `<site>/api/health/deep`: 200 with `"status":"ok"` when the database and the storage are fine,
  503 otherwise. While that endpoint is not deployed (404) it falls back to `<site>/api/health`, and only a
  non-200 or a body without `"status":"ok"` counts as down.
- It tries 3 times, 20 seconds apart, before deciding the site is down.
- Down: it opens an issue titled **Site down** with what each try saw, or comments on the one already open
  (at most one comment an hour, so a long outage is not hundreds of emails).
- Healthy again: it comments **Recovered** and closes the issue.
- The address is the repository variable `XPEED_PUBLIC_URL` (Settings > Secrets and variables > Actions >
  Variables). Without it the default `https://xpeed.skale.club` is used. **Set the variable to the new
  address when the domain moves to xpeed.app.**
- It needs no secret: only the built-in `GITHUB_TOKEN` with `issues: write`.

## 2. How GitHub notifies the owner

GitHub emails the repository owner when an issue is opened or commented on, as long as the owner watches the
repository (Watch > Participating and @mentions is enough for issues the workflow opens; use "All activity" to
be sure) and email is on in github.com/settings/notifications. Install the GitHub mobile app for a push
notification. A failed workflow run also sends an email (Actions notifications in the same settings page).
Check once that the email address on the account is one that is read.

Limits to know: scheduled workflows can start a few minutes late, and GitHub switches them off after 60 days
without any activity in the repository (re-enable them in the Actions tab).

## 3. Error tracking (first party: nothing leaves Xpeed's own server)

Until 2026-11-15 nothing told the owner that the site broke in somebody's browser or that Xpeed Companion failed on somebody's
computer. Now both report to Xpeed's own server, and the **Problems** section of the admin page (`/admin`, admins only) lists them.
No third-party error service (no Sentry account or DSN) is used, so the privacy policy ("no analytics tools or third-party
trackers", and the "Technical error reports" item under "Which data we keep") stays true.

**The site.** `src/lib/error-reporter.ts` listens to `window.onerror`, `unhandledrejection` and the React `ErrorBoundary`, and sends
`POST /api/client-errors` (`api/client-errors.ts`).

- Sent: a scrubbed message, a scrubbed stack (30 lines, 4000 characters), the route as a pattern **without** query string or
  fragment (ids and tokens in the path become `:id`), the build (`SOURCE_COMMIT`, 12 characters), the browser family and major
  version taken from the request's `User-Agent` header (`chrome/131 desktop`, never the string), the time, and a fingerprint.
- Never sent or stored: e-mail addresses, phone numbers, JWTs, bearer tokens and device keys, long opaque strings, UUIDs, IP
  addresses, the account name in a file path, anything after a `?` or `#`, the page's contents, form values, the IP address of
  the sender (it is only a hashed rate-limit key in `sim_rate`, which is swept after a day).
- Scrubbed twice: in the browser before sending (`src/lib/error-scrub.ts`) and again on the server with the same module, so an
  old or hostile client cannot put anything personal in the database. The server computes the fingerprint itself (message and top
  frame with the numbers and build hashes taken out: "restarted 3 times" and "restarted 5 times" are one problem); the one the
  browser sends is ignored.
- Limits: the browser sends at most 20 reports a minute, the same fingerprint at most once a minute, 100 per page load, never
  reports its own failed POST and never retries it. The server allows 60 a minute per IP address (counted in the database like the
  upload limiter, so every server instance agrees), refuses bodies over 16 KB, and keeps at most 2000 distinct problems (new ones
  past that are dropped, known ones keep counting).
- Who: if the request carries a valid sign-in, the person is counted among the people the problem touched, as a one-way hash
  (`sha256("xpeed-errors:" + account id)`); the id itself is never stored or shown, and never in the body.

**Xpeed Companion.** `POST /api/sim/companion-errors` (`api/sim/companion-errors.ts`), device key like the heartbeat (a missing,
unknown, revoked key or a person's sign-in is 401); `{ version, worker, message, backtrace, os, at }`; 10 a minute per computer.
The Companion (`xpeed-sim/src/crashreport.rs`) writes a panic (from its panic hook) and a worker that was restarted 3 times or
more (from the supervisor) to `error-reports.jsonl` in its own folder (the newest 5), with Windows account names in paths replaced
by `[user]`, and sends them once at its next start while paired, deleting what the server took. `os` is the family only
(`windows x86_64`).

**Storage.** `error_groups` (one row per fingerprint and source: first and last seen, count, sample message, stack, route,
version, browser or OS family, worker, people affected, resolved time, how many times it reopened), `error_group_users` (one-way
hashes) and `error_occurrences` (the newest 50 per group). Only the server reads them (row level security, no grant to the browser
roles). The daily job `error_retention` (`server/jobs.ts`) deletes occurrences older than **30 days** and resolved problems not
seen for 90 days.

**The admin view.** Problems, newest first: source, message, count, last seen, version, people, route, browser or worker; the
sample stack opens on demand; **Mark resolved** hides it until it happens again (an occurrence that happened after the
resolution reopens it and says "Came back after being resolved"; a late report of something older does not). The API is
`GET /api/sim/v1/admin/problems?status=open|resolved|all&source=site|companion` and
`POST /api/sim/v1/admin/problems/<id>` `{ "resolved": true|false }`, both behind the app's own admin check (401 signed out or with a
device key, 403 for everybody else).

Not covered: exceptions thrown on the **server** itself (they are one JSON line each in the container log; Coolify shows it) and
errors of the Android app's native layer.

## 4. Disk alarm

`GET /api/health` now carries `disk: { usedPercent, freePercent }` for the volume of the uploaded files (`STORAGE_DIR`, by default
`/data/files`), measured like `df`; `null` when the files are on S3 or the volume cannot be read. Percentages only: no path, no
sizes. It never changes the status of the check (the container's own health check must not restart over a full disk).

The Uptime workflow reads it on every run and **fails the run when the disk is above 85%**, which GitHub e-mails to the owner
(Actions notifications, section 2). To avoid an e-mail every 5 minutes the run fails for the disk only in the first run of each
hour (or on a manual run); the warning is in every run's log. The same rule now applies to a site that is down: the run fails
when the "Site down" issue is opened or commented on (once an hour at most), so the owner gets the issue e-mail and a red run.
An older deploy without the `disk` field raises no alarm.

To free space: look at `xpeed-files` first (lap files; retention already reduces laps older than 90 days to 10 Hz), then Docker
images and logs on the Coolify server, or grow the volume.

## 5. Still missing

- **A second disk alarm on the server itself.** `ops/disk-alarm.sh` is written (alerts above 80% on `/` and on the Docker
  volumes folder, opens a "Disk alarm" issue) but is not on the server. Install steps are at the top of the script; it needs
  `gh` and a fine-grained token (Issues write, this repo only) on the Coolify server. It would also cover the database volume
  and `/`, which `/api/health` does not report.
- **Backups of the files volume.** The database has a daily backup (04:00, 14 kept); the `xpeed-files` volume
  does not, and nothing alerts when a backup fails.
- **Outside view of the server itself.** The uptime check runs from GitHub, so it sees what visitors see, but
  it cannot tell why (stopped container, expired certificate). The disk number covers one cause.
