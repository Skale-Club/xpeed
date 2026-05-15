# Phase 01: Supabase Keepalive Hardening — PLAN

## Tasks

### 1. Update `.github/workflows/supabase-keepalive.yml`

- Add `permissions: contents: write` at workflow level.
- Add `contents: write` requires `actions/checkout@v4` to use the default
  `GITHUB_TOKEN` (no extra setup needed).
- After the keepalive script succeeds, append a step that:
  - Writes a timestamp to `.github/keepalive-heartbeat`
  - Configures git user as `github-actions[bot]`
  - Commits with message `chore: keepalive heartbeat <UTC ISO> [skip ci]`
  - Pushes to `main`
- The `[skip ci]` suffix avoids triggering downstream CI in this workflow or any
  future workflows on push events.

### 2. Create `scripts/supabase-keepalive-verify.mjs`

A small read-only verifier that:
- Reads `app_settings` row `system.supabase_keepalive` via Supabase client.
- Parses `setting_value.updated_at_utc` (or falls back to row `updated_at`).
- Exits non-zero if no row found OR timestamp is older than `MAX_STALE_HOURS`
  (default 12).
- Logs clearly what it found and the staleness.

### 3. Add `supabase:keepalive:verify` npm script

In `package.json`, add:
```json
"supabase:keepalive:verify": "node scripts/supabase-keepalive-verify.mjs"
```

### 4. Create `.github/workflows/supabase-keepalive-healthcheck.yml`

- `on: schedule` at `0 14 * * *` (daily at 14:00 UTC — offset from the 6-hourly
  keepalive so it lands between runs).
- `on: workflow_dispatch` for manual checks.
- Runs `npm run supabase:keepalive:verify` with the same secrets.
- On failure, the GitHub Actions failure-email kicks in.

### 5. Initial heartbeat file

- Create `.github/keepalive-heartbeat` now with a starting timestamp so the
  first scheduled run has something to update (avoids "nothing to commit" on
  first push).

### 6. Update `README.md`

Add a short "Supabase keepalive (operational note)" section under a
maintenance / ops heading:
- What it does
- Why it exists (the 60-day idle disable trap)
- Where to look if the Supabase pause email arrives again
- Manual recovery steps (re-enable workflow, dispatch manually, check secrets)

### 7. Commit and push

Single commit titled `fix: harden Supabase keepalive against GitHub idle
disable`. Push to `main`. This commit itself resets the 60-day clock.

### 8. Verify on GitHub

- Trigger both workflows manually via `gh workflow run`.
- Confirm both finish green.
- Confirm the heartbeat commit was pushed (visible in `git log` after `git
  pull`).

## Risks & mitigations

- **Push-on-every-run pollutes git log**: 4 commits/day × 365 = ~1500 commits/yr.
  Mitigated by `[skip ci]` to keep CI quiet and tagging commits with bot author
  so humans can filter them. Acceptable trade-off — repo is private,
  history is informational.
- **Heartbeat commit could conflict with concurrent human pushes**: mitigated
  by `git pull --rebase` before push, OR by retrying on conflict. We will use
  a simple `git push`; if it fails the workflow fails loudly (good — we want
  to know). The next scheduled run will retry.
- **Permissions failure**: if `contents: write` isn't enabled at repo level
  (Settings → Actions → General → Workflow permissions), the push will fail.
  Will verify after first run; documented in README.

## Success criteria (verify-backward)

- [ ] Both workflows in `state: "active"` on GitHub
- [ ] Manual dispatch of `supabase-keepalive.yml` succeeds AND pushes a commit
- [ ] Manual dispatch of `supabase-keepalive-healthcheck.yml` succeeds
- [ ] `.github/keepalive-heartbeat` file exists with a recent UTC timestamp
- [ ] `app_settings.system.supabase_keepalive` row is fresh (the existing
      script already does this; verifier confirms)
- [ ] README documents recovery procedure
