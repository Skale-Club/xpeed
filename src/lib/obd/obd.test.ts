import { describe, it, expect } from 'vitest';
import {
  LIVE_PIDS, ADAPTER_VOLTAGE, pidHeader, parseMode01, parseSupportedPids,
  parseDtcReply, parseVin, decodeDtc, parseAdapterVoltage, parseMultiMode01, parseCustomReply,
} from './pids';
import { compileFormula, FormulaError } from './formula';
import { validateCustomPid, validateTerminalCommand } from './custom-pids';
import { buildScannerCsv, scannerFilename } from './session-csv';
import { Elm327, ElmTimeoutError, receiveAddressFor, type ObdLink } from './elm327';
import { classifyReply, diffSweeps, formatSweep } from './scan';
import { PID_PRESETS, mergePreset } from './presets';
import { matchCanonicalKey } from '@/lib/canonical-params';
import { parseCSV } from '@/lib/csv-parser';

describe('PID column headers', () => {
  const expected: Record<number, string | null> = {
    0x0c: 'engine_rpm',
    0x0d: 'vehicle_speed',
    0x05: 'coolant_temp',
    0x04: 'engine_load',
    0x11: 'throttle_position',
    0x06: 'stft_b1',
    0x07: 'ltft_b1',
    0x0f: 'intake_air_temp',
    0x10: 'maf',
    0x0b: 'map',
    0x0e: null,
    0x14: 'o2_b1s1',
    0x15: 'o2_b1s2',
    0x3c: 'catalyst_temp',
    0x42: 'battery_voltage_12v',
    0x46: 'ambient_air_temp',
    0x2f: 'fuel_level',
    0x5b: 'hybrid_battery_soc',
    0x5e: 'mpg_or_fuel_rate',
  };

  it.each(LIVE_PIDS.map((d) => [d.pid, d] as const))('PID %s maps to its canonical key', (pid, def) => {
    expect(matchCanonicalKey(pidHeader(def))?.canonical_key ?? null).toBe(expected[pid]);
  });

  it('adapter voltage maps to the 12V battery', () => {
    expect(matchCanonicalKey(pidHeader(ADAPTER_VOLTAGE))?.canonical_key).toBe('battery_voltage_12v');
  });
});

describe('Mode 01 parsing', () => {
  it('decodes RPM', () => {
    const rpm = LIVE_PIDS.find((d) => d.pid === 0x0c)!;
    const bytes = parseMode01(['410C1AF8'], 0x0c, 2);
    expect(rpm.decode(bytes!)).toBe(1726);
  });

  it('accepts spaced output and ignores other ECUs / wrong PIDs', () => {
    expect(parseMode01(['41 0D 00', '41 05 7B'], 0x05, 1)).toEqual([0x7b]);
  });

  it('returns null for NO DATA', () => {
    expect(parseMode01(['NO DATA'], 0x0c, 2)).toBeNull();
  });

  it('decodes the supported-PID bitmap', () => {
    // BE 1F A8 13 — the classic J1979 example
    expect(parseSupportedPids(['4100BE1FA813'], 0x00)).toEqual([
      0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20,
    ]);
  });
});

describe('DTC parsing', () => {
  it('decodes code letters', () => {
    expect(decodeDtc(0x01, 0x33)).toBe('P0133');
    expect(decodeDtc(0x41, 0x23)).toBe('C0123');
    expect(decodeDtc(0x80, 0x01)).toBe('B0001');
    expect(decodeDtc(0xc1, 0x55)).toBe('U0155');
    expect(decodeDtc(0, 0)).toBeNull();
  });

  it('parses CAN single-frame replies', () => {
    expect(parseDtcReply(['4302013302440000'], 0x43, true)).toEqual(['P0133', 'P0244']);
  });

  it('parses CAN multi-frame replies with padding', () => {
    const lines = ['00A', '0:43040133024403', '1:0004205555'];
    expect(parseDtcReply(lines, 0x43, true)).toEqual(['P0133', 'P0244', 'P0300', 'P0420']);
  });

  it('parses legacy (non-CAN) fixed frames', () => {
    expect(parseDtcReply(['43 01 33 00 00 00 00', '43 04 20 00 00 00 00'], 0x43, false)).toEqual(['P0133', 'P0420']);
  });

  it('returns nothing for "no codes"', () => {
    expect(parseDtcReply(['4300'], 0x43, true)).toEqual([]);
  });
});

