import { expect, it } from 'vitest';
import { defaultLayout } from './live-layout';
it('fills six secondary panels with actual supported sensors, including short term fuel trim', () => {
  const channels = ['Battery voltage (V)', 'Calculated engine load (%)', 'Throttle position (%)', 'Intake air temperature (°C)', 'Long term fuel trim B1 (%)', 'Short term fuel trim B1 (%)', 'Mass air flow (g/s)'];
  const values = defaultLayout(channels).filter((widget) => widget.kind === 'value');
  expect(values).toHaveLength(6);
  expect(values.some((widget) => widget.channel === 'Short term fuel trim B1 (%)')).toBe(true);
  expect(values.every((widget) => channels.includes(widget.channel!))).toBe(true);
});
it('does not create fictitious sensors to fill empty slots', () => {
  expect(defaultLayout(['Battery voltage (V)']).filter((widget) => widget.kind === 'value')).toHaveLength(1);
});
