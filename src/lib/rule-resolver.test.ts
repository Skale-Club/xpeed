import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { resolveRulesetForCar } from './rule-resolver';
import { sessionProcessingPayload } from './session-processing';
import type { CarProfile } from './db';
import type { Session } from '@/types/session';

const seed = readFileSync('supabase/migrations/20260517130000_rule_library.sql', 'utf8');
const registered = new Set([...seed.matchAll(/\('([a-z0-9-]+)', '/g)].map(match => match[1]));
const cases = [
  [{ make: 'Toyota', model: 'Prius', year: 2010 }, 'toyota-prius-g3'],
  [{ make: 'Toyota', model: 'Prius', year: 2018 }, 'toyota-prius-g4'],
  [{ make: 'Toyota', model: 'Prius', year: 2025 }, 'generic-hybrid'],
  [{ make: 'Honda', model: 'Civic', year: 2018 }, 'honda-civic-g10'],
  [{ make: 'Ford', model: 'F-150', year: 2017 }, 'ford-f150-13gen'],
  [{ make: 'Subaru', model: 'WRX', year: 2018 }, 'subaru-wrx-vab'],
  [{ make: 'Tesla', model: 'Model 3' }, 'tesla-model3'],
  ...['petrol', 'diesel', 'hybrid', 'electric', 'flex', 'unknown'].map(engine_type => [{ engine_type }, null]),
  [null, 'generic-petrol'],
] as [Partial<CarProfile> | null, string | null][];

it.each(cases)('uses a registered database ruleset for %j', (car, expected) => {
  const result = resolveRulesetForCar(car);
  expect(registered.has(result.id)).toBe(true);
  if (expected) expect(result.id).toBe(expected);
  expect(result.rules.length).toBeGreaterThan(0);
});

it('recovery of a Prius 2010 produces the same valid foreign key as direct ingestion', () => {
  const payload = sessionProcessingPayload({ id: 'trip', source_filename: 'trip.csv', session_start: '2026-10-29T20:00:00Z' } as Session,
    { make: 'Toyota', model: 'Prius', year: 2010, engine_type: 'hybrid' } as CarProfile,
    'Time (s),Vehicle speed (km/h),Engine RPM (rpm)\n0,25,1000\n90,30,1400');
  expect(payload.ruleset_id).toBe('toyota-prius-g3');
  expect(registered.has(payload.ruleset_id)).toBe(true);
  expect(payload.row_count).toBe(2);
});
