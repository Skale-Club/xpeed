import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  callbacks: {} as Record<string, (event: { connectionId: string; data?: string }) => void>,
  remove: vi.fn(async () => undefined),
  connect: vi.fn(async (_options: { connectionId: string; deviceId: string }) => undefined),
  disconnect: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isPluginAvailable: () => true },
  registerPlugin: () => ({
    ...mock,
    addListener: async (event: string, callback: typeof mock.callbacks[string]) => {
      mock.callbacks[event] = callback;
      return { remove: mock.remove };
    },
  }),
}));
vi.mock('@/lib/i18n', () => ({ default: { t: (_key: string, fallback: string) => fallback } }));
import { connectSerialLink } from './native-serial';

beforeEach(() => {
  vi.clearAllMocks();
  mock.callbacks = {};
  mock.connect.mockReset().mockResolvedValue(undefined);
});

describe('Classic Bluetooth transport', () => {
  it('routes serial data and ignores stale connection events', async () => {
    const dropped = vi.fn();
    const link = await connectSerialLink('AA:BB:CC:DD:EE:FF', 'OBDLink MX+', dropped);
    const { connectionId } = mock.connect.mock.calls[0][0];
    const data = vi.fn();
    link.onData(data);
    mock.callbacks.data({ connectionId: 'old', data: 'wrong' });
    mock.callbacks.disconnected({ connectionId: 'old' });
    expect(data).not.toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
    mock.callbacks.data({ connectionId, data: 'ELM327\r>' });
    expect(data).toHaveBeenCalledWith('ELM327\r>');
    await link.write('ATI\r');
    expect(mock.write).toHaveBeenCalledWith({ connectionId, data: 'ATI\r' });
    expect(link.nativeId).toBe('classic:AA:BB:CC:DD:EE:FF');
    mock.callbacks.disconnected({ connectionId });
    mock.callbacks.disconnected({ connectionId });
    expect(dropped).toHaveBeenCalledTimes(1);
    await expect(link.write('ATI\r')).rejects.toThrow(/closed/);
    link.close();
    await vi.waitFor(() => expect(mock.remove).toHaveBeenCalledTimes(2));
  });

  it('cleans up failed opens without leaving subscriptions', async () => {
    mock.connect.mockRejectedValue(new Error('Socket timeout'));
    await expect(connectSerialLink('AA:BB:CC:DD:EE:FF', 'VEEPEAK', vi.fn()))
      .rejects.toThrow('Socket timeout');
    expect(mock.disconnect).toHaveBeenCalledTimes(1);
    expect(mock.remove).toHaveBeenCalledTimes(2);
  });

  it('does not start the scanner reconnect loop when the socket drops during opening', async () => {
    const dropped = vi.fn();
    mock.connect.mockImplementation(async ({ connectionId }) => {
      mock.callbacks.disconnected({ connectionId });
    });
    await expect(connectSerialLink('AA:BB:CC:DD:EE:FF', 'VEEPEAK', dropped))
      .rejects.toThrow(/while opening/);
    expect(dropped).not.toHaveBeenCalled();
    expect(mock.remove).toHaveBeenCalledTimes(2);
  });

  it('closing locally suppresses drops and prevents writes', async () => {
    const dropped = vi.fn();
    const link = await connectSerialLink('AA:BB:CC:DD:EE:FF', 'ELM327', dropped);
    const { connectionId } = mock.connect.mock.calls[0][0];
    link.close();
    link.close();
    mock.callbacks.disconnected({ connectionId });
    expect(dropped).not.toHaveBeenCalled();
    await expect(link.write('ATI\r')).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(mock.remove).toHaveBeenCalledTimes(2));
    expect(mock.disconnect).toHaveBeenCalledTimes(1);
  });
});
