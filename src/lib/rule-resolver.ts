// Resolves which ruleset to use for a given car.
// Today: matches on make + model_prefix + year range.
// Falls back to generic petrol / hybrid / diesel based on engine_type.
//
// All rulesets are static (bundled in src/lib/default-rules/) for now;
// a future iteration will pull them from the parameter_rules / vehicle_rulesets
// tables seeded in 20260517130000_rule_library.sql.

import { DEFAULT_PRIUS_RULES, type DefaultRule } from '@/lib/default-rules';
import { GENERIC_PETROL_RULES } from '@/lib/default-rules/generic-petrol';
import { GENERIC_HYBRID_RULES } from '@/lib/default-rules/generic-hybrid';
import { GENERIC_DIESEL_RULES } from '@/lib/default-rules/generic-diesel';
import { HONDA_CIVIC_G10_RULES } from '@/lib/default-rules/honda-civic-g10';
import { FORD_F150_RULES } from '@/lib/default-rules/ford-f150';
import { SUBARU_WRX_RULES } from '@/lib/default-rules/subaru-wrx';
import { TESLA_MODEL3_RULES } from '@/lib/default-rules/tesla-model3';
import type { CarProfile } from '@/lib/db';

interface RulesetMatcher {
  id: string;
  matches: (car: CarProfile) => boolean;
  rules: DefaultRule[];
}

// Order matters: most specific first.
const RULESETS: RulesetMatcher[] = [
  {
    id: 'toyota-prius',
    matches: (c) => c.make?.toLowerCase() === 'toyota' && c.model?.toLowerCase().startsWith('prius') === true,
    rules: DEFAULT_PRIUS_RULES,
  },
  {
    id: 'honda-civic-g10',
    matches: (c) => c.make?.toLowerCase() === 'honda'
      && c.model?.toLowerCase().startsWith('civic') === true
      && (c.year == null || (c.year >= 2016 && c.year <= 2021)),
    rules: HONDA_CIVIC_G10_RULES,
  },
  {
    id: 'ford-f150',
    matches: (c) => c.make?.toLowerCase() === 'ford'
      && (c.model?.toLowerCase().includes('f-150') === true || c.model?.toLowerCase().includes('f150') === true),
    rules: FORD_F150_RULES,
  },
  {
    id: 'subaru-wrx',
    matches: (c) => c.make?.toLowerCase() === 'subaru' && c.model?.toLowerCase().includes('wrx') === true,
    rules: SUBARU_WRX_RULES,
  },
  {
    id: 'tesla-model3',
    matches: (c) => c.make?.toLowerCase() === 'tesla' && c.model?.toLowerCase().includes('model 3') === true,
    rules: TESLA_MODEL3_RULES,
  },
];

const ENGINE_FALLBACKS: Record<string, DefaultRule[]> = {
  hybrid: GENERIC_HYBRID_RULES,
  electric: TESLA_MODEL3_RULES, // closest analogue we have
  diesel: GENERIC_DIESEL_RULES,
  petrol: GENERIC_PETROL_RULES,
};

// Bump when thresholds, rule logic, or the set of bundled rulesets change.
// Sessions store this at upload time so future reprocessing can target stale ones.
export const RULES_VERSION = '1.0';

export interface ResolvedRuleset {
  id: string;
  rules: DefaultRule[];
  matched_via: 'make_model' | 'engine_type' | 'default';
}

/**
 * Pick the most appropriate ruleset for a given car profile.
 * Falls back through specific match → engine type → generic petrol.
 */
export function resolveRulesetForCar(car: Partial<CarProfile> | null | undefined): ResolvedRuleset {
  if (car) {
    // Try specific make/model matchers
    for (const r of RULESETS) {
      try {
        if (r.matches(car as CarProfile)) {
          return { id: r.id, rules: r.rules, matched_via: 'make_model' };
        }
      } catch {
        // matcher may throw on missing fields; treat as no match
      }
    }

    // Engine type fallback
    const engine = (car as CarProfile & { engine_type?: string }).engine_type;
    if (engine && ENGINE_FALLBACKS[engine]) {
      return { id: `generic-${engine}`, rules: ENGINE_FALLBACKS[engine], matched_via: 'engine_type' };
    }
  }

  return { id: 'generic-petrol', rules: GENERIC_PETROL_RULES, matched_via: 'default' };
}
