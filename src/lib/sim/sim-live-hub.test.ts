import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveHub, readFrame, type LiveEvent, type LiveFrame } from '../../../api/sim/_live';

// Fake timers also fake Date.now, which is the hub's clock.
const frame = (seq: number, extra: Partial<LiveFrame> = {}): LiveFrame => ({
  v: 1, seq, sentAt: 1_000 + seq, game: 'lmu', dashboard: 'race', rows: [['times'], ['session', 'flag']], model: { speedKph: seq }, ...extra,
});
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ ...frame(1), ...over });

let hub: ReturnType<typeof createLiveHub>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); hub = createLiveHub(); });
afterEach(() => { hub.reset(); vi.useRealTimers(); });

const listen = (user = 'u1') => {
  const events: LiveEvent[] = [];
  const sub = hub.subscribe(user, (e) => events.push(e));
  return { events, sub };
};
const names = (events: LiveEvent[]) => events.map((e) => e.event);

describe('readFrame', () => {
  it('reads a good frame and keeps the model untouched', () => {
    const read = readFrame(body({ model: { a: { deep: [1, 2] } } }));
    expect(read.ok && read.value.model).toEqual({ a: { deep: [1, 2] } });
  });

  it.each([
    ['not json', '{', 'invalid_json'],
    ['an array', '[]', 'invalid_request'],
    ['v 2', body({ v: 2 }), 'invalid_version'],
    ['a negative seq', body({ seq: -1 }), 'invalid_seq'],
    ['a fractional seq', body({ seq: 1.5 }), 'invalid_seq'],
    ['a text sentAt', body({ sentAt: 'now' }), 'invalid_sent_at'],
    ['a bad game', body({ game: 'LMU!' }), 'invalid_game'],
    ['an unknown dashboard', body({ dashboard: 'drift' }), 'invalid_dashboard'],
    ['rows that are not an array', body({ rows: 'times' }), 'invalid_rows'],
    ['more than 30 rows', body({ rows: Array.from({ length: 31 }, () => ['times']) }), 'invalid_rows'],
    ['an empty row', body({ rows: [[]] }), 'invalid_rows'],
    ['a widget id with capitals', body({ rows: [['Times']] }), 'invalid_rows'],
    ['a widget id that is too short', body({ rows: [['t']] }), 'invalid_rows'],
    ['a widget id that is too long', body({ rows: [['a'.repeat(25)]] }), 'invalid_rows'],
    ['a model that is a list', body({ model: [] }), 'invalid_model'],
    ['no model', body({ model: null }), 'invalid_model'],
  ])('refuses %s', (_name, text, why) => {
    expect(readFrame(text)).toEqual({ ok: false, why });
  });

  it('accepts 30 rows and ids of 2 and 24 characters', () => {
    expect(readFrame(body({ rows: Array.from({ length: 30 }, () => ['ab', 'a'.repeat(24)]) })).ok).toBe(true);
  });
});

