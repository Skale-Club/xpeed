import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import HistoryPage from './HistoryPage';

const obd = vi.hoisted(() => ({ recording: null as null | { active: boolean; startedAt: Date; manual: boolean }, recordingCarId: 'car-1', status: 'live', lastTrip: null as null | { sessionId: string }, savingTrip: false }));
vi.mock('@/contexts/ObdScannerContext', () => ({ useObd: () => obd }));
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
const settings = vi.hoisted(() => ({ distanceUnit: 'km', timezone: 'UTC' }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => settings }));
const selectView = (name: 'List' | 'Calendar') => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

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
  obd.recording = null; obd.recordingCarId = 'car-1'; obd.lastTrip = null; obd.savingTrip = false;
  settings.timezone = 'UTC';
});

describe('HistoryPage', () => {
  it('pins the active trip and marks its calendar day red even without completed trips', async () => {
    obd.recording = { active: true, startedAt: new Date(), manual: false };
    db.getSessions.mockResolvedValueOnce([]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    const active = screen.getByTestId('active-trip');
    expect(within(active).getByText('Recording trip')).toBeInTheDocument();
    expect(within(active).getByRole('link')).toHaveAttribute('href', '/live');
    selectView('Calendar');
    const day = screen.getByRole('button', { name: /Recording trip/ });
    expect(day).toHaveClass('text-destructive');
    fireEvent.click(day);
    expect(day).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Completed trips will appear here after saving.')).toBeInTheDocument();
    expect(screen.queryByText('No trips yet')).not.toBeInTheDocument();
  });

  it('does not put another car’s recording into the selected car’s history', async () => {
    obd.recording = { active: true, startedAt: new Date(), manual: false };
    obd.recordingCarId = 'other-car';
    db.getSessions.mockResolvedValueOnce([]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    expect(await screen.findByText('No trips yet')).toBeInTheDocument();
    expect(screen.queryByTestId('active-trip')).not.toBeInTheDocument();
  });

  it('replaces the live entry with the completed trip when saving finishes', async () => {
    obd.recording = { active: true, startedAt: new Date(), manual: false };
    db.getSessions.mockResolvedValueOnce([]).mockResolvedValueOnce([TRIPS[1]]);
    db.getFlagsForSessions.mockResolvedValue([]);
    const view = render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    await screen.findByText('Completed trips will appear here after saving.');
    obd.recording = null;
    obd.lastTrip = { sessionId: 'new' };
    view.rerender(<MemoryRouter><HistoryPage /></MemoryRouter>);
    expect(await screen.findByText('Ida pra praia')).toBeInTheDocument();
    expect(screen.queryByTestId('active-trip')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('trip-row')).toHaveLength(1);
  });
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

describe('HistoryPage calendar and paging', () => {
  it('keeps only 20 trips on screen and allows jumping directly to the oldest page', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `t${i}`, source_filename: `Journey ${i}`, session_start: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      uploaded_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), duration_seconds: 600, summary: null, active_dtcs: [],
    }));
    db.getSessions.mockResolvedValueOnce(many);
    db.getFlagsForSessions.mockResolvedValue([]);
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    expect(await screen.findAllByTestId('trip-row')).toHaveLength(20);
    expect(screen.getByText('Journey 299')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Page' }), { target: { value: '15' } });
    await waitFor(() => expect(screen.getByText('Journey 0')).toBeInTheDocument());
    expect(screen.getAllByTestId('trip-row')).toHaveLength(20);
    await waitFor(() => expect(db.getFlagsForSessions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.queryByText('Journey 0')).not.toBeInTheDocument();
    for (const [ids] of db.getFlagsForSessions.mock.calls) expect(ids.length).toBeLessThanOrEqual(20);
    selectView('Calendar');
    selectView('List');
    expect(screen.getByText('Journey 299')).toBeInTheDocument();
    expect(screen.getAllByTestId('trip-row')).toHaveLength(20);
  });
  it('starts in List without filters or a calendar, and switches to trips for the selected day', async () => {
    db.getSessions.mockResolvedValueOnce(TRIPS);
    db.getFlagsForSessions.mockResolvedValue([]);
    render(<MemoryRouter initialEntries={['/history?view=list&month=2026-10&day=2026-10-27&q=missing']}><HistoryPage /></MemoryRouter>);
    await screen.findAllByTestId('trip-row');
    expect(screen.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Trip calendar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Month')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Calendar date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search trip names')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    selectView('Calendar');
    fireEvent.click(screen.getByRole('button', { name: /Tuesday, October 20, 2026/ }));
    expect(screen.getAllByTestId('trip-row')).toHaveLength(1);
    expect(screen.queryByText('Ida pra praia')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tuesday, October 20, 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tuesday, October 20, 2026/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Tuesday, October 27, 2026/ }));
    expect(screen.getByText('Ida pra praia')).toBeInTheDocument();
    expect(screen.getAllByTestId('trip-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('No trips on this day.')).toBeInTheDocument();
    expect(screen.queryByTestId('trip-row')).not.toBeInTheDocument();
    selectView('List');
    expect(screen.getAllByTestId('trip-row')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Trip calendar' })).not.toBeInTheDocument();
  });
  it('restores a calendar filter from the URL', async () => {
    db.getSessions.mockResolvedValueOnce(TRIPS);
    db.getFlagsForSessions.mockResolvedValue([]);
    render(<MemoryRouter initialEntries={['/history?month=2026-10&day=2026-10-27']}><HistoryPage /></MemoryRouter>);
    expect(await screen.findAllByTestId('trip-row')).toHaveLength(1);
    expect(screen.getByText('Ida pra praia')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Calendar' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /Tuesday, October 27, 2026/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('shows the selected day in the chosen timezone, including trips near midnight', async () => {
    settings.timezone = 'America/New_York';
    db.getSessions.mockResolvedValueOnce([{ ...TRIPS.find((trip) => trip.id === 'new'), session_start: '2026-11-01T01:00:00Z' }]);
    db.getFlagsForSessions.mockResolvedValue([]);
    render(<MemoryRouter initialEntries={['/history?view=calendar&day=2026-10-31']}><HistoryPage /></MemoryRouter>);
    expect(await screen.findByText('Ida pra praia')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('No trips on this day.')).toBeInTheDocument();
    selectView('List');
    expect(screen.getByRole('heading', { name: 'Saturday, Oct 31' })).toBeInTheDocument();
  });
  it('keeps the recording on its own day when browsing older calendar dates', async () => {
    obd.recording = { active: true, startedAt: new Date('2026-10-29T10:00:00Z'), manual: false };
    db.getSessions.mockResolvedValueOnce(TRIPS);
    db.getFlagsForSessions.mockResolvedValue([]);
    render(<MemoryRouter initialEntries={['/history?view=calendar&day=2026-10-20']}><HistoryPage /></MemoryRouter>);
    await screen.findByTestId('trip-row');
    expect(screen.queryByTestId('active-trip')).not.toBeInTheDocument();
    selectView('List');
    expect(screen.getByTestId('active-trip')).toBeInTheDocument();
    expect(screen.getAllByTestId('trip-row')).toHaveLength(2);
  });
});
