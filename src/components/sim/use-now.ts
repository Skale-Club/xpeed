import { useEffect, useState } from 'react';

/**
 * The current time (epoch ms), moved on every `everyMs` (30 s by default). A computer is online for three minutes after the server heard from it,
 * and a page that only redraws when its data changes would still say Online long after the last heartbeat; this makes it look again.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
