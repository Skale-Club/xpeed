import { describe, expect, it } from 'vitest';
import { emptySse, feedSse, type SseEvent, type SseState } from './live-sse';

/** Feeds every chunk in turn, as the stream's reader would. */
function feedAll(chunks: string[]) {
  let state: SseState = emptySse();
  const events: SseEvent[] = [];
  let retry: number | undefined;
  for (const chunk of chunks) {
    const result = feedSse(state, chunk);
    state = result.state;
    events.push(...result.events);
    if (result.retry !== undefined) retry = result.retry;
  }
  return { events, retry, state };
}

describe('the SSE parser', () => {
  it('reads one event', () => {
    expect(feedAll(['event: frame\ndata: {"a":1}\n\n']).events).toEqual([{ event: 'frame', data: '{"a":1}' }]);
  });

  it('joins a frame split across chunks, even in the middle of a word', () => {
    const { events } = feedAll(['event: fra', 'me\nda', 'ta: {"se', 'q":2}\n', '\n']);
    expect(events).toEqual([{ event: 'frame', data: '{"seq":2}' }]);
  });

  it('reads several events in one chunk, in order', () => {
    const { events } = feedAll(['event: frame\ndata: 1\n\nevent: idle\ndata: {}\n\nevent: frame\ndata: 2\n\n']);
    expect(events.map((e) => `${e.event}:${e.data}`)).toEqual(['frame:1', 'idle:{}', 'frame:2']);
  });

  it('ignores comments (the 15 s ping) and keeps going', () => {
    const { events } = feedAll([': ping\n\n', 'event: idle\ndata: {}\n\n', ': ping\n']);
    expect(events).toEqual([{ event: 'idle', data: '{}' }]);
  });

  it('reads the retry field and does not make an event of it', () => {
    const { events, retry } = feedAll(['retry: 2000\n\n']);
    expect(retry).toBe(2000);
    expect(events).toEqual([]);
  });

  it('ignores a retry that is not a number', () => {
    expect(feedAll(['retry: soon\n\n']).retry).toBeUndefined();
  });

  it('holds an event until its blank line arrives', () => {
    const first = feedAll(['event: frame\ndata: {}\n']);
    expect(first.events).toEqual([]);
    const done = feedSse(first.state, '\n');
    expect(done.events).toEqual([{ event: 'frame', data: '{}' }]);
  });

  it('joins several data lines with a newline and calls an unnamed event "message"', () => {
    expect(feedAll(['data: a\ndata: b\n\n']).events).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('understands CRLF and CR line ends, also when CRLF is cut in two', () => {
    expect(feedAll(['event: frame\r\ndata: x\r\n\r\n']).events).toEqual([{ event: 'frame', data: 'x' }]);
    expect(feedAll(['event: frame\r', '\ndata: y\r', '\n\r', '\n']).events).toEqual([{ event: 'frame', data: 'y' }]);
    expect(feedAll(['event: frame\rdata: z\r\r', '\n']).events).toEqual([{ event: 'frame', data: 'z' }]);
  });

  it('does not change the state it is given', () => {
    const state = emptySse();
    feedSse(state, 'event: frame\ndata: 1\n');
    expect(state).toEqual(emptySse());
  });
});
