import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { ParameterChart } from './SessionCharts';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) => <div><output>{JSON.stringify(data)}</output>{children}</div>,
  ReferenceLine: ({ y }: { y: number }) => <span data-testid="limit">{y}</span>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));
afterEach(() => { cleanup(); localStorage.clear(); });
it('converts historical values and warning limits together without modifying the saved trip', () => {
  localStorage.setItem('settings_temperatureUnit', 'F');
  const rows = [{ t_seconds: 0, data: { coolant: 100 } }];
  render(<SettingsProvider><ParameterChart rows={rows} parameterKey="coolant" canonicalKey="coolant_temp" label="Coolant" unit="°C" warnMax={110} criticalMax={120} /></SettingsProvider>);
  expect(screen.getByText('(°F)')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('212');
  expect(screen.getAllByTestId('limit').map((item) => item.textContent)).toEqual(['230', '248']);
  expect(rows[0].data.coolant).toBe(100);
});
