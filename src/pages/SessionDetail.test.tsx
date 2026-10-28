import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import SessionDetail from './SessionDetail';
import { Toaster } from '@/components/ui/toaster';

const db = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionFlags: vi.fn(async () => []),
  getSessionRows: vi.fn(async () => []),
  getCarById: vi.fn(async () => ({ id: 'car-1', make: 'Toyota', model: 'Prius', year: 2010, engine_type: 'hybrid' })),
  deleteSessionFlags: vi.fn(),
  insertSessionFlags: vi.fn(),
  downloadSessionCSV: vi.fn(),
}));
const extras = vi.hoisted(() => ({ createSharedReport: vi.fn(async () => ({ id: 'rep-1' })) }));
vi.mock('@/lib/db', () => db);
vi.mock('@/lib/db-extras', () => extras);
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/PhotoUpload', () => ({ default: () => null }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'km', timezone: 'UTC' }) }));

const TRIP = {
  id: 't1', car_profile_id: 'car-1', source_filename: 'xpeed-scan_2026-10-28 15-30-00.csv', session_start: '2026-10-28T15:30:00Z',
  uploaded_at: '2026-10-28T16:00:00Z', duration_seconds: 1800, row_count: 900,
  summary: { summaries: [{ canonical_key: 'vehicle_speed', avg: 40 }] },
  gemini_analysis: { summary: 'Engine warmed up normally; fuel trims were a bit lean.' },
  active_dtcs: ['P0420'],
};

const renderTrip = () => render(
  <MemoryRouter initialEntries={['/session/t1']}>
    <Routes><Route path="/session/:id" element={<SessionDetail />} /></Routes>
    <Toaster />
  </MemoryRouter>,
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

    expect(await screen.findByRole('heading', { name: /^Trip / })).toBeInTheDocument();
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('20 km')).toBeInTheDocument();
    expect(screen.getByText(/fuel trims were a bit lean/)).toBeInTheDocument();

    const problems = screen.getAllByTestId('trip-problem');
    expect(problems).toHaveLength(2);
    expect(screen.getByText('Engine running hot')).toBeInTheDocument();
    expect(screen.getByText('The car stored a fault code')).toBeInTheDocument();
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
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/rep-1`));
    expect(extras.createSharedReport).toHaveBeenCalledWith('t1', 30);
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });
});
