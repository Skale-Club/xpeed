import { vi } from 'vitest';

// Fake Web Bluetooth + ELM327 for page tests: a CAN car with RPM, speed and
// coolant on the engine ECU (7E0 / broadcast), and Toyota-style mode 21
// modules on 7E2/7E3. Replies arrive in 20-byte chunks like BLE notifications.

export const VIN = 'JTDKN3DU5A0123456';
const VIN_HEX = `490201${Array.from(VIN).map((c) => c.charCodeAt(0).toString(16).toUpperCase()).join('')}`;

const PID_DATA: Record<string, string> = { '0C': '1AF8', '0D': '32', '05': '7B' };
let hybridCounter = 0;
const MODE21_ECUS: Record<string, Record<string, () => string>> = {
  '7E3': { '21CE': () => '61CE7A' },
  '7E2': {
    // Second byte changes on every read, like a live sensor
    '2101': () => `6101AA${(hybridCounter++ % 256).toString(16).toUpperCase().padStart(2, '0')}`,
    '2181': () => ['00B', '0:61810102030405', '1:060708090000'].join('\r'),
  },
};

function elmReply(cmd: string, header: string, carOn: boolean): string {
  if (cmd === 'ATZ' || cmd === 'ATI') return 'ELM327 v1.5';
  if (cmd === 'ATDPN') return 'A6';
  if (cmd === 'ATRV') return '12.4V';
  if (cmd.startsWith('AT')) return 'OK';
  // Ignition off: the adapter is powered by the OBD port, but no ECU answers.
  if (!carOn) return cmd === '0100' ? 'SEARCHING...\rUNABLE TO CONNECT' : 'NO DATA';
  const ecu = MODE21_ECUS[header];
  if (ecu) return ecu[cmd]?.() ?? (cmd.startsWith('21') ? '7F2112' : 'NO DATA');
  if (header !== '7DF' && header !== '7E0') return 'NO DATA';
  const table: Record<string, string> = {
    '0100': 'SEARCHING...\r4100BE1FA813',
    '0120': '412000000000',
    '03': '430201330420',
    '07': '4700',
    '0A': '4A00',
    '04': '44',
    '0902': ['014', `0:${VIN_HEX.slice(0, 12)}`, `1:${VIN_HEX.slice(12, 26)}`, `2:${VIN_HEX.slice(26)}`].join('\r'),
  };
  if (table[cmd]) return table[cmd];
  if (cmd.startsWith('01')) {
    const pids = cmd.slice(2).match(/../g) ?? [];
    const parts = pids.filter((p) => PID_DATA[p]).map((p) => p + PID_DATA[p]);
    return parts.length ? `41${parts.join('')}` : 'NO DATA';
  }
  return 'NO DATA';
}

export function installFakeBluetooth(failConnects = 0) {
  const sent: string[] = [];
  let connectCalls = 0;
  let carOn = true;
  const char = Object.assign(new EventTarget(), {
    uuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    properties: { notify: true, indicate: false, write: true, writeWithoutResponse: false },
    value: undefined as DataView | undefined,
    startNotifications: async () => char,
  });
  let pending = '';
  let header = '7DF';
  Object.assign(char, {
    writeValue: async (bytes: Uint8Array) => {
      pending += new TextDecoder().decode(bytes);
      if (!pending.endsWith('\r')) return;
      const cmd = pending.trim();
      pending = '';
      sent.push(cmd);
      if (cmd.startsWith('ATSH')) header = cmd.slice(4);
      const out = new TextEncoder().encode(`${elmReply(cmd, header, carOn)}\r\r>`);
      setTimeout(() => {
        for (let i = 0; i < out.length; i += 20) {
          const part = out.slice(i, i + 20);
          char.value = new DataView(part.buffer);
          char.dispatchEvent(new Event('characteristicvaluechanged'));
        }
      }, 1);
    },
  });
  const server = {
    connected: true,
    connect: async () => {
      connectCalls++;
      if (connectCalls <= failConnects) throw new DOMException('Connection Error: Connection attempt failed.', 'NetworkError');
      server.connected = true;
      header = '7DF';
      return server;
    },
    disconnect: () => { server.connected = false; },
    getPrimaryServices: async () => [{ uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', getCharacteristics: async () => [char] }],
  };
  const device = Object.assign(new EventTarget(), { id: 'veepeak-1', name: 'VEEPEAK', gatt: server });
  const requestDevice = vi.fn(async () => device);
  const getDevices = vi.fn(async () => [device]);
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice, getDevices } });
  return {
    sent,
    connectCalls: () => connectCalls,
    requestDevice,
    /** Switch the ignition on/off. */
    setCarOn: (on: boolean) => { carOn = on; },
    /** The adapter drops the Bluetooth link (e.g. it went to sleep). */
    dropLink: () => {
      server.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
}

