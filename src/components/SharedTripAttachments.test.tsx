import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SharedTripAttachments } from './SharedTripAttachments';
const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-extras', () => ({ getSharedMedia: load }));
beforeEach(() => { load.mockReset().mockResolvedValue([{ id: 'photo', url: 'https://example.test/first', caption: 'Dashboard', video: false }]); });
afterEach(cleanup);

it('recovers a shared image load error with a fresh link', async () => {
  render(<SharedTripAttachments reportId="report" />);
  fireEvent.error(await screen.findByRole('img', { name: 'Dashboard' }));
  expect(screen.getByRole('alert')).toBeInTheDocument();
  load.mockResolvedValue([{ id: 'photo', url: 'https://example.test/retry', caption: 'Dashboard', video: false }]);
  fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
  expect(await screen.findByRole('img', { name: 'Dashboard' })).toHaveAttribute('src', 'https://example.test/retry');
});

it('refreshes shared links after resuming and removes listeners on unmount', async () => {
  const view = render(<SharedTripAttachments reportId="report" />);
  await screen.findByRole('img', { name: 'Dashboard' });
  load.mockResolvedValue([{ id: 'photo', url: 'https://example.test/returned', caption: 'Dashboard', video: false }]);
  await act(async () => { fireEvent(document, new Event('visibilitychange')); });
  expect(screen.getByRole('img', { name: 'Dashboard' })).toHaveAttribute('src', 'https://example.test/returned');
  view.unmount();
  const calls = load.mock.calls.length;
  fireEvent(window, new Event('online'));
  expect(load).toHaveBeenCalledTimes(calls);
});
