import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  available: true,
  choose: vi.fn(),
  serial: vi.fn(),
  initialize: vi.fn(),
  picker: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));
vi.mock('./native-serial', () => ({
  CLASSIC_PREFIX: 'classic:',
  hasClassicBluetooth: () => mock.available,
  chooseNativeAdapter: mock.choose,
  connectSerialLink: mock.serial,
}));
vi.mock('@capacitor-community/bluetooth-le', () => ({ BleClient: {
  initialize: mock.initialize, isEnabled: async () => true, requestDevice: mock.picker,
} }));
import { connectNativeLink } from './native-ble';
beforeEach(() => { vi.clearAllMocks(); mock.available = true; });

it('opens the selected paired classic adapter', async () => {
  mock.choose.mockResolvedValue({ deviceId: 'AA:BB', name: 'OBDLink LX' });
  mock.serial.mockResolvedValue({ nativeId: 'classic:AA:BB' });
  const drop = vi.fn();
  await connectNativeLink(drop, [0xffe0]);
  expect(mock.serial).toHaveBeenCalledWith('AA:BB', 'OBDLink LX', drop);
  expect(mock.picker).not.toHaveBeenCalled();
});
it('reopens classic adapters without a picker', async () => {
  const drop = vi.fn();
  await connectNativeLink(drop, [], { deviceId: 'classic:AA:BB', name: 'VEEPEAK' });
  expect(mock.serial).toHaveBeenCalledWith('AA:BB', 'VEEPEAK', drop);
  expect(mock.choose).not.toHaveBeenCalled();
});
it('keeps BLE selection working on older APKs', async () => {
  mock.available = false;
  mock.picker.mockRejectedValue(new Error('Cancelled'));
  await expect(connectNativeLink(vi.fn(), [0xffe0])).rejects.toThrow('Cancelled');
  expect(mock.choose).not.toHaveBeenCalled();
  expect(mock.picker).toHaveBeenCalled();
});
it('routes the BLE choice to the existing scanner', async () => {
  mock.choose.mockResolvedValue({ ble: true });
  mock.picker.mockRejectedValue(new Error('Cancelled'));
  await expect(connectNativeLink(vi.fn(), [0xffe0])).rejects.toThrow('Cancelled');
  expect(mock.picker).toHaveBeenCalled();
  expect(mock.serial).not.toHaveBeenCalled();
});
