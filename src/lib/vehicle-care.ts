import { tripDayKey } from './trip-history';
export const KM_PER_MILE = 1.609344;
export interface VehicleCare {
  odometerKm: number | null;
  odometerAt: string | null;
  oilDueKm: number | null;
  oilDueDate: string | null;
  warnBeforeKm: number;
  warnBeforeDays: number;
  enabled: boolean;
  oilPlanAt: string | null;
}
export interface OilService {
  id: string; performed_at: string; odometer_km: number | null; created_at: string;
}
export interface VehicleCareRecord { state: VehicleCare; revision: string | null; lastOil: OilService | null }
export const EMPTY_VEHICLE_CARE: VehicleCare = { odometerKm: null, odometerAt: null, oilDueKm: null, oilDueDate: null, warnBeforeKm: 0, warnBeforeDays: 14, enabled: true, oilPlanAt: null };
export function validCare(value: unknown): value is VehicleCare {
  const item = value as VehicleCare;
  const distance = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000_000);
  const timestamp = (v: unknown) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
  return !!item && typeof item === 'object' && distance(item.odometerKm) && distance(item.oilDueKm)
    && (item.oilDueDate === null || (typeof item.oilDueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.oilDueDate) && Number.isFinite(Date.parse(item.oilDueDate)) && new Date(item.oilDueDate).toISOString().slice(0, 10) === item.oilDueDate))
    && typeof item.warnBeforeKm === 'number' && distance(item.warnBeforeKm)
    && Number.isInteger(item.warnBeforeDays) && item.warnBeforeDays >= 0 && item.warnBeforeDays <= 365
    && typeof item.enabled === 'boolean' && timestamp(item.odometerAt) && timestamp(item.oilPlanAt);
}
export function oilPlanCompleted(record: VehicleCareRecord, timezone?: string): boolean {
  const { lastOil, state } = record;
  return !!(lastOil && state.oilPlanAt && Date.parse(lastOil.created_at) > Date.parse(state.oilPlanAt) && lastOil.performed_at >= tripDayKey(new Date(state.oilPlanAt), timezone));
}
export interface OilReminder { status: 'due' | 'soon'; dueKm: number | null; dueDate: string | null; odometerKm: number | null }
/** Uses the owner's recorded odometer and calendar date, never inferred OBD mileage. */
export function oilReminder(record: VehicleCareRecord, today: string, timezone?: string): OilReminder | null {
  const state = record.state;
  if (!state.enabled || oilPlanCompleted(record, timezone)) return null;
  const kmLeft = state.oilDueKm !== null && state.odometerKm !== null ? state.oilDueKm - state.odometerKm : null;
  const daysLeft = state.oilDueDate ? Math.round((Date.parse(state.oilDueDate) - Date.parse(today)) / 86400000) : null;
  const due = (kmLeft !== null && kmLeft <= 0) || (daysLeft !== null && daysLeft <= 0);
  const soon = (kmLeft !== null && kmLeft <= state.warnBeforeKm) || (daysLeft !== null && daysLeft <= state.warnBeforeDays);
  return due || soon ? { status: due ? 'due' : 'soon', dueKm: state.oilDueKm, dueDate: state.oilDueDate, odometerKm: state.odometerKm } : null;
}
