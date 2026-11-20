// The frame Xpeed Companion pushes and the phone page draws (`/api/sim/live/stream`, server side: api/sim/_live.ts).
// The types mirror the Companion's serde models (`xpeed-sim/src/panel/model.rs` and `widgets.rs`, all camelCase). Everything is optional: a
// game fills only what it has, an older or newer Companion may leave a field out, and the page draws what is there and nothing else.
// A tuple of the Rust side is an array here; a `COLORREF` is a number (0x00BBGGRR).

export type Role = 'text' | 'muted' | 'primary' | 'good' | 'danger' | 'warn' | 'best' | 'info' | 'cold';
export type Show = 'shown' | 'dimmed' | 'hidden';
export type Colorref = number;

export interface Elem {
  show?: Show;
  role?: Role;
  label?: string;
  short?: string;
  text?: string;
  unit?: string;
  /** 0..1 (a gauge), -1..1 for the wheel. */
  frac?: number;
}

export interface Cell { label?: string; value?: string; role?: Role; show?: Show }
export interface Light { kind?: string; glow?: 'off' | 'on' | 'ready'; word?: string; show?: Show }

export type TyreShape = { solid?: Colorref; bands?: [Colorref, Colorref, Colorref] };
export interface TyreTile {
  corner?: string;
  word?: string;
  role?: Role;
  temp?: string;
  heat?: Colorref;
  shape?: TyreShape;
  treadText?: ([string, Colorref] | null)[] | null;
  pressure?: [string, string] | null;
  brake?: string | null;
  wear?: number | null;
}
export interface TyresModel { show?: Show; tiles?: TyreTile[]; title?: string; compound?: string | null; brakeLabel?: string }

export interface LapRow {
  kind?: 'live' | 'done' | 'best' | 'invalid';
  show?: Show;
  number?: string;
  time?: string;
  timeRole?: Role;
  gap?: string;
  gapRole?: Role;
  sectors?: ([string, Role] | null)[];
}
export interface LapsModel { show?: Show; title?: string; heads?: string[]; sectors?: boolean; rows?: LapRow[]; empty?: string }

export interface FlagCardModel {
  show?: Show;
  title?: string;
  kind?: 'green' | 'yellow' | 'blue' | 'white' | 'black' | 'chequered' | null;
  word?: string;
}
export interface FuelCalcModel {
  show?: Show;
  title?: string;
  stats?: Cell[];
  heads?: string[];
  rows?: { laps?: string; needed?: string; toAdd?: string; role?: Role }[];
  toEnd?: { label?: string; needed?: string; toAdd?: string | null; addLabel?: string; role?: Role } | null;
  note?: string | null;
}
export interface TyreTrendModel {
  show?: Show;
  title?: string;
  heads?: string[];
  rows?: { corner?: string; tread?: number | null; wear?: string; lapsLeft?: string; role?: Role; worst?: boolean }[];
  note?: string | null;
}
export interface SectorsModel {
  show?: Show;
  title?: string;
  bestHead?: string;
  rows?: { label?: string; time?: string; best?: string; tone?: 'plain' | 'best' | 'faster' | 'slower'; fromLastLap?: boolean }[];
  theoreticalLabel?: string;
  theoretical?: string;
  gap?: string | null;
  gapLabel?: string;
}
export interface DeltaBarModel { show?: Show; title?: string; caption?: string; value?: string; role?: Role; frac?: number }
export interface SessionCardModel {
  show?: Show;
  title?: string;
  position?: string | null;
  ofCars?: string | null;
  classLine?: string | null;
  remaining?: string | null;
  remainingNote?: string | null;
}
export interface RelativeModel {
  show?: Show;
  title?: string;
  rows?: { position?: string; name?: string; gap?: string | null; role?: Role; relation?: 'level' | 'lapping' | 'lapped'; isPlayer?: boolean }[];
  note?: string | null;
}
export interface StandingsModel {
  show?: Show;
  title?: string;
  className?: string | null;
  heads?: string[];
  rows?: { position?: string; name?: string; gap?: string; last?: string; isPlayer?: boolean; skippedBefore?: boolean }[];
  note?: string | null;
}
export interface GapTrend { dir?: 'closing' | 'opening' | 'steady'; text?: string; role?: Role }
export interface GapSide { label?: string; car?: { position?: string; name?: string; gap?: string; trend?: GapTrend | null } | null }
export interface GapsModel { show?: Show; title?: string; ahead?: GapSide; behind?: GapSide; note?: string | null }
export interface RadarCar { rightM?: number; aheadM?: number; threat?: 'clear' | 'near' | 'alongside' }
export interface RadarModel {
  show?: Show;
  title?: string;
  mode?: 'map' | 'spotter' | 'waiting';
  cars?: RadarCar[];
  leftBars?: number;
  rightBars?: number;
  note?: string | null;
}
export interface DeltaRefModel {
  show?: Show;
  title?: string;
  value?: string;
  role?: Role;
  line?: string | null;
  personalLine?: string | null;
  note?: string | null;
}

