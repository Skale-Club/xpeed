// Built-in manufacturer PID sets. Only definitions cross-checked on a real
// car go here: for the Prius Gen3 the 14 block voltages in 7E2/2181 add up
// to the pack voltage the same reply reports (209.4 V vs 209.0 V idle,
// 224.8 V vs 225.0 V charging), and 2174's boost-converter voltages track it.

import { newPidId, type CustomPid } from './custom-pids';

export interface PidPreset {
  id: string;
  label: string;
  pids: () => CustomPid[];
}

// Torque byte letters for reply index i (A..Z, then AA, AB…).
function letter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
}

const word = (hi: number) => `(${letter(hi)}*256+${letter(hi + 1)})`;
const BLOCK_SCALE = '*79.99/65535';
const blockWords = Array.from({ length: 14 }, (_, k) => word(k * 2));

function priusGen3(): CustomPid[] {
  const pid = (p: Omit<CustomPid, 'id' | 'header'>): CustomPid => ({ id: newPidId(), header: '7E2', ...p });
  return [
    pid({ name: 'HV pack voltage', unit: 'V', command: '2181', formula: `${word(30)}/10`, min: 150, max: 260 }),
    pid({
      name: 'HV block spread', unit: 'V', command: '2181',
      formula: `(MAX(${blockWords.join(',')})-MIN(${blockWords.join(',')}))${BLOCK_SCALE}`, min: 0, max: 1.5,
    }),
    ...blockWords.map((w, k) => pid({
      name: `HV block ${String(k + 1).padStart(2, '0')}`, unit: 'V', command: '2181', formula: `${w}${BLOCK_SCALE}`, min: 12, max: 18,
    })),
    pid({ name: 'HV before boost', unit: 'V', command: '2174', formula: `${word(5)}/2`, min: 150, max: 260 }),
    pid({ name: 'HV after boost', unit: 'V', command: '2174', formula: `${word(7)}/2`, min: 150, max: 700 }),
  ];
}

export const PID_PRESETS: PidPreset[] = [
  { id: 'prius-gen3', label: 'Toyota Prius Gen3 (2010–2015) — HV battery', pids: priusGen3 },
];

/** Append preset PIDs, skipping ones already present (same header, request and formula). */
export function mergePreset(existing: CustomPid[], preset: CustomPid[]): CustomPid[] {
  const key = (p: CustomPid) => `${p.header}|${p.command}|${p.formula}`;
  const seen = new Set(existing.map(key));
  return [...existing, ...preset.filter((p) => !seen.has(key(p)))];
}
