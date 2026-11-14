import type { BestVsAverage, CornerSpread, Insight } from '@/lib/sim/insights';
import { lengthIn, lengthLabel, speedIn, speedLabel, type DistanceUnit } from '@/lib/sim/analysis';

/**
 * The sentences of the analysis, as data: a finding of the analysis library (`insights.ts`) becomes a translation key and the
 * values to put in it. No text and no `t` here, so every kind and cause can be tested without a screen; the screen calls
 * `t(key, values)`. Nothing is claimed that the finding does not carry: a cause that was not measured is never named, and when the
 * library says it could not tell why, the sentence says so (and which channel was missing, when the caller knows).
 */

export interface InsightText {
  /** A key in the locale files, under `modes.analysis`. */
  key: string;
  /** Already formatted for the person's units: seconds with two decimals, distances in m or ft, speeds in km/h or mph. */
  values: Record<string, string | number>;
}

export type MissingChannel = 'brake' | 'throttle' | 'position';

export interface InsightTextOptions {
  unit?: DistanceUnit;
  /** What the comparison could not read for this corner (`CornerDelta.missing`); names the reason for an `unknownCause`. */
  missing?: readonly MissingChannel[];
}

const seconds = (value: number) => value.toFixed(2);
/** A speed difference in the person's unit: the library reports km/h. */
const speed = (kmh: number, unit: DistanceUnit) => `${speedIn(kmh / 3.6, unit).toFixed(0)} ${speedLabel(unit)}`;
const distance = (meters: number, unit: DistanceUnit) => `${lengthIn(Math.abs(meters), unit).toFixed(0)} ${lengthLabel(unit)}`;
const key = (name: string) => `modes.analysis.insight.${name}`;

/** The sentence for one finding of `lapInsights`. */
export function insightText(insight: Insight, options: InsightTextOptions = {}): InsightText {
  const unit = options.unit ?? 'km';
  const base = { seconds: seconds(insight.seconds), corner: insight.corner ?? 0, sector: insight.sector ?? 0 };
  const noCause: InsightText = { key: key('cornerNoCause'), values: base };
  switch (insight.kind) {
    case 'brakeEarlier':
      return insight.meters !== undefined ? { key: key('brakeEarlier'), values: { ...base, distance: distance(insight.meters, unit) } } : noCause;
    case 'slowerExit':
      return insight.kmh !== undefined ? { key: key('slowerExit'), values: { ...base, speed: speed(insight.kmh, unit) } } : noCause;
    case 'topSpeedLower':
      return { key: key('topSpeedLower'), values: { ...base, speed: speed(insight.kmh ?? 0, unit) } };
    case 'sectorGap':
      return { key: key('sectorGap'), values: base };
    case 'inconsistent':
      return insight.meters !== undefined
        ? { key: key('inconsistentBrake'), values: { ...base, distance: distance(insight.meters, unit) } }
        : { key: key('inconsistent'), values: base };
    case 'lostInCorner':
      break;
  }
  // A time lost in a corner: the cause says what to write, and a cause without its number is not named.
  switch (insight.cause) {
    case 'brakesEarly':
      return insight.meters !== undefined ? { key: key('brakeEarlier'), values: { ...base, distance: distance(insight.meters, unit) } } : noCause;
    case 'brakesLate':
      if (insight.meters === undefined) return noCause;
      // The library reports the speed given up in the corner; a figure of zero or less means the time went after the apex.
      return insight.kmh !== undefined && insight.kmh >= 1
        ? { key: key('brakesLateSlower'), values: { ...base, distance: distance(insight.meters, unit), speed: speed(insight.kmh, unit) } }
        : { key: key('brakesLate'), values: { ...base, distance: distance(insight.meters, unit) } };
    case 'lowMinSpeed':
      return insight.kmh !== undefined ? { key: key('lowMinSpeed'), values: { ...base, speed: speed(insight.kmh, unit) } } : noCause;
    case 'latePickup':
      return insight.meters !== undefined ? { key: key('latePickup'), values: { ...base, distance: distance(insight.meters, unit) } } : noCause;
    case 'line':
      return insight.meters !== undefined ? { key: key('line'), values: { ...base, distance: distance(insight.meters, unit) } } : noCause;
    case 'wrongGear':
      return { key: key('wrongGear'), values: base };
    case 'slowExit':
      return insight.kmh !== undefined ? { key: key('slowerExit'), values: { ...base, speed: speed(insight.kmh, unit) } } : noCause;
    case 'unknownCause': {
      const missing = options.missing ?? [];
      const why = missing.includes('brake') ? 'Brake' : missing.includes('throttle') ? 'Throttle' : missing.includes('position') ? 'Position' : '';
      return { key: key(`unknownCause${why}`), values: base };
    }
    case 'none':
    case undefined:
      return noCause;
  }
}

