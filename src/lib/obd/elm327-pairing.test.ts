import { describe, it, expect } from 'vitest';
import { Elm327, ElmTimeoutError, type ObdLink } from './elm327';

/**
 * A link whose adapter answers after a per-command delay (or never, or with
 * an error), delivering replies in small chunks like BLE notifications do.
 */
function slowLink(behavior: (cmd: string) => { reply: string | null; delayMs?: number }): ObdLink & { sent: string[] } {
  let cb: (chunk: string) => void = () => undefined;
  const sent: string[] = [];
  return {
    name: 'slow',
    sent,
    async write(data) {
      const cmd = data.replace(/\r/g, '');
      sent.push(cmd);
      const { reply, delayMs = 0 } = behavior(cmd);
      if (reply === null) return;
      const full = `${reply}\r\r>`;
      setTimeout(() => {
        for (let i = 0; i < full.length; i += 5) cb(full.slice(i, i + 5));
      }, delayMs);
    },
    onData(fn) { cb = fn; },
    close() {},
  };
}

describe('Elm327 reply pairing after a timeout', () => {
  it('does not read the late reply of a timed-out command as the next command\'s answer', async () => {
    const link = slowLink((cmd) => {
      if (cmd === '010C') return { reply: 'LATE-010C', delayMs: 120 }; // answers after the 40 ms timeout
      if (cmd === '010D') return { reply: '410D32' };
      return { reply: '410F40' };
    });
    const elm = new Elm327(link, { resyncMs: 400 });
    await expect(elm.send('010C', 40)).rejects.toBeInstanceOf(ElmTimeoutError);
    // The next command must get its own reply, not the stray one still on its way.
    await expect(elm.send('010D')).resolves.toEqual(['410D32']);
    await expect(elm.send('010F')).resolves.toEqual(['410F40']);
    // The late prompt arrived by itself: the adapter was not poked
    expect(link.sent).toEqual(['010C', '010D', '010F']);
  });

  it('nudges an adapter that stays silent once, then carries on', async () => {
    const link = slowLink((cmd) => {
      if (cmd === 'HANG') return { reply: null };
      if (cmd === '') return { reply: '' }; // a bare CR just brings the prompt back
      return { reply: `ok-${cmd}` };
    });
    const elm = new Elm327(link, { resyncMs: 60 });
    await expect(elm.send('HANG', 30)).rejects.toBeInstanceOf(ElmTimeoutError);
    await expect(elm.send('ATE0')).resolves.toEqual(['ok-ATE0']);
    expect(link.sent).toEqual(['HANG', '', 'ATE0']);
  });

  it('never nudges after a clear-codes request, which a bare CR would repeat', async () => {
    const link = slowLink((cmd) => (cmd === '04' ? { reply: null } : { reply: `ok-${cmd}` }));
    const elm = new Elm327(link, { resyncMs: 60 });
    await expect(elm.send('04', 30)).rejects.toBeInstanceOf(ElmTimeoutError);
    await expect(elm.send('03')).resolves.toEqual(['ok-03']);
    expect(link.sent).toEqual(['04', '03']);
  });
});

describe('Elm327 header changes are checked', () => {
  const initialized = async (behavior: (cmd: string) => { reply: string | null; delayMs?: number }) => {
    const link = slowLink((cmd) => {
      if (cmd === 'ATDPN') return { reply: 'A6' };
      if (cmd === '0100') return { reply: '4100BE1FA813' };
      return behavior(cmd);
    });
    const elm = new Elm327(link, { resyncMs: 60 });
    await elm.initialize();
    link.sent.length = 0;
    return { elm, link };
  };

  it('does not remember a header the adapter refused, and tries again', async () => {
    let refuse = true;
    const { elm, link } = await initialized((cmd) => {
      if (cmd === 'ATSH7E2') return { reply: refuse ? '?' : 'OK' };
      if (cmd === '2101') return { reply: '6101AA' };
      return { reply: 'OK' };
    });
    // The request must not be sent to the wrong ECU as if the header had switched
    await expect(elm.request('2101', '7E2')).rejects.toThrow(/did not accept ATSH7E2/);
    expect(link.sent).toEqual(['ATSH7E2']);
    refuse = false;
    await expect(elm.request('2101', '7E2')).resolves.toEqual(['6101AA']);
    expect(link.sent).toEqual(['ATSH7E2', 'ATSH7E2', '2101']);
  });

  it('forgets the header when the adapter does not answer the switch at all', async () => {
    let swallow = true;
    const { elm, link } = await initialized((cmd) => {
      if (cmd === 'ATSH7E2') return swallow ? { reply: null } : { reply: 'OK' };
      if (cmd === '') return { reply: '' };
      if (cmd === '2101') return { reply: '6101AA' };
      return { reply: 'OK' };
    });
    await expect(elm.request('2101', '7E2', 40)).rejects.toBeInstanceOf(ElmTimeoutError);
    swallow = false;
    await expect(elm.request('2101', '7E2', 200)).resolves.toEqual(['6101AA']);
    expect(link.sent.filter((c) => c === 'ATSH7E2')).toHaveLength(2);
  });

  it('does not remember a receive filter that was not accepted', async () => {
    let refuse = true;
    const { elm, link } = await initialized((cmd) => {
      if (cmd.startsWith('ATCRA')) return { reply: refuse ? '?' : 'OK' };
      return { reply: cmd.startsWith('21') ? '6101AA' : 'OK' };
    });
    await expect(elm.request('2101', '7C0')).rejects.toThrow(/ATCRA7C8/);
    refuse = false;
    await expect(elm.request('2101', '7C0')).resolves.toEqual(['6101AA']);
    expect(link.sent.filter((c) => c === 'ATCRA7C8')).toHaveLength(2);
  });
});
