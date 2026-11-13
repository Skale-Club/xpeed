# Alerts: what tells the owner that something is wrong

Written 2026-11-13, after the 2026-11-10 incident (a copy script overwrote production). The scripts are now
guarded (see `db/guard-destructive.mjs` and `docs/database/README.md`); this page is about being told when
the site is down.

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

## 3. Still missing

- **Error tracking.** Nothing records server exceptions or client crashes; a bug that does not take the site
  down is invisible until someone reports it. Candidate: Sentry (the Sentry connector exists), or logs shipped
  from the Coolify container.
- **Disk alarm, not installed.** `ops/disk-alarm.sh` is written (alerts above 80% on `/` and on the Docker
  volumes folder, opens a "Disk alarm" issue) but is not on the server. Install steps are at the top of the
  script; it needs `gh` and a fine-grained token (Issues write, this repo only) on the Coolify server.
- **Backups of the files volume.** The database has a daily backup (04:00, 14 kept); the `xpeed-files` volume
  does not, and nothing alerts when a backup fails.
- **Outside view of the server itself.** The uptime check runs from GitHub, so it sees what visitors see, but
  it cannot tell why (full disk, stopped container, expired certificate). The disk alarm covers one cause.
