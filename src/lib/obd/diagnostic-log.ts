const KEY = 'xpeed.obd.diagnostics';
const LIMIT = 200;
export interface ObdDiagnostic { at: string; event: string; details: Record<string, string | number | boolean | null> }

export function readObdDiagnostics(): ObdDiagnostic[] {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(rows) ? rows.slice(-LIMIT) : [];
  } catch { return []; }
}
/** Local transitions only: no raw telemetry, VIN, account IDs or server writes. */
export function logObdDiagnostic(event: string, details: ObdDiagnostic['details']) {
  try {
    const rows = readObdDiagnostics();
    rows.push({ at: new Date().toISOString(), event, details });
    localStorage.setItem(KEY, JSON.stringify(rows.slice(-LIMIT)));
  } catch { /* Diagnostics must never interrupt a recording. */ }
}
