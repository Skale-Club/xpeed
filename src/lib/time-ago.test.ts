import { describe, it, expect } from 'vitest';
import { timeAgo } from './time-ago';

const NOW = new Date('2026-10-28T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('timeAgo', () => {
  it('says how long ago, in plain words', () => {
    expect(timeAgo(ago(10 * 1000), 'en', NOW)).toBe('now');
    expect(timeAgo(ago(5 * MIN), 'en', NOW)).toBe('5 minutes ago');
    expect(timeAgo(ago(3 * 60 * MIN), 'en', NOW)).toBe('3 hours ago');
    expect(timeAgo(ago(1 * DAY + MIN), 'en', NOW)).toBe('yesterday');
    expect(timeAgo(ago(12 * DAY), 'en', NOW)).toBe('12 days ago');
    expect(timeAgo(ago(40 * DAY), 'en', NOW)).toBe('1 month ago');
    expect(timeAgo(ago(65 * DAY), 'en', NOW)).toBe('2 months ago');
    expect(timeAgo(ago(370 * DAY), 'en', NOW)).toBe('1 year ago');
    expect(timeAgo(ago(800 * DAY), 'en', NOW)).toBe('2 years ago');
  });

  it('speaks the app language', () => {
    expect(timeAgo(ago(3 * DAY), 'pt-BR', NOW)).toBe('há 3 dias');
    expect(timeAgo(ago(3 * DAY), 'es-ES', NOW)).toBe('hace 3 días');
  });

  it('never says "in the future" when clocks disagree', () => {
    expect(timeAgo(new Date(NOW + 5 * MIN).toISOString(), 'en', NOW)).toBe('now');
  });
});
