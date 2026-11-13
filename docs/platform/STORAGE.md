# Storage: disk or S3, and how laps are kept

Phase 1, part 2. All files of the app (lap files, track layouts, photos, trip CSVs, small JSON records) go through
one interface, `FileStore` (`server/files.ts`). There are two implementations and the environment picks one.

| Driver | Class | When |
|---|---|---|
| `disk` (default) | `DiskStore` | A folder on the server volume (`STORAGE_DIR`, `/data/files` by default). Today's production. |
| `s3` | `S3Store` (`server/s3.ts`) | Any S3-compatible object storage: Cloudflare R2, Backblaze B2, Hetzner Object Storage, MinIO, AWS S3. |

The code that uses files (`api/*`, the storage route, the service client, `/api/health/deep`) does not know which one
it has: it calls `createStore()` (`server/storage-driver.ts`).

## Switching

Nothing changes unless `STORAGE_DRIVER=s3` is set. To use S3 storage:

| Variable | Required | Meaning |
|---|---|---|
| `STORAGE_DRIVER` | yes | `s3` (anything but `disk` or `s3` stops the server at start-up) |
| `S3_ENDPOINT` | yes | The provider's address, no bucket in it: `https://<account>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | yes | The one bucket the app uses. App buckets (`sim-laps`, `session-photos`...) are key prefixes inside it |
| `S3_ACCESS_KEY_ID` | yes | |
| `S3_SECRET_ACCESS_KEY` | yes | Never logged; error messages name the missing variable, not its value |
| `S3_REGION` | no | Default `auto` (what R2 wants). B2 needs its real region (`us-west-004`), Hetzner too (`fsn1`) |
| `S3_FORCE_PATH_STYLE` | no | Default `true`: `endpoint/bucket/key`. `false` gives `bucket.endpoint/key` |

The server checks these at start-up (`assertStorageEnv`), so a bad deploy fails at once instead of on the first
upload. `/api/health` and `/api/health/deep` report `storage: ok | down | off` for either driver: the deep check writes
and deletes a small object (`.probe/<uuid>` at the root of the bucket) with the credentials in use, so a revoked key or
a full account turns the uptime monitor red.

`STORAGE_SECRET` (signed download links) is independent of the driver.

### Provider notes

| Provider | `S3_ENDPOINT` | `S3_REGION` | Notes |
|---|---|---|---|
| Cloudflare R2 | `https://<account id>.r2.cloudflarestorage.com` | `auto` | Make an API token with Object Read & Write on the one bucket. No egress fees. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | the region in the endpoint, e.g. `us-west-004` | Application key limited to the bucket. |
| Hetzner Object Storage | `https://<location>.your-objectstorage.com` | the location, e.g. `fsn1` | |

How it talks to them: AWS Signature Version 4 with `node:crypto` and `fetch`, no SDK (about 300 lines, no new
dependency). It uses PUT, GET, HEAD, DELETE and ListObjectsV2 only. A "do not overwrite" upload (`upsert: false`) sends
`If-None-Match: *` and checks with a HEAD first, so a provider that ignores the header still cannot overwrite in the
normal case (a provider that ignores the header leaves a small window between the two requests).

Reads are limited to 128 MB per object in memory, read as a stream so a lying answer is cut off.

## Moving from the disk to R2 or B2

Use `scripts/storage-copy.mjs`. It copies every object, never deletes anything, and is a dry run unless you say
`--apply`.

1. Create the bucket and an access key at the provider. Put the `S3_*` settings in the shell (not in a file that is
   committed). Keep the app running on the disk meanwhile.
2. Look first (changes nothing, on either side):

   ```
   STORAGE_DIR=/data/files S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_REGION=auto \
     node scripts/storage-copy.mjs --from disk --to s3
   ```

   It prints, per bucket, how many objects each side has, how many would be copied and how many are already there.
3. Copy: same command with `--apply` (add `--verify-content` to also read every copied object back and compare its
   SHA-256). After copying it checks the size of **every** object on the destination and exits with 1 if anything is
   missing or different. Objects already on the destination with the same size are skipped, so the command can be
   repeated and resumed; run it again right before the switch to catch what arrived meanwhile.
4. Switch: set `STORAGE_DRIVER=s3` and the `S3_*` variables in Coolify, redeploy. Check `/api/health/deep` is 200 and
   open a lap in the app.
5. Keep the disk volume for a while as the backup. The script never touches it.

Two sides with different settings (R2 to B2): prefix with `SRC_` and `DST_`, for example `SRC_S3_BUCKET=old
DST_S3_BUCKET=new`. A prefixed variable wins over the plain one. `--from-dir` and `--to-dir` set a disk side's folder.
`--bucket sim-laps` copies one app bucket only (repeatable).

### What protects the destination

- Nothing is written without `--apply`.
- If the destination is empty, or only holds objects the source also has with the same size (a resumed copy), `--apply`
  just copies.
