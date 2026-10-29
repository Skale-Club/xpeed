import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useObdScanner, type TripResult } from './use-obd-scanner';
import { installFakeBluetooth, VIN } from '@/test/fake-obd';
import { pidHeader, LIVE_PIDS } from '@/lib/obd/pids';

// The scanner hook against the simulated car (src/test/fake-car.ts), with real timers.

const SPEED = pidHeader(LIVE_PIDS.find((d) => d.pid === 0x0d)!);
const OTHER_VIN = 'WVWZZZ1JZXW000001';

/** Shift Date.now() forward, as if that much driving time had passed. */
function advanceClock(ms: number) {
  const prev = Date.now.bind(Date);
  return vi.spyOn(Date, 'now').mockImplementation(() => prev() + ms);
}

function setup(options: { alwaysOn?: boolean } = {}) {
  const fake = installFakeBluetooth();
  const ended: TripResult[] = [];
  const dropped: Date[] = [];
  const hook = renderHook(() => useObdScanner({
    alwaysOn: options.alwaysOn ?? true,
    onTripEnd: (t) => ended.push(t),
    onTripDropped: (d) => dropped.push(d),
  }));
  return { fake, ended, dropped, ...hook };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).bluetooth;
});

describe('useObdScanner', () => {
  it('collects no recording samples while parked and starts only after movement', async () => {
    const fake = installFakeBluetooth();
    fake.setPid('0D', '00');
    fake.setPid('0C', '0E10'); // 900 rpm, parked engine warm-up.
    const { result, unmount } = renderHook(() => useObdScanner({ alwaysOn: true }));
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.live.get().values[SPEED]).toBe(0), { timeout: 8000 });
    expect(result.current.recording).toBeNull();
    expect(result.current.getRecording().total).toBe(0);
    fake.setPid('0D', ''); // A missing speed reply must not turn RPM into a false start.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); });
    expect(result.current.recording).toBeNull();
    expect(result.current.getRecording().total).toBe(0);
    fake.setPid('0D', '19');
    await waitFor(() => expect(result.current.recording?.active).toBe(true), { timeout: 8000 });
    expect(result.current.getRecording().total).toBeGreaterThan(0);
    unmount();
  }, 20000);
  it('falls back to individual readings when larger PID batches omit sensors', async () => {
    const fake = installFakeBluetooth(0, 2);
    const { result, unmount } = renderHook(() => useObdScanner());
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.live.get().values[SPEED]).toBe(50), { timeout: 8000 });
    expect(result.current.connection?.multiPid).toBe(false);
    expect(result.current.live.get().values['Engine RPM (rpm)']).toBe(1726);
    expect(fake.sent).toContain('010D');
    unmount();
  }, 15000);
  it('looks the car up again when the adapter is plugged into another one', async () => {
    const { fake, result, unmount } = setup();
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.status).toBe('live'), { timeout: 8000 });
    await waitFor(() => expect(result.current.vin).toBe(VIN), { timeout: 5000 });
    expect(result.current.channels.some((c) => c.header === SPEED)).toBe(true);

    // The adapter is unplugged and moved: another car, with a shorter list of PIDs (coolant + rpm only).
    fake.swapCar({ vin: OTHER_VIN, supported: '08100000', pidData: { '0C': '1AF8', '05': '7B' } });
    fake.dropLink();
    await waitFor(() => expect(result.current.vin).toBe(OTHER_VIN), { timeout: 10000 });
    await waitFor(() => expect(result.current.status).toBe('live'), { timeout: 5000 });
    // Not the first car's channels
    expect(result.current.channels.some((c) => c.header === SPEED)).toBe(false);
    expect(result.current.channels.length).toBeGreaterThan(0);
    unmount();
  }, 30000);

  it('keeps the same car\'s channels and trip across a reconnect', async () => {
    const { fake, result, ended, unmount } = setup();
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.recording?.active).toBe(true), { timeout: 8000 });
    const before = result.current.channels;
    fake.dropLink();
    await waitFor(() => expect(fake.connectCalls()).toBe(2), { timeout: 8000 });
    await waitFor(() => expect(result.current.status).toBe('live'), { timeout: 8000 });
    // Same VIN: the PID list was not looked up again, and the trip carries on
    expect(result.current.channels).toBe(before);
    expect(result.current.recording?.active).toBe(true);
    expect(ended).toHaveLength(0);
    unmount();
  }, 30000);

  it('keeps the trip open through a Bluetooth stall, which says nothing about the car', async () => {
    const { fake, result, ended, dropped, unmount } = setup();
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.recording?.active).toBe(true), { timeout: 8000 });
    // The adapter stops answering, and a minute of "driving time" passes in the meantime.
    fake.stall(true);
    const clock = advanceClock(60_000);
    // A full cycle of nothing, long past the 20 s of silence that mean "car off"
    await new Promise((r) => setTimeout(r, 3800));
    fake.stall(false);
    await waitFor(() => expect(result.current.status).toBe('live'));
    await new Promise((r) => setTimeout(r, 2500));
    expect(result.current.recording?.active).toBe(true);
    expect(ended).toHaveLength(0);
    expect(dropped).toHaveLength(0);
    clock.mockRestore();
    unmount();
  }, 30000);

  it('ends and hands over the trip in progress when the screen goes away (sign-out)', async () => {
    const { result, ended, unmount } = setup();
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.recording?.active).toBe(true), { timeout: 8000 });
    await waitFor(() => expect(result.current.getRecording().total).toBeGreaterThan(0), { timeout: 5000 });
    const clock = advanceClock(120_000);
    unmount();
    clock.mockRestore();
    expect(ended).toHaveLength(1);
    expect(ended[0].reason).toBe('disconnected');
    expect(ended[0].samples.length).toBeGreaterThan(0);
  }, 30000);

  it('ends the open trip when a new connection is made, instead of adding to it', async () => {
    const { result, ended, unmount } = setup({ alwaysOn: false });
    await act(async () => { await result.current.startTrip(); });
    await waitFor(() => expect(result.current.recording?.active).toBe(true), { timeout: 8000 });
    await waitFor(() => expect(result.current.getRecording().total).toBeGreaterThan(0), { timeout: 5000 });
    const firstStart = result.current.recording!.startedAt.getTime();
    const clock = advanceClock(120_000);
    await act(async () => { await result.current.connect(); });
    clock.mockRestore();
    expect(ended).toHaveLength(1);
    expect(ended[0].startedAt.getTime()).toBe(firstStart);
    expect(result.current.recording).toBeNull();
    unmount();
  }, 30000);

  it('on a computer, stops looking for the adapter once the trip is over', async () => {
    const { fake, result, unmount } = setup({ alwaysOn: false });
    await act(async () => { await result.current.startTrip(); });
    await waitFor(() => expect(result.current.recording?.active).toBe(true), { timeout: 8000 });
    // The adapter drops while the trip is open and stays out of reach: it is looked for, for the trip's sake.
    fake.failNextConnects(100);
    fake.dropLink();
    await waitFor(() => expect(result.current.status).toBe('reconnecting'), { timeout: 5000 });
    // The trip is closed by hand; nothing is left to look for.
    act(() => result.current.stopTrip());
    await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 15000 });
    expect(result.current.recording).toBeNull();
    unmount();
  }, 30000);

  it('backs up only the samples recorded since the last backup, with the columns kept as it goes', async () => {
    const { result, unmount } = setup();
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.getRecording().total).toBeGreaterThan(1), { timeout: 8000 });
    const first = result.current.getRecording();
    expect(first.samples).toHaveLength(first.total);
    expect(first.columns.length).toBeGreaterThan(0);
    const later = result.current.getRecording(first.total);
    expect(later.samples.length).toBeLessThan(later.total);
    expect(later.samples[0]).toBe(result.current.getRecording().samples[first.total]);
    unmount();
  }, 30000);

  it('does not poke a parked car\'s bus on every pass, but looks at once when the voltage rises', async () => {
    const { fake, result, unmount } = setup();
    fake.setCarOn(false);
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.status).toBe('waiting'), { timeout: 15000 });
    const probes = () => fake.sent.filter((c) => c === '0100').length;

    // Parked for five minutes: probing the bus every 10 s now, checking the voltage in between.
    const clock = advanceClock(5 * 60_000);
    const before = probes();
    await waitFor(() => expect(probes()).toBe(before + 1), { timeout: 8000 });
    const afterProbe = probes();
    await new Promise((r) => setTimeout(r, 4500));
    expect(probes()).toBe(afterProbe);
    expect(fake.sent.filter((c) => c === 'ATRV').length).toBeGreaterThan(0);

    // The engine starts: the adapter's voltage rises, and the very next check probes the bus.
    fake.setVoltage('14.1V');
    await waitFor(() => expect(probes()).toBe(afterProbe + 1), { timeout: 6000 });
    clock.mockRestore();
    unmount();
  }, 40000);
});
