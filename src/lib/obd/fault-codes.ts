// Reading the car's fault codes (DTCs). On CAN cars each OBD module is asked
// on its own address (7E0 engine, 7E1 transmission, 7E2 hybrid…), so replies
// from two modules never mix and a module with a long list can't hide another.
// The readout also says whether any module answered at all: only then can a
// code that is missing be taken as "the car no longer reports it".

import type { Elm327 } from './elm327';
import { collectMessages, parseDtcReply } from './pids';

export interface FaultCodeReadout {
  /** Confirmed codes (mode 03) — what turns the check-engine light on. */
  stored: string[];
  /** Seen once, not confirmed yet (mode 07); never also in `stored`. */
  pending: string[];
  /** Codes that survive a clear until the car re-checks itself (mode 0A); Scanner only. */
  permanent: string[];
  /** At least one module answered the request, so an empty list really means "no codes". */
  checked: boolean;
}

export const NO_READOUT: FaultCodeReadout = { stored: [], pending: [], permanent: [], checked: false };

/** Physical addresses of the OBD modules a car can have on CAN. */
const MODULE_HEADERS = ['7E0', '7E1', '7E2', '7E3', '7E4', '7E5', '7E6', '7E7'];
const MODES = [
  { mode: '03', reply: 0x43, key: 'stored' },
  { mode: '07', reply: 0x47, key: 'pending' },
  { mode: '0A', reply: 0x4a, key: 'permanent' },
] as const;

const answered = (lines: string[], reply: number) => collectMessages(lines).some((m) => m[0] === reply);

export async function readFaultCodes(
  elm: Elm327,
  isCan: boolean,
  { permanent = false, timeoutMs = 1500 }: { permanent?: boolean; timeoutMs?: number } = {},
): Promise<FaultCodeReadout> {
  const found = { stored: new Set<string>(), pending: new Set<string>(), permanent: new Set<string>() };
  let checked = false;
  const modes = MODES.filter((m) => permanent || m.key !== 'permanent');

  const ask = async (mode: (typeof MODES)[number], header: string | null): Promise<boolean> => {
    try {
      const lines = await elm.request(mode.mode, header, header ? timeoutMs : 5000);
      if (!answered(lines, mode.reply)) return false;
      parseDtcReply(lines, mode.reply, isCan).forEach((c) => found[mode.key].add(c));
      return true;
    } catch {
      return false; // timeout: nobody at this address
    }
  };

  if (isCan) {
    for (const header of MODULE_HEADERS) {
      // A module that doesn't answer the confirmed-codes request isn't there.
      if (!(await ask(modes[0], header))) continue;
      checked = true;
      for (const mode of modes.slice(1)) await ask(mode, header);
    }
  } else {
    for (const mode of modes) {
      if (await ask(mode, null)) checked = true;
    }
  }

  const stored = Array.from(found.stored).sort();
  return {
    stored,
    pending: Array.from(found.pending).filter((c) => !found.stored.has(c)).sort(),
    permanent: Array.from(found.permanent).sort(),
    checked,
  };
}

/** Combine two readouts from the same drive (codes seen at any point count). */
export function mergeReadouts(a: FaultCodeReadout, b: FaultCodeReadout): FaultCodeReadout {
  const stored = new Set([...a.stored, ...b.stored]);
  return {
    stored: Array.from(stored).sort(),
    pending: Array.from(new Set([...a.pending, ...b.pending])).filter((c) => !stored.has(c)).sort(),
    permanent: Array.from(new Set([...a.permanent, ...b.permanent])).sort(),
    checked: a.checked || b.checked,
  };
}