describe('VIN parsing', () => {
  const vin = 'JTDKN3DU5A0123456';
  const hex = Array.from(vin).map((c) => c.charCodeAt(0).toString(16).toUpperCase()).join('');

  it('parses CAN multi-frame VIN', () => {
    const payload = `490201${hex}`;
    const lines = ['014', `0:${payload.slice(0, 12)}`, `1:${payload.slice(12, 26)}`, `2:${payload.slice(26)}`];
    expect(parseVin(lines)).toBe(vin);
  });

  it('parses legacy VIN frames', () => {
    const data = `000000${hex}`; // 3 bytes padding + 17 chars = 20 bytes, 4 per frame
    const lines = [0, 1, 2, 3, 4].map((i) => `49020${i + 1}${data.slice(i * 8, i * 8 + 8)}`);
    expect(parseVin(lines)).toBe(vin);
  });
});

describe('adapter voltage', () => {
  it('parses ATRV', () => {
    expect(parseAdapterVoltage(['12.6V'])).toBe(12.6);
    expect(parseAdapterVoltage(['?'])).toBeNull();
  });
});

describe('scanner CSV', () => {
  it('round-trips through the upload parser', () => {
    const rpm = pidHeader(LIVE_PIDS[0]);
    const coolant = pidHeader(LIVE_PIDS[2]);
    const csv = buildScannerCsv([rpm, coolant], [
      { t: 0, values: { [rpm]: 800, [coolant]: 85 } },
      { t: 1.25, values: { [rpm]: 1726.5, [coolant]: null } },
    ], ['P0420', 'P0133']);
    const parsed = parseCSV(csv);
    expect(parsed.timeColumn).toEqual({ type: 'seconds', key: 'Time (s)' });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1][rpm]).toBe(1726.5);
    expect(parsed.headerMapping[coolant]?.canonical_key).toBe('coolant_temp');
    expect(parsed.activeDtcs).toEqual(['P0133', 'P0420']);
  });

  it('builds a filename the upload hook can date', () => {
    const name = scannerFilename(new Date(2026, 9, 28, 15, 30, 5));
    expect(name).toBe('xpeed-scan_2026-10-28 15-30-05.csv');
    expect(name).toMatch(/(\d{4})-(\d{2})-(\d{2})[\s_-](\d{2})-(\d{2})-(\d{2})/);
  });
});

function fakeLink(reply: (cmd: string) => string | null): ObdLink & { sent: string[] } {
  let cb: (chunk: string) => void = () => undefined;
  const sent: string[] = [];
  return {
    name: 'fake',
    sent,
    async write(data) {
      const cmd = data.trim();
      sent.push(cmd);
      const r = reply(cmd);
      if (r === null) return;
      // Deliver in small chunks like BLE notifications do.
      const full = `${r}\r\r>`;
      setTimeout(() => {
        for (let i = 0; i < full.length; i += 5) cb(full.slice(i, i + 5));
      }, 0);
    },
    onData(fn) { cb = fn; },
    close() {},
  };
}

describe('Elm327', () => {
  it('serializes commands and reassembles chunked replies', async () => {
    const elm = new Elm327(fakeLink((cmd) => (cmd === '010C' ? '410C1AF8' : '410D32')));
    const [a, b] = await Promise.all([elm.send('010C'), elm.send('010D')]);
    expect(a).toEqual(['410C1AF8']);
    expect(b).toEqual(['410D32']);
  });

  it('initializes and detects a CAN protocol', async () => {
    const link = fakeLink((cmd) => {
      if (cmd === 'ATI') return 'ELM327 v1.5';
      if (cmd === '0100') return 'SEARCHING...\r4100BE1FA813';
      if (cmd === 'ATDPN') return 'A6';
      return 'OK';
    });
    const info = await new Elm327(link).initialize();
    expect(info).toEqual({ version: 'ELM327 v1.5', protocol: '6', isCan: true });
    expect(link.sent.slice(0, 7)).toEqual(['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']);
  });

  it('fails initialization when the ECU does not answer', async () => {
    const link = fakeLink((cmd) => (cmd === '0100' ? 'UNABLE TO CONNECT' : 'OK'));
    await expect(new Elm327(link).initialize()).rejects.toThrow(/UNABLE TO CONNECT/);
  });

  it('times out and keeps the queue usable', async () => {
    const elm = new Elm327(fakeLink((cmd) => (cmd === 'HANG' ? null : 'OK')));
    const hang = elm.send('HANG', 30);
    const next = elm.send('ATE0');
    await expect(hang).rejects.toBeInstanceOf(ElmTimeoutError);
    await expect(next).resolves.toEqual(['OK']);
  });
});

