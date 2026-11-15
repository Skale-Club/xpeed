// POST /api/sim/companion-errors: Xpeed Companion reports a crash (a panic it wrote to a file and sends at its next start) or a worker that keeps
// failing ("worker X restarted N times"). Device key, like a heartbeat or a lap upload; not a browser: no CORS headers. First-party only.
//
//   { "version": "0.8.0", "worker": "recorder", "message": "panicked at ...", "backtrace": "...", "os": "windows 11", "at": "2026-11-15T10:00:00.000Z" }
//
// Strict on version and worker (and on the types of the rest); any other field is ignored (a newer Companion may send more). The message
// and backtrace are scrubbed here again (e-mails, phone numbers, tokens, query strings, the account name in a Windows path). The device key
// is the only identity: it gives the rate limit (10 a minute per device) and the "people affected" count (a one-way hash, never an id).
// Answers 200 {"ok":true}; refusals are { error, retryable } like every upload refusal. A revoked or unknown key is 401.
import { openBackend } from '../_backend';
import { COMPANION_REPORTS_PER_MINUTE, failedReport, MAX_REPORT_BYTES, readCompanionReport, recordReport } from '../_error-reports';
import { bearer, refuse, reply, sha256Hex } from './_shared';

export default async function companionErrors(req: Request): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  const key = bearer(req);
  if (!key) return refuse({ error: 'unauthorized' }, 401, false);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) return refuse({ error: 'too_large' }, 413, false);

  const backend = openBackend();
  if (!backend) return refuse({ error: 'unavailable' }, 503, true);
  try {
    const text = await req.text();
    if (text.length > MAX_REPORT_BYTES) return refuse({ error: 'too_large' }, 413, false);
    const read = readCompanionReport(text);
    if (!read.ok) return refuse({ error: read.why }, 400, false);
    // One statement: the device behind the key, the rate count and the write. A revoked or unknown key is null.
    const done = await recordReport(backend, 'companion', read.value, { rateKey: '', rateMax: COMPANION_REPORTS_PER_MINUTE, tokenHash: sha256Hex(key) });
    if (!done) return refuse({ error: 'unauthorized' }, 401, false);
    if (done.status === 'rate') return refuse({ error: 'too_many_requests' }, 429, true, { 'Retry-After': String(Math.max(1, Number(done.wait) || 60)) });
    if (done.status === 'full') console.error(JSON.stringify({ event: 'error_groups_full', source: 'companion' }));
    return reply({ ok: true });
  } catch (error) {
    failedReport('companion_error_report_failed', error);
    return refuse({ error: 'unavailable' }, 503, true);
  }
}
