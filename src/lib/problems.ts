// Plain-language view of a vehicle problem (a vehicle_issues row): what to
// call it, what it means, what the owner should do, and how urgent it is.
// The technical key/code stays available for the mechanic, but out of the way.

import type { TFunction } from 'i18next';
import { lookupDtc, type DtcInfo } from '@/lib/dtc-codes';
import type { IssueSeverity, VehicleIssue } from '@/lib/db-issues';

/** Problems coming from the car's own fault codes use keys like "dtc:P0420". */
export const DTC_PREFIX = 'dtc:';
/** Title of a fault-code problem the car has only seen once (pending, not confirmed). */
export const PENDING_SUFFIX = ' (pending)';
/** resolved_note of a fault-code problem closed because the car stopped reporting the code. */
export const CODE_GONE_NOTE = 'auto:code-gone';

export type Urgency = 'urgent' | 'soon' | 'watch' | 'later';

export const URGENCY: Record<IssueSeverity, Urgency> = {
  critical: 'urgent',
  serious: 'soon',
  warning: 'watch',
  easy_fix: 'later',
};

export const URGENCY_ORDER: Urgency[] = ['urgent', 'soon', 'watch', 'later'];

/** Fault-code severity → problem severity. */
export function dtcSeverity(code: string): IssueSeverity {
  const info = lookupDtc(code);
  return info?.severity === 'severe' ? 'critical' : info?.severity === 'minor' ? 'warning' : 'serious';
}

// canonical_key → catalog entry. Fuel trims share one explanation.
const CATALOG_KEY: Record<string, string> = {
  coolant_temp: 'coolant_temp',
  engine_rpm: 'engine_rpm',
  battery_voltage_12v: 'battery_voltage_12v',
  intake_air_temp: 'intake_air_temp',
  stft_b1: 'fuel_trim',
  ltft_b1: 'fuel_trim',
  engine_load: 'engine_load',
  oil_temp: 'oil_temp',
  transmission_temp: 'transmission_temp',
  motor_temp_front: 'motor_temp',
  motor_temp_rear: 'motor_temp',
  battery_voltage_hv: 'hv_battery',
  battery_pack_temp: 'hv_battery_temp',
  hybrid_battery_soc: 'hv_battery',
  inverter_temp: 'inverter_temp',
  catalyst_temp: 'catalyst_temp',
};

// English defaults; translations live under problems.catalog.* in src/locales.
const DEFAULTS: Record<string, { title: string; meaning: string; action: string }> = {
  coolant_temp: {
    title: 'Engine running hot',
    meaning: 'The engine temperature stayed above normal for a while.',
    action: 'Check the coolant level with the engine cold. If the temperature gauge climbs again, pull over safely and see a mechanic.',
  },
  engine_rpm: {
    title: 'Engine revving very high',
    meaning: 'The engine spun close to its limit for a long time.',
    action: "Avoid revving hard, especially with a cold engine or in a low gear. If it wasn't you, have it checked.",
  },
  battery_voltage_12v: {
    title: 'Weak 12 V battery',
    meaning: "The small 12 V battery's voltage went outside the normal range.",
    action: 'Ask for a battery and charging-system test at your next service, or sooner if the car is slow to start.',
  },
  intake_air_temp: {
    title: 'Hot air going into the engine',
    meaning: 'The air the engine breathes was hotter than normal.',
    action: 'Check the air filter and that nothing blocks the air intake.',
  },
  fuel_trim: {
    title: 'Fuel mixture out of balance',
    meaning: 'The engine is correcting its air–fuel mix more than usual.',
    action: "Often an air leak, a dirty sensor or injectors. Book a check-up; it's not urgent if the car drives fine.",
  },
  engine_load: {
    title: 'Engine working very hard',
    meaning: 'The engine ran near full effort for a long time.',
    action: 'Normal on steep hills or with a heavy load. If it happens on regular drives, have it checked.',
  },
  oil_temp: {
    title: 'Engine oil running hot',
    meaning: 'The engine oil got hotter than normal.',
    action: 'Check the oil level and when it was last changed.',
  },
  transmission_temp: {
    title: 'Gearbox running hot',
    meaning: 'The transmission fluid got hotter than normal.',
    action: 'Avoid towing or heavy loads and have the transmission fluid checked.',
  },
  motor_temp: {
    title: 'Electric motor running hot',
    meaning: 'An electric drive motor got hotter than normal.',
    action: 'Drive gently and have the cooling system checked by a specialist.',
  },
  hv_battery: {
    title: 'Hybrid battery outside its normal range',
    meaning: "The high-voltage battery's charge or voltage went outside the usual range.",
    action: 'If it keeps happening, have the hybrid battery checked by a hybrid specialist.',
  },
  hv_battery_temp: {
    title: 'Hybrid battery running hot',
    meaning: 'The high-voltage battery got hotter than normal.',
    action: 'Check that the battery cooling vent (usually near the rear seat) is not blocked or dirty.',
  },
  inverter_temp: {
    title: 'Hybrid system running hot',
    meaning: "The hybrid system's inverter got hotter than normal.",
    action: 'Check the inverter coolant level and have the hybrid cooling pump checked.',
  },
  catalyst_temp: {
    title: 'Catalytic converter very hot',
    meaning: 'The exhaust catalytic converter got hotter than normal.',
    action: 'This can come from misfires or a rich mixture. Book a check-up.',
  },
};

