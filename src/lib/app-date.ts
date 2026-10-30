import { readPreference } from './preferences';
/** Read only the display preference: stored instants and civil service dates never change. */
export function preferredTimeZone(): string | undefined {
  try {
    const zone = readPreference('timezone') || undefined;
    if (zone) new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    return zone;
  } catch { return undefined; }
}

export function formatAppDate(date: Date, language: string | undefined, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(language, { ...options, timeZone: preferredTimeZone() }).format(date);
}

export function appHour(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: preferredTimeZone() }).format(date));
}

/** Civil date/time inputs follow the chosen app zone, independently of the device. */
export function zonedDateTimeInput(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (key: string) => parts.find(value => value.type === key)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** Reject nonexistent DST times; for a repeated hour use its earlier occurrence. */
export function parseZonedDateTime(input: string, timezone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return null;
  const civil = Date.parse(`${input}Z`);
  if (!Number.isFinite(civil)) return null;
  const matches: number[] = [];
  for (const hours of [-24, 0, 24]) {
    const probe = civil + hours * 3600000;
    const wall = Date.parse(`${zonedDateTimeInput(new Date(probe), timezone)}Z`);
    const instant = civil - (wall - Math.floor(probe / 60000) * 60000);
    if (zonedDateTimeInput(new Date(instant), timezone) === input) matches.push(instant);
  }
  return matches.length ? new Date(Math.min(...matches)) : null;
}
