# Phase 01: Supabase Keepalive Hardening — VERIFICATION

All success criteria from PLAN.md confirmed end-to-end on 2026-05-15.

## Evidence

### 1. Workflows in `active` state

```
$ gh api repos/Skale-Club/car-insights-ai/actions/workflows
Supabase Keepalive Health Check -> active
Supabase Keepalive              -> active
```

Both workflows are armed. The previously-disabled state (`disabled_inactivity`)
was cleared.

### 2. Manual dispatch of `supabase-keepalive.yml` succeeded AND pushed a heartbeat commit

Run `25918158909` (workflow_dispatch, 2026-05-15T12:37:32Z) — `success` in 34s.

Produced commit `4fc39ce`:

```
4fc39ce 2026-05-15 chore: keepalive heartbeat 2026-05-15T12:38:02Z [skip ci]
90e18d1 2026-05-15 fix: harden Supabase keepalive against GitHub idle disable
```

The `[skip ci]` tag was honoured — the heartbeat commit did not trigger
the workflow again (verified by no new in-progress run after the push).

### 3. Manual dispatch of `supabase-keepalive-healthcheck.yml` succeeded

Run `25918159803` (workflow_dispatch, 2026-05-15T12:37:34Z) — `success` in 32s.

The verifier successfully read `app_settings.system.supabase_keepalive` and
confirmed freshness was well within the 12h threshold.

### 4. `.github/keepalive-heartbeat` file is fresh on `main`

```
Last keepalive: 2026-05-15T12:38:02Z
```

Timestamp matches the heartbeat commit, written automatically by the workflow.

### 5. `app_settings.system.supabase_keepalive` row is fresh

Confirmed via the health-check workflow: the row was updated by the keepalive
script and read back successfully by the verifier in the same minute.

### 6. README documents recovery procedure

`README.md` section "Supabase Keepalive (operational note)" covers:
- What both workflows do and why
- Required secrets + required repo "Workflow permissions" setting
- Manual ops commands (`npm run supabase:keepalive`,
  `npm run supabase:keepalive:verify`)
- Step-by-step recovery via `gh` CLI if it happens again

## Why this fix won't degrade

The defence-in-depth is real, not cosmetic:

- **Layer 1 (preventive):** every successful keepalive run pushes a commit. As
  long as the keepalive runs at all in any 60-day window, GitHub will not
  disable the schedule. Since keepalive runs every 6h, the schedule has
  ~240 attempts to push a commit before the 60-day deadline. A single
  successful run is enough to reset the clock.
- **Layer 2 (detective):** the daily health check fails loudly if the
  heartbeat row is > 12h stale. GitHub Actions emails the repo owner on
  failure. So even if Layer 1 ever silently fails (e.g. push rejected by
  branch protection added later, secret rotated), the detection latency is
  bounded at ~24h — well below Supabase's 7-day pause window.
- **Layer 3 (recovery):** the README has the exact `gh` CLI commands needed to
  diagnose + re-enable, so recovery is mechanical, not investigative.

The original failure mode (silent disable after 60 days, learn from Supabase
pause email) is now impossible: Layer 2 alarms within 24h, well before
Supabase reaches its 7-day pause threshold from any single missed run.

## Commits

- `90e18d1 fix: harden Supabase keepalive against GitHub idle disable` (manual)
- `4fc39ce chore: keepalive heartbeat 2026-05-15T12:38:02Z [skip ci]` (workflow)
