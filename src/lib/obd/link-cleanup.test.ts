import { describe, it, expect, vi, beforeEach } from 'vitest';

// A link that fails to finish opening must not stay connected: adapters that
// take a single client would refuse every later attempt until unplugged.

const native = vi.hoisted(() => ({ on: false }));
const ble = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  isEnabled: vi.fn(async () => true),
  connect: vi.fn(async () => undefined),
  getServices: vi.fn(async () => [] as unknown[]),
  startNotifications: vi.fn(async () => undefined),
  stopNotifications: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.on, getPlatform: () => 'android' },
  registerPlugin: () => ({}),
}));
vi.mock('@capacitor-community/bluetooth-le', () => ({ BleClient: ble }));

import { connectBleLink } from './elm327';

beforeEach(() => {
  native.on = false;
  Object.values(ble).forEach((fn) => fn.mockClear());
  ble.connect.mockReset().mockResolvedValue(undefined);
  ble.startNotifications.mockReset().mockResolvedValue(undefined);
  ble.getServices.mockReset().mockResolvedValue([]);
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: vi.fn() } });
});

describe('web link', () => {
  function device(failAt: 'services' | 'characteristics' | 'notifications') {
    const char = Object.assign(new EventTarget(), {
      uuid: 'ffe1',
      properties: { notify: true, indicate: false, write: true, writeWithoutResponse: false },
      startNotifications: async () => {
        if (failAt === 'notifications') throw new Error('notifications refused');
        return char;
      },
      writeValue: async () => undefined,
    });
    const server = {
      connected: true,
      connect: async () => server,
      disconnect: vi.fn(() => { server.connected = false; }),
      getPrimaryServices: async () => {
        if (failAt === 'services') throw new Error('no services');
        return [{
          uuid: 'ffe0',
          getCharacteristics: async () => {
            if (failAt === 'characteristics') throw new Error('no characteristics');
            return [char];
          },
        }];
      },
    };
    return { dev: Object.assign(new EventTarget(), { id: 'd1', name: 'VEEPEAK', gatt: server }), server };
  }

  it.each(['services', 'characteristics', 'notifications'] as const)('disconnects when %s fails after connecting', async (failAt) => {
    const { dev, server } = device(failAt);
    await expect(connectBleLink(() => undefined, { device: dev })).rejects.toThrow();
    expect(server.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses to write once closed', async () => {
    const { dev, server } = device('none' as never);
    const link = await connectBleLink(() => undefined, { device: dev });
    link.close();
    expect(server.disconnect).toHaveBeenCalled();
    await expect(link.write('0100\r')).rejects.toThrow(/closed/);
  });
});

describe('Android link', () => {
  const service = (over: { notify?: boolean } = {}) => ({
    uuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
    characteristics: [{ uuid: 'ffe1', properties: { notify: over.notify ?? true, write: true } }],
  });

  it('cleans up a failed Android connection and retries without reporting a dropped link', async () => {
    vi.useFakeTimers();
    try {
      native.on = true;
      ble.getServices.mockResolvedValue([service()]);
      const onDrop = vi.fn();
      const callbacks: (() => void)[] = [];
      ble.connect.mockImplementation(async (...args: unknown[]) => {
        const callback = args[1] as () => void;
        callbacks.push(callback);
        if (callbacks.length === 1) {
          callback();
          throw new Error('Connection failed with status 133');
        }
      });
      const opening = connectBleLink(onDrop, { device: { nativeId: 'aa:bb' } });
      await vi.runAllTimersAsync();
      const link = await opening;
      expect(ble.connect).toHaveBeenCalledTimes(2);
      expect(ble.disconnect).toHaveBeenCalledWith('aa:bb');
      callbacks[0]();
      expect(onDrop).not.toHaveBeenCalled();
      callbacks[1]();
      expect(onDrop).toHaveBeenCalledTimes(1);
      link.close();
      callbacks[1]();
      expect(onDrop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry denied permission and preserves the reason', async () => {
    native.on = true;
    ble.connect.mockRejectedValue(new Error('Permission denied'));
    await expect(connectBleLink(() => undefined, { device: { nativeId: 'aa:bb' } }))
      .rejects.toThrow('Bluetooth connection: Permission denied');
    expect(ble.connect).toHaveBeenCalledTimes(1);
    expect(ble.disconnect).toHaveBeenCalledWith('aa:bb');
  });

  it('disconnects when starting notifications fails', async () => {
    native.on = true;
    ble.getServices.mockResolvedValue([service()]);
    ble.startNotifications.mockRejectedValue(new Error('cannot subscribe'));
    const onDrop = vi.fn();
    await expect(connectBleLink(onDrop, { device: { nativeId: 'aa:bb' } })).rejects.toThrow(/cannot subscribe/);
    expect(ble.disconnect).toHaveBeenCalledWith('aa:bb');
  });

  it('disconnects when reading the services fails', async () => {
    native.on = true;
    ble.getServices.mockRejectedValue(new Error('discovery failed'));
    await expect(connectBleLink(() => undefined, { device: { nativeId: 'aa:bb' } })).rejects.toThrow();
    expect(ble.disconnect).toHaveBeenCalledWith('aa:bb');
  });
});