export interface Banner { kind?: string; title?: string; note?: string }

/** The panel's `DashModel`. */
export interface DashModel {
  status?: [string, string] | null;
  banner?: Banner | null;
  track?: string;
  car?: string;
  session?: string | null;
  lap?: Elem;
  invalid?: boolean;
  rev?: Elem;
  lapTime?: Elem;
  lastLap?: Elem;
  bestLap?: Elem;
  delta?: Elem;
  deltaVs?: string;
  deltaNote?: string | null;
  gear?: Elem;
  gearBelow?: Elem;
  gearAbove?: Elem;
  speed?: Elem;
  brake?: Elem;
  throttle?: Elem;
  clutch?: Elem;
  steer?: Elem;
  fuelTitle?: string;
  fuel?: Elem;
  fuelShare?: number | null;
  fuelTick?: number | null;
  fuelLaps?: Elem;
  fuelTank?: Elem;
  fuelPerLap?: Elem;
  fuelLow?: boolean;
  engine?: Cell[];
  progress?: Elem;
  distance?: Elem;
  alertsTitle?: string;
  alerts?: Light[];
  noAlerts?: string;
  electronics?: Cell[];
  damage?: Elem;
  tyres?: TyresModel | null;
  laps?: LapsModel;
  map?: Show;
  mapTitle?: string;
  flag?: FlagCardModel | null;
  fuelCalc?: FuelCalcModel | null;
  tyreTrend?: TyreTrendModel | null;
  sectors?: SectorsModel | null;
  deltaBar?: DeltaBarModel | null;
  sessionCard?: SessionCardModel | null;
  relative?: RelativeModel | null;
  standings?: StandingsModel | null;
  gaps?: GapsModel | null;
  radar?: RadarModel | null;
  deltaRef?: DeltaRefModel | null;
}

/** What the stream's `frame` event carries. */
export interface LiveFrame {
  v: 1;
  seq: number;
  sentAt?: number;
  receivedAt?: number;
  game?: string;
  dashboard?: string;
  /** Each row is one or two widget ids, side by side. */
  rows: string[][];
  model: DashModel;
}

/** A frame as the stream delivers it, or null for anything that is not one (the page never trusts a byte of it). */
export function parseFrame(json: string): LiveFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const frame = value as Partial<LiveFrame>;
  if (frame.v !== 1 || !Array.isArray(frame.rows) || !frame.model || typeof frame.model !== 'object') return null;
  const rows = frame.rows
    .filter((row): row is string[] => Array.isArray(row))
    .map((row) => row.filter((id): id is string => typeof id === 'string'))
    .filter((row) => row.length > 0);
  return { ...(frame as LiveFrame), rows };
}

/** A COLORREF (0x00BBGGRR) as a CSS colour. */
export function colorref(value: number | undefined | null): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `rgb(${value & 0xff}, ${(value >> 8) & 0xff}, ${(value >> 16) & 0xff})`;
}
