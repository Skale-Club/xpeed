import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReport, createErrorReporter, DEDUPE_MS, ENDPOINT, installErrorReporter, MAX_REPORTS_PER_PAGE, REPORTS_PER_MINUTE, reportError,
} from '@/lib/error-reporter';
import { fingerprintOf, scrubRoute, scrubText } from '@/lib/error-scrub';

const JWT = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1aWQtYSIsInBob25lIjoiKzE1NTUifQ.c2lnbmF0dXJlLWJ5dGVz';

/** A different word for each number (digits and long runs of one letter are not told apart by a fingerprint or kept by the scrubber). */
const word = (n: number) => `${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + (Math.floor(n / 26) % 26))}${String.fromCharCode(97 + (Math.floor(n / 676) % 26))}`;

const errorWith = (message: string, stack?: string) => {
  const error = new Error(message);
  error.stack = stack ?? `Error: ${message}\n    at render (https://xpeed.skale.club/assets/index-AbC123xy.js:10:2345)`;
  return error;
};

/** A reporter with a fake clock and a fake network; `sent()` is what went to the server. */
function rig(options: { getToken?: () => Promise<string | null>; fetch?: typeof fetch } = {}) {
  let time = 1_000_000;
  const fetchSpy = vi.fn(options.fetch ?? (async () => new Response('{"ok":true}', { status: 200 })));
  const reporter = createErrorReporter({ fetch: fetchSpy as unknown as typeof fetch, now: () => time, baseUrl: () => 'https://xpeed.test', getToken: options.getToken });
  return {
    report: reporter.report,
    advance: (ms: number) => { time += ms; },
    fetchSpy,
    sent: () => fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) as Record<string, string> })),
  };
}

