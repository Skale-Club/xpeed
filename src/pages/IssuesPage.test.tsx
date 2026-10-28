import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import IssuesPage from './IssuesPage';
import { Toaster } from '@/components/ui/toaster';
import type { VehicleIssue } from '@/lib/db-issues';

const issue = (over: Partial<VehicleIssue>): VehicleIssue => ({
  id: 'i', car_profile_id: 'car-1', canonical_key: 'coolant_temp', title: 'Coolant ran high', severity: 'critical',
  status: 'active', first_seen_at: '2026-10-01T10:00:00Z', last_seen_at: '2026-10-27T10:00:00Z',
  first_session_id: 's0', last_session_id: 's9', resolved_at: null, resolved_note: null, recurrence_count: 0,
  created_at: '2026-10-01T10:00:00Z', ...over,
});

const ISSUES: VehicleIssue[] = [
  issue({ id: 'a', canonical_key: 'dtc:P0420', title: 'P0420', severity: 'serious', status: 'recurred', recurrence_count: 2 }),
  issue({ id: 'b' }),
  issue({ id: 'c', canonical_key: 'battery_voltage_12v', severity: 'warning', status: 'resolved', resolved_at: '2026-10-20T00:00:00Z' }),
];

const api = vi.hoisted(() => ({
  getIssuesForCar: vi.fn(async () => [] as VehicleIssue[]),
  resolveIssue: vi.fn(async () => undefined),
  ignoreIssue: vi.fn(async () => undefined),
  reopenIssue: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db-issues', () => api);
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ selectedCar: { id: 'car-1', name: 'Prius' }, selectedCarId: 'car-1' }),
}));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<MemoryRouter><IssuesPage /></MemoryRouter>);

describe('IssuesPage', () => {
  it('says all is good when nothing needs attention', async () => {
    api.getIssuesForCar.mockResolvedValueOnce([ISSUES[2]]);
    renderPage();
    expect(await screen.findByText('All good')).toBeInTheDocument();
    expect(screen.getByText('No problems here.')).toBeInTheDocument();
  });

  it('lists open problems in plain language, most urgent first', async () => {
    api.getIssuesForCar.mockResolvedValueOnce(ISSUES);
    renderPage();
    expect(await screen.findByText('2 problems need attention')).toBeInTheDocument();
    expect(screen.getByText(/At least one is urgent/)).toBeInTheDocument();

    const cards = screen.getAllByTestId('problem-card');
    expect(cards).toHaveLength(2);
    // Urgent overheating first, then the fault code
    expect(within(cards[0]).getByText('Engine running hot')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Urgent')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Fault code P0420 (engine or gearbox)')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Book a check-up')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Came back after being fixed (2×)')).toBeInTheDocument();
    // The code is tucked away for the mechanic
    expect(within(cards[1]).getByText(/^P0420/)).toBeInTheDocument();
    expect(within(cards[0]).getByRole('link', { name: 'View the trip' })).toHaveAttribute('href', '/session/s9');
    // No raw keys as titles
    expect(screen.queryByRole('heading', { name: 'coolant_temp' })).not.toBeInTheDocument();
  });

  it('marks a problem as fixed and moves it to the resolved tab', async () => {
    api.getIssuesForCar.mockResolvedValueOnce(ISSUES);
    renderPage();
    const first = (await screen.findAllByTestId('problem-card'))[0];
    fireEvent.click(within(first).getByRole('button', { name: "It's fixed" }));
    await waitFor(() => expect(api.resolveIssue).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(screen.getAllByTestId('problem-card')).toHaveLength(1));

    fireEvent.click(screen.getByRole('tab', { name: /Resolved or ignored/ }));
    expect(screen.getAllByTestId('problem-card')).toHaveLength(2);
    fireEvent.click(within(screen.getAllByTestId('problem-card')[0]).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(api.reopenIssue).toHaveBeenCalled());
  });
});

describe('IssuesPage safety nets', () => {
  it('never says "all good" when the problems could not be loaded, and can try again', async () => {
    api.getIssuesForCar.mockRejectedValueOnce(new Error('offline'));
    renderPage();
    expect(await screen.findByText("Couldn't check your car")).toBeInTheDocument();
    expect(screen.queryByText('All good')).not.toBeInTheDocument();

    api.getIssuesForCar.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('All good')).toBeInTheDocument();
  });

  it('gives no verdict while loading', () => {
    api.getIssuesForCar.mockReturnValueOnce(new Promise(() => undefined));
    renderPage();
    expect(screen.queryByText('All good')).not.toBeInTheDocument();
  });

  it('asks before ignoring an urgent problem', async () => {
    api.getIssuesForCar.mockResolvedValueOnce(ISSUES);
    renderPage();
    const urgent = (await screen.findAllByTestId('problem-card'))[0];
    fireEvent.click(within(urgent).getByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText('Ignore an urgent problem?')).toBeInTheDocument();
    expect(api.ignoreIssue).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(api.ignoreIssue).toHaveBeenCalledWith('b'));
  });

  it('offers to undo after marking a problem as fixed', async () => {
    api.getIssuesForCar.mockResolvedValueOnce(ISSUES);
    render(<MemoryRouter><IssuesPage /><Toaster /></MemoryRouter>);
    const first = (await screen.findAllByTestId('problem-card'))[0];
    fireEvent.click(within(first).getByRole('button', { name: "It's fixed" }));
    await screen.findByText('Marked as fixed');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.reopenIssue).toHaveBeenCalledWith('b'));
  });
});