describe('publish and latest', () => {
  it('keeps only the latest frame of an owner and no frame of another', () => {
    hub.publish('u1', 'd1', frame(1));
    hub.publish('u1', 'd1', frame(2));
    expect(hub.latest('u1')?.frame.seq).toBe(2);
    expect(hub.latest('u2')).toBeNull();
  });

  it('stamps receivedAt and puts it in the JSON', () => {
    hub.publish('u1', 'd1', frame(1));
    expect(JSON.parse(hub.latest('u1')!.json)).toMatchObject({ seq: 1, receivedAt: 1_000_000, model: { speedKph: 1 } });
  });

  it('drops a frame with a seq below the last one of the same device', () => {
    hub.publish('u1', 'd1', frame(50));
    expect(hub.publish('u1', 'd1', frame(49))).toMatchObject({ stored: false });
    expect(hub.latest('u1')?.frame.seq).toBe(50);
    expect(hub.publish('u1', 'd1', frame(51))).toMatchObject({ stored: true });
  });

  it('does not compare seq across devices', () => {
    hub.publish('u1', 'd1', frame(50));
    expect(hub.publish('u1', 'd2', frame(3))).toMatchObject({ stored: true });
  });

  it('takes a restart (seq below 10) only after a silence longer than 10 s', () => {
    hub.publish('u1', 'd1', frame(500));
    vi.advanceTimersByTime(9_000);
    expect(hub.publish('u1', 'd1', frame(2))).toMatchObject({ stored: false });
    vi.advanceTimersByTime(10_001);
    expect(hub.publish('u1', 'd1', frame(2))).toMatchObject({ stored: true });
    expect(hub.latest('u1')?.frame.seq).toBe(2);
    // after the restart the new numbers are the reference
    expect(hub.publish('u1', 'd1', frame(1))).toMatchObject({ stored: false });
  });

  it('does not take a low seq above 9 as a restart', () => {
    hub.publish('u1', 'd1', frame(500));
    vi.advanceTimersByTime(20_000);
    expect(hub.publish('u1', 'd1', frame(10))).toMatchObject({ stored: false });
  });

  it('forgets a frame after 30 s (lazily and on the timer)', () => {
    hub.publish('u1', 'd1', frame(1));
    vi.advanceTimersByTime(29_000);
    expect(hub.latest('u1')).not.toBeNull();
    vi.advanceTimersByTime(1_500);
    expect(hub.latest('u1')).toBeNull();
    // the sweep also frees the owner
    hub.publish('u2', 'd1', frame(1));
    vi.advanceTimersByTime(41_000);
    expect(hub.size()).toBe(0);
  });

  it('answers latest() with a shorter age too', () => {
    hub.publish('u1', 'd1', frame(1));
    vi.advanceTimersByTime(6_000);
    expect(hub.latest('u1', 5_000)).toBeNull();
    expect(hub.latest('u1')).not.toBeNull();
  });
});