- If it holds objects the source does not have, or objects with the same name and a **different size** (a copy would
  overwrite something, for example laps that retention already reduced), the run goes through
  `db/guard-destructive.mjs`: a destination that matches a production host (`XPEED_PROD_HOSTS` adds yours, for example
  the R2 endpoint host) is refused unless `--i-know-this-is-production` is given and the host is typed in a terminal;
  any other destination asks for its name to be typed back, or `--yes`. With no terminal and no `--yes` it refuses
  (exit 2) and changes nothing.
- Add the production R2 endpoint host to `XPEED_PROD_HOSTS` once it exists, so a copy aimed at it by mistake is
  refused.

## Retention: old laps shrink to 10 Hz

`server/retention.ts`, run once a day by `server/jobs.ts`, **off unless `RETENTION_ENABLED=true`** (and a database is
configured). `reduceOldLaps({ olderThanDays: 90, hz: 10 })` reduces laps that are older than 90 days (by `started_at`),
not a personal best and not marked. The row keeps its summary columns (`sample_count`, time, sectors); only the file
shrinks and the row gets `reduced = true` and the new `size_bytes`.

For each lap, in this order (it never loses a lap):

1. read the file with the strict reader; a file that does not open is left alone and counted as `unreadable`;
2. keep about 10 samples per second chosen from the real clock (`t`): the first and the last sample always stay, every
   channel is cut at the same positions, `sampleRateHz` becomes 10, and every other header field (track, car, lap time,
   sectors, start time, channels) is exactly as it was;
3. write it with the strict writer, read it back and compare (header, lap time, first and last samples, all channels);
   anything that differs aborts this lap;
4. write the bytes under a temporary key (`<user>/.reducing-<name>`), read them back;
5. replace the real key (an atomic write on both drivers) and read it back;
6. update the row (`WHERE reduced = false`, so two instances running at once are harmless);
7. remove the temporary key.

If step 5 or 6 fails the original bytes (still in memory) are written back, so the row and the file agree: both say
"full detail" or both say "reduced". A lap that is already at 10 Hz or less is only marked. A run is limited by a time
budget (5 minutes) and a lap count (500) and works in batches of 25; what is left is done the next day.

One line per run goes to the log: `{"event":"job_done","job":"retention","considered":..,"reduced":..,
"alreadyLow":..,"unreadable":..,"missingFile":..,"failed":..,"savedBytes":..,"ms":..,"budgetReached":..}`.

### Assumed schema (to resolve when the data-model migration lands)

`candidatesForReduction()` in `server/retention.ts` selects the laps. At the time it was written the migrations had
none of these:

| Assumed | Where | Meaning |
|---|---|---|
| `sim_laps.reduced boolean NOT NULL DEFAULT false` | data-model task | set by retention |
| `sim_laps.marked boolean NOT NULL DEFAULT false` | not designed yet | a lap the person asked to keep in full detail |
| `sim_personal_bests.lap_id uuid` | data-model task (`sim_personal_bests`) | the lap that holds a best; those are never reduced |

The existing `sim_laps.id`, `user_id`, `storage_path`, `size_bytes`, `started_at` are used as they are. If a name
differs, change `CANDIDATES_SQL` and `MARK_REDUCED_SQL` (both marked `TODO(merge)`) and nothing else. The rows the query
returns are checked again in JavaScript from their own flags, so a loose query cannot send a personal best or a marked
lap to the reducer. `scripts/verify-storage.mjs` runs the SQL on a real PostgreSQL (PGlite) with those columns.

## Orphan sweeper

`server/jobs.ts` also schedules `sweepOrphanLaps()` once a day, when it exists. It is looked up by name in
`api/sim/_shared` with a `typeof` check, so the schedule works before and after the data-model task adds it (it logs
`job_done` with whatever the function returns). The retention temporary names start with a dot, so listings
(`list`, `listAll`) never show them and a sweeper that walks the listings cannot delete a copy in progress; a leftover
of a crashed run is removed the next time that lap is processed.

## Plausibility recheck

`server/jobs.ts` also runs `plausibility_recheck` (on by default; `PLAUSIBILITY_RECHECK=false` turns it off): laps that arrived before the
plausibility checks (`plausible IS NULL`) get their verdict from their files, 200 at a time, for at most 3 minutes a run; first run 1 to 5 minutes after
start, then daily. One `job_done` line with `checked`, `plausible`, `implausible`, `remaining`. See `API-V1.md` (Plausibility).

## Tests

`npm run test:storage` (`scripts/verify-storage.mjs`, in CI after `test:sim`): the S3 driver against an in-process fake
S3 that recomputes every signature itself (and a check against the examples published in the AWS documentation), one
contract suite run against both drivers, the copy script as a child process, and retention against a real PostgreSQL
and both drivers, including write failures halfway. No real storage account and no production data are involved.
