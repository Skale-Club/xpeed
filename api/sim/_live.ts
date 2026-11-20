// The live relay's memory: the latest dashboard frame of each owner, and the streams (phones) watching it. Nothing here is ever written to
// the database or to storage, and nothing of `model` is read or logged: it is an opaque object the Companion builds and the phone draws.
// Pure and testable: no network, no module-level state except the one hub the routes share (`liveHub`). Tests use fake timers.
// Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md (2f) and docs/platform/API-V1.md (Live dashboard relay).

/** The body of a frame may not be larger than this. */
export const MAX_LIVE_BYTES = 64 * 1024;
export const MAX_LIVE_ROWS = 30;
/** A row is a handful of widgets; this is only a sanity bound. */
export const MAX_LIVE_ROW_WIDGETS = 12;
export const LIVE_DASHBOARDS = ['race', 'qualifying', 'practice', 'time_trial'] as const;
export type LiveDashboard = (typeof LIVE_DASHBOARDS)[number];

/** A frame older than this is forgotten. */
export const FRAME_TTL_MS = 30_000;
/** No frame for this long and a stream is told `idle` (and a frame younger than this is sent at once to a new stream). */
export const IDLE_AFTER_MS = 5_000;
/** A stream gets at most 15 frames a second: this is the smallest gap, in ms (rounded up so it is never more than 15). */
export const MIN_FRAME_GAP_MS = Math.ceil(1000 / 15);
export const MAX_STREAMS_PER_OWNER = 4;
export const MAX_OWNERS = 1000;
/** Devices whose sequence is tracked per owner. */
const MAX_DEVICES_PER_OWNER = 8;
/** A seq below this after a silence longer than `RESTART_GAP_MS` is a Companion that started over. */
const RESTART_SEQ = 10;
const RESTART_GAP_MS = 10_000;
const SWEEP_EVERY_MS = 10_000;

export interface LiveFrame {
  v: 1;
  seq: number;
  sentAt: number;
  game: string;
  dashboard: LiveDashboard;
  rows: string[][];
  model: Record<string, unknown>;
}

const GAME = /^[a-z][a-z0-9_]{0,31}$/;
const WIDGET = /^[a-z_]{2,24}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The frame in a body, or the word for what is wrong with it. `model` is only checked to be an object. */
export function readFrame(text: string): { ok: true; value: LiveFrame } | { ok: false; why: string } {
  let input: unknown;
  try { input = JSON.parse(text); } catch { return { ok: false, why: 'invalid_json' }; }
  if (!isObject(input)) return { ok: false, why: 'invalid_request' };
  const { v, seq, sentAt, game, dashboard, rows, model } = input;
  if (v !== 1) return { ok: false, why: 'invalid_version' };
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return { ok: false, why: 'invalid_seq' };
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt < 0) return { ok: false, why: 'invalid_sent_at' };
  if (typeof game !== 'string' || !GAME.test(game)) return { ok: false, why: 'invalid_game' };
  if (typeof dashboard !== 'string' || !(LIVE_DASHBOARDS as readonly string[]).includes(dashboard)) return { ok: false, why: 'invalid_dashboard' };
  if (!Array.isArray(rows) || rows.length > MAX_LIVE_ROWS) return { ok: false, why: 'invalid_rows' };
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0 || row.length > MAX_LIVE_ROW_WIDGETS) return { ok: false, why: 'invalid_rows' };
    if (!row.every((id) => typeof id === 'string' && WIDGET.test(id))) return { ok: false, why: 'invalid_rows' };
  }
  if (!isObject(model)) return { ok: false, why: 'invalid_model' };
  return { ok: true, value: { v: 1, seq, sentAt, game, dashboard: dashboard as LiveDashboard, rows: rows as string[][], model } };
}

/** What a stream is told: `frame` carries the frame JSON plus `receivedAt`; `idle` carries `{}`. `data` is always one line. */
export interface LiveEvent { event: 'frame' | 'idle'; data: string }

