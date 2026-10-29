/** Read only the display preference: stored instants and civil service dates never change. */
export function preferredTimeZone(): string | undefined {
  try {
    const zone = localStorage.getItem('settings_timezone') || undefined;
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