const DTC_AREA_DEFAULT: Record<DtcInfo['category'], string> = {
  powertrain: 'engine or gearbox',
  chassis: 'brakes, suspension or steering',
  body: 'body and comfort systems',
  network: 'communication between modules',
};

const DTC_ACTION_DEFAULT: Record<DtcInfo['severity'], string> = {
  severe: 'See a mechanic as soon as possible and show them this code.',
  moderate: 'Book a check-up and show the mechanic this code.',
  minor: 'It can wait for your next service; mention this code.',
};

export interface ProblemText {
  title: string;
  meaning: string;
  action: string;
  /** Code to show the mechanic (fault code or internal key). */
  code: string;
  /** Extra technical description, for the mechanic. */
  technical: string | null;
}

export function describeProblem(issue: Pick<VehicleIssue, 'canonical_key' | 'title'>, t: TFunction): ProblemText {
  const key = issue.canonical_key;

  if (key.startsWith(DTC_PREFIX)) {
    const code = key.slice(DTC_PREFIX.length);
    const info = lookupDtc(code);
    const category = info?.category ?? 'powertrain';
    const severity = info?.severity ?? 'moderate';
    const area = t(`problems.dtc.area.${category}`, DTC_AREA_DEFAULT[category]);
    if (issue.title?.endsWith(PENDING_SUFFIX)) {
      // Seen once, not confirmed: say so, and don't alarm.
      return {
        title: t('problems.dtc.pendingTitle', 'Possible fault {{code}} ({{area}})', { code, area }),
        meaning: t('problems.dtc.pendingMeaning', "The car's computer noticed a possible fault in the {{area}} once and is checking whether it happens again.", { area }),
        action: t('problems.dtc.pendingAction', "No need to rush. If the car confirms it, it shows here as a fault code with what to do; if not, it goes away by itself."),
        code,
        technical: info && !info.name.startsWith('Unknown') ? `${info.name} (pending)` : null,
      };
    }
    return {
      title: t('problems.dtc.titleCode', 'Fault code {{code}} ({{area}})', {
        code,
        area: t(`problems.dtc.area.${category}`, DTC_AREA_DEFAULT[category]),
      }),
      meaning: t('problems.dtc.meaning', "The car's computer recorded a fault in the {{area}}.", {
        area: t(`problems.dtc.area.${category}`, DTC_AREA_DEFAULT[category]),
      }),
      action: t(`problems.dtc.action.${severity}`, DTC_ACTION_DEFAULT[severity]),
      code,
      technical: info && !info.name.startsWith('Unknown') ? info.name : null,
    };
  }

  const entry = CATALOG_KEY[key];
  if (entry) {
    const d = DEFAULTS[entry];
    return {
      title: t(`problems.catalog.${entry}.title`, d.title),
      meaning: t(`problems.catalog.${entry}.meaning`, d.meaning),
      action: t(`problems.catalog.${entry}.action`, d.action),
      code: key,
      technical: issue.title,
    };
  }

  return {
    title: issue.title,
    meaning: t('problems.generic.meaning', 'A reading was outside its normal range during a trip.'),
    action: t('problems.generic.action', 'Keep an eye on it; if it keeps happening, mention it at your next service.'),
    code: key,
    technical: null,
  };
}

/** Problems that still need the owner's attention. */
export function isOpenProblem(issue: Pick<VehicleIssue, 'status'>): boolean {
  return issue.status === 'active' || issue.status === 'recurred';
}