beforeEach(() => {
  window.history.pushState({}, '', '/virtual/sessions/3f2a9c1e-1b2d-4c3e-9f4a-5b6c7d8e9f01?token=secret123&email=maria@example.com#top');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the error reporter: what is sent', () => {
  it('sends exactly the fields of the contract, to the site\'s own server, and nothing personal', async () => {
    const { report, sent } = rig();
    expect(await report(errorWith(`Cannot save for maria.silva@example.com, phone +1 (555) 000-0001, token ${JWT}`, `Error: boom\n    at save (https://xpeed.skale.club/assets/a.js:1:1?session=abc123)\n    at C:\\Users\\Vanildo\\x.js:2:2`))).toBe(true);
    const [call] = sent();
    expect(call.url).toBe(`https://xpeed.test${ENDPOINT}`);
    expect(call.init.method).toBe('POST');
    expect(Object.keys(call.body).sort()).toEqual(['agent', 'at', 'build', 'fingerprint', 'message', 'route', 'stack']);
    const everything = JSON.stringify(call.body);
    for (const secret of ['maria', 'example.com', '555', 'eyJ', 'abc123', 'Vanildo', 'secret123', '3f2a9c1e', 'token=', '#top']) expect(everything).not.toContain(secret);
    expect(call.body.message).toContain('[email]');
    expect(call.body.message).toContain('[phone]');
    expect(call.body.message).toContain('[token]');
    expect(call.body.stack).toContain('[user]');
  });

  it('sends the route without its query string, fragment or ids, the build, the browser family and a fingerprint of the message and the top frame', async () => {
    const { report, sent } = rig();
    const error = errorWith('x is undefined');
    await report(error);
    const [call] = sent();
    expect(call.body.route).toBe('/virtual/sessions/:id');
    expect(call.body.build).toBe('dev');
    expect(call.body.agent).toBe('chrome/130 mobile');
    expect(call.body.agent).not.toContain('Android');
    expect(call.body.fingerprint).toBe(fingerprintOf(call.body.message, call.body.stack));
    expect(Date.parse(call.body.at)).toBeGreaterThan(0);
    expect(scrubRoute('/s/Zk39dkAq83jdkQ?x=1')).toBe('/s/:id');
  });

  it('puts neither the sign-in nor an account id in the body: the token is a header, and only when there is one', async () => {
    const withToken = rig({ getToken: async () => JWT });
    await withToken.report(errorWith('one'));
    const [call] = withToken.sent();
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`);
    expect(JSON.stringify(call.body)).not.toContain('eyJ');
    expect(Object.keys(call.body)).not.toContain('userId');

    const anonymous = rig({ getToken: async () => null });
    await anonymous.report(errorWith('two'));
    expect((anonymous.sent()[0].init.headers as Record<string, string>).Authorization).toBeUndefined();

    const broken = rig({ getToken: async () => { throw new Error('auth is down'); } });
    expect(await broken.report(errorWith('three'))).toBe(true);
    expect(broken.sent()).toHaveLength(1);
  });

  it('does not wait for a sign-in that never answers: the report goes anonymous after 1.5 seconds', async () => {
    vi.useFakeTimers();
    const { report, sent } = rig({ getToken: () => new Promise(() => undefined) });
    const pending = report(errorWith('slow auth'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(await pending).toBe(true);
    expect((sent()[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('is what buildReport says: the stack is cut to 30 lines, the message to one line, and noise is not a report', () => {
    const long = errorWith('a '.repeat(600), Array.from({ length: 100 }, (_, i) => `    at fn${i} (a.js:1:1)`).join('\n'));
    const built = buildReport(long)!;
    expect(built.message.length).toBeLessThanOrEqual(500);
    expect(built.stack.split('\n').length).toBeLessThanOrEqual(30);
    expect(buildReport(new Error('ResizeObserver loop completed with undelivered notifications.'))).toBeNull();
    expect(buildReport('Script error.')).toBeNull();
    expect(buildReport(errorWith('from an extension', 'Error: x\n    at a (chrome-extension://abcdef/content.js:1:1)'))).toBeNull();
    expect(buildReport({ nothing: 'useful' })).toBeNull();
    expect(buildReport('a plain string rejected')!.message).toBe('a plain string rejected');
    expect(scrubText('?')).toBe('?');
  });
});

describe('the error reporter: limits and loops', () => {
  it('sends the same problem once a minute, and again after that', async () => {
    const { report, advance, sent } = rig();
    expect(await report(errorWith('same'))).toBe(true);
    expect(await report(errorWith('same'))).toBe(false);
    advance(DEDUPE_MS - 1);
    expect(await report(errorWith('same'))).toBe(false);
    advance(1);
    expect(await report(errorWith('same'))).toBe(true);
    expect(sent()).toHaveLength(2);
    // Numbers in the message do not make it a new problem.
    advance(DEDUPE_MS);
    expect(await report(errorWith('failed after 3 tries', 'Error\n    at f (a.js:1:1)'))).toBe(true);
    expect(await report(errorWith('failed after 9 tries', 'Error\n    at f (a.js:5:7)'))).toBe(false);
  });

  it('sends at most 20 different problems a minute, and 20 more in the next one', async () => {
    const { report, advance, sent } = rig();
    const results: boolean[] = [];
    for (let i = 0; i < REPORTS_PER_MINUTE + 5; i++) results.push(await report(errorWith(`distinct problem ${word(i)}`, `Error\n    at frame${word(i)} (a.js:1:1)`)));
    expect(results.filter(Boolean)).toHaveLength(REPORTS_PER_MINUTE);
    expect(sent()).toHaveLength(REPORTS_PER_MINUTE);
    advance(61_000);
    expect(await report(errorWith('a new problem after the minute', 'Error\n    at later (a.js:1:1)'))).toBe(true);
  });

  it('sends at most 100 reports from one page load, however long it stays open', async () => {
    const { report, advance, sent } = rig();
    for (let i = 0; i < MAX_REPORTS_PER_PAGE + 20; i++) {
      advance(10_000);
      await report(errorWith(`page problem ${word(i)}`, `Error\n    at frame${word(i)} (a.js:1:1)`));
    }
    expect(sent()).toHaveLength(MAX_REPORTS_PER_PAGE);
  });

  it('never reports its own failure: a POST that fails (rejected, 500, 429 or a throw) is dropped, never retried, never reported, and does not stop the next problem', async () => {
    const failures: Array<[typeof fetch, boolean]> = [
      [(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch, true],
      [(async () => new Response('{"error":"unavailable"}', { status: 503 })) as typeof fetch, true],
      [(async () => new Response('{"error":"too_many_requests"}', { status: 429 })) as typeof fetch, true],
      // A fetch that throws before it returns anything: the report is lost, quietly.
      [((): Response => { throw new Error('fetch itself threw'); }) as unknown as typeof fetch, false],
    ];
    for (const [failing, sentOk] of failures) {
      const { report, fetchSpy } = rig({ fetch: failing });
      await expect(report(errorWith('first'))).resolves.toBe(sentOk);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expect(report(errorWith('second', 'Error\n    at other (a.js:1:1)'))).resolves.toBe(sentOk);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  });

  it('is not an unhandled rejection when the network is down: installed on the window, a failing POST does not report itself in a loop', async () => {
    const calls: string[] = [];
    const failingFetch = vi.fn(async (url: string) => { calls.push(String(url)); throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', failingFetch);
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    const uninstall = installErrorReporter({ baseUrl: () => 'https://xpeed.test' });
    try {
      window.dispatchEvent(new ErrorEvent('error', { error: errorWith('the page broke'), message: 'the page broke' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(failingFetch).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([`https://xpeed.test${ENDPOINT}`]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      uninstall();
      window.removeEventListener('unhandledrejection', unhandled);
      vi.unstubAllGlobals();
    }
  });

  it('does nothing when it is switched off (development)', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const reporter = createErrorReporter({ fetch: fetchSpy as unknown as typeof fetch, disabled: true });
    expect(await reporter.report(errorWith('quiet'))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the error reporter: where it listens', () => {
  it('reports window errors and unhandled rejections, and the boundary\'s reportError, and stops listening when removed', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchSpy);
    const uninstall = installErrorReporter({ baseUrl: () => 'https://xpeed.test' });
    try {
      window.dispatchEvent(new ErrorEvent('error', { error: errorWith('from window.onerror'), message: 'from window.onerror' }));
      const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
      rejection.reason = errorWith('from a promise', 'Error: from a promise\n    at later (a.js:3:3)');
      window.dispatchEvent(rejection);
      reportError(errorWith('from the error boundary', 'Error\n    at Boundary (a.js:4:4)'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const messages = fetchSpy.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { message: string }).message);
      expect(messages.sort()).toEqual(['from a promise', 'from the error boundary', 'from window.onerror'].sort());
    } finally {
      uninstall();
    }
    fetchSpy.mockClear();
    // The test's own listener marks the synthetic error as handled, so the test runner does not take it for a crash of the test.
    const handled = (event: Event) => event.preventDefault();
    window.addEventListener('error', handled);
    window.dispatchEvent(new ErrorEvent('error', { error: errorWith('after removal'), message: 'after removal', cancelable: true }));
    window.removeEventListener('error', handled);
    reportError(errorWith('after removal too'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('reportError never throws, installed or not', () => {
    expect(() => reportError(undefined)).not.toThrow();
    expect(() => reportError({ get message(): string { throw new Error('a hostile getter'); } })).not.toThrow();
  });
});
