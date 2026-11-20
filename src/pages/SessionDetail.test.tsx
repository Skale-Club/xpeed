import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import SessionDetail from './SessionDetail';
import { Toaster } from '@/components/ui/toaster';

const db = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionFlags: vi.fn(async () => []),
  getSessionRows: vi.fn(async () => []),
  getCarById: vi.fn(async () => ({ id: 'car-1', make: 'Toyota', model: 'Prius', year: 2010, engine_type: 'hybrid' })),
  replaceSessionFlags: vi.fn(async () => undefined),
  downloadSessionCSV: vi.fn(),
}));
const extras = vi.hoisted(() => ({
  createSharedReport: vi.fn(async () => ({ id: 'rep-1' })),
  listSharedReports: vi.fn(async () => [] as unknown[]),
  revokeSharedReport: vi.fn(async () => undefined),
  listSessionPhotos: vi.fn(async () => [{ id: 'photo-1' }]),
  includeSharedMedia: vi.fn(async () => undefined),
}));
const fuel = vi.hoisted(() => ({ listFuelEntries: vi.fn(async () => [] as unknown[]) }));
vi.mock('@/lib/db', () => db);
vi.mock('@/lib/fuel-api', async (load) => ({ ...(await load<typeof import('@/lib/fuel-api')>()), listFuelEntries: fuel.listFuelEntries }));
vi.mock('@/lib/db-extras', () => extras);
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/PhotoUpload', () => ({ default: () => null }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'km', volumeUnit:'L',consumptionUnit:'km/L',currency:'USD',timezone:'UTC' }) }));

const TRIP = {
  id: 't1', car_profile_id: 'car-1', source_filename: 'xpeed-scan_2026-10-28 15-30-00.csv', session_start: '2026-10-28T15:30:00Z',
  uploaded_at: '2026-10-28T16:00:00Z', duration_seconds: 1800, row_count: 900,
  summary: { faultCodes:{stored:[],pending:[],checked:true,complete:true},summaries: [{ canonical_key: 'vehicle_speed', avg: 40, duration_seconds:1800 }] },
  gemini_analysis: { summary: 'Engine warmed up normally; fuel trims were a bit lean.' },
  active_dtcs: ['P0420'],
};

