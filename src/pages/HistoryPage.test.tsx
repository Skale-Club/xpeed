import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import HistoryPage from './HistoryPage';

const db = vi.hoisted(() => ({
  getSessions: vi.fn(),
  getFlagsForSessions: vi.fn(),
  updateSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db', () => db);
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ selectedCar: { id: 'car-1', name: 'Prius' }, selectedCarId: 'car-1' }),
}));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'km', timezone: 'UTC' }) }));

const TRIPS = [
  {
    id: 'old', source_filename: 'xpeed-scan_2026-10-20 08-00-00.csv', session_start: '2026-10-20T08:00:00Z', uploaded_at: '2026-10-20T09:00:00Z',
    duration_seconds: 600, summary: { summaries: [{ canonical_key: 'vehicle_speed', avg: 30 }] }, active_dtcs: [],
  },
  {
    id: 'new', source_filename: 'Ida pra praia', session_start: '2026-10-27T10:00:00Z', uploaded_at: '2026-10-27T12:00:00Z',
    duration_seconds: 3900, summary: { summaries: [{ canonical_key: 'vehicle_speed', avg: 60 }] }, active_dtcs: ['P0420'],
  },
];

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HistoryPage', () => {
  it('shows an empty state that leads to starting a trip', async () => {
    db.getSessions.mockResolvedValueOnce([]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    expect(await screen.findByText('No trips yet')).toBeInTheDocument();
    expect(db.getFlagsForSessions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /start trip/i })).toBeInTheDocument();
  });

  it('lists trips newest first with plain facts and problem counts', async () => {
    db.getSessions.mockResolvedValueOnce(TRIPS);
    db.getFlagsForSessions.mockResolvedValueOnce([
      { session_id: 'new', canonical_key: 'coolant_temp', severity: 'critical', message: 'hot' },
    ]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    const rows = await screen.findAllByTestId('trip-row');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]).getByText('Ida pra praia')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/1 h 05 min · 65 km/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('2 problems')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/session/new');

    expect(within(rows[1]).getByText(/ trip$/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('All good')).toBeInTheDocument();
    // No file names or row counts
    expect(screen.queryByText(/\.csv/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rows/)).not.toBeInTheDocument();
  });

  it('renames and deletes with visible buttons', async () => {
    db.getSessions.mockResolvedValueOnce(TRIPS);
    db.getFlagsForSessions.mockResolvedValueOnce([]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    const rows = await screen.findAllByTestId('trip-row');

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Rename' }));
    fireEvent.change(await screen.findByLabelText('Trip name'), { target: { value: 'Trabalho' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.updateSession).toHaveBeenCalledWith('old', { source_filename: 'Trabalho' }));
    expect(await screen.findByText('Trabalho')).toBeInTheDocument();

    fireEvent.click(within(screen.getAllByTestId('trip-row')[0]).getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(db.deleteSession).toHaveBeenCalledWith('new'));
    await waitFor(() => expect(screen.getAllByTestId('trip-row')).toHaveLength(1));
  });
});

describe('HistoryPage paging', () => {
  it('shows 50 trips at a time and fetches problems only for the trips on screen', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `t${i}`, source_filename: 'Trip', session_start: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      uploaded_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), duration_seconds: 600, summary: null, active_dtcs: [],
    }));
    db.getSessions.mockResolvedValueOnce(many);
    db.getFlagsForSessions.mockResolvedValue([]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);

    expect(await screen.findAllByTestId('trip-row')).toHaveLength(50);
    expect(db.getFlagsForSessions).toHaveBeenCalledTimes(1);
    expect(db.getFlagsForSessions.mock.calls[0][0]).toHaveLength(50);

    fireEvent.click(screen.getByRole('button', { name: 'Show older trips' }));
    await waitFor(() => expect(screen.getAllByTestId('trip-row')).toHaveLength(100));
    expect(db.getFlagsForSessions).toHaveBeenCalledTimes(2);
    // Every request stays small, however many trips there are
    for (const [ids] of db.getFlagsForSessions.mock.calls) expect(ids.length).toBeLessThanOrEqual(50);

    fireEvent.click(screen.getByRole('button', { name: 'Show older trips' }));
    await waitFor(() => expect(screen.getAllByTestId('trip-row')).toHaveLength(120));
    expect(screen.queryByRole('button', { name: 'Show older trips' })).not.toBeInTheDocument();
    db.getFlagsForSessions.mockReset();
  }, 30000);
});
