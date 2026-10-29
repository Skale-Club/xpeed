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
  rerender(<PullToRefresh onRefresh={refresh}><button>Edit</button></PullToRefresh>);
  pull(screen.getByText('Edit'));
  expect(refresh).not.toHaveBeenCalled();
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
