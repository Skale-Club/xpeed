// User-defined (manufacturer-specific) PIDs, e.g. Toyota mode 21 data from
// the hybrid ECU. Formulas name the reply bytes A, B, C… Stored per vehicle
// in this browser.

import { compileFormula, FormulaError } from './formula';

export interface CustomPid {
  id: string;
  name: string;
  unit: string;
  /** ECU request header ("7E2", "18DA10F1"); null = broadcast. */
  header: string | null;
  /** Read request, e.g. "2181", "22F190", "015B". */
  command: string;
  formula: string;
  min: number;
  max: number;
}

// Read-only services: current data (01), vehicle info (09), Toyota/KWP local
// identifiers (21) and UDS data identifiers (22). Anything that writes,
// resets or runs routines on an ECU is refused.
const COMMAND_RE = /^(01[0-9A-F]{2}|09[0-9A-F]{2}|21[0-9A-F]{2}|22[0-9A-F]{4})$/;
const HEADER_RE = /^([0-9A-F]{3}|[0-9A-F]{8})$/;

export function normalizeCommand(raw: string): string {
  return raw.replace(/^0x/i, '').replace(/\s/g, '').toUpperCase();
}

export function normalizeHeader(raw: string | null | undefined): string | null {
  const h = (raw ?? '').replace(/^0x/i, '').replace(/\s/g, '').toUpperCase();
  return h || null;
}

/** Returns an error message, or null when the definition is usable. */
export function validateCustomPid(p: Omit<CustomPid, 'id'>): string | null {
  if (!p.name.trim()) return 'Name is required.';
  if (!COMMAND_RE.test(p.command)) return `"${p.command}" is not a supported read request (use 01xx, 09xx, 21xx or 22xxxx).`;
  if (p.header && !HEADER_RE.test(p.header)) return `"${p.header}" is not a valid ECU header (e.g. 7E2).`;
  try {
    compileFormula(p.formula);
  } catch (err) {
    return err instanceof FormulaError ? `Formula: ${err.message}` : String(err);
  }
  if (!Number.isFinite(p.min) || !Number.isFinite(p.max) || p.max <= p.min) return 'Max must be greater than min.';
  return null;
}

const TERMINAL_OBD_RE = /^(01([0-9A-F]{2}){1,6}|02[0-9A-F]{4}|03|07|0A|09[0-9A-F]{2}|21[0-9A-F]{2}|22[0-9A-F]{4})$/;
const TERMINAL_AT_RE = /^AT(RV|I|@1|DPN?|CS)$/;

/** Terminal commands are limited to reads; returns an error message or null. */
export function validateTerminalCommand(cmd: string, header: string | null): string | null {
  if (TERMINAL_AT_RE.test(cmd)) return header ? 'AT commands go to the adapter; leave the header empty.' : null;
  if (!TERMINAL_OBD_RE.test(cmd)) {
    return 'Only read requests are allowed here (01, 02, 03, 07, 09, 0A, 21, 22, and ATRV/ATI/ATDP/ATCS).';
  }
  if (header && !HEADER_RE.test(header)) return `"${header}" is not a valid ECU header (e.g. 7E2).`;
  return null;
}

let seq = 0;
export function newPidId(): string {
  seq += 1;
  return `pid_${Date.now().toString(36)}_${seq}`;
}

const storageKey = (carId: string | null) => `xpeed.obd.customPids.${carId ?? 'default'}`;

export function loadCustomPids(carId: string | null): CustomPid[] {
  try {
    const raw = localStorage.getItem(storageKey(carId));
    const list = raw ? (JSON.parse(raw) as CustomPid[]) : [];
    return Array.isArray(list) ? list.filter((p) => !validateCustomPid(p)) : [];
  } catch {
    return [];
  }
}

export function saveCustomPids(carId: string | null, pids: CustomPid[]): void {
  try {
    localStorage.setItem(storageKey(carId), JSON.stringify(pids));
  } catch {
    // Private mode / blocked storage: the list just won't survive a reload.
  }
}
