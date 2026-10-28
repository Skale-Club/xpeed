import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import LivePage from './LivePage';
import ScannerPage from './ScannerPage';
import { ObdScannerProvider } from '@/contexts/ObdScannerContext';
import { installFakeBluetooth } from '@/test/fake-obd';
import { PID_PRESETS } from '@/lib/obd/presets';

vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ selectedCar: { name: 'Prius' }, selectedCarId: 'car-1' }),
}));
vi.mock('@/hooks/use-csv-upload', () => ({ ingestSessionCsv: vi.fn(async () => ({ sessionId: 's1', rows: 1, flags: 0, dtcs: 0 })) }));

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>go {to}</button>;
}

function renderApp(path = '/live') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ObdScannerProvider>
        <GoTo to="/live" />
        <GoTo to="/scanner" />
        <Routes>
          <Route path="/live" element={<LivePage />} />
          <Route path="/scanner" element={<ScannerPage />} />
        </Routes>
      </ObdScannerProvider>
    </MemoryRouter>,
  );
}

// hidden: true — an open Customize sheet marks the page behind it aria-hidden.
const gauge = (label: string) => screen.getByRole('meter', { name: label, hidden: true });
const noGauge = (label: string) => expect(screen.queryByRole('meter', { name: label, hidden: true })).not.toBeInTheDocument();

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (navigator as unknown as Record<string, unknown>).bluetooth;
});

describe('LivePage', () => {
  it('asks to connect when no adapter is linked', () => {
    installFakeBluetooth();
    renderApp();
    expect(screen.getByText(/Connect your OBD2 adapter/)).toBeInTheDocument();
    expect(screen.queryByTestId('widget-gauge')).not.toBeInTheDocument();
  });

  it('connects and shows default gauges, numbers and charts', async () => {
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));

    await waitFor(() => expect(gauge('Engine RPM')).toHaveAttribute('aria-valuenow', '1726'), { timeout: 3000 });
    expect(gauge('Vehicle speed')).toHaveAttribute('aria-valuenow', '50');
    expect(gauge('Engine coolant temperature')).toHaveAttribute('aria-valuenow', '83');
    expect(screen.getAllByTestId('widget-chart')).toHaveLength(2);
    // ATRV fallback shows up as a number widget
    expect(within(screen.getAllByTestId('widget-value')[0]).getByText('12.40')).toBeInTheDocument();
    // Charts get points as cycles come in
    await waitFor(() => expect(document.querySelectorAll('polyline').length).toBeGreaterThan(0));
  });

  it('keeps the connection while navigating between Scanner and Live', async () => {
    const { requestDevice } = installFakeBluetooth();
    renderApp('/scanner');
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    expect(await screen.findByText('1726', {}, { timeout: 3000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'go /live' }));
    await waitFor(() => expect(gauge('Engine RPM')).toHaveAttribute('aria-valuenow', '1726'));
    fireEvent.click(screen.getByRole('button', { name: 'go /scanner' }));
    expect(await screen.findByText('1726')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    expect(requestDevice).toHaveBeenCalledTimes(1);
  });

  it('draws the HV block bars when the Prius preset is loaded', async () => {
    localStorage.setItem('xpeed.obd.customPids.car-1', JSON.stringify(PID_PRESETS[0].pids()));
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    const widget = await screen.findByTestId('widget-blocks', {}, { timeout: 3000 });
    expect(within(widget).getByText('HV battery blocks')).toBeInTheDocument();
    for (let i = 1; i <= 14; i++) expect(screen.getByTestId(`hv-block-${i}`)).toBeInTheDocument();
    // Emulated 2181 only carries 9 data bytes: blocks 1–4 have values, the rest are missing
    await waitFor(() => expect(within(screen.getByTestId('hv-block-1')).getByText('0.31')).toBeInTheDocument());
    expect(within(screen.getByTestId('hv-block-14')).getByText('—')).toBeInTheDocument();
  });

  it('customizes the layout and remembers it per vehicle', async () => {
    installFakeBluetooth();
    const { unmount } = renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    await waitFor(() => expect(gauge('Engine RPM')).toBeInTheDocument(), { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Widget type'), { target: { value: 'gauge' } });
    fireEvent.change(within(sheet).getByLabelText('Parameter'), { target: { value: 'Battery voltage (V)' } });
    fireEvent.click(within(sheet).getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(gauge('Battery voltage')).toBeInTheDocument());

    const saved = JSON.parse(localStorage.getItem('xpeed.obd.liveLayout.car-1') ?? '[]');
    expect(saved.at(-1)).toMatchObject({ kind: 'gauge', channel: 'Battery voltage (V)' });

    // Remove the first widget (RPM gauge)
    fireEvent.click(within(sheet).getAllByRole('button', { name: /remove/i })[0]);
    await waitFor(() => noGauge('Engine RPM'));

    unmount();
    delete (navigator as unknown as Record<string, unknown>).bluetooth;
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    await waitFor(() => expect(gauge('Battery voltage')).toBeInTheDocument(), { timeout: 3000 });
    noGauge('Engine RPM');

    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /reset to default/i }));
    await waitFor(() => expect(gauge('Engine RPM')).toBeInTheDocument());
    expect(localStorage.getItem('xpeed.obd.liveLayout.car-1')).toBeNull();
  }, 15000);
});
