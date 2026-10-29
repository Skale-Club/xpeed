import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import LivePage from './LivePage';
import ScannerPage from './ScannerPage';
import { ObdScannerProvider } from '@/contexts/ObdScannerContext';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { installFakeBluetooth } from '@/test/fake-obd';
import { PID_PRESETS } from '@/lib/obd/presets';

vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ selectedCar: { name: 'Prius' }, selectedCarId: 'car-1' }),
}));
vi.mock('@/hooks/use-csv-upload', () => ({ ingestSessionCsv: vi.fn(async () => ({ sessionId: 's1', rows: 1, flags: 0, dtcs: 0 })) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
// Reading codes in the Scanner updates the car's problems; not under test here.
vi.mock('@/lib/issue-reconciler', () => ({ syncFaultCodes: vi.fn(async () => ({ resolved: 0 })) }));
// No earlier upload of the same trip to replace.
vi.mock('@/lib/db', () => ({ findSessionStartedAt: vi.fn(async () => null), deleteSession: vi.fn(async () => undefined) }));

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>go {to}</button>;
}

function renderApp(path = '/live') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsProvider>
        <ObdScannerProvider>
          <GoTo to="/live" />
          <GoTo to="/scanner" />
          <Routes>
            <Route path="/live" element={<LivePage />} />
            <Route path="/scanner" element={<ScannerPage />} />
          </Routes>
        </ObdScannerProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

// hidden: true — an open Customize sheet marks the page behind it aria-hidden.
const gauge = (label: string) => {
  const matches = screen.getAllByTestId('widget-gauge').flatMap((card) => within(card).queryAllByRole('meter', { name: label, hidden: true }));
  if (matches.length !== 1) throw new Error(`Expected one dial for ${label}, found ${matches.length}`);
  return matches[0];
};
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
  it('shows Fahrenheit readings and converted dial bounds with the same normal temperature status', async () => {
    localStorage.setItem('settings_temperatureUnit', 'F');
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    await waitFor(() => {
      const meter = gauge('Engine coolant temperature');
      expect(meter).toHaveAttribute('aria-valuemin', '104');
      expect(meter).toHaveAttribute('aria-valuemax', '248');
      expect(meter).toHaveAttribute('aria-valuenow', '181.4');
      expect(meter).toHaveTextContent('°F');
    }, { timeout: 8000 });
  });
  it('shows adapter identity and transport below the dashboard and confirms disconnection', async () => {
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    const card = await screen.findByTestId('adapter-connection', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('VEEPEAK');
    await waitFor(() => expect(card).toHaveTextContent('Bluetooth LE (BLE)'), { timeout: 8000 });
    expect(screen.getByRole('heading', { name: /Live panel/ }).parentElement).not.toHaveTextContent('VEEPEAK');
    fireEvent.click(within(card).getByRole('button'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('An active trip recording will also end');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(card).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.queryByTestId('adapter-connection')).not.toBeInTheDocument());
  });
  it('updates readings in place and opens an expanded timeline without reconnecting', async () => {
    const fake = installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    await waitFor(() => expect(gauge('Engine RPM')).toHaveAttribute('aria-valuenow', '1726'), { timeout: 8000 });
    const original = gauge('Engine RPM');
    fake.setPid('0C', '1F40');
    await waitFor(() => expect(gauge('Engine RPM')).toHaveAttribute('aria-valuenow', '2000'));
    expect(gauge('Engine RPM')).toBe(original);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open timeline: Engine RPM' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Engine RPM chart' })).toHaveClass('h-64');
    fireEvent.change(within(dialog).getByLabelText('Timeline period'), { target: { value: '1800000' } });
    expect(within(dialog).getByLabelText('Timeline period')).toHaveValue('1800000');
    expect(fake.requestDevice).toHaveBeenCalledTimes(1);
  });
  it('asks to connect when no adapter is linked', () => {
    installFakeBluetooth();
    renderApp();
    expect(screen.getByText(/Connect to your car to see its readings live/)).toBeInTheDocument();
    // The Scanner is for mechanics: no link to it unless Advanced tools is on
    expect(screen.queryByRole('link', { name: /scanner/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('widget-gauge')).not.toBeInTheDocument();
  });

  it('connects and shows default gauges, numbers and charts', async () => {
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));

    await waitFor(() => expect(gauge('Engine RPM')).toHaveAttribute('aria-valuenow', '1726'), { timeout: 8000 });
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
    expect(await screen.findByText('1726', {}, { timeout: 8000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'go /live' }));
    await waitFor(() => expect(gauge('Engine RPM')).toHaveAttribute('aria-valuenow', '1726'));
    fireEvent.click(screen.getByRole('button', { name: 'go /scanner' }));
    expect(await screen.findByText('1726')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    expect(requestDevice).toHaveBeenCalledTimes(1);
  }, 30000);

  it('draws the HV block bars when the Prius preset is loaded', async () => {
    localStorage.setItem('xpeed.obd.customPids.car-1', JSON.stringify(PID_PRESETS[0].pids()));
    installFakeBluetooth();
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    const widget = await screen.findByTestId('widget-blocks', {}, { timeout: 8000 });
    expect(within(widget).getByText('Hybrid battery')).toBeInTheDocument();
    for (let i = 1; i <= 14; i++) expect(screen.getByTestId(`hv-block-${i}`)).toBeInTheDocument();
    // Emulated 2181 only carries 9 data bytes: blocks 1–4 have values, the rest are missing
    await waitFor(() => expect(within(screen.getByTestId('hv-block-1')).getByText('0.31')).toBeInTheDocument());
    expect(within(screen.getByTestId('hv-block-14')).getByText('—')).toBeInTheDocument();
  });

  it('customizes the layout and remembers it per vehicle', async () => {
    installFakeBluetooth();
    const { unmount } = renderApp();
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    await waitFor(() => expect(gauge('Engine RPM')).toBeInTheDocument(), { timeout: 8000 });

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
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    await waitFor(() => expect(gauge('Battery voltage')).toBeInTheDocument(), { timeout: 8000 });
    noGauge('Engine RPM');

    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /reset to default/i }));
    await waitFor(() => expect(gauge('Engine RPM')).toBeInTheDocument());
    expect(localStorage.getItem('xpeed.obd.liveLayout.car-1')).toBeNull();
  }, 15000);
});
