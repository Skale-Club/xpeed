// Reads the live dashboard Xpeed Companion relays through the server (`GET /api/sim/live/stream`, the signed-in person's bearer token).
// `fetch` and a stream reader, not EventSource (which cannot send the Authorization header). Reconnects after a close or an error (2 s, then
// 5 s, then 10 s), stops for good on 401, and hands the page at most ~15 frames a second.
import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';
import { parseFrame, type LiveFrame } from './live-frame';
import { emptySse, feedSse } from './live-sse';

export type LiveState =
  /** Opening the stream. */
  | 'connecting'
  /** Frames are flowing. */
  | 'live'
  /** Connected, but the Companion is not sending. */
  | 'idle'
  /** The stream broke; trying again. */
  | 'reconnecting'
  /** Not signed in (or the session ended): nothing more is tried. */
  | 'signin';

export const BACKOFF_MS = [2000, 5000, 10000] as const;
/** The server pings every 15 s: this long without a byte means the connection is dead. */
export const SILENCE_MS = 45_000;
/** At most this many frames a second reach the page. */
export const MAX_FPS = 15;

export const STREAM_PATH = '/api/sim/live/stream';

export interface LiveStream {
  state: LiveState;
  frame: LiveFrame | null;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); done(); }, ms);
    const stop = () => { clearTimeout(timer); done(); };
    signal.addEventListener('abort', stop, { once: true });
  });

export function useLiveStream(enabled = true): LiveStream {
  const [state, setState] = useState<LiveState>('connecting');
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const latest = useRef<LiveFrame | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const life = new AbortController();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushedAt = 0;
    const minGap = Math.floor(1000 / MAX_FPS);

    const flush = () => {
      flushTimer = null;
      flushedAt = Date.now();
      setFrame(latest.current);
    };
    // The newest frame replaces one still waiting; the page sees one per `minGap`.
    const show = (next: LiveFrame | null) => {
      latest.current = next;
      if (next === null) {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        // The first frame after a pause shows at once.
        flushedAt = 0;
        return;
      }
      if (flushTimer) return;
      const wait = flushedAt + minGap - Date.now();
      if (wait <= 0) flush();
      else flushTimer = setTimeout(flush, wait);
    };

    const run = async () => {
      let attempt = 0;
      let serverRetry: number | undefined;
      while (!life.signal.aborted) {
        const lap = new AbortController();
        const stop = () => lap.abort();
        life.signal.addEventListener('abort', stop, { once: true });
        let silence: ReturnType<typeof setTimeout> | null = null;
        const hear = () => {
          if (silence) clearTimeout(silence);
          silence = setTimeout(() => lap.abort(), SILENCE_MS);
        };
        try {
          const token = await getAccessToken();
          if (life.signal.aborted) return;
          if (!token) { setState('signin'); return; }
          hear();
          const response = await fetch(`${publicAppUrl()}${STREAM_PATH}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            cache: 'no-store',
            signal: lap.signal,
          });
          if (response.status === 401) { setState('signin'); return; }
          if (response.ok && response.body) {
            attempt = 0;
            setState((s) => (s === 'live' || s === 'idle' ? s : 'connecting'));
            const reader = response.body.getReader();
            // Giving up on this stream (the silence watchdog, or the page leaving) also ends a read that is waiting.
            lap.signal.addEventListener('abort', () => { void reader.cancel().catch(() => undefined); }, { once: true });
            const decoder = new TextDecoder();
            let parsed = emptySse();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              hear();
              const result = feedSse(parsed, decoder.decode(value, { stream: true }));
              parsed = result.state;
              if (result.retry !== undefined) serverRetry = result.retry;
              for (const event of result.events) {
                if (event.event === 'frame') {
                  const next = parseFrame(event.data);
                  if (next) { setState('live'); show(next); }
                } else if (event.event === 'idle') {
                  setState('idle');
                  show(null);
                }
              }
            }
          }
        } catch {
          // A broken stream, or the silence watchdog: fall through to the pause and the next try.
        } finally {
          if (silence) clearTimeout(silence);
          life.signal.removeEventListener('abort', stop);
        }
        if (life.signal.aborted) return;
        setState('reconnecting');
        const pause = attempt === 0 && serverRetry !== undefined ? serverRetry : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        await sleep(pause, life.signal);
      }
    };
    void run();

    return () => {
      life.abort();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [enabled]);

  return { state, frame };
}
