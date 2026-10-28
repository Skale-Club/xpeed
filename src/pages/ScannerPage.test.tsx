import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import ScannerPage from './ScannerPage';
import { ObdScannerProvider } from '@/contexts/ObdScannerContext';
import { VIN, installFakeBluetooth } from '@/test/fake-obd';

const ingestMock = vi.hoisted(() => vi.fn(async (_file: File, _carId: string, _name?: string) => ({ sessionId: 's1', rows: 1, flags: 0, dtcs: 0 })));

vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({
  useCarsContext: () => ({ selectedCar: { name: 'Prius' }, selectedCarId: 'car-1' }),
}));
vi.mock('@/hooks/use-csv-upload', () => ({ ingestSessionCsv: ingestMock }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
// Reading codes in the Scanner updates the car's problems; not under test here.
vi.mock('@/lib/issue-reconciler', () => ({ syncFaultCodes: vi.fn(async () => ({ resolved: 0 })) }));
// No earlier upload of the same trip to replace.
vi.mock('@/lib/db', () => ({ findSessionStartedAt: vi.fn(async () => null), deleteSession: vi.fn(async () => undefined) }));

function readFile(file: File) {
  // jsdom's File has no .text(); browsers do.
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}

function renderPage() {
  return render(<MemoryRouter><ObdScannerProvider><ScannerPage /></ObdScannerProvider></MemoryRouter>);
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  // Forget the adapter between tests (otherwise it auto-reconnects on mount).
  localStorage.clear();
  delete (navigator as unknown as Record<string, unknown>).bluetooth;
});

describe('ScannerPage', () => {
  it('explains when Web Bluetooth is missing', () => {
    renderPage();
    expect(screen.getByText('Bluetooth is not available in this browser')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect adapter/i })).toBeDisabled();
  });

  it('connects, streams live data, reads codes and VIN, and saves the trip on disconnect', async () => {
    const { sent } = installFakeBluetooth();
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));

    // Live values decoded from the emulator
    expect(await screen.findByText('1726', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('83')).toBeInTheDocument();
    expect(await screen.findByText('12.40')).toBeInTheDocument(); // ATRV, since PID 42 is unsupported
    expect(screen.getByText('VEEPEAK')).toBeInTheDocument();
    expect(screen.getByText('Protocol 6 (CAN)')).toBeInTheDocument();
    expect(screen.getByText('multi-PID')).toBeInTheDocument();
    expect(sent.some((c) => /^01(0[45]|0C|0D|0E|0F|1[01]){2,}/.test(c) && c.length > 4)).toBe(true);

    // Trouble codes
    fireEvent.click(screen.getByRole('button', { name: /read trouble codes/i }));
    // Each OBD module is asked on its own address, so this takes a few round trips.
    expect(await screen.findByText('P0133', {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.getByText('P0420')).toBeInTheDocument();

    // VIN
    fireEvent.click(screen.getByRole('button', { name: /read vin/i }));
    expect(await screen.findByText(VIN)).toBeInTheDocument();

    // Clear codes goes through a confirmation dialog
    expect(sent).not.toContain('04');
    fireEvent.click(screen.getByRole('button', { name: /clear codes/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^clear codes$/i, hidden: false }));
    await waitFor(() => expect(sent).toContain('04'));

    // Only supported PIDs are polled
    expect(sent).not.toContain('0142');
    expect(sent).toContain('ATRV');

    // The engine was running, so a trip started by itself. Pretend 70 s went
    // by (trips under a minute are dropped), then disconnect: it gets saved.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 70_000);
    await waitFor(() => expect(sent.filter((c) => c.startsWith('010C')).length).toBeGreaterThan(3));
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    clock.mockRestore();

    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1));
    const [file, carId, name] = ingestMock.mock.calls[0];
    expect(carId).toBe('car-1');
    expect(name).toMatch(/^Trip /);
    expect(file.name).toMatch(/^xpeed-scan_\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.csv$/);
    const [header, firstRow] = (await readFile(file)).split('\n');
    expect(header.startsWith('Time (s),')).toBe(true);
    expect(header).toContain('Engine RPM (rpm)');
    expect(header).toContain('Battery voltage (V)');
    expect(firstRow).toContain('1726');
  }, 40000);

  it('retries a flaky Bluetooth connect', async () => {
    const fake = installFakeBluetooth(2);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    expect(await screen.findByText('1726', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(fake.connectCalls()).toBe(3);
  }, 10000);

  it('explains what to check when the adapter will not connect', async () => {
    const fake = installFakeBluetooth(99);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    expect(await screen.findByText(/accepts only one connection/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/Connection attempt failed/)).toBeInTheDocument();
    expect(fake.connectCalls()).toBe(3);
    expect(screen.getByRole('button', { name: /connect adapter/i })).toBeEnabled();
  }, 10000);

  it('polls custom ECU PIDs and offers a read-only terminal', async () => {
    localStorage.setItem('xpeed.obd.customPids.car-1', JSON.stringify([
      { id: 'p1', name: 'State of Charge', unit: '%', header: '7E3', command: '21CE', formula: 'A/2', min: 0, max: 100 },
    ]));
    const { sent } = installFakeBluetooth();
    renderPage();
    expect(screen.getByText('State of Charge')).toBeInTheDocument(); // listed before connecting

    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    expect(await screen.findByText('61.0', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('1726')).toBeInTheDocument();
    await waitFor(() => expect(sent.filter((c) => c === 'ATSH7DF').length).toBeGreaterThan(0));

    // Terminal: reads to a specific ECU work…
    fireEvent.change(screen.getByLabelText('Header'), { target: { value: '7e3' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '21 ce' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('61CE7A')).toBeInTheDocument();

    // …writes and resets are refused before reaching the adapter
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '1101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Only read requests are allowed/)).toBeInTheDocument();
    expect(sent).not.toContain('1101');

    localStorage.clear();
  }, 10000);

  it('adds a custom PID by hand and rejects unsafe requests', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reset' } });
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: '1101' } });
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: /add pid/i }));
    expect(screen.getByText(/not a supported read request/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Inverter temp' } });
    fireEvent.change(screen.getByLabelText('ECU header'), { target: { value: '7E2' } });
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: '21C3' } });
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'A-50' } });
    fireEvent.click(screen.getByRole('button', { name: /add pid/i }));
    expect(screen.getByText('Inverter temp')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('xpeed.obd.customPids.car-1') ?? '[]')).toHaveLength(1);
    localStorage.clear();
  });

  it('finds ECUs, sweeps mode 21 and highlights changing bytes', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { sent } = installFakeBluetooth();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    await screen.findByText('1726', {}, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /find ecus/i }));
    expect(await screen.findByText('12 addresses did not answer.', {}, { timeout: 20000 })).toBeInTheDocument();
    expect(screen.getByText('7E0')).toBeInTheDocument();
    expect(screen.getByText('7E2')).toBeInTheDocument();
    expect(screen.getByText('7E3')).toBeInTheDocument();
    expect(screen.getAllByText('answers (not supported)')).toHaveLength(1); // 7E3 refuses 2101 but is there
    expect(sent).toContain('ATCRA7C8'); // non-OBD modules get an explicit receive filter

    const scan7E2 = () => screen.getAllByRole('button', { name: /scan pids/i })[1];
    fireEvent.click(scan7E2());
    expect(await screen.findByText('ECU 7E2: 2 data blocks', {}, { timeout: 20000 })).toBeInTheDocument();
    expect(sent).toContain('21FF');
    expect(sent.filter((c) => /^21[0-9A-F]{2}$/.test(c)).length).toBeGreaterThanOrEqual(255);
    expect(document.querySelectorAll('.text-warn')).toHaveLength(0);

    // Second sweep: the live byte of 2101 is highlighted
    await waitFor(() => expect(scan7E2()).toBeEnabled());
    fireEvent.click(scan7E2());
    await waitFor(() => expect(document.querySelectorAll('.text-warn').length).toBe(1), { timeout: 20000 });

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('2181 [9] 01 02 03 04 05 06 07 08 09');
    expect(writeText.mock.calls[0][0]).toMatch(/2101 \[2\] AA [0-9A-F]{2} {2}changed: 1/);

    // Live polling resumes after the scan
    const before = sent.length;
    await waitFor(() => expect(sent.slice(before).some((c) => c.startsWith('01'))).toBe(true));
  }, 60000);

  it('adds the Prius Gen3 preset and reads each shared ECU block once per cycle', async () => {
    const { sent } = installFakeBluetooth();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /add preset: toyota prius gen3/i }));
    expect(screen.getByText('HV block 14')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('xpeed.obd.customPids.car-1') ?? '[]')).toHaveLength(18);

    fireEvent.click(screen.getByRole('button', { name: /connect adapter/i }));
    // Emulated 2181 = 01 02 03…: block 01 = (1*256+2)*79.99/65535
    expect(await screen.findByText('0.31', {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(sent.filter((c) => c === '2174').length).toBeGreaterThanOrEqual(2));
    const first = sent.indexOf('2174');
    const second = sent.indexOf('2174', first + 1);
    expect(sent.slice(first + 1, second).filter((c) => c === '2181')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /remove all/i }));
    expect(screen.queryByText('HV block 14')).not.toBeInTheDocument();
    localStorage.clear();
  }, 10000);
});
