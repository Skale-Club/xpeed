export const UPDATE_IDLE_MS = 30_000;

/** Event-driven: a single timeout exists only while an update is waiting. */
export function createIdleUpdateGate(onIdle: () => void, blocked: () => boolean) {
  let lastActivity = Date.now();
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notBefore = 0;
  const ready = () => Date.now() - lastActivity >= UPDATE_IDLE_MS && Date.now() >= notBefore
    && document.visibilityState !== 'hidden' && navigator.onLine !== false && !blocked()
    && !document.activeElement?.matches('input,textarea,select,[contenteditable="true"],[role="textbox"]')
    && !document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]');
  const schedule = () => {
    clearTimeout(timer);
    if (!pending) return;
    const delay = Math.max(lastActivity + UPDATE_IDLE_MS, notBefore) - Date.now();
    if (delay > 0) { timer = setTimeout(schedule, delay); return; }
    if (ready()) { pending = false; onIdle(); }
    // If blocked, a focus/visibility/recording event resumes the check. No polling loop.
  };
  const activity = () => { lastActivity = Date.now(); schedule(); };
  const movement = () => { if (Date.now() - lastActivity >= 1000) activity(); };
  const events = ['pointerdown', 'touchstart', 'keydown', 'input', 'scroll', 'wheel', 'focusin', 'focusout'];
  for (const event of events) window.addEventListener(event, activity, { passive: true, capture: true });
  window.addEventListener('pointermove', movement, { passive: true, capture: true });
  window.addEventListener('touchmove', movement, { passive: true, capture: true });
  document.addEventListener('visibilitychange', activity);
  window.addEventListener('online', activity);
  return {
    ready,
    request(at = 0) { pending = true; notBefore = Math.max(notBefore, at); schedule(); },
    dispose() {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, activity, true);
      window.removeEventListener('pointermove', movement, true);
      window.removeEventListener('touchmove', movement, true);
      document.removeEventListener('visibilitychange', activity);
      window.removeEventListener('online', activity);
    },
  };
}
