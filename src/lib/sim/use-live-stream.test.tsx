import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { sampleFrame } from '@/components/sim/live/live-fixture';

const auth = vi.hoisted(() => ({ token: vi.fn<() => Promise<string | null>>() }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: auth.token }));

import { BACKOFF_MS, streamUrl, SILENCE_MS, STREAM_PATH, useLiveStream } from './use-live-stream';

const encoder = new TextEncoder();

/** A response whose body is a stream the test writes to (and closes). */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}
const status = (code: number) => ({ ok: false, status: code, body: null }) as unknown as Response;
const frameEvent = (seq: number) => `event: frame\ndata: ${JSON.stringify(sampleFrame({ seq }))}\n\n`;

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
/** Lets promises and (fake) timers run for `ms`. */
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  auth.token.mockReset().mockResolvedValue('session-token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveStream', () => {
  it('opens the stream with the session token and shows the frames that arrive', async () => {
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    const { result } = renderHook(() => useLiveStream());
    expect(result.current.state).toBe('connecting');
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.endsWith(STREAM_PATH)).toBe(true);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token');

    stream.push('retry: 2000\n\n');
    stream.push(frameEvent(7));
    await tick();
    expect(result.current.state).toBe('live');
    expect(result.current.frame?.seq).toBe(7);
    expect(result.current.frame?.rows[0]).toEqual(['times']);
  });

  it('goes idle on an idle event and drops the old frame', async () => {
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    const { result } = renderHook(() => useLiveStream());
    await tick();
    stream.push(frameEvent(1));
    await tick();
    expect(result.current.state).toBe('live');
    stream.push('event: idle\ndata: {}\n\n');
    await tick();
    expect(result.current.state).toBe('idle');
    expect(result.current.frame).toBeNull();
    stream.push(': ping\n\n');
    stream.push(frameEvent(2));
    await tick();
    expect(result.current.state).toBe('live');
    expect(result.current.frame?.seq).toBe(2);
  });

  it('ignores a frame that is not one', async () => {
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    const { result } = renderHook(() => useLiveStream());
    await tick();
    stream.push('event: frame\ndata: {"v":2}\n\nevent: frame\ndata: not json\n\n');
    await tick();
    expect(result.current.frame).toBeNull();
    expect(result.current.state).toBe('connecting');
  });

  it('hands the page about 15 frames a second: the newest one replaces those waiting', async () => {
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    const { result } = renderHook(() => useLiveStream());
    await tick();
    stream.push(frameEvent(1) + frameEvent(2) + frameEvent(3));
    await tick();
    expect(result.current.frame?.seq).toBe(1);
    await tick(100);
    expect(result.current.frame?.seq).toBe(3);
  });

  it('reconnects after 2 s, then 5 s, then 10 s, and keeps to 10 s', async () => {
    const first = openStream();
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(status(503))
      .mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLiveStream());
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.end(); // the server closed the stream
    await tick();
    expect(result.current.state).toBe('reconnecting');
    await tick(BACKOFF_MS[0] - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // fails: the next wait is 5 s

    await tick(BACKOFF_MS[1] - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 503: the next wait is 10 s

    await tick(BACKOFF_MS[2] - 1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await tick(BACKOFF_MS[2]); // stays at 10 s
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.state).toBe('reconnecting');
  });

  it('keeps the last frame on screen while it reconnects, and starts again from the first wait once a stream worked', async () => {
    const first = openStream();
    const second = openStream();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const { result } = renderHook(() => useLiveStream());
    await tick();
    first.push(frameEvent(4));
    await tick();
    first.end();
    await tick();
    expect(result.current.state).toBe('reconnecting');
    expect(result.current.frame?.seq).toBe(4);
    await tick(BACKOFF_MS[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.push(frameEvent(5));
    await tick(100);
    expect(result.current.state).toBe('live');
    expect(result.current.frame?.seq).toBe(5);
  });

  it('stops for good on 401', async () => {
    fetchMock.mockResolvedValue(status(401));
    const { result } = renderHook(() => useLiveStream());
    await tick();
    expect(result.current.state).toBe('signin');
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call the server when nobody is signed in', async () => {
    auth.token.mockResolvedValue(null);
    const { result } = renderHook(() => useLiveStream());
    await tick();
    expect(result.current.state).toBe('signin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up on a stream that has said nothing (not even a ping) for too long, and reconnects', async () => {
    const stalled = openStream();
    fetchMock.mockResolvedValueOnce(stalled.response).mockResolvedValue(status(503));
    const { result } = renderHook(() => useLiveStream());
    await tick();
    await tick(SILENCE_MS - 1);
    expect(result.current.state).toBe('connecting');
    await tick(1);
    expect(result.current.state).toBe('reconnecting');
    await tick(BACKOFF_MS[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('closes the stream when the page goes away', async () => {
    const stream = openStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    const { unmount } = renderHook(() => useLiveStream());
    await tick();
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the room the page has for the panel', () => {
  it('goes in the stream address, so the Companion draws the picture for this screen', () => {
    expect(streamUrl(null)).toMatch(/\/api\/sim\/live\/stream$/);
    const url = new URL(streamUrl({ w: 828.4, h: 330, dpr: 2.625 }), 'http://x');
    expect(url.pathname).toBe('/api/sim/live/stream');
    expect(Object.fromEntries(url.searchParams)).toEqual({ w: '828', h: '330', dpr: '2.63' });
  });
});