describe('formula', () => {
  it('evaluates Torque-style expressions', () => {
    expect(compileFormula('(A*256+B)/4')([0x1a, 0xf8])).toBe(1726);
    expect(compileFormula('A-40')([0x7b])).toBe(83);
    expect(compileFormula('-A+2*(B-1)')([3, 5])).toBe(5);
    expect(compileFormula('SIGNED(A)')([0xff])).toBe(-1);
    expect(compileFormula('{B:3}')([0, 0b1000])).toBe(1);
    expect(compileFormula('AA')(Array.from({ length: 27 }, (_, i) => i))).toBe(26);
  });

  it('returns null when bytes are missing or the result is not finite', () => {
    expect(compileFormula('A*256+B')([1])).toBeNull();
    expect(compileFormula('A/B')([1, 0])).toBeNull();
  });

  it('rejects bad syntax and anything that is not arithmetic', () => {
    expect(() => compileFormula('A*')).toThrow(FormulaError);
    expect(() => compileFormula('alert(1)')).toThrow(FormulaError);
    expect(() => compileFormula('A;B')).toThrow(FormulaError);
    expect(() => compileFormula('')).toThrow(FormulaError);
  });
});

describe('multi-PID and custom replies', () => {
  const defs = LIVE_PIDS.filter((d) => [0x0c, 0x0d, 0x05].includes(d.pid));

  it('splits a multi-PID reply', () => {
    const got = parseMultiMode01(['410C1AF80D32057B'], defs);
    expect(got.get(0x0c)).toEqual([0x1a, 0xf8]);
    expect(got.get(0x0d)).toEqual([0x32]);
    expect(got.get(0x05)).toEqual([0x7b]);
  });

  it('merges multi-frame and multi-ECU multi-PID replies', () => {
    const got = parseMultiMode01(['009', '0:410C1AF80D32', '1:057B00000000', '410D10'], defs);
    expect(got.get(0x05)).toEqual([0x7b]);
    expect(got.get(0x0d)).toEqual([0x32]);
  });

  it('merges supported-PID bitmaps from several ECUs', () => {
    expect(parseSupportedPids(['410080000000', '410000000001'], 0x00)).toEqual([0x01, 0x20]);
  });

  it('strips the response header of custom replies', () => {
    expect(parseCustomReply(['00B', '0:61810102030405', '1:060708090000'], '2181')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parseCustomReply(['62F190AABB'], '22F190')).toEqual([0xaa, 0xbb]);
    expect(parseCustomReply(['7F2112'], '2181')).toBeNull();
  });
});

describe('custom PIDs', () => {
  const base = { name: 'SOC', unit: '%', header: '7E3', command: '2181', formula: 'A/2', min: 0, max: 100 };

  it('validates definitions', () => {
    expect(validateCustomPid(base)).toBeNull();
    expect(validateCustomPid({ ...base, command: '2E0101' })).toMatch(/read request/);
    expect(validateCustomPid({ ...base, command: '04' })).toMatch(/read request/);
    expect(validateCustomPid({ ...base, header: 'XYZ' })).toMatch(/header/);
    expect(validateCustomPid({ ...base, formula: 'A+' })).toMatch(/Formula/);
    expect(validateCustomPid({ ...base, max: 0 })).toMatch(/Max/);
  });

  it('limits the terminal to reads', () => {
    expect(validateTerminalCommand('2181', '7E3')).toBeNull();
    expect(validateTerminalCommand('010C0D', null)).toBeNull();
    expect(validateTerminalCommand('ATRV', null)).toBeNull();
    for (const cmd of ['04', '1101', '2E0101AA', '3101', 'ATZ', 'ATSH7E0', 'ATMA']) {
      expect(validateTerminalCommand(cmd, null)).not.toBeNull();
    }
  });
});

describe('Elm327 headers', () => {
  it('switches header only when needed and returns to broadcast', async () => {
    const link = fakeLink((cmd) => {
      if (cmd === '0100') return '4100BE1FA813';
      if (cmd === 'ATDPN') return 'A6';
      if (cmd === '2181') return '61810102';
      if (cmd === '010C') return '410C1AF8';
      return 'OK';
    });
    const elm = new Elm327(link);
    await elm.initialize();
    link.sent.length = 0;
    await Promise.all([elm.request('2181', '7E3'), elm.request('2181', '7E3'), elm.request('010C'), elm.request('2181', '7E3')]);
    expect(link.sent).toEqual(['ATSH7E3', '2181', '2181', 'ATSH7DF', '010C', 'ATSH7E3', '2181']);
  });

  it('refuses ECU headers on non-CAN protocols', async () => {
    const link = fakeLink((cmd) => (cmd === '0100' ? '4100BE1FA813' : cmd === 'ATDPN' ? 'A3' : 'OK'));
    const elm = new Elm327(link);
    await elm.initialize();
    await expect(elm.request('2181', '7E3')).rejects.toThrow(/CAN/);
  });
});

