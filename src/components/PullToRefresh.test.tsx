import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PullToRefresh } from './PullToRefresh';
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
afterEach(cleanup);
function pull(target: HTMLElement, delta = 160) {
  fireEvent.touchStart(target, { touches: [{ clientX: 30, clientY: 20 }] });
  fireEvent.touchMove(target, { touches: [{ clientX: 30, clientY: 20 + delta }], cancelable: true });
  fireEvent.touchEnd(target, { touches: [] });
}
it('refreshes only after a deliberate pull released at the top', async () => {
  const refresh = vi.fn(async () => undefined);
  render(<PullToRefresh onRefresh={refresh}><p>Page</p></PullToRefresh>);
  pull(screen.getByText('Page'), 40);
  expect(refresh).not.toHaveBeenCalled();
  pull(screen.getByText('Page'));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
});
it('does not refresh while disabled or when dragging a form control', () => {
  const refresh = vi.fn(async () => undefined);
  const { rerender } = render(<PullToRefresh onRefresh={refresh} disabled><p>Page</p></PullToRefresh>);
  pull(screen.getByText('Page'));
  rerender(<PullToRefresh onRefresh={refresh}><input aria-label="Edit" /></PullToRefresh>);
  pull(screen.getByRole('textbox', { name: 'Edit' }));
  expect(refresh).not.toHaveBeenCalled();
});
it('refreshes over navigation links and action buttons without activating them', async () => {
  const refresh = vi.fn(async () => undefined);
  const activate = vi.fn();
  render(<PullToRefresh onRefresh={refresh}><button onClick={activate}>Action</button><a href="/live" onClick={activate}>Live</a></PullToRefresh>);
  const action = screen.getByRole('button');
  pull(action);
  fireEvent.click(action, { detail: 1 });
  expect(activate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  const link = screen.getByRole('link');
  pull(link);
  fireEvent.click(link, { detail: 1 });
  expect(activate).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(2);
  // A subsequent normal tap remains usable.
  fireEvent.touchStart(action, { touches: [{ clientX: 30, clientY: 20 }] });
  fireEvent.touchEnd(action, { touches: [] });
  fireEvent.click(action, { detail: 1 });
  expect(activate).toHaveBeenCalledOnce();
});
it('ignores nested scrolling and cancelled gestures', () => {
  const refresh = vi.fn(async () => undefined);
  render(<PullToRefresh onRefresh={refresh}><p>Page</p></PullToRefresh>);
  const target = screen.getByText('Page');
  target.scrollTop = 20;
  pull(target);
  expect(refresh).not.toHaveBeenCalled();
  target.scrollTop = 0;
  fireEvent.touchStart(target, { touches: [{ clientX: 30, clientY: 20 }] });
  fireEvent.touchMove(target, { touches: [{ clientX: 30, clientY: 200 }], cancelable: true });
  fireEvent.touchCancel(target);
  fireEvent.touchEnd(target);
  expect(refresh).not.toHaveBeenCalled();
});
it('coalesces repeated gestures while a refresh is pending', async () => {
  let finish!: () => void;
  const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<PullToRefresh onRefresh={refresh}><p>Page</p></PullToRefresh>);
  pull(screen.getByText('Page'));
  pull(screen.getByText('Page'));
  expect(refresh).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
});
