import type { AccountLap } from '@/lib/sim/account-laps';

let counter = 0;
/** A lap as the server lists it, with sensible defaults. */
export function accountLap(extra: Partial<AccountLap> = {}): AccountLap {
  counter++;
  return {
    id: `srv-${counter}`,
    game: 'ac',
    track: 'Monza',
    car: 'Ferrari 499P',
    lapNumber: counter,
    timeMs: 100_000 + counter,
    valid: true,
    startedAt: '2026-11-10T12:00:00.000Z',
    sampleCount: 1000 + counter,
    sizeBytes: 1000,
    createdAt: '2026-11-10T12:05:00.000Z',
    deviceName: 'Rig',
    ...extra,
  };
}

/** Answers GET /api/sim/laps, /api/sim/devices and (empty) /api/sim/games like the server would. */
export function stubSimServer(laps: AccountLap[] | null, devices: Array<{ id: string; name: string; last_seen_at?: string | null }> = []) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/sim/laps') return laps ? new Response(JSON.stringify({ laps }), { status: 200 }) : new Response(null, { status: 401 });
    if (path === '/api/sim/devices') {
      return new Response(JSON.stringify({ devices: devices.map((device) => ({ created_at: '2026-11-01T00:00:00.000Z', last_seen_at: null, last_lap_at: null, revoked_at: null, ...device })) }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
}
