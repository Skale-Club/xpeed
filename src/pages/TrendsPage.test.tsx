import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { chooseOption, selectOptions } from '@/test/select';
import TrendsPage from './TrendsPage';

const db = vi.hoisted(() => ({ getSessions: vi.fn() }));
vi.mock('@/lib/db', () => db);
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCarId: 'car-1', selectedCar: { id: 'car-1', name: 'Prius' } }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ timezone: 'UTC', distanceUnit: 'km', temperatureUnit: 'c' }) }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
}));

const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
const trip = (id: string, key: string, label: string, unit: string) => ({
  id, session_start: recent, uploaded_at: recent, duration_seconds: 600,
  summary: { summaries: [{ canonical_key: key, parameter_key: key, label, unit, avg: 40, min: 10, max: 90, duration_seconds: 600 }] },
});

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function open() {
  db.getSessions.mockResolvedValue([trip('a', 'vehicle_speed', 'Vehicle speed', 'km/h'), trip('b', 'coolant_temperature', 'Coolant temperature', '°C')]);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TrendsPage /></QueryClientProvider>);
  return await screen.findByTestId('trends-filters');
}

describe('the filters of the trends page', () => {
  it('are one wrapping row of three compact drop-downs with the name inside each one, and no card around them', async () => {
    const bar = await open();
    expect(bar).toHaveClass('flex', 'flex-wrap', 'items-center', 'gap-2');
    for (const chrome of ['border', 'bg-card', 'p-3', 'p-4']) expect(bar).not.toHaveClass(chrome);
    const boxes = within(bar).getAllByRole('combobox');
    expect(boxes.map((box) => box.getAttribute('id'))).toEqual(['trends-sensor', 'trends-group', 'trends-range']);
    for (const box of boxes) expect(box).toHaveClass('h-8', 'text-xs', 'focus-visible:ring-1');
    expect(bar.querySelector('label')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'What to compare' })).toHaveTextContent(/^What to compareVehicle speed \(km\/h\)$/);
    expect(screen.getByRole('combobox', { name: 'View by' })).toHaveTextContent(/^View byMonth$/);
    expect(screen.getByRole('combobox', { name: 'History' })).toHaveTextContent(/^History12 months$/);
  });

  it('keep what each one offers and still change the chart', async () => {
    await open();
    expect(selectOptions(screen.getByRole('combobox', { name: 'View by' }))).toEqual(['Month', 'Year']);
    expect(selectOptions(screen.getByRole('combobox', { name: 'History' }))).toEqual(['12 months', '36 months', 'All time']);
    chooseOption(screen.getByRole('combobox', { name: 'What to compare' }), 'Coolant temperature (°C)');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'What to compare' })).toHaveTextContent('Coolant temperature (°C)'));
    expect(screen.getByText(/^Coolant temperature · /)).toBeInTheDocument();
  });
});
