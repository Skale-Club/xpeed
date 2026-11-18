import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { DeviceCoachPermission } from './DeviceCoachPermission';
const mock = vi.hoisted(() => ({ save: vi.fn(), demo: false }));
vi.mock('@/lib/sim/companion-coach', () => ({ setCompanionCoachPermission: mock.save }));
vi.mock('@/lib/sim/demo/mode', () => ({ useDemoMode: () => mock.demo, isDemoMode: () => mock.demo }));
beforeEach(async () => { mock.demo = false; mock.save.mockReset(); await i18n.changeLanguage('en'); });
afterEach(cleanup);
const props = { accountId: 'driver-a', deviceId: 'device-a', allowed: false, onChanged: vi.fn() };
it('starts off and requires explicit confirmation before permitting a device', async () => {
  mock.save.mockResolvedValue(true);
  render(<DeviceCoachPermission {...props} />);
  expect(mock.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Allow assistant' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(mock.save).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Allow assistant' }));
  expect(await screen.findByRole('button', { name: 'Turn off assistant' })).toBeInTheDocument();
  expect(mock.save).toHaveBeenCalledWith('driver-a', 'device-a', true, expect.any(AbortSignal));
});
it('can disable the capability independently of recording and without another enable prompt', async () => {
  mock.save.mockResolvedValue(false);
  render(<DeviceCoachPermission {...props} allowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn off assistant' }));
  expect(await screen.findByRole('button', { name: 'Allow assistant' })).toBeInTheDocument();
  expect(mock.save).toHaveBeenCalledWith('driver-a', 'device-a', false, expect.any(AbortSignal));
});
it('discards a late permission result when the displayed account changes', async () => {
  let finish!: (saved: boolean) => void;
  mock.save.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
  const view = render(<DeviceCoachPermission {...props} allowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn off assistant' }));
  await waitFor(() => expect(mock.save).toHaveBeenCalledTimes(1));
  const signal = mock.save.mock.calls[0][3] as AbortSignal;
  view.rerender(<DeviceCoachPermission {...props} accountId="driver-b" deviceId="device-b" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(false));
  expect(screen.getByRole('button', { name: 'Allow assistant' })).toBeEnabled();
});
it('hides capability controls in example mode', () => {
  mock.demo = true;
  render(<DeviceCoachPermission {...props} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument(); expect(mock.save).not.toHaveBeenCalled();
});
