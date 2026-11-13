// Screen harness only: the social side of the racing data API (docs/platform/API-V1.md, "Social side") faked with realistic data, on top of
// the read-side fake of sim-v1.ts: a signed-in driver (`lap_fan`) with a dozen other drivers in every relation (friends, a request in each
// direction, a blocked one, a private one, a friends-only one), a leaderboard of 25 with ties for the track and car the harness driver
// drove last, smaller boards for the other pairs, a few share links (a lap, a session, an anonymous one), reports for the admin page.
//
//   VITE_HARNESS_ADMIN=true   the signed-in driver is an admin (the "Racing games" section of the admin page, and /admin/* answers)
//   HARNESS_NO_LAPS=1         (from sim-v1.ts) nothing driven: the leaderboards show their "drive a lap first" state
import type { PublicLapShare, PublicSessionShare } from '@/lib/sim/social-client';
import type { FakeV1State } from '@/test/v1-fake-server';
import { boardKey, driver, fakeSocialState, handlePublic, ranked, type FakeBoard, type FakeSocialState } from '@/test/social-fake-server';

const SCOPES = ['public', 'friends'] as const;

export function buildSocial(v1: FakeV1State): FakeSocialState {
  const admin = process.env.VITE_HARNESS_ADMIN === 'true';
  const state = fakeSocialState({ v1, admin, recheckRemaining: admin ? 120 : 0, publicFiles: v1.files });
  const pairs = new Map<string, { game: string; track: { id: string; name: string }; car: { id: string; name: string } }>();
  for (const session of v1.sessions) pairs.set(`${session.track.id}|${session.car.id}`, { game: session.game, track: session.track, car: session.car });

  const bestOf = (trackId: string, carId: string) => {
    const valid = v1.laps.filter((lap) => lap.valid && lap.track?.id === trackId && lap.car?.id === carId);
    return valid.length ? valid.reduce((best, lap) => (lap.timeMs < best.timeMs ? lap : best)) : null;
  };

  // People.
  const bestLap = (index: number) => {
    const pair = [...pairs.values()][index % Math.max(1, pairs.size)];
    const mine = pair ? bestOf(pair.track.id, pair.car.id) : null;
    return pair && mine ? [{ lapId: `10000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`, game: pair.game, track: pair.track, car: pair.car, timeMs: mine.timeMs + 400 + index * 130, achievedAt: '2026-11-09T18:00:00.000Z' }] : [];
  };
  state.drivers = [
    driver({ handle: 'apex_anna', displayName: 'Anna Apex', relation: 'friend', personalBestsCount: 9, gamesPlayed: ['lmu', 'ac'], bestLaps: bestLap(0) }),
    driver({ handle: 'turbo_tiago', displayName: 'Tiago Turbo', relation: 'friend', personalBestsCount: 4, gamesPlayed: ['lmu'], bestLaps: bestLap(1) }),
    driver({ handle: 'late_braker', displayName: null, relation: 'friend', personalBestsCount: 2, gamesPlayed: ['ac'], bestLaps: bestLap(2) }),
    driver({ handle: 'rookie_rita', displayName: 'Rita', relation: 'incoming', personalBestsCount: 1, gamesPlayed: ['lmu'], bestLaps: bestLap(3) }),
    driver({ handle: 'pit_wall_pedro', displayName: 'Pedro Pit Wall', relation: 'requested', personalBestsCount: 5, gamesPlayed: ['lmu', 'ac'], bestLaps: bestLap(4) }),
    driver({ handle: 'blocked_bob', displayName: 'Bob', relation: 'blocked' }),
    driver({ handle: 'secret_sam', displayName: 'Sam', visibility: 'private' }),
    driver({ handle: 'friends_only_fay', displayName: 'Fay', visibility: 'friends' }),
    driver({ handle: 'public_paulo', displayName: 'Paulo Public', relation: 'none', personalBestsCount: 12, gamesPlayed: ['lmu', 'ac'], bestLaps: bestLap(5) }),
    driver({ handle: 'nameless_nina', displayName: null, relation: 'none', personalBestsCount: 3, gamesPlayed: ['ac'], bestLaps: bestLap(6) }),
  ];
  for (const other of state.drivers) {
    const status = { friend: 'accepted', incoming: 'incoming', requested: 'outgoing', blocked: 'blocked' }[other.relation as string] as 'accepted' | 'incoming' | 'outgoing' | 'blocked' | undefined;
    if (status) state.friendRows.push({ handle: other.handle, displayName: other.visibility === 'private' ? null : other.displayName, status, since: '2026-11-0' + (state.friendRows.length + 1) + 'T10:00:00.000Z' });
  }

  // Boards: the track and car of the latest session get 25 drivers with ties, the others a short list. "Me" is always the harness driver's real best.
  const latest = [...v1.sessions].sort((p, q) => Date.parse(q.startedAt) - Date.parse(p.startedAt))[0];
  const names = ['Anna Apex', 'Tiago Turbo', null, 'Rita', 'Pedro Pit Wall', 'Paulo Public', null, 'Marta Marginal', 'Joao Joule', 'Lia Lap', 'Caio Curva', 'Duda Drift', 'Edu Esse', 'Fabi Fast', 'Gui Grid', 'Hugo Hairpin', 'Iris Inlap', 'Jota Jump', 'Kiko Kerb', 'Lara Late', 'Maya Mix', 'Nico Nose', 'Otto Oval', 'Pri Pace', 'Quim Quick'];
  const handles = ['apex_anna', 'turbo_tiago', 'late_braker', 'rookie_rita', 'pit_wall_pedro', 'public_paulo', 'nameless_nina', 'marta_m', 'joao_j', 'lia_lap', 'caio_c', 'duda_d', 'edu_e', 'fabi_f', 'gui_g', 'hugo_h', 'iris_i', 'jota_j', 'kiko_k', 'lara_l', 'maya_m', 'nico_n', 'otto_o', 'pri_p', 'quim_q'];
  for (const pair of pairs.values()) {
    const mine = bestOf(pair.track.id, pair.car.id);
    if (!mine) continue;
    const isLatest = pair.track.id === latest?.track.id && pair.car.id === latest?.car.id;
    const count = isLatest ? 25 : 7;
    const rows = Array.from({ length: count }, (_, i) => ({ handle: handles[i], displayName: names[i], timeMs: mine.timeMs - 2200 + i * 190 }));
    if (isLatest) rows[2].timeMs = rows[1].timeMs; // a tie for second
    if (isLatest) rows[6].timeMs = rows[5].timeMs;
    // The harness driver sits 12th on the long board, 4th on the short ones.
    const place = isLatest ? 11 : 3;
    rows.splice(place, 1, { handle: state.me.handle, displayName: state.me.displayName, timeMs: mine.timeMs });
    const entries = ranked(rows.map((row) => ({ ...row, isMe: row.handle === state.me.handle, lapId: row.handle === state.me.handle ? mine.id : undefined })));
    const meta = { game: pair.game, track: { ...pair.track, lengthM: null }, car: { ...pair.car, class: null } };
    state.boards.set(boardKey(pair.track.id, pair.car.id, 'public'), { entries, ...meta } satisfies FakeBoard);
    const friendHandles = new Set(['apex_anna', 'turbo_tiago', 'late_braker', state.me.handle]);
    state.boards.set(boardKey(pair.track.id, pair.car.id, 'friends'), { entries: ranked(entries.filter((entry) => friendHandles.has(entry.handle)).map((entry) => ({ handle: entry.handle, displayName: entry.displayName, timeMs: entry.timeMs, isMe: entry.isMe, lapId: entry.lapId }))), ...meta });
  }

  // Share links: something to open at /s/demo-lap, /s/demo-session and /s/demo-anon (anything else is "not available").
  const firstSession = v1.sessions[0];
  const lapOf = firstSession ? v1.laps.filter((lap) => lap.sessionId === firstSession.id) : [];
  const shared = lapOf[2];
  if (firstSession && shared) {
    const publicLap = (anonymous: boolean): PublicLapShare => ({
      kind: 'lap', createdAt: '2026-11-13T09:00:00.000Z', expiresAt: null, driver: anonymous ? null : { handle: state.me.handle, displayName: state.me.displayName },
      lap: { id: shared.id, game: shared.game, track: { name: shared.track!.name, lengthM: 5793 }, car: { name: shared.car!.name, class: null }, lapNumber: shared.lapNumber, timeMs: shared.timeMs, valid: shared.valid, startedAt: shared.startedAt, sectorsMs: shared.sectorsMs, topSpeedKmh: shared.topSpeedKmh },
    });
    const publicSession: PublicSessionShare = {
      kind: 'session', createdAt: '2026-11-13T09:00:00.000Z', expiresAt: null, driver: { handle: state.me.handle, displayName: state.me.displayName },
      session: {
        game: firstSession.game, track: { name: firstSession.track.name, lengthM: 5793 }, car: { name: firstSession.car.name, class: null }, kind: firstSession.kind, startedAt: firstSession.startedAt,
        endedAt: firstSession.endedAt, weather: firstSession.weather, airTempC: firstSession.airTempC, trackTempC: firstSession.trackTempC, lapCount: lapOf.length, bestLapMs: firstSession.bestLapMs,
        laps: lapOf.slice(0, 12).map((lap) => ({ id: lap.id, lapNumber: lap.lapNumber, timeMs: lap.timeMs, valid: lap.valid, startedAt: lap.startedAt, sectorsMs: lap.sectorsMs, topSpeedKmh: lap.topSpeedKmh })),
      },
    };
    state.publicTokens.set('demo-lap', publicLap(false));
    state.publicTokens.set('demo-anon', publicLap(true));
    state.publicTokens.set('demo-session', publicSession);
    for (const lap of lapOf) state.shareable.laps.set(lap.id, publicLap(false));
    state.shareable.sessions.set(firstSession.id, publicSession);
    state.shares = [
      { id: '20000000-0000-4000-8000-000000000001', kind: 'lap', lapId: shared.id, sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true },
      { id: '20000000-0000-4000-8000-000000000002', kind: 'session', lapId: null, sessionId: firstSession.id, createdAt: '2026-11-11T10:00:00.000Z', expiresAt: '2026-12-11T10:00:00.000Z', revokedAt: null, active: true },
    ];
  }

  // Moderation (only answered when the harness driver is an admin).
  const suspect = v1.laps.find((lap) => lap.valid) ?? null;
  if (suspect) {
    state.reports = [
      {
        id: '30000000-0000-4000-8000-000000000001', kind: 'lap', status: 'open', reason: 'cheating', details: 'Sector 2 is faster than the world record by four seconds.', createdAt: '2026-11-12T10:00:00.000Z', decidedAt: null,
        reporter: { handle: 'apex_anna', displayName: 'Anna Apex' },
        target: { lapId: suspect.id, game: suspect.game, track: suspect.track, car: suspect.car, timeMs: suspect.timeMs, plausible: false, hidden: false, owner: { handle: 'public_paulo', displayName: 'Paulo Public' } },
      },
      {
        id: '30000000-0000-4000-8000-000000000002', kind: 'profile', status: 'open', reason: 'offensive_name', details: null, createdAt: '2026-11-11T10:00:00.000Z', decidedAt: null,
        reporter: { handle: 'turbo_tiago', displayName: null }, target: { handle: 'nameless_nina', displayName: null, visibility: 'public', hidden: false },
      },
    ];
    state.adminLaps.set(suspect.id, {
      lap: {
        id: suspect.id, game: suspect.game, track: suspect.track, car: suspect.car, lapNumber: suspect.lapNumber, timeMs: suspect.timeMs, valid: true, startedAt: suspect.startedAt, sectorsMs: suspect.sectorsMs,
        topSpeedKmh: suspect.topSpeedKmh, sampleCount: suspect.sampleCount, sizeBytes: suspect.sizeBytes, formatVersion: 2, createdAt: suspect.createdAt, marked: false, plausible: false,
        plausibility: { v: 1, failed: [{ check: 'speed_range', detail: { maxMs: 171.4, limitMs: 150 } }, { check: 'sector_sum', detail: { sumMs: suspect.timeMs - 4200, lapMs: suspect.timeMs, differenceMs: 4200 } }] }, hidden: false,
      },
      owner: { handle: 'public_paulo', displayName: 'Paulo Public', visibility: 'public', hidden: false }, onLeaderboard: false,
      reports: [{ id: '30000000-0000-4000-8000-000000000001', status: 'open', reason: 'cheating', createdAt: '2026-11-12T10:00:00.000Z' }],
    });
  }
  return state;
}

export { handlePublic };
