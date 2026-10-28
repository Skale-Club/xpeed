// Discovery helpers: find which ECUs answer and which mode 21 local
// identifiers they support. Everything here only sends read requests.

import { collectMessages } from './pids';

/** 11-bit request IDs worth probing: OBD range plus modules Toyota hybrids use. */
export const ECU_CANDIDATES = [
  '7E0', '7E1', '7E2', '7E3', '7E4', '7E5', '7E6', '7E7',
  '7C0', '7C4', '7D0', '7D2', '7B0', '7A1', '7A2',
];

export const NRC_NAMES: Record<number, string> = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'not supported',
  0x13: 'bad length',
  0x22: 'conditions not correct',
  0x31: 'out of range',
  0x33: 'security access denied',
  0x78: 'response pending',
};

export type ReplyKind =
  | { kind: 'positive'; data: number[] }
  | { kind: 'negative'; nrc: number }
  | { kind: 'none' };

/**
 * Classify a reply to `command` (e.g. "2181"): positive data with the echoed
 * mode/PID stripped, a negative response (7F <mode> <NRC>), or nothing.
 * A positive message wins over a "response pending" seen before it.
 */
export function classifyReply(lines: string[], command: string): ReplyKind {
  const mode = parseInt(command.slice(0, 2), 16);
  const pidLen = (command.length - 2) / 2;
  const pid = command.slice(2).toUpperCase();
  let negative: number | null = null;
  for (const msg of collectMessages(lines)) {
    if (msg[0] === mode + 0x40) {
      const echoed = msg.slice(1, 1 + pidLen).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      if (echoed === pid) return { kind: 'positive', data: msg.slice(1 + pidLen) };
    }
    if (msg[0] === 0x7f && msg[1] === mode && msg.length >= 3 && negative === null) negative = msg[2];
  }
  return negative !== null ? { kind: 'negative', nrc: negative } : { kind: 'none' };
}

export function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export interface EcuProbe {
  header: string;
  /** null = nobody answered. */
  reply: ReplyKind | null;
}

export interface SweepHit {
  command: string;
  data: number[];
  /** Byte indexes that changed since the previous sweep of the same ECU. */
  changed: number[];
}

/** Mark bytes that changed against an earlier sweep (same command). */
export function diffSweeps(previous: SweepHit[] | undefined, current: Omit<SweepHit, 'changed'>[]): SweepHit[] {
  const prev = new Map((previous ?? []).map((h) => [h.command, h.data]));
  return current.map((h) => {
    const old = prev.get(h.command);
    const changed = old ? h.data.flatMap((b, i) => (old[i] !== b ? [i] : [])) : [];
    return { ...h, changed };
  });
}

/** Plain-text report of a sweep, meant to be pasted into a chat or a note. */
export function formatSweep(header: string, hits: SweepHit[]): string {
  return [
    `ECU ${header} — ${hits.length} PIDs`,
    ...hits.map((h) => `${h.command} [${h.data.length}] ${toHex(h.data)}${h.changed.length ? `  changed: ${h.changed.join(',')}` : ''}`),
  ].join('\n');
}