describe('streams', () => {
  it('sends the latest frame at once when it is younger than 5 s, else idle', () => {
    hub.publish('u1', 'd1', frame(1));
    const fresh = listen('u1');
    expect(names(fresh.events)).toEqual(['frame']);
    expect(JSON.parse(fresh.events[0].data).seq).toBe(1);
    vi.advanceTimersByTime(5_000);
    const stale = listen('u1');
    expect(names(stale.events)).toEqual(['idle']);
    expect(listen('nobody').events).toEqual([{ event: 'idle', data: '{}' }]);
  });

  it('counts viewers and decrements on close', () => {
    const a = listen();
    const b = listen();
    expect(hub.viewers('u1')).toBe(2);
    a.sub!.close();
    a.sub!.close();
    expect(hub.viewers('u1')).toBe(1);
    b.sub!.close();
    expect(hub.viewers('u1')).toBe(0);
    expect(hub.publish('u1', 'd1', frame(1))).toMatchObject({ viewers: 0 });
  });

  it('allows 4 streams an owner and refuses the fifth, until one closes', () => {
    const subs = Array.from({ length: 4 }, () => listen());
    expect(subs.every((s) => s.sub)).toBe(true);
    expect(listen().sub).toBeNull();
    expect(listen('u2').sub).not.toBeNull();
    subs[0].sub!.close();
    expect(listen().sub).not.toBeNull();
  });

  it('sends a published frame at once when the gap has passed and says how many watch', () => {
    const { events } = listen();
    events.length = 0;
    expect(hub.publish('u1', 'd1', frame(1))).toMatchObject({ viewers: 1 });
    expect(names(events)).toEqual(['frame']);
  });

  it('coalesces to at most 15 frames a second and ends on the newest', () => {
    const { events } = listen();
    events.length = 0;
    for (let i = 0; i < 100; i++) { hub.publish('u1', 'd1', frame(i)); vi.advanceTimersByTime(10); }
    vi.advanceTimersByTime(200);
    const frames = events.filter((e) => e.event === 'frame');
    // 1 s of publishing at 100/s: about 15 reach the stream, and the last one sent is the newest.
    expect(frames.length).toBeLessThanOrEqual(16);
    expect(frames.length).toBeGreaterThan(10);
    const seqs = frames.map((e) => JSON.parse(e.data).seq as number);
    expect(seqs.at(-1)).toBe(99);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('never sends more than 15 in any one second of a long burst', () => {
    const times: number[] = [];
    hub.subscribe('u1', (e) => { if (e.event === 'frame') times.push(Date.now()); });
    for (let i = 0; i < 300; i++) { hub.publish('u1', 'd1', frame(i)); vi.advanceTimersByTime(10); }
    expect(times.length).toBeGreaterThan(30);
    for (const start of times) {
      expect(times.filter((t) => t >= start && t < start + 1000).length).toBeLessThanOrEqual(15);
    }
  });

  it('sends idle once after 5 s without a frame, and frames again when they resume', () => {
    const { events } = listen();
    events.length = 0;
    hub.publish('u1', 'd1', frame(1));
    vi.advanceTimersByTime(4_900);
    expect(names(events)).toEqual(['frame']);
    vi.advanceTimersByTime(200);
    expect(names(events)).toEqual(['frame', 'idle']);
    vi.advanceTimersByTime(60_000);
    expect(names(events)).toEqual(['frame', 'idle']);
    hub.publish('u1', 'd1', frame(2));
    expect(names(events)).toEqual(['frame', 'idle', 'frame']);
    vi.advanceTimersByTime(5_100);
    expect(names(events)).toEqual(['frame', 'idle', 'frame', 'idle']);
  });

  it('keeps the idle timer of the frame a new stream was given', () => {
    hub.publish('u1', 'd1', frame(1));
    vi.advanceTimersByTime(3_000);
    const { events } = listen();
    events.length = 0;
    vi.advanceTimersByTime(1_900);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(names(events)).toEqual(['idle']);
  });

  it('sends nothing more after close', () => {
    const { events, sub } = listen();
    events.length = 0;
    hub.publish('u1', 'd1', frame(1));
    hub.publish('u1', 'd1', frame(2));
    sub!.close();
    vi.advanceTimersByTime(60_000);
    expect(names(events)).toEqual(['frame']);
  });

  it('drops a late frame (older seq) without telling the streams', () => {
    const { events } = listen();
    hub.publish('u1', 'd1', frame(5));
    vi.advanceTimersByTime(100);
    events.length = 0;
    hub.publish('u1', 'd1', frame(4));
    expect(events).toEqual([]);
  });
});

describe('owner cap', () => {
  it('forgets the least recently used owner without streams past the cap', () => {
    const small = createLiveHub({ maxOwners: 3 });
    for (const u of ['a', 'b', 'c']) small.publish(u, 'd', frame(1));
    small.publish('a', 'd', frame(2)); // a is the most recent now
    small.publish('d', 'd', frame(1));
    expect(small.size()).toBe(3);
    expect(small.latest('b')).toBeNull();
    expect(small.latest('a')).not.toBeNull();
    small.reset();
  });

  it('never forgets an owner that has a stream, and says so when everyone is watched', () => {
    const small = createLiveHub({ maxOwners: 2 });
    small.subscribe('a', () => undefined);
    small.subscribe('b', () => undefined);
    expect(small.publish('c', 'd', frame(1))).toBeNull();
    expect(small.subscribe('c', () => undefined)).toBeNull();
    expect(small.viewers('a')).toBe(1);
    small.reset();
  });

  it('holds at most 1000 owners by default', () => {
    for (let i = 0; i < 1100; i++) hub.publish(`u${i}`, 'd', frame(1));
    expect(hub.size()).toBe(1000);
  });
});