const renderTrip = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/session/t1']}>
      <Routes><Route path="/session/:id" element={<SessionDetail />} /></Routes>
      <Toaster />
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SessionDetail', () => {
  it('leads with a summary and the problems in plain language', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    db.getSessionFlags.mockResolvedValueOnce([{ canonical_key: 'coolant_temp', severity: 'critical', message: 'Coolant critical' }] as never);
    renderTrip();

    expect(await screen.findByRole('heading', { level: 2, name: / trip$/ })).toBeInTheDocument();
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('20 km')).toBeInTheDocument();
    expect(screen.getByText(/fuel trims were a bit lean/)).toBeInTheDocument();

    const problems = screen.getAllByTestId('trip-problem');
    expect(problems).toHaveLength(2);
    expect(screen.getByText('Engine running hot')).toBeInTheDocument();
    expect(screen.getByText(/^Fault code P/)).toBeInTheDocument();
    // Technical bits stay hidden until asked for
    expect(screen.queryByText('Download CSV')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /technical details/i }));
    expect(screen.getByText('Download CSV')).toBeInTheDocument();
    // Re-evaluation and charts use the car's own rules, not the Prius defaults
    expect(db.getCarById).toHaveBeenCalledWith('car-1');
  });

  it('says so when the trip had no problems', async () => {
    db.getSession.mockResolvedValueOnce({ ...TRIP, active_dtcs: [] });
    renderTrip();
    expect(await screen.findByText('Nothing wrong was found on this trip.')).toBeInTheDocument();
  });

  it('creates a report link for the mechanic', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderTrip();
    fireEvent.click(await screen.findByRole('button', { name: /send to the mechanic/i }));
    // The owner is told the link is public and shows the VIN before it exists
    expect(await screen.findByText(/anyone who has the link/i)).toBeInTheDocument();
    expect(screen.getByText(/VIN/)).toBeInTheDocument();
    expect(extras.createSharedReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/rep-1`));
    expect(extras.createSharedReport).toHaveBeenCalledWith('t1', 30);
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('lists the links made for the trip and turns one off', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    extras.listSharedReports.mockResolvedValueOnce([
      { id: 'rep-9', session_id: 't1', user_id: 'u1', expires_at: null, view_count: 3, created_at: '2026-10-20T10:00:00Z' },
    ]);
    renderTrip();
    const links = await screen.findByTestId('shared-links');
    expect(links).toHaveTextContent('opened 3 times');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(extras.revokeSharedReport).toHaveBeenCalledWith('rep-9'));
    expect(await screen.findByText('Link turned off')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-links')).not.toBeInTheDocument();
  });

  it('includes only the current attachments when the owner opts in', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderTrip();
    fireEvent.click(await screen.findByRole('button', { name: /send to the mechanic/i }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(extras.includeSharedMedia).toHaveBeenCalledWith('rep-1', ['photo-1']));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });

  it('does not hand out a link if including the selected attachments fails', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    extras.includeSharedMedia.mockRejectedValueOnce(new Error('unavailable'));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderTrip();
    fireEvent.click(await screen.findByRole('button', { name: /send to the mechanic/i }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(extras.revokeSharedReport).toHaveBeenCalledWith('rep-1'));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('keeps the trip as it was and says so when re-evaluating fails', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    db.getSessionRows.mockResolvedValueOnce([{ id: 'r1', session_id: 't1', t_seconds: 0, t_timestamp: null, data: { coolant: 90 } }] as never);
    db.replaceSessionFlags.mockRejectedValueOnce(new Error('network down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderTrip();
    fireEvent.click(await screen.findByRole('button', { name: /technical details/i }));
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText("Couldn't check the trip again")).toBeInTheDocument();
    expect(db.getSessionFlags).toHaveBeenCalledTimes(1); // not re-read as if it had worked
    consoleError.mockRestore();
  });
  it('lets the owner set the fuel price right on the trip when none is saved', async () => {
    db.getSession.mockResolvedValueOnce(TRIP);
    renderTrip();
    expect(await screen.findByText('Set your fuel price once and every trip shows what it cost.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set fuel price' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('costs a trip from before the first saved price, with fuel worked out from the air flow', async () => {
    db.getSession.mockResolvedValueOnce({ ...TRIP, summary: { ...TRIP.summary, summaries: [...TRIP.summary.summaries, { canonical_key: 'maf', parameter_key: 'Mass air flow (g/s)', unit: 'g/s' }] } });
    // 30 min at 10 g/s of air: 1800 s x 10 / (14.7 x 745) = 1.64 L; at $1/L that is $1.64.
    db.getSessionRows.mockResolvedValueOnce(Array.from({ length: 61 }, (_, i) => ({ id: `r${i}`, session_id: 't1', t_seconds: i * 30, t_timestamp: null, data: { 'Mass air flow (g/s)': 10 }, created_at: '' })) as never);
    fuel.listFuelEntries.mockResolvedValueOnce([{ id: 'p1', kind: 'reference', at: '2026-11-15T12:00:00Z', litres: 0, pricePerLitre: 1, totalPaid: null, currency: 'USD', odometerKm: null, fullTank: false, source: 'manual', region: '', sourceUrl: '', note: '' }]);
    renderTrip();
    expect((await screen.findByTestId('trip-cost')).textContent).toBe('$1.64');
    expect(screen.getByText(/the first price you saved/)).toBeTruthy();
    expect(screen.getByText(/worked out from the engine's air flow \(100% of the trip\)/)).toBeTruthy();
  });
});
