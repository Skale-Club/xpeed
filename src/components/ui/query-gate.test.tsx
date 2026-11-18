import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { QueryGate, type GateQuery } from './query-gate';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

const base: GateQuery = { isPending: false, isError: false, error: null, isFetching: false, dataUpdatedAt: 1, refetch: () => undefined };
const gate = (query: Partial<GateQuery>, props: Partial<React.ComponentProps<typeof QueryGate>> = {}) => (
  <QueryGate query={{ ...base, ...query }} empty={false} {...props}>
    <p>the data</p>
  </QueryGate>
);

describe('QueryGate', () => {
  it('shows a loading list during the first read, or the skeleton it is given', () => {
    const { rerender } = render(gate({ isPending: true, dataUpdatedAt: 0 }));
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(screen.queryByText('the data')).toBeNull();
    rerender(gate({ isPending: true, dataUpdatedAt: 0 }, { skeleton: <p>custom skeleton</p> }));
    expect(screen.getByText('custom skeleton')).toBeInTheDocument();
  });

  it('shows an error with a retry that refetches when there is nothing to show', () => {
    const refetch = vi.fn();
    render(gate({ isError: true, error: new Error('boom'), dataUpdatedAt: 0, refetch }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('the data')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the data on success', () => {
    render(gate({}));
    expect(screen.getByText('the data')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps old data under a "saved data" notice when a later read failed', () => {
    const refetch = vi.fn();
    render(gate({ isError: true, error: new Error('boom'), dataUpdatedAt: 5, refetch }));
    expect(screen.getByText('the data')).toBeInTheDocument();
    expect(screen.getByText('Showing saved data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty node, or a plain empty state, for an empty answer', () => {
    const { rerender } = render(gate({}, { empty: true, emptyNode: <p>no laps</p> }));
    expect(screen.getByText('no laps')).toBeInTheDocument();
    expect(screen.queryByText('the data')).toBeNull();
    rerender(gate({}, { empty: true }));
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('shows the signed-out error with the sign-in action when the predicate says so', () => {
    render(gate({ isError: true, error: 'signed-out', dataUpdatedAt: 0 }, { isSignedOut: (e) => e === 'signed-out', signInAction: <a href="/login">Sign in</a> }));
    expect(screen.getByText('You are signed out')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});
