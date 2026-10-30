import type { FaultInspection } from '@/hooks/use-obd-scanner';

export interface SavedFaultInspection {
  inspection: FaultInspection;
  profileVin: string | null;
  /** Also true until the Problems update has finished successfully. */
  syncFailed: boolean;
}

export function faultInspectionScope(userId: string | null | undefined, carId: string | null): string | null {
  return userId && carId ? `xpeed.fault-inspection.v1:${encodeURIComponent(userId)}:${encodeURIComponent(carId)}` : null;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
function valid(value: unknown): value is SavedFaultInspection {
  if (!object(value) || typeof value.syncFailed !== 'boolean' || !(value.profileVin === null || typeof value.profileVin === 'string')) return false;
  const scan = value.inspection;
  if (!object(scan) || typeof scan.at !== 'string' || !Number.isFinite(Date.parse(scan.at)) || !(scan.vin === null || typeof scan.vin === 'string')) return false;
  const readout = scan.readout;
  return object(readout) && strings(readout.stored) && strings(readout.pending) && strings(readout.permanent)
    && typeof readout.checked === 'boolean' && (readout.complete === undefined || typeof readout.complete === 'boolean')
    && (readout.modules === undefined || strings(readout.modules))
    && (readout.codeModules === undefined || (object(readout.codeModules) && Object.values(readout.codeModules).every(strings)));
}

/** A device copy of the actual readout, never a reason to contact the adapter. */
export function loadFaultInspection(userId: string | null | undefined, carId: string | null, profileVin: string | null): SavedFaultInspection | null {
  const key = faultInspectionScope(userId, carId);
  if (!key) return null;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!valid(value)) return null;
    // A VIN added to the profile may confirm an earlier read; a different VIN must not reuse it.
    if (value.profileVin !== profileVin && !(profileVin && value.inspection.vin === profileVin)) return null;
    if (profileVin && value.inspection.vin && profileVin !== value.inspection.vin) return null;
    return value;
  } catch { return null; }
}

export function saveFaultInspection(userId: string | null | undefined, carId: string | null, record: SavedFaultInspection): boolean {
  const key = faultInspectionScope(userId, carId);
  if (!key || !valid(record) || (record.profileVin && record.inspection.vin && record.profileVin !== record.inspection.vin)) return false;
  try { localStorage.setItem(key, JSON.stringify(record)); return true; }
  catch { return false; }
}
