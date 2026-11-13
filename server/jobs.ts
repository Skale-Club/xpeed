// Background jobs, one run a day each, started once from server/index.ts:
//   - retention (RETENTION_ENABLED=true): old laps are reduced to 10 Hz (server/retention.ts);
//   - orphan sweeper: `sweepOrphanLaps()` removes lap files that have no row. It lives in the sim data model code; this
//     file calls it when it exists (typeof check), so the schedule works before and after that function lands.
// Every run logs one JSON line. A job never throws into the process and never overlaps itself.
import { getPool } from './db';
import { createStore } from './storage-driver';
import { reduceOldLaps, type RetentionDb } from './retention';
import * as simShared from '../api/sim/_shared';

type Env = Record<string, string | undefined>;
const DAY_MS = 24 * 3600 * 1000;

export interface Job { name: string; run: () => Promise<Record<string, unknown> | void> }

/** The first run waits a random time (so a restart loop or several instances do not all start at once), then every 24 hours. */
export function scheduleDaily(job: Job, { random = Math.random, maxOffsetMs = 3 * 3600 * 1000, setTimer = setTimeout }: { random?: () => number; maxOffsetMs?: number; setTimer?: typeof setTimeout } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const summary = await job.run();
      console.log(JSON.stringify({ event: 'job_done', job: job.name, ms: Date.now() - started, ...(summary ?? {}) }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'job_failed', job: job.name, ms: Date.now() - started, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
    } finally { running = false; }
  };
  const delay = Math.floor(random() * maxOffsetMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (wait: number) => { timer = setTimer(() => { void tick().finally(() => arm(DAY_MS)); }, wait); timer?.unref?.(); };
  arm(delay);
  return { delay, stop: () => clearTimeout(timer) };
}

/** The jobs this environment asks for. Exported so a test can see which ones would run. */
export function enabledJobs(env: Env = process.env, shared: Record<string, unknown> = simShared): Job[] {
  const jobs: Job[] = [];
  if (env.RETENTION_ENABLED === 'true' && env.DATABASE_URL) {
    jobs.push({
      name: 'retention',
      run: async () => ({ ...(await reduceOldLaps({ db: getPool() as unknown as RetentionDb, store: createStore(env), olderThanDays: 90, hz: 10 })) }),
    });
  }
  const sweep = shared.sweepOrphanLaps;
  // TODO(merge): sweepOrphanLaps() comes from the data-model task. It is looked up in api/sim/_shared; if it lands in
  // another module, import it there and pass it here. Its result (a count, or an object) is logged as it is.
  if (typeof sweep === 'function' && env.DATABASE_URL) {
    jobs.push({
      name: 'orphan_sweeper',
      run: async () => {
        const result = await (sweep as () => unknown)();
        return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : { result };
      },
    });
  }
  return jobs;
}

export function startBackgroundJobs(env: Env = process.env) {
  return enabledJobs(env).map((job) => ({ name: job.name, ...scheduleDaily(job) }));
}
