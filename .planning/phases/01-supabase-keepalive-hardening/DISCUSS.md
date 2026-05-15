# Phase 01: Supabase Keepalive Hardening

## Problem statement

Supabase free-tier auto-pauses projects after 7 days of inactivity. A keepalive
implementation already exists (`scripts/supabase-keepalive.mjs` +
`.github/workflows/supabase-keepalive.yml`, commit `ec7c480`, dated 2026-03-08),
yet on **2026-05-14** the project `Car Insights AI` (ID `drqmrddxlrlbqnydumjm`)
was auto-paused.

## Root cause (confirmed via `gh api`)

The Supabase Keepalive workflow's state was `disabled_inactivity` as of
2026-05-07. This is **GitHub's documented behaviour**: scheduled workflows
(`on: schedule`) are automatically disabled after 60 days of repository
inactivity (no commits to the default branch). There is no email notification
when this happens.

Timeline:
- 2026-03-08 — last commit on `main` before the disable event
- 2026-05-07 — GitHub disables the workflow (60 days idle)
- 2026-05-07 → 2026-05-14 — Supabase project receives no activity (7 days)
- 2026-05-13 — Supabase warns of pending pause
- 2026-05-14 — Supabase pauses the project

## Why prior fix (`ec7c480`) was insufficient

Commit `ec7c480 fix: improve Supabase keepalive reliability` improved the script
(retries, multi-operation activity, sanitized env vars) but did nothing to
prevent the workflow itself from being disabled. The reliability problem was
upstream of the script — it was at the cron trigger level.

## Goal

The keepalive must never fail silently again, full stop. That requires:

1. **Defeat the 60-day idle disable** — workflow must keep the repo "active"
   from GitHub's perspective, regardless of human commits.
2. **Redundant detection** — if the keepalive workflow somehow stops (other
   GitHub outage, disabled secret, etc.), a second mechanism must detect
   staleness and surface it loudly.
3. **Observability** — a failure must produce a visible signal (email, badge,
   anything actionable) before Supabase pauses.
4. **Documented recovery** — if it ever does fail, the steps to recover must
   be in `README.md`.

## Decisions

- **Trigger source:** GitHub Actions (explicit user decision 2026-05-15). No
  Vercel cron, UptimeRobot, or cron-job.org as alternatives.
- **Free tier:** must stay within free-tier constraints (no Supabase Pro, no
  paid GitHub Actions plan).
- **Heartbeat strategy:** the keepalive workflow itself pushes a small commit
  (heartbeat file under `.github/`) on each run, which counts as repo activity
  and prevents the 60-day disable. The commit message includes `[skip ci]` to
  avoid triggering other CI workflows.
- **Redundant check:** a second workflow on a different schedule reads the
  `app_settings.system.supabase_keepalive` row written by the script and fails
  loudly if `updated_at` is more than 12 hours stale.
- **Notifications:** rely on GitHub's built-in "failed workflow" email
  notifications (Settings → Notifications → Actions). Cheap and effective.

## Non-goals

- Migrating to Supabase Pro to remove auto-pause entirely.
- Adding external monitoring services (UptimeRobot, etc.).
- Re-architecting the existing keepalive script — it works fine when triggered.

## Open questions

None. All decisions captured above.
