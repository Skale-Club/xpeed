// POST /api/client-errors: the site tells Xpeed's own server that a page broke in somebody's browser (src/lib/error-reporter.ts).
// No third-party service: the report is scrubbed again here and stored in the app's database (supabase/migrations/20261115120000_error_tracking.sql),
// where the admin page lists it as a problem.
//
//   { "message": "...", "stack": "...", "route": "/virtual/sessions/:id", "build": "6ae3b07a1c2d", "agent": "ignored", "fingerprint": "ignored", "at": "2026-11-15T10:00:00.000Z" }
//
// Strict about the types; any other field is ignored. The sign-in header is optional: when it is a valid sign-in, the account is counted (as a
// one-way hash) among the people the problem touched. It is never stored as an id and never shown. Answers 200 {"ok":true}; the browser
// never retries, so a refusal is final: { error, retryable } like the rest of the API.
import { openBackend } from './_backend';
import { failedReport, MAX_REPORT_BYTES, readSiteReport, recordReport, SITE_REPORTS_PER_IP_MINUTE } from './_error-reports';
import { bearer, browserHeaders, clientIp, refuse, reply, sha256Hex } from './sim/_shared';

export default async function clientErrors(req: Request): Promise<Response> {
  const cors = browserHeaders(req);
  const answer = (body: Record<string, unknown>, status: number, retryable: boolean, extra: Record<string, string> = {}) => refuse(body, status, retryable, { ...cors, ...extra });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return answer({ error: 'method_not_allowed' }, 405, false, { Allow: 'POST, OPTIONS' });
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) return answer({ error: 'too_large' }, 413, false);

  const backend = openBackend();
  if (!backend) return answer({ error: 'unavailable' }, 503, true);
  try {
    const text = await req.text();
    if (text.length > MAX_REPORT_BYTES) return answer({ error: 'too_large' }, 413, false);
    const read = readSiteReport(text, req.headers.get('user-agent'));
    if (!read.ok) return answer({ error: read.why }, 400, false);

    // Who was it, if the person is signed in: only to count people. A missing, old or invalid sign-in (or a device key) is simply anonymous.
    let userId: string | null = null;
    const token = bearer(req);
    if (token && !token.startsWith('xpd_')) {
      try { userId = await backend.userId(token); } catch { userId = null; }
    }
    // The address is only a rate-limit key (hashed, kept a day at most in sim_rate); it is never stored with the report.
    const done = await recordReport(backend, 'site', read.value, { rateKey: `ce:${sha256Hex(clientIp(req)).slice(0, 32)}`, rateMax: SITE_REPORTS_PER_IP_MINUTE, userId });
    if (done?.status === 'rate') return answer({ error: 'too_many_requests' }, 429, true, { 'Retry-After': String(Math.max(1, Number(done.wait) || 60)) });
    if (done?.status === 'full') console.error(JSON.stringify({ event: 'error_groups_full', source: 'site' }));
    // 'full' still answers ok: the page cannot do anything about it.
    return reply({ ok: true }, 200, cors);
  } catch (error) {
    failedReport('client_error_report_failed', error);
    return answer({ error: 'unavailable' }, 503, true);
  }
}
