import { afterEach, expect, it, vi } from 'vitest';
import { reloadPreservingScreen, restoreUpdatePosition } from './update-position';
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
it('restores the same route, query, hash and scroll position after new content has loaded', () => {
  const reload = vi.fn(), scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(window, 'location', { configurable: true, value: { pathname: '/history', search: '?month=2026-10', hash: '#today', reload } });
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(350);
  reloadPreservingScreen(); expect(reload).toHaveBeenCalledOnce();
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(window.innerHeight + 500);
  const stop = restoreUpdatePosition();
  expect(scroll).toHaveBeenCalledWith(0, 350); expect(sessionStorage.getItem('xpeed:update-position')).toBeNull(); stop();
});
it('does not apply an old position to another page', () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  sessionStorage.setItem('xpeed:update-position', JSON.stringify({ page: '/other', x: 0, y: 300, at: Date.now() }));
  restoreUpdatePosition()(); expect(scroll).not.toHaveBeenCalled();
});