export interface StoredFrame { frame: LiveFrame; deviceId: string; receivedAt: number; json: string }

export interface Subscription { close(): void }

interface Sub {
  emit: (event: LiveEvent) => void;
  lastSentAt: number;
  pending: StoredFrame | null;
  timer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface Owner {
  latest: StoredFrame | null;
  subs: Set<Sub>;
  /** The last sequence number and its arrival, per device. */
  seqs: Map<string, { seq: number; at: number }>;
}

const unref = (timer: unknown) => { (timer as { unref?: () => void })?.unref?.(); };

export interface LiveHubOptions { now?: () => number; maxOwners?: number; maxStreamsPerOwner?: number }

export function createLiveHub(options: LiveHubOptions = {}) {
  // Read the clock on every call (not a saved reference to Date.now), so a test clock or a patched Date applies.
  const now = options.now ?? (() => Date.now());
  const maxOwners = options.maxOwners ?? MAX_OWNERS;
  const maxStreams = options.maxStreamsPerOwner ?? MAX_STREAMS_PER_OWNER;
  // Map order is the least recently used first: an owner that publishes or subscribes is moved to the end.
  const owners = new Map<string, Owner>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  /** Room for one more owner: the least recently used owner without a stream is forgotten; false when every owner is being watched. */
  const makeRoom = (): boolean => {
    if (owners.size < maxOwners) return true;
    for (const [id, owner] of owners) {
      if (owner.subs.size === 0) { owners.delete(id); return true; }
    }
    return false;
  };

  const touch = (userId: string): Owner | null => {
    let owner = owners.get(userId);
    if (owner) { owners.delete(userId); owners.set(userId, owner); return owner; }
    if (!makeRoom()) return null;
    owner = { latest: null, subs: new Set(), seqs: new Map() };
    owners.set(userId, owner);
    ensureSweeper();
    return owner;
  };

  const sweep = () => {
    const t = now();
    for (const [id, owner] of owners) {
      if (owner.latest && t - owner.latest.receivedAt > FRAME_TTL_MS) owner.latest = null;
      for (const [device, seen] of owner.seqs) if (t - seen.at > FRAME_TTL_MS) owner.seqs.delete(device);
      if (!owner.latest && owner.subs.size === 0) owners.delete(id);
    }
    if (owners.size === 0 && sweeper) { clearInterval(sweeper); sweeper = null; }
  };

  function ensureSweeper() {
    if (sweeper) return;
    sweeper = setInterval(sweep, SWEEP_EVERY_MS);
    unref(sweeper);
  }

  const send = (sub: Sub, stored: StoredFrame) => {
    sub.lastSentAt = now();
    sub.pending = null;
    sub.emit({ event: 'frame', data: stored.json });
  };

  // `idle` once, 5 s after the last frame arrived; the next frame offered re-arms it.
  const armIdle = (sub: Sub, receivedAt: number) => {
    if (sub.idleTimer) clearTimeout(sub.idleTimer);
    const wait = Math.max(0, IDLE_AFTER_MS - (now() - receivedAt));
    sub.idleTimer = setTimeout(() => {
      sub.idleTimer = null;
      if (!sub.closed) sub.emit({ event: 'idle', data: '{}' });
    }, wait);
    unref(sub.idleTimer);
  };

  // A newer frame replaces one still waiting, and goes out when the stream's 15-a-second gap has passed.
  const offer = (sub: Sub, stored: StoredFrame) => {
    if (sub.closed) return;
    sub.pending = stored;
    armIdle(sub, stored.receivedAt);
    const wait = MIN_FRAME_GAP_MS - (now() - sub.lastSentAt);
    if (wait <= 0) {
      if (sub.timer) { clearTimeout(sub.timer); sub.timer = null; }
      send(sub, stored);
    } else if (!sub.timer) {
      sub.timer = setTimeout(() => {
        sub.timer = null;
        if (!sub.closed && sub.pending) send(sub, sub.pending);
      }, wait);
      unref(sub.timer);
    }
  };

  return {
    /**
     * Keeps `frame` as the owner's latest and hands it to their streams. Null when the hub is full of watched owners (try again later);
     * `stored` is false when the frame was older than one already kept from the same device (a late arrival: dropped, not an error).
     */
    publish(userId: string, deviceId: string, frame: LiveFrame): { stored: boolean; viewers: number } | null {
      const owner = touch(userId);
      if (!owner) return null;
      const t = now();
      const prev = owner.seqs.get(deviceId);
      if (prev && frame.seq < prev.seq && !(frame.seq < RESTART_SEQ && t - prev.at > RESTART_GAP_MS)) return { stored: false, viewers: owner.subs.size };
      owner.seqs.delete(deviceId);
      owner.seqs.set(deviceId, { seq: frame.seq, at: t });
      if (owner.seqs.size > MAX_DEVICES_PER_OWNER) owner.seqs.delete(owner.seqs.keys().next().value as string);
      const stored: StoredFrame = { frame, deviceId, receivedAt: t, json: JSON.stringify({ ...frame, receivedAt: t }) };
      owner.latest = stored;
      for (const sub of owner.subs) offer(sub, stored);
      return { stored: true, viewers: owner.subs.size };
    },

    /** The owner's latest frame when it is no older than `maxAgeMs`. */
    latest(userId: string, maxAgeMs = FRAME_TTL_MS): StoredFrame | null {
      const owner = owners.get(userId);
      if (!owner?.latest) return null;
      if (now() - owner.latest.receivedAt > maxAgeMs) {
        if (now() - owner.latest.receivedAt > FRAME_TTL_MS) owner.latest = null;
        return null;
      }
      return owner.latest;
    },

    /**
     * A stream for the owner. `emit` is called at once with the latest frame when it is younger than 5 s, else with `idle` (nothing has
     * arrived for 5 s, which is what idle says). Null when the owner already has the most streams (or the hub is full).
     */
    subscribe(userId: string, emit: (event: LiveEvent) => void): Subscription | null {
      const existing = owners.get(userId);
      if (existing && existing.subs.size >= maxStreams) return null;
      const owner = touch(userId);
      if (!owner) return null;
      const sub: Sub = { emit, lastSentAt: Number.NEGATIVE_INFINITY, pending: null, timer: null, idleTimer: null, closed: false };
      owner.subs.add(sub);
      const latest = owner.latest;
      if (latest && now() - latest.receivedAt < IDLE_AFTER_MS) {
        send(sub, latest);
        armIdle(sub, latest.receivedAt);
      } else {
        emit({ event: 'idle', data: '{}' });
      }
      return {
        close() {
          if (sub.closed) return;
          sub.closed = true;
          if (sub.timer) clearTimeout(sub.timer);
          if (sub.idleTimer) clearTimeout(sub.idleTimer);
          sub.timer = sub.idleTimer = null;
          sub.pending = null;
          owner.subs.delete(sub);
        },
      };
    },

    /** Streams open for the owner. */
    viewers: (userId: string) => owners.get(userId)?.subs.size ?? 0,
    /** Drops what has expired (also done on a timer while there is anything to keep). */
    sweep,
    /** Owners held in memory. */
    size: () => owners.size,
    /** Tests: forget everything. */
    reset() {
      for (const owner of owners.values()) for (const sub of owner.subs) { sub.closed = true; if (sub.timer) clearTimeout(sub.timer); if (sub.idleTimer) clearTimeout(sub.idleTimer); }
      owners.clear();
      if (sweeper) { clearInterval(sweeper); sweeper = null; }
    },
  };
}

export type LiveHub = ReturnType<typeof createLiveHub>;

/** The hub the routes share: one server process answers for the whole app. */
export const liveHub: LiveHub = createLiveHub();
