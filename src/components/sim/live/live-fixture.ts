// A frame shaped like the Companion's serde models (`xpeed-sim/src/panel/model.rs`, `widgets.rs`, camelCase), written by hand for the tests.
import type { DashModel, Elem, LiveFrame, Role } from '@/lib/sim/live-frame';

export const elem = (text: string, role: Role = 'text', extra: Partial<Elem> = {}): Elem => ({ show: 'shown', role, label: '', short: '', text, unit: '', frac: 0, ...extra });

export const ALL_WIDGET_IDS = [
  'times', 'centre', 'fuel', 'tyres', 'laps', 'track', 'alerts', 'flag', 'fuel_calc', 'tyre_trend', 'sectors', 'delta_bar', 'session',
  'relative', 'standings', 'gaps', 'radar', 'delta_ref',
];

export function sampleModel(): DashModel {
  const tile = (corner: string, temp: string) => ({
    corner, word: 'OK', role: 'good' as Role, temp, heat: 0x0000ff, shape: { solid: 0x00ff00 }, treadText: null, pressure: ['27.1', 'psi'] as [string, string], brake: '310°', wear: 0.8,
  });
  return {
    status: null,
    banner: null,
    track: 'Spa-Francorchamps',
    car: 'Porsche 911 GT3 R',
    session: 'Race',
    lap: elem('5', 'text', { label: 'LAP' }),
    invalid: false,
    rev: elem('', 'text', { frac: 0.7 }),
    lapTime: elem('1:47.912', 'text', { label: 'LAP TIME' }),
    lastLap: elem('1:48.301', 'text', { label: 'LAST' }),
    bestLap: elem('1:47.100', 'best', { label: 'BEST' }),
    delta: elem('-0.270', 'good', { frac: 0.43 }),
    deltaVs: 'vs best',
    deltaNote: null,
    gear: elem('4'),
    gearBelow: elem('3', 'muted'),
    gearAbove: elem('5', 'muted'),
    speed: elem('187', 'text', { unit: 'km/h' }),
    brake: elem('0%', 'danger', { label: 'Brake', short: 'BRK', frac: 0 }),
    throttle: elem('82%', 'good', { label: 'Throttle', short: 'THR', frac: 0.82 }),
    clutch: elem('', 'text', { show: 'hidden' }),
    steer: elem('', 'text', { show: 'hidden' }),
    fuelTitle: 'Fuel',
    fuel: elem('32.4', 'text', { unit: 'L' }),
    fuelShare: 0.54,
    fuelTick: 0.04,
    fuelLaps: elem('12.3', 'good', { label: 'laps' }),
    fuelTank: elem('of 60 L'),
    fuelPerLap: elem('2.6 L per lap'),
    fuelLow: false,
    engine: [{ label: 'WATER', value: '92°C', role: 'good', show: 'shown' }],
    progress: elem('43%', 'text', { frac: 0.43 }),
    distance: elem('1.9 km'),
    alertsTitle: 'Alerts',
    alerts: [{ kind: 'pit', glow: 'on', word: 'PIT LIMITER', show: 'shown' }],
    noAlerts: 'No alerts',
    electronics: [],
    damage: elem('none', 'muted', { label: 'Damage' }),
    tyres: { show: 'shown', title: 'Tyres', compound: 'Medium', brakeLabel: 'Brake', tiles: [tile('FL', '88°'), tile('FR', '90°'), tile('RL', '85°'), tile('RR', '86°')] },
    laps: {
      show: 'shown', title: 'Laps', heads: ['Lap', 'Time', 'Gap'], sectors: false, empty: 'No laps yet',
      rows: [
        { kind: 'live', show: 'shown', number: '5', time: '1:12.004', timeRole: 'text', gap: '', gapRole: 'text', sectors: [null, null, null] },
        { kind: 'best', show: 'shown', number: '4', time: '1:47.100', timeRole: 'best', gap: '', gapRole: 'text', sectors: [null, null, null] },
      ],
    },
    map: 'shown',
    mapTitle: 'Track',
    flag: { show: 'shown', title: 'Flag', kind: 'yellow', word: 'YELLOW' },
    fuelCalc: {
      show: 'shown', title: 'Fuel calculator', note: null,
      stats: [{ label: 'AVG', value: '2.6 L', role: 'text', show: 'shown' }, { label: 'LAST', value: '2.7 L', role: 'text', show: 'shown' }, { label: 'LEFT', value: '12.3', role: 'good', show: 'shown' }],
      heads: ['Laps', 'Needed', 'Add'],
      rows: [{ laps: '5', needed: '15.6 L', toAdd: '0.0 L', role: 'text' }, { laps: '20', needed: '54.6 L', toAdd: '22.2 L', role: 'warn' }],
      toEnd: { label: 'To the end', needed: '40.1 L', toAdd: '7.7 L', addLabel: 'add', role: 'warn' },
    },
    tyreTrend: {
      show: 'shown', title: 'Tyre wear', heads: ['per lap', 'laps left'], note: null,
      rows: [{ corner: 'FL', tread: 0.8, wear: '1.8%', lapsLeft: '44', role: 'good', worst: true }],
    },
    sectors: {
      show: 'shown', title: 'Sectors', bestHead: 'Best', theoreticalLabel: 'Theoretical', theoretical: '1:46.948', gap: '-0.152', gapLabel: 'from best',
      rows: [{ label: 'S1', time: '35.210', best: '35.100', tone: 'faster', fromLastLap: true }],
    },
    deltaBar: { show: 'shown', title: 'Delta', caption: 'vs best lap', value: '-0.270', role: 'good', frac: 0.43 },
    sessionCard: { show: 'shown', title: 'Session', position: 'P3', ofCars: '/ 24', classLine: 'P2 in class', remaining: '12:34', remainingNote: 'left' },
    relative: {
      show: 'shown', title: 'Relative', note: null,
      rows: [
        { position: 'P2', name: 'A. Rossi', gap: '-1.2', role: 'text', relation: 'level', isPlayer: false },
        { position: 'P3', name: 'You', gap: null, role: 'text', relation: 'level', isPlayer: true },
        { position: 'P4', name: 'J. Smith', gap: '+0.8', role: 'info', relation: 'lapping', isPlayer: false },
      ],
    },
    standings: {
      show: 'shown', title: 'Standings', className: 'GT3', heads: ['Gap', 'Last'], note: null,
      rows: [{ position: 'P1', name: 'M. Verdi', gap: 'Leader', last: '1:46.9', isPlayer: false, skippedBefore: false }, { position: 'P3', name: 'You', gap: '+12.3', last: '1:48.3', isPlayer: true, skippedBefore: true }],
    },
    gaps: {
      show: 'shown', title: 'Gaps', note: null,
      ahead: { label: 'Ahead', car: { position: 'P2', name: 'A. Rossi', gap: '+1.234', trend: { dir: 'closing', text: 'closing 0.3 s/lap', role: 'good' } } },
      behind: { label: 'Behind', car: null },
    },
    radar: { show: 'shown', title: 'Radar', mode: 'map', cars: [{ rightM: 3, aheadM: 2, threat: 'alongside' }, { rightM: -2, aheadM: -12, threat: 'clear' }], leftBars: 0, rightBars: 0, note: null },
    deltaRef: { show: 'shown', title: 'Delta to reference', value: '-0.054', role: 'good', line: 'Xpeed best · L. Moretti · 2:01.234', personalLine: null, note: null },
  };
}

export function sampleFrame(over: Partial<LiveFrame> = {}): LiveFrame {
  return {
    v: 1,
    seq: 1,
    sentAt: 1_700_000_000_000,
    receivedAt: 1_700_000_000_050,
    game: 'ams2',
    dashboard: 'race',
    rows: [['times'], ['centre', 'fuel'], ['tyres'], ['delta_bar'], ['session'], ['relative'], ['flag'], ['radar'], ['mystery']],
    model: sampleModel(),
    ...over,
  };
}
