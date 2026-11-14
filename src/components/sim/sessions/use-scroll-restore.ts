import { useEffect, useRef } from 'react';
import { useNavigationType } from 'react-router-dom';

const key = (id: string) => `xpeed.sim.sessions.scroll.${id}`;

/**
 * Keeps the place in a long list when a person opens one of its items and comes back: the scroll position is saved when the list goes away and put
 * back once there is something to scroll (`ready`), but only when the person came back (the browser's back button), not when they arrived by a link. Session storage can be missing or throw: then the list simply starts at the top.
 */
export function useScrollRestore(id: string, ready: boolean) {
  const restored = useRef(false);
  const back = useNavigationType() === 'POP';
  const idRef = useRef(id);
  idRef.current = id;
  useEffect(() => {
    if (!ready || restored.current || !back) return;
    restored.current = true;
    try {
      const saved = Number(window.sessionStorage.getItem(key(idRef.current)));
      if (Number.isFinite(saved) && saved > 0) window.requestAnimationFrame(() => window.scrollTo({ top: saved }));
    } catch {
      /* the list starts at the top */
    }
  }, [ready, back]);
  useEffect(() => () => {
    try {
      window.sessionStorage.setItem(key(idRef.current), String(Math.round(window.scrollY)));
    } catch {
      /* not kept */
    }
  }, []);
}
