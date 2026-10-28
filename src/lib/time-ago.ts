/**
 * "3 days ago", "yesterday", "2 hours ago"… in the given language, for how
 * long ago something happened. Future times (clock skew) read as "now".
 */
export function timeAgo(iso: string, language?: string, now: number = Date.now()): string {
  // "auto" gives "yesterday" for 1 day, but "last month" for anything 30-59 days back,
  // which reads vaguer than it is; months and years always count.
  const rtf = new Intl.RelativeTimeFormat(language || undefined, { numeric: 'auto' });
  const count = new Intl.RelativeTimeFormat(language || undefined, { numeric: 'always' });
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return rtf.format(0, 'second');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  const months = Math.floor(days / 30.44);
  if (months < 12) return count.format(-Math.max(1, months), 'month');
  return count.format(-Math.max(1, Math.floor(days / 365.25)), 'year');
}
