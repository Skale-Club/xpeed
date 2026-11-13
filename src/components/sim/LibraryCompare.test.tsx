import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { gzipLap } from '@/lib/sim/lap-file';
import { addLapFile } from '@/lib/sim/library';
import { compareUrl } from '@/lib/sim/compare-url';
import { makeSampleLaps } from '@/lib/sim/sample-laps';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { LibraryCompare } from './LibraryCompare';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
// No account: layouts are looked for on the device only (the account sync has its own tests).
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => null }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));

const [mine, best] = makeSampleLaps();
const keep = async (lap: typeof mine, name: string) => (await addLapFile('ana', new File([await gzipLap(lap)], name))).id;
const renderAt = (url: string) =>
  render(<MemoryRouter initialEntries={[url]}><SettingsProvider><LibraryCompare /></SettingsProvider></MemoryRouter>);

let idb: FakeIdb;
beforeEach(async () => {
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  idb.uninstall();
});

describe('the compare screen started from kept laps', () => {
  it('opens the two laps named in the address, ready to compare', async () => {
    const [a, b] = [await keep(mine, 'mine.xlap.gz'), await keep(best, 'best.xlap.gz')];
    renderAt(compareUrl(a, b));
    await waitFor(() => expect(within(screen.getByTestId('lap-list')).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^\+0\.3\d\d s$/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('lap-list')).getAllByText(/From your sessions/)).toHaveLength(2);
  });

  it('opens a single lap when only one is named', async () => {
    const a = await keep(mine, 'mine.xlap.gz');
    renderAt(compareUrl(a));
    await waitFor(() => expect(within(screen.getByTestId('lap-list')).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByTestId('final-gap')).not.toBeInTheDocument();
  });

  it('says when a lap is no longer on the device, and still opens the others', async () => {
    const a = await keep(mine, 'mine.xlap.gz');
    renderAt(compareUrl(a, 'ana|gone'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some of those laps are no longer on this device.');
    expect(within(screen.getByTestId('lap-list')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('does not open another account’s lap', async () => {
    const foreign = (await addLapFile('bob', new File([await gzipLap(mine)], 'x.xlap.gz'))).id;
    renderAt(compareUrl(foreign));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer on this device');
    expect(screen.queryByTestId('lap-list')).not.toBeInTheDocument();
  });

  it('starts empty when the address names nothing', async () => {
    renderAt('/sim/compare');
    expect(await screen.findByText(/Open one or two lap files/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
