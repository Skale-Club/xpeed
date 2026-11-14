import { useEffect, useRef, useState } from 'react';

/**
 * Whether an element has been on screen (or just below it) at some point: once true it stays true. Used to read what a row needs only when the row is
 * about to be seen. Without IntersectionObserver (old browsers, tests) nothing is ever "in view", so nothing extra is read.
 */
export function useInView<T extends Element>(margin = '240px') {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (seen || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    }, { rootMargin: margin });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen, margin]);
  return { ref, seen };
}