describe('ECU discovery helpers', () => {
  it('derives the CAN receive address', () => {
    expect(receiveAddressFor('7E2')).toBeNull();
    expect(receiveAddressFor('7C0')).toBe('7C8');
    expect(receiveAddressFor('7D2')).toBe('7DA');
    expect(receiveAddressFor('18DA10F1')).toBe('18DAF110');
  });

  it('classifies positive, negative and empty replies', () => {
    expect(classifyReply(['00B', '0:61810102030405', '1:060708090000'], '2181')).toEqual({ kind: 'positive', data: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(classifyReply(['7F2112'], '21C3')).toEqual({ kind: 'negative', nrc: 0x12 });
    expect(classifyReply(['NO DATA'], '2181')).toEqual({ kind: 'none' });
    expect(classifyReply(['7F2178', '6101AA'], '2101')).toEqual({ kind: 'positive', data: [0xaa] });
    // A positive reply for a different identifier does not count
    expect(classifyReply(['6102AA'], '2101')).toEqual({ kind: 'none' });
  });

  it('highlights bytes that changed between sweeps and formats a report', () => {
    const first = diffSweeps(undefined, [{ command: '2101', data: [1, 2, 3] }]);
    expect(first[0].changed).toEqual([]);
    const second = diffSweeps(first, [{ command: '2101', data: [1, 9, 3] }, { command: '2102', data: [5] }]);
    expect(second.map((h) => h.changed)).toEqual([[1], []]);
    expect(formatSweep('7E2', second)).toBe('ECU 7E2 — 2 PIDs\n2101 [3] 01 09 03  changed: 1\n2102 [1] 05');
  });

  it('sets and clears the receive filter for non-OBD modules', async () => {
    const link = fakeLink((cmd) => (cmd === '0100' ? '4100BE1FA813' : cmd === 'ATDPN' ? 'A6' : cmd === '2101' ? '6101AA' : 'OK'));
    const elm = new Elm327(link);
    await elm.initialize();
    link.sent.length = 0;
    await elm.request('2101', '7C0');
    await elm.request('2101', '7E2');
    await elm.request('0100');
    expect(link.sent).toEqual(['ATSH7C0', 'ATCRA7C8', '2101', 'ATSH7E2', 'ATAR', '2101', 'ATSH7DF', '0100']);
  });
});

describe('Prius Gen3 preset (real 2010 Prius replies)', () => {
  const hex = (s: string) => s.split(' ').map((b) => parseInt(b, 16));
  // 7E2 / 2181 and 2174 data bytes captured from the car, idle then charging
  const idle2181 = hex('30 49 2F E7 2F AE 2F E7 2F 5C 2F BE 2F D7 2F E7 2F 74 2F D7 2F BE 30 10 2F E7 30 72 AD DB 08 2A 0F');
  const charging2181 = hex('33 AE 33 6C 33 43 33 6C 33 22 33 5C 33 5C 33 6C 33 0A 33 5C 33 43 33 95 33 6C 33 BE AD CA 08 CA 0F');
  const charging2174 = hex('46 42 41 49 00 01 C0 01 C5');
  const preset = PID_PRESETS.find((p) => p.id === 'prius-gen3')!.pids();
  const byName = (n: string) => preset.find((p) => p.name === n)!;
  const run = (n: string, bytes: number[]) => compileFormula(byName(n).formula)(bytes)!;

  it('defines valid read-only PIDs on the hybrid ECU', () => {
    expect(preset).toHaveLength(18);
    for (const p of preset) {
      expect(validateCustomPid(p)).toBeNull();
      expect(p.header).toBe('7E2');
      // None may be mistaken for the 12 V battery or another canonical sensor
      expect(matchCanonicalKey(pidHeader(p))).toBeNull();
    }
  });

  it('decodes block voltages that add up to the reported pack voltage', () => {
    for (const bytes of [idle2181, charging2181]) {
      const blocks = Array.from({ length: 14 }, (_, k) => run(`HV block ${String(k + 1).padStart(2, '0')}`, bytes));
      const pack = run('HV pack voltage', bytes);
      expect(Math.abs(blocks.reduce((a, b) => a + b, 0) - pack)).toBeLessThan(1);
      expect(run('HV block spread', bytes)).toBeCloseTo(Math.max(...blocks) - Math.min(...blocks), 6);
    }
    expect(run('HV block 01', idle2181)).toBeCloseTo(15.09, 2);
    expect(run('HV pack voltage', idle2181)).toBe(209);
    expect(run('HV block spread', idle2181)).toBeCloseTo(0.339, 3);
    expect(run('HV pack voltage', charging2181)).toBe(225);
    expect(run('HV before boost', charging2174)).toBe(224);
    expect(run('HV after boost', charging2174)).toBe(226.5);
  });

  it('merges without duplicating', () => {
    const once = mergePreset([], preset);
    expect(mergePreset(once, PID_PRESETS[0].pids())).toHaveLength(18);
  });

  it('supports MAX/MIN in formulas', () => {
    expect(compileFormula('MAX(A,B,C)-MIN(A,B,C)')([5, 9, 2])).toBe(7);
    expect(() => compileFormula('MAX(A,)')).toThrow(FormulaError);
  });
});
