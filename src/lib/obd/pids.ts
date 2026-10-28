// SAE J1979 Mode 01 PIDs read by the live scanner, plus reply parsers for
// supported-PID bitmaps, DTCs (modes 03/07/0A) and the VIN (mode 09).
//
// `name` doubles as the CSV column header of recorded sessions, so it must
// resolve to the intended key in matchCanonicalKey() (see obd.test.ts).

export interface PidDef {
  pid: number;
  name: string;
  unit: string;
  bytes: number;
  decode: (b: number[]) => number;
  /** Gauge range for the live tile. */
  min: number;
  max: number;
}

export const LIVE_PIDS: PidDef[] = [
  { pid: 0x0c, name: 'Engine RPM', unit: 'rpm', bytes: 2, decode: ([a, b]) => (256 * a + b) / 4, min: 0, max: 8000 },
  { pid: 0x0d, name: 'Vehicle speed', unit: 'km/h', bytes: 1, decode: ([a]) => a, min: 0, max: 200 },
  { pid: 0x05, name: 'Engine coolant temperature', unit: '°C', bytes: 1, decode: ([a]) => a - 40, min: -40, max: 130 },
  { pid: 0x04, name: 'Calculated engine load', unit: '%', bytes: 1, decode: ([a]) => (a * 100) / 255, min: 0, max: 100 },
  { pid: 0x11, name: 'Throttle position', unit: '%', bytes: 1, decode: ([a]) => (a * 100) / 255, min: 0, max: 100 },
  { pid: 0x06, name: 'Short term fuel trim B1', unit: '%', bytes: 1, decode: ([a]) => ((a - 128) * 100) / 128, min: -25, max: 25 },
  { pid: 0x07, name: 'Long term fuel trim B1', unit: '%', bytes: 1, decode: ([a]) => ((a - 128) * 100) / 128, min: -25, max: 25 },
  { pid: 0x0f, name: 'Intake air temperature', unit: '°C', bytes: 1, decode: ([a]) => a - 40, min: -40, max: 100 },
  { pid: 0x10, name: 'Mass air flow', unit: 'g/s', bytes: 2, decode: ([a, b]) => (256 * a + b) / 100, min: 0, max: 200 },
  { pid: 0x0b, name: 'Manifold absolute pressure', unit: 'kPa', bytes: 1, decode: ([a]) => a, min: 0, max: 255 },
  { pid: 0x0e, name: 'Timing advance', unit: '°', bytes: 1, decode: ([a]) => a / 2 - 64, min: -20, max: 60 },
  { pid: 0x14, name: 'O2 sensor B1S1', unit: 'V', bytes: 2, decode: ([a]) => a / 200, min: 0, max: 1.275 },
  { pid: 0x15, name: 'Sensor B1S2 voltage', unit: 'V', bytes: 2, decode: ([a]) => a / 200, min: 0, max: 1.275 },
  { pid: 0x3c, name: 'Catalyst temperature', unit: '°C', bytes: 2, decode: ([a, b]) => (256 * a + b) / 10 - 40, min: 0, max: 1000 },
  { pid: 0x42, name: 'Control module voltage', unit: 'V', bytes: 2, decode: ([a, b]) => (256 * a + b) / 1000, min: 10, max: 16 },
  { pid: 0x46, name: 'Ambient air temperature', unit: '°C', bytes: 1, decode: ([a]) => a - 40, min: -40, max: 60 },
  { pid: 0x2f, name: 'Fuel level', unit: '%', bytes: 1, decode: ([a]) => (a * 100) / 255, min: 0, max: 100 },
  { pid: 0x5b, name: 'Hybrid battery remaining life', unit: '%', bytes: 1, decode: ([a]) => (a * 100) / 255, min: 0, max: 100 },
  { pid: 0x5e, name: 'Engine fuel rate', unit: 'L/h', bytes: 2, decode: ([a, b]) => (256 * a + b) / 20, min: 0, max: 30 },
];

/** Pseudo-PID for the adapter's own pin-16 voltage reading (ATRV). */
export const ADAPTER_VOLTAGE: Omit<PidDef, 'pid' | 'bytes' | 'decode'> = {
  name: 'Battery voltage', unit: 'V', min: 10, max: 16,
};

export function pidHeader(def: { name: string; unit: string }): string {
  return `${def.name} (${def.unit})`;
}

