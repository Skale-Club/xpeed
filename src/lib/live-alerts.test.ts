import { expect, it } from 'vitest';
import { createLiveAlertMonitor } from './live-alerts';
import { DEFAULT_PRIUS_RULES } from './default-rules';

it('requires continuous sustained evidence, escalates once, and resets after normal readings or a gap', () => {
  const monitor = createLiveAlertMonitor(DEFAULT_PRIUS_RULES.filter(rule => rule.canonical_key === 'coolant_temp'));
  const feed = (at: number, value: number | null) => monitor.observe({coolant_temp:value},at);
  expect(feed(0,110)).toEqual([]);
  expect(feed(10_000,110)).toEqual([]);
  expect(feed(20_000,110)).toEqual([]);
  expect(feed(30_000,110)).toMatchObject([{key:'coolant_temp',severity:'warning',value:110}]);
  expect(feed(40_000,110)).toEqual([]);
  expect(feed(50_000,120)).toEqual([]);
  feed(60_000,120); feed(70_000,120);
  expect(feed(80_000,120)).toMatchObject([{severity:'critical'}]);
  feed(90_000,null); feed(100_000,120); feed(110_000,120);
  expect(feed(140_000,120)).toEqual([]); // missing samples cannot prove 30s overheating
  monitor.reset();
  expect(feed(150_000,120)).toEqual([]);
});
