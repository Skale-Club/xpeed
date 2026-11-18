# Optional Virtual coach: verification and pilot acceptance

Local feature branch: `feat/virtual-driving-coach`. Nothing here authorizes a
push, merge, production migration, secret configuration or deployment.

## Automated checks

On a suitable machine or the existing CI runners, run the repository's normal
typecheck/lint/Vitest/build and Deno checks, plus `npm run test:virtual-coach`.
The focused suite uses fake identities/data/provider boundaries and isolated
PostgreSQL; it must never load production credentials or contact paid AI.
For the native app run `cargo fmt --check`, `cargo clippy --all-targets --locked
-- -D warnings`, `cargo test --locked` and the Windows installer build. CI keeps
formatter corrections as an artifact if rustfmt fails. Feature-branch Windows
checks build artifacts only; the publication job remains restricted to main.

Surface constraints: project dependencies and Rust tools are absent, and
memory is critical. Local syntax/targeted semantic checks, Node contracts,
isolated SQL and PowerShell AST parsing do not replace these full checks.

## Product flow

1. Sign in to a development account with fake sessions. Coach starts off.
   Capture, upload, session/compare screens remain usable without it. Opening
   Training goals or Car setups is a separate explicit action and makes no AI
   call. Example mode cannot create real records or start paid requests.
2. Save each goal metric from an eligible baseline. Confirm target units,
   missing follow-up, the latest same-context/kind session after creation,
   condition/partial-coverage labels, source links and explicit manual status.
   Delete a source lap/session and refresh: no stale measured improvement.
3. Save a setup, copy a revision and compare changed values/units. Creation and
   viewing do not record session usage. Explicitly attach/detach the version;
   verify only that snapshot reaches coach context. Removing the parent keeps
   child settings. Session deletion preserves the library; full Virtual-data
   erasure removes it. Privacy export includes goals, setups and Virtual chats
   without Real-car chats, device key hashes or provider credentials.
4. Confirm only super admin can see provider/key controls. Select a client and
   configure its assigned source using test stubs. Ordinary users cannot
   access key metadata or mutate it through the API. Personal billing never
   consumes platform quota and failures never switch sources automatically.
5. In Companion Monitor open Session Coach. It starts off, and demo has no
   working launcher. Without owner permission it offers `/virtual/companion`.
   A device token cannot enable itself; a different account cannot permit it.
   Revocation disables capability as well as normal device access.
6. Enable locally, select an uploaded session and inspect the shared history.
   Record only after the pilot's deliberate click, check the preview and send
   manually. Speak answer/Stop voice are independent. Missing language engines
   preserve typing. Check tab/focus/Escape, scaling/small screens and native
   parent-window closing. Native controls currently use English.
7. During HTTP/dictation/speech close, disable, switch sessions, change language
   by reopening, or re-pair: stale text/results must not reach the new scope.
   Windows process exit must terminate its own speech Job Object. No audio file,
   hidden recording, shell text interpolation or automatic paid send occurs.
8. Simulate uncertain delivery and restart. Pending history restores the exact
   admitted UUID/message; only manual Send checks it. Completed retries return
   cache, pending stays pending, and a busy device does not claim the fresh
   UUID. Definitive failure may release a nonce only for a later manual send.

## Release preparation

Apply the five additive migrations (16:00 chat, 17:00 credentials, 18:00 goals,
19:00 setups, 20:00 Companion) through the normal validated release procedure.
The authorized Coolify deployment provisions a persistent hidden runtime-only
32-byte Base64 `AI_CREDENTIAL_ENCRYPTION_KEY` if absent and preserves existing
keys without rotation. Its API token needs environment read/write permissions.
Never commit the key or expose it as `VITE_*`; keep protected Coolify backups.
Existing global mode needs no such secret. The native publication job waits for
the exact compatible server commit with healthy database/storage before
distributing Companion 0.12.0. Release authorization and measured evidence belong
in the app journal; feature-branch artifacts are not evidence of production
publication or real driving/audio acceptance.