export function pidHex(pid: number): string {
  return pid.toString(16).toUpperCase().padStart(2, '0');
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function normalize(line: string): string {
  return line.replace(/\s/g, '').toUpperCase();
}

/**
 * Group reply lines into messages. Handles ISO 15765 multi-frame output with
 * headers off ("014" length line, then "0:..", "1:..") and trims padding.
 * Each ECU that answers produces its own message.
 */
export function collectMessages(lines: string[]): number[][] {
  const messages: number[][] = [];
  let current: number[] | null = null;
  let expected: number | null = null;

  const finish = () => {
    if (current && expected !== null) current.splice(expected);
    current = null;
    expected = null;
  };

  for (const raw of lines) {
    const l = normalize(raw);
    const frame = l.match(/^([0-9A-F]):([0-9A-F]+)$/);
    if (frame) {
      if (frame[1] === '0' || !current) {
        const len = expected;
        finish();
        expected = len;
        current = [];
        messages.push(current);
      }
      current.push(...hexToBytes(frame[2]));
      continue;
    }
    if (/^[0-9A-F]{3}$/.test(l)) {
      finish();
      expected = parseInt(l, 16);
      continue;
    }
    finish();
    if (/^[0-9A-F]+$/.test(l) && l.length % 2 === 0) messages.push(hexToBytes(l));
  }
  finish();
  return messages;
}

/** Data bytes of a Mode 01 reply for `pid`, or null for NO DATA / errors. */
export function parseMode01(lines: string[], pid: number, bytes: number): number[] | null {
  for (const msg of collectMessages(lines)) {
    if (msg[0] === 0x41 && msg[1] === pid && msg.length >= 2 + bytes) {
      return msg.slice(2, 2 + bytes);
    }
  }
  return null;
}

/**
 * Data bytes per PID from a multi-PID Mode 01 reply ("010C0D05" →
 * "41 0C a b 0D a 05 a"). CAN only, up to 6 PIDs per request. When several
 * ECUs answer, the first value seen for a PID wins.
 */
export function parseMultiMode01(lines: string[], defs: Pick<PidDef, 'pid' | 'bytes'>[]): Map<number, number[]> {
  const sizes = new Map(defs.map((d) => [d.pid, d.bytes]));
  const out = new Map<number, number[]>();
  for (const msg of collectMessages(lines)) {
    if (msg[0] !== 0x41) continue;
    let i = 1;
    while (i < msg.length) {
      const size = sizes.get(msg[i]);
      if (size === undefined || i + 1 + size > msg.length) break;
      if (!out.has(msg[i])) out.set(msg[i], msg.slice(i + 1, i + 1 + size));
      i += 1 + size;
    }
  }
  return out;
}

/**
 * Data bytes of a reply to an arbitrary read request such as "2181" or
 * "22F190": the positive-response byte (mode + 0x40) and the echoed PID are
 * stripped, so byte A of a Torque-style formula is the first value byte.
 */
export function parseCustomReply(lines: string[], command: string): number[] | null {
  const cmd = command.toUpperCase();
  const mode = parseInt(cmd.slice(0, 2), 16);
  const pid = hexToBytes(cmd.slice(2));
  for (const msg of collectMessages(lines)) {
    if (msg[0] !== mode + 0x40) continue;
    if (pid.every((b, i) => msg[1 + i] === b)) return msg.slice(1 + pid.length);
  }
  return null;
}

/** Decode a supported-PIDs bitmap (reply to 0100 / 0120 / 0140), merged across ECUs. */
export function parseSupportedPids(lines: string[], base: number): number[] {
  const pids = new Set<number>();
  for (const msg of collectMessages(lines)) {
    if (msg[0] !== 0x41 || msg[1] !== base || msg.length < 6) continue;
    msg.slice(2, 6).forEach((byte, i) => {
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) pids.add(base + i * 8 + bit + 1);
      }
    });
  }
  return Array.from(pids).sort((a, b) => a - b);
}

export function decodeDtc(a: number, b: number): string | null {
  if (a === 0 && b === 0) return null;
  const letter = 'PCBU'[a >> 6];
  return `${letter}${(a >> 4) & 0x3}${(a & 0xf).toString(16)}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

/**
 * Parse a DTC reply. `responseByte` is 0x43 (stored), 0x47 (pending) or
 * 0x4A (permanent). On CAN the byte after the mode is a DTC count; legacy
 * protocols return fixed 3-code frames padded with zeros.
 */
export function parseDtcReply(lines: string[], responseByte: number, isCan: boolean): string[] {
  const codes = new Set<string>();
  for (const msg of collectMessages(lines)) {
    if (msg[0] !== responseByte) continue;
    let payload = msg.slice(1);
    if (isCan) {
      const count = payload[0] ?? 0;
      payload = payload.slice(1, 1 + count * 2);
    }
    for (let i = 0; i + 1 < payload.length; i += 2) {
      const code = decodeDtc(payload[i], payload[i + 1]);
      if (code) codes.add(code);
    }
  }
  return Array.from(codes);
}

/** Parse a Mode 09 PID 02 reply into a 17-char VIN, or null. */
export function parseVin(lines: string[]): string | null {
  const bytes: number[] = [];
  for (const msg of collectMessages(lines)) {
    if (msg[0] === 0x49 && msg[1] === 0x02) bytes.push(...msg.slice(3));
  }
  const vin = String.fromCharCode(...bytes.filter((b) => b > 0x20 && b < 0x7f)).replace(/[^A-Z0-9]/gi, '');
  return vin.length >= 17 ? vin.slice(-17).toUpperCase() : null;
}

/** Parse an ATRV reply like "12.6V". */
export function parseAdapterVoltage(lines: string[]): number | null {
  const m = lines.join(' ').match(/(\d+(?:\.\d+)?)\s*V/i);
  return m ? Number(m[1]) : null;
}
