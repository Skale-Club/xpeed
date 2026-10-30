const KEY = 'xpeed:update-position';
const page = () => window.location.pathname + window.location.search + window.location.hash;

export function reloadPreservingScreen() {
  try { sessionStorage.setItem(KEY, JSON.stringify({ page: page(), x: window.scrollX, y: window.scrollY, at: Date.now() })); }
  catch { /* Browser reload still keeps the current URL. */ }
  window.location.reload();
}

/** Restore once, after the current page has enough content; stop if the user takes over. */
export function restoreUpdatePosition(): () => void {
  let saved: { page: string; x: number; y: number; at: number };
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return () => {};
    saved = JSON.parse(raw);
    if (saved.page !== page() || !Number.isFinite(saved.at) || Date.now() - saved.at > 60_000
      || !Number.isFinite(saved.x) || !Number.isFinite(saved.y) || saved.x < 0 || saved.y < 0) {
      sessionStorage.removeItem(KEY); return () => {};
    }
  } catch { return () => {}; }
  let observer: ResizeObserver | undefined;
  const stop = () => {
    observer?.disconnect(); clearTimeout(timer);
    window.removeEventListener('pointerdown', stop, true);
    window.removeEventListener('keydown', stop, true);
    try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  };
  const restore = () => {
    if (document.documentElement.scrollHeight - window.innerHeight < saved.y) return;
    window.scrollTo(saved.x, saved.y); stop();
  };
  const timer = setTimeout(stop, 10_000);
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(restore); observer.observe(document.body); }
  window.addEventListener('pointerdown', stop, { capture: true, once: true });
  window.addEventListener('keydown', stop, { capture: true, once: true });
  restore();
  return stop;
}
