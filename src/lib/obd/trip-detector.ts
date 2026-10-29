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
  /**
   * The adapter itself could not be reached (Bluetooth stall, reconnecting), so
   * this says nothing about the car: it does not count toward "car turned
   * off", only toward a much longer grace period.
   */
  linkDown?: boolean;
}

export type TripEndReason = 'car-off' | 'parked' | 'manual' | 'disconnected';

export type TripEvent =
  | { type: 'start'; at: number }
  | { type: 'end'; at: number; reason: TripEndReason; keep: boolean };

export interface TripDetectorOptions {
  /** Moving faster than this starts a trip. */
  startSpeedKmh: number;
  /** RPM fallback only when the vehicle does not report speed. */
  startRpm: number;
  /** ECU silent this long = car turned off. */
  offAfterMs: number;
  /** Parked (not moving, engine stopped/idle) this long ends an automatic trip. */
  parkedAfterMs: number;
  /** Shorter trips are discarded. */
  minTripMs: number;
  /** Adapter unreachable this long (without a word from the car) ends the trip. */
  linkGraceMs: number;
  /** An automatic trip that never went faster than this is warm-up in a parking spot, not a trip. */
  movementKmh: number;
}

export const DEFAULT_TRIP_OPTIONS: TripDetectorOptions = {
  startSpeedKmh: 3,
  startRpm: 400,
  offAfterMs: 20_000,
  // Long enough that a hybrid crawling in a jam with the engine off is not cut in two.
  parkedAfterMs: 10 * 60_000,
  minTripMs: 60_000,
  // Long enough for a Bluetooth stall or a reconnect, short enough that a trip
  // doesn't stay open for hours after the phone left the car.
  linkGraceMs: 150_000,
  movementKmh: 5,
};

const MIN_MANUAL_TRIP_MS = 5_000;

export class TripDetector {
  private start: number | null = null;
  private manual = false;
  private lastAlive: number | null = null;
  private lastActive: number | null = null;
  // Time the adapter was unreachable since the car last answered: not car silence.
  private downMs = 0;
  private lastAt: number | null = null;
  // Whether this trip ever moved (and whether speed was reported at all).
  private moved = false;
  private speedSeen = false;
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
    return this.lastAlive !== null && this.silentFor(now) < this.opts.offAfterMs;
  }

  /** How long the car has been silent, not counting time the adapter couldn't be reached. */
  private silentFor(at: number): number {
    return this.lastAlive === null ? Infinity : at - this.lastAlive - this.downMs;
  }

  private active(r: TripReading): boolean {
    // A reported zero speed proves stationary even when the engine is warming up.
    // RPM is only a fallback for vehicles that do not provide speed at all.
    return r.ecuAlive && (r.speedKmh != null
      ? r.speedKmh >= this.opts.startSpeedKmh
      : (r.rpm ?? 0) >= this.opts.startRpm);
  }

  private end(at: number, reason: TripEndReason): TripEvent {
    const start = this.start as number;
    const end = Math.max(start, at);
    // A trip the user ends by hand is kept unless it's a mis-tap.
    const minMs = reason === 'manual' ? MIN_MANUAL_TRIP_MS : this.opts.minTripMs;
    // An automatic trip that never moved (a cold hybrid warming up in READY, parked) isn't a trip.
    const phantom = !this.manual && reason !== 'manual' && this.speedSeen && !this.moved;
    this.start = null;
    this.manual = false;
    return { type: 'end', at: end, reason, keep: end - start >= minMs && !phantom };
  }

  /** Note what this reading says about movement, for the trip in progress. */
  private noteMovement(r: TripReading) {
    if (!r.ecuAlive || r.speedKmh == null) return;
    this.speedSeen = true;
    if (r.speedKmh >= this.opts.movementKmh) this.moved = true;
  }

  private begin(at: number) {
    this.start = at;
    this.moved = false;
    this.speedSeen = false;
  }

  /** Feed one cycle. With `autoStart` off, trips only begin via startManual(). */
  update(r: TripReading, autoStart = true): TripEvent[] {
    const events: TripEvent[] = [];

    if (r.linkDown) {
      // Nothing is known about the car: only a long absence ends the trip.
      if (this.lastAt !== null) this.downMs += Math.max(0, r.at - this.lastAt);
      this.lastAt = r.at;
      if (this.start !== null && (this.lastAlive === null || r.at - this.lastAlive >= this.opts.linkGraceMs)) {
        events.push(this.end(this.lastAlive ?? r.at, 'disconnected'));
      }
      return events;
    }

    // Was the car off, or parked, up to this cycle? (Checked before this reading counts.)
    const wasOff = this.silentFor(r.at) >= this.opts.offAfterMs;
    const wasParked = this.lastActive === null || r.at - this.lastActive >= this.opts.parkedAfterMs;
    if (r.ecuAlive) {
      this.lastAlive = r.at;
      this.downMs = 0;
    }
    this.lastAt = r.at;
    const active = this.active(r);
    if (active) this.lastActive = r.at;

    if (this.start === null) {
      if (wasOff || wasParked) this.autoHeld = false;
      if (active && autoStart && !this.autoHeld) {
        this.begin(r.at);
        this.noteMovement(r);
        events.push({ type: 'start', at: r.at });
      }
      return events;
    }
    this.noteMovement(r);

    if (this.lastAlive === null || this.silentFor(r.at) >= this.opts.offAfterMs) {
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
    this.begin(at);
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
