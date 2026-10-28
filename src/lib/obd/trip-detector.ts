// Decides, from each live-data cycle, when a trip starts and ends so the app
// can run unattended in the car: nothing is recorded while the car is off or
// sitting in READY, and a trip is closed (and saved) when the car turns off.

export interface TripReading {
  /** Epoch ms of the cycle. */
  at: number;
  /** The engine/hybrid ECU answered at least one standard PID. */
  ecuAlive: boolean;
  speedKmh: number | null;
  rpm: number | null;
}

export type TripEndReason = 'car-off' | 'parked' | 'manual' | 'disconnected';

export type TripEvent =
  | { type: 'start'; at: number }
  | { type: 'end'; at: number; reason: TripEndReason; keep: boolean };

export interface TripDetectorOptions {
  /** Moving faster than this starts a trip. */
  startSpeedKmh: number;
  /** Engine above this starts a trip (a parked hybrid in READY sits at 0). */
  startRpm: number;
  /** ECU silent this long = car turned off. */
  offAfterMs: number;
  /** Parked (not moving, engine stopped/idle) this long ends an automatic trip. */
  parkedAfterMs: number;
  /** Shorter trips are discarded. */
  minTripMs: number;
}

export const DEFAULT_TRIP_OPTIONS: TripDetectorOptions = {
  startSpeedKmh: 3,
  startRpm: 400,
  offAfterMs: 20_000,
  parkedAfterMs: 5 * 60_000,
  minTripMs: 60_000,
};

const MIN_MANUAL_TRIP_MS = 5_000;

export class TripDetector {
  private start: number | null = null;
  private manual = false;
  private lastAlive: number | null = null;
  private lastActive: number | null = null;
  // Set when the user ends a trip by hand while driving: no new automatic
  // trip until the car is switched off or parked, or one would start at once.
  private autoHeld = false;

  constructor(private opts: TripDetectorOptions = DEFAULT_TRIP_OPTIONS) {}

  get recording(): boolean {
    return this.start !== null;
  }

  /** Automatic recording is paused after a manual stop, until the car is switched off or parked. */
  get autoStartHeld(): boolean {
    return this.autoHeld;
  }

  /** The car is answering right now (on / READY). */
  carOn(now: number): boolean {
    return this.lastAlive !== null && now - this.lastAlive < this.opts.offAfterMs;
  }

  private active(r: TripReading): boolean {
    return r.ecuAlive && ((r.speedKmh ?? 0) >= this.opts.startSpeedKmh || (r.rpm ?? 0) >= this.opts.startRpm);
  }

  private end(at: number, reason: TripEndReason): TripEvent {
    const start = this.start as number;
    const end = Math.max(start, at);
    // A trip the user ends by hand is kept unless it's a mis-tap.
    const minMs = reason === 'manual' ? MIN_MANUAL_TRIP_MS : this.opts.minTripMs;
    this.start = null;
    this.manual = false;
    return { type: 'end', at: end, reason, keep: end - start >= minMs };
  }

  /** Feed one cycle. With `autoStart` off, trips only begin via startManual(). */
  update(r: TripReading, autoStart = true): TripEvent[] {
    const events: TripEvent[] = [];
    // Was the car off, or parked, up to this cycle? (Checked before this reading counts.)
    const wasOff = this.lastAlive === null || r.at - this.lastAlive >= this.opts.offAfterMs;
    const wasParked = this.lastActive === null || r.at - this.lastActive >= this.opts.parkedAfterMs;
    if (r.ecuAlive) this.lastAlive = r.at;
    const active = this.active(r);
    if (active) this.lastActive = r.at;

    if (this.start === null) {
      if (wasOff || wasParked) this.autoHeld = false;
      if (active && autoStart && !this.autoHeld) {
        this.start = r.at;
        events.push({ type: 'start', at: r.at });
      }
      return events;
    }

    if (this.lastAlive === null || r.at - this.lastAlive >= this.opts.offAfterMs) {
      events.push(this.end(this.lastAlive ?? r.at, 'car-off'));
    } else if (!this.manual && this.lastActive !== null && r.at - this.lastActive >= this.opts.parkedAfterMs) {
      events.push(this.end(this.lastActive, 'parked'));
    }
    return events;
  }

  /** User pressed "Start trip": record now, until stopped or the car turns off. */
  startManual(at: number): TripEvent[] {
    if (this.start !== null) {
      this.manual = true;
      return [];
    }
    this.start = at;
    this.manual = true;
    this.autoHeld = false;
    this.lastActive = at;
    return [{ type: 'start', at }];
  }

  stop(at: number, reason: 'manual' | 'disconnected'): TripEvent[] {
    if (reason === 'manual') this.autoHeld = true;
    return this.start === null ? [] : [this.end(at, reason)];
  }
}
