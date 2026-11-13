// Background jobs, one run a day each, started once from server/index.ts:
//   - retention (RETENTION_ENABLED=true): old laps are reduced to 10 Hz (server/retention.ts);
//   - plausibility recheck (on; PLAUSIBILITY_RECHECK=false turns it off): laps that arrived before the plausibility checks get their
//     verdict from their files, 200 at a time, for at most 3 minutes a run (api/sim/_plausibility.ts). First run 1 to 5 minutes after start;
//   - orphan sweeper: `sweepOrphanLaps()` (api/sim/_sweep.ts) removes lap files that have no row. It is passed in, so a test
//     can run the schedule with or without it.
// Every run logs one JSON line. A job never throws into the process and never overlaps itself.
import { getPool } from './db';
import { createStore } from './storage-driver';
import { reduceOldLaps, type RetentionDb } from './retention';
import { sweepOrphanLaps } from '../api/sim/_sweep';
import { openBackend } from '../api/_backend';
import { recheckLaps, type RecheckResult } from '../api/sim/_plausibility';

type Env = Record<string, string | undefined>;
const DAY_MS = 24 * 3600 * 1000;

export interface Job {
  name: string;
  run: () => Promise<Record<string, unknown> | void>;
  /** The first run waits a random time between these two (milliseconds); the default is 0 to 3 hours. */
  firstRunMs?: [min: number, max: number];
}

/** The first run waits a random time (so a restart loop or several instances do not all start at once), then every 24 hours. */
export function scheduleDaily(job: Job, { random = Math.random, minOffsetMs = 0, maxOffsetMs = 3 * 3600 * 1000, setTimer = setTimeout }: { random?: () => number; minOffsetMs?: number; maxOffsetMs?: number; setTimer?: typeof setTimeout } = {}) {
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
  const delay = minOffsetMs + Math.floor(random() * (maxOffsetMs - minOffsetMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (wait: number) => { timer = setTimer(() => { void tick().finally(() => arm(DAY_MS)); }, wait); timer?.unref?.(); };
  arm(delay);
  return { delay, stop: () => clearTimeout(timer) };
}

export const RECHECK_BATCH = 200;
export const RECHECK_BUDGET_MS = 3 * 60 * 1000;
/** The first plausibility recheck runs 1 to 5 minutes after start. */
export const RECHECK_FIRST_RUN_MS: [number, number] = [60 * 1000, 5 * 60 * 1000];
let rechecking = false;

/**
 * Reads the files of laps that have no plausibility verdict, `batch` at a time, until none is left or `budgetMs` is spent (checked
 * before each batch). Answers the totals of the run (`remaining` is what the last batch left). A batch that checks nothing ends the run, so a
 * lap that cannot be settled never loops; recheckLaps itself marks an unreadable file, so it is not met again. Never overlaps itself.
 */
export async function runPlausibilityRecheck({ recheck, batch = RECHECK_BATCH, budgetMs = RECHECK_BUDGET_MS, now = Date.now }:
  { recheck: (limit: number) => Promise<RecheckResult>; batch?: number; budgetMs?: number; now?: () => number }): Promise<RecheckResult | { skipped: true }> {
  if (rechecking) return { skipped: true };
  rechecking = true;
  try {
    const started = now();
    const total: RecheckResult = { checked: 0, plausible: 0, implausible: 0, remaining: 0 };
    for (;;) {
      const done = await recheck(batch);
      total.checked += done.checked; total.plausible += done.plausible; total.implausible += done.implausible; total.remaining = done.remaining;
      if (done.remaining <= 0 || done.checked === 0 || now() - started >= budgetMs) return total;
    }
  } finally { rechecking = false; }
}

/** The jobs this environment asks for. Exported so a test can see which ones would run. */
export function enabledJobs(env: Env = process.env, shared: Record<string, unknown> = { sweepOrphanLaps, recheckLaps }): Job[] {
  const jobs: Job[] = [];
  if (env.RETENTION_ENABLED === 'true' && env.DATABASE_URL) {
    jobs.push({
      name: 'retention',
      run: async () => ({ ...(await reduceOldLaps({ db: getPool() as unknown as RetentionDb, store: createStore(env), olderThanDays: 90, hz: 10 })) }),
    });
  }
  const sweep = shared.sweepOrphanLaps;
  if (typeof sweep === 'function' && env.DATABASE_URL) {
    jobs.push({
      name: 'orphan_sweeper',
      run: async () => {
        const result = await (sweep as () => unknown)();
        return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : { result };
      },
    });
  }
  const recheck = shared.recheckLaps;
  if (env.PLAUSIBILITY_RECHECK !== 'false' && typeof recheck === 'function' && env.DATABASE_URL) {
    jobs.push({
      name: 'plausibility_recheck',
      firstRunMs: RECHECK_FIRST_RUN_MS,
      run: async () => {
        const backend = openBackend(env as NodeJS.ProcessEnv);
        if (!backend) throw new Error('no backend');
        return { ...(await runPlausibilityRecheck({ recheck: (limit) => (recheck as typeof recheckLaps)(backend, limit) })) };
      },
    });
  }
  return jobs;
}

export function startBackgroundJobs(env: Env = process.env) {
  return enabledJobs(env).map((job) => ({ name: job.name, ...scheduleDaily(job, job.firstRunMs ? { minOffsetMs: job.firstRunMs[0], maxOffsetMs: job.firstRunMs[1] } : {}) }));
}
