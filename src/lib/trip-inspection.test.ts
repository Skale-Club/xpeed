import { expect, it } from 'vitest';
import { completeTripInspection, tripCodes } from './trip-inspection';
import { tripProblems, tripDistanceKm } from './trips';
import { tripFuelEstimate } from './fuel-ledger';
import type { Session } from '@/types/session';

it('retains pending-only faults and never interprets a missing or partial read as all clear',()=>{
  const summary={faultCodes:{stored:[],pending:['P0300'],permanent:[],checked:true,complete:false,modules:['7E0']}};
  expect(completeTripInspection({summary})).toBe(false);
  expect(completeTripInspection({summary:null})).toBe(false);
  expect(tripCodes({summary})).toEqual(['P0300']);
  expect(tripProblems([],[],summary)).toMatchObject([{canonical_key:'dtc:P0300',severity:'warning'}]);
  expect(completeTripInspection({summary:{faultCodes:{...summary.faultCodes,pending:[],complete:true}}})).toBe(true);
});
it('does not extrapolate an incomplete speed record into a whole-trip distance or fuel estimate',()=>{
  const session={duration_seconds:3600,summary:{summaries:[{canonical_key:'vehicle_speed',avg:60,duration_seconds:10}]}} as Session;
  expect(tripDistanceKm(session)).toBeNull();
  expect(tripFuelEstimate(session,[]).distance).toBeNull();
  expect(tripDistanceKm({...session,summary:{summaries:[{canonical_key:'vehicle_speed',avg:60}]}})).toBeNull();
});
