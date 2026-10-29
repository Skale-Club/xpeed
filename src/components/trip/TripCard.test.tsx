import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { TripCard } from './TripCard';
import { ConnectionPill } from './ConnectionPill';
import { ObdScannerProvider } from '@/contexts/ObdScannerContext';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { installFakeBluetooth } from '@/test/fake-obd';

const ingestMock = vi.hoisted(() => vi.fn(async (_file: File, _carId: string, _name?: string) => ({ sessionId: 'trip-1', rows: 1, flags: 0, dtcs: 0 })));

vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ selectedCar: { name: 'Prius' }, selectedCarId: 'car-1' }),
}));
vi.mock('@/hooks/use-csv-upload', () => ({ ingestSessionCsv: ingestMock }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
// No earlier upload of the same trip to replace.
vi.mock('@/lib/db', () => ({ findSessionStartedAt: vi.fn(async () => null), deleteSession: vi.fn(async () => undefined) }));

function renderCard() {
  return render(
    <MemoryRouter>
      <SettingsProvider>
        <ObdScannerProvider>
          <ConnectionPill />
          <TripCard />
        </ObdScannerProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

/** Shift Date.now() forward, as if that much driving time had passed. */
function advanceClock(ms: number) {
  const prev = Date.now.bind(Date);
  return vi.spyOn(Date, 'now').mockImplementation(() => prev() + ms);
}

const pill = () => screen.getByTestId('connection-pill');

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  ingestMock.mockClear();
  localStorage.clear();
  delete (navigator as unknown as Record<string, unknown>).bluetooth;
});

describe('TripCard', () => {
  it('tells the user when the browser cannot connect', () => {
    renderCard();
    expect(screen.getByText(/can't connect to the car/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start trip/i })).not.toBeInTheDocument();
  });

  it('connects first, then starts a trip, records, and saves it when ended', async () => {
    const { requestDevice } = installFakeBluetooth();
    localStorage.setItem('xpeed.obd.alwaysOn', 'false'); // only the button starts trips
    renderCard();
    expect(pill()).toHaveTextContent('Car not connected');
    // Not connected: a note to connect, and no "Start trip" yet
    expect(screen.getByTestId('not-connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start trip/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    fireEvent.click(await screen.findByRole('button', { name: /start trip/i }, { timeout: 5000 }));
    expect(await screen.findByText('Recording your trip', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(pill()).toHaveTextContent('Recording trip');
    expect(pill()).toHaveAttribute('href', '/live');
    expect(pill().querySelector('.animate-pulse')).toBeNull();
    expect(document.querySelector('.animate-ping')).toBeNull();
    expect(screen.getByRole('link', { name: 'View all live sensors' })).toHaveAttribute('href', '/live');
    expect(requestDevice).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('1726')).toBeInTheDocument());

    const clock = advanceClock(10_000);
    fireEvent.click(screen.getByRole('button', { name: /end trip/i }));
    clock.mockRestore();

    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1));
    expect(ingestMock.mock.calls[0][1]).toBe('car-1');
    expect(ingestMock.mock.calls[0][2]).toMatch(/^Trip /);
    // Fault codes read when the car came on travel with the trip (→ Problems list)
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(ingestMock.mock.calls[0][0]);
    });
    const [header, firstRow] = csv.split('\n');
    expect(header.endsWith(',DTC')).toBe(true);
    expect(firstRow.endsWith('P0133 P0420')).toBe(true);
    expect(await screen.findByText('Last trip saved.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/session/trip-1');
    // Still connected, ready for the next trip
    expect(pill()).toHaveTextContent('Car connected');
  }, 15000);

  it('always-on: waits while the car is off, records by itself and saves when it turns off', async () => {
    const fake = installFakeBluetooth();
    fake.setCarOn(false);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    expect(await screen.findByText(/waiting for the car/i, { selector: 'p' }, { timeout: 15000 })).toBeInTheDocument();
    expect(pill()).toHaveTextContent('Waiting for the car');
    expect(ingestMock).not.toHaveBeenCalled();

    // Ignition on: the standby probe notices and recording starts on its own
    fake.setCarOn(true);
    expect(await screen.findByText('Recording your trip', {}, { timeout: 8000 })).toBeInTheDocument();

    // Drive for "70 s", then switch off; after 20 s of silence the trip is saved
    let clock = advanceClock(70_000);
    await waitFor(() => expect(screen.getAllByText('1726').length).toBeGreaterThan(0));
    fake.setCarOn(false);
    // The card notices the car stopped answering (trip still open)…
    expect(await screen.findByText(/the trip continues/, {}, { timeout: 5000 })).toBeInTheDocument();
    clock.mockRestore();
    clock = advanceClock(100_000);
    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1), { timeout: 10000 });
    clock.mockRestore();
    expect(await screen.findByText(/waiting for the car/i, { selector: 'p' })).toBeInTheDocument();
  }, 40000);

  it('reconnects by itself when the adapter drops, and remembers it for next time', async () => {
    const fake = installFakeBluetooth();
    const { unmount } = renderCard();
    // Always on: once connected, the moving car starts recording by itself
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    await screen.findByText('Recording your trip', {}, { timeout: 5000 });

    fake.dropLink();
    // A second Bluetooth link is opened by itself, and the trip keeps recording
    await waitFor(() => expect(fake.connectCalls()).toBe(2), { timeout: 8000 });
    await waitFor(() => expect(pill()).toHaveTextContent('Recording trip'), { timeout: 8000 });
    expect(fake.requestDevice).toHaveBeenCalledTimes(1);
    // The loop on the dropped link is gone: nothing flips the card back to "waiting".
    await new Promise((r) => setTimeout(r, 2500));
    expect(pill()).toHaveTextContent('Recording trip');

    // Next visit: connects to the remembered adapter without the chooser
    unmount();
    renderCard();
    await waitFor(() => expect(pill()).toHaveTextContent(/Car connected|Recording trip/), { timeout: 5000 });
    expect(fake.requestDevice).toHaveBeenCalledTimes(1);
  }, 30000);

  it('always-on: keeps looking for the remembered adapter when it is out of reach at start', async () => {
    const fake = installFakeBluetooth();
    // First visit links the adapter so it is remembered.
    const { unmount } = renderCard();
    // Always on: once connected, the moving car starts recording by itself
    fireEvent.click(screen.getByRole('button', { name: /connect to the car/i }));
    await screen.findByText('Recording your trip', {}, { timeout: 5000 });
    unmount();

    // Next start: the adapter is out of range for the first attempt.
    fake.failNextConnects(1);
    renderCard();
    await waitFor(() => expect(pill()).toHaveTextContent(/Looking for|Connecting/), { timeout: 3000 });
    await waitFor(() => expect(pill()).toHaveTextContent(/Car connected|Recording trip/), { timeout: 9000 });
    expect(fake.requestDevice).toHaveBeenCalledTimes(1);
  }, 30000);

  it('can turn always-on off', async () => {
    installFakeBluetooth();
    renderCard();
    const toggle = screen.getByRole('switch', { name: /record trips automatically/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem('xpeed.obd.alwaysOn')).toBe('false');
  });

  it('offers always-on only on phones and tablets', () => {
    const phone = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36' });
    try {
      installFakeBluetooth();
      renderCard();
      expect(screen.queryByRole('switch', { name: /record trips automatically/i })).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: phone });
    }
  });
});