/** One thing worth working on after a session, from `sessionInsights`: where the driving varies most, or where the best lap beat the average. */
export type SessionFinding =
  | { kind: 'variable'; spread: CornerSpread }
  | { kind: 'bestVsAverage'; gain: BestVsAverage }
  // The three the server works out from the stored lap metadata (`GET /sessions/<id>/insights`), with no lap file: in seconds.
  | { kind: 'sectorGain'; sector: number; seconds: number }
  | { kind: 'sectorSpread'; sector: number; seconds: number }
  | { kind: 'consistency'; seconds: number; laps: number };

/** Differences smaller than these are noise at the rate laps are sampled, so they are not mentioned. */
const MIN_BRAKE_M = 3;
const MIN_SPEED_KMH = 1.5;

export function sessionFindingText(finding: SessionFinding, options: { unit?: DistanceUnit } = {}): InsightText {
  const unit = options.unit ?? 'km';
  const name = (suffix: string) => `modes.analysis.session.${suffix}`;
  if (finding.kind === 'sectorGain' || finding.kind === 'sectorSpread') return { key: name(finding.kind), values: { sector: finding.sector, seconds: seconds(finding.seconds) } };
  if (finding.kind === 'consistency') return { key: name('consistency'), values: { seconds: seconds(finding.seconds), laps: finding.laps } };
  if (finding.kind === 'variable') {
    const { spread } = finding;
    const values = { corner: spread.corner, seconds: seconds(spread.timeStdS), laps: spread.laps };
    return spread.brakePointStdM !== null && spread.brakePointStdM >= MIN_BRAKE_M
      ? { key: name('variableBrake'), values: { ...values, distance: distance(spread.brakePointStdM, unit) } }
      : { key: name('variable'), values };
  }
  const { gain } = finding;
  const values = { corner: gain.corner, seconds: seconds(gain.seconds) };
  if (gain.brakePointM !== null && Math.abs(gain.brakePointM) >= MIN_BRAKE_M) {
    return { key: name(gain.brakePointM > 0 ? 'gainBrakeLater' : 'gainBrakeEarlier'), values: { ...values, distance: distance(gain.brakePointM, unit) } };
  }
  if (gain.minSpeedKmh >= MIN_SPEED_KMH) return { key: name('gainSpeed'), values: { ...values, speed: speed(gain.minSpeedKmh, unit) } };
  return { key: name('gain'), values };
}

/** The findings to show after a session: the two that matter, the most variable corner and the biggest gain of the best lap, when they are worth saying. */
export function sessionFindings(result: { mostVariableCorner: CornerSpread | null; biggestGain: BestVsAverage | null }): SessionFinding[] {
  const found: SessionFinding[] = [];
  if (result.mostVariableCorner && result.mostVariableCorner.timeStdS >= 0.03) found.push({ kind: 'variable', spread: result.mostVariableCorner });
  if (result.biggestGain && result.biggestGain.seconds >= 0.03) found.push({ kind: 'bestVsAverage', gain: result.biggestGain });
  return found.slice(0, 2);
}
