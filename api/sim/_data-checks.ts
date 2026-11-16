// What the Companion's automatic data checks found in a lap (the `checks` list of the lap header, see src/lib/sim/lap-file.ts), turned into
// what the server keeps and what the admin Problems page shows.
//
// The Companion already uploads every lap with the device key, so the findings travel with the lap and the server reports them: no second
// sender, no second endpoint, and the report is made by the same code that records a crash (recordReport, one error group per message). The
// message has no number that changes from lap to lap, so one problem is one group (per reader, game, check and Companion version), counted by
// occurrences and by people affected:
//
//   data check clutch_stuck in acevo (Assetto Corsa EVO 0.9.1), Companion 0.8.2
//
// Never fails a lap: a report that cannot be made is logged and forgotten.
import type { Backend } from '../_backend';
import type { LapHeader } from '../../src/lib/sim/lap-file';
import { COMPANION_REPORTS_PER_MINUTE, failedReport, recordReport, type NormalizedReport } from '../_error-reports';
import { fingerprintOf, scrubMessage } from '../../src/lib/error-scrub';
import { sha256Hex } from './_shared';

/** The worker name of these reports: the Problems page shows it where a crash shows the part of the app that broke. */
export const DATA_CHECK_WORKER = 'data-check';
/** At most this many reports for one lap: a broken reader fails several checks at once, and the rate limit is shared with crash reports. */
const MAX_REPORTS_PER_LAP = 4;

/** The `recorder` column: who recorded the lap and the checks it failed, or null for a file that carries neither. */
export function recorderJson(header: LapHeader): Record<string, unknown> | null {
  if (!header.recorder && !header.checks?.length) return null;
  return { ...(header.recorder ?? {}), ...(header.checks?.length ? { checks: header.checks } : {}) };
}

/** "data check clutch_stuck in acevo (Assetto Corsa EVO 0.9.1), Companion 0.8.2". */
export function dataCheckMessage(check: string, header: LapHeader): string {
  const recorder = header.recorder;
  const source = recorder?.source ?? header.game;
  const game = recorder?.gameBuild ? ` (${recorder.gameBuild})` : '';
  return `data check ${check} in ${source}${game}${recorder ? `, Companion ${recorder.version}` : ''}`;
}

/** Reports the checks the lap failed to the Problems page. Needs the Companion's version (a lap with no recorder cannot be told from a hand-made file). */
export async function reportDataChecks(backend: Backend, deviceKey: string, header: LapHeader): Promise<number> {
  const recorder = header.recorder;
  if (!recorder || !header.checks?.length) return 0;
  let sent = 0;
  for (const check of header.checks.slice(0, MAX_REPORTS_PER_LAP)) {
    try {
      // The message is scrubbed like a crash report's. The fingerprint is the server's own and keeps the version apart from the numbers the
      // generic one makes equal: one group per (reader, game, check, Companion version), whatever the game build or the lap.
      const message = scrubMessage(dataCheckMessage(check, header));
      if (!message) continue;
      const read: NormalizedReport = {
        message, stack: '', route: null, version: recorder.version, agent: 'windows', worker: DATA_CHECK_WORKER, at: null,
        fingerprint: fingerprintOf(message, '', [DATA_CHECK_WORKER, check, recorder.source, header.game, recorder.version].join('|')),
      };
      const done = await recordReport(backend, 'companion', read, { rateKey: '', rateMax: COMPANION_REPORTS_PER_MINUTE, tokenHash: sha256Hex(deviceKey) });
      if (done?.status === 'rate') break;
      if (done?.status === 'ok') sent += 1;
    } catch (error) {
      failedReport('data_check_report_failed', error);
      break;
    }
  }
  return sent;
}
