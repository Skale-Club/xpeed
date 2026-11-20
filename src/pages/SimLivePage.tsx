import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { BrandLogo } from '@/components/BrandLogo';
import { LiveDashboard } from '@/components/sim/live/LiveDashboard';
import { useScreenWakeLock } from '@/hooks/use-wake-lock';
import type { LiveScreen } from '@/lib/sim/live-frame';
import { useLiveStream, type LiveState } from '@/lib/sim/use-live-stream';
import { cn } from '@/lib/utils';

const STATE_TEXT: Record<Exclude<LiveState, 'signin'>, [key: string, fallback: string]> = {
  live: ['phoneLive.stateLive', 'Live'],
  idle: ['phoneLive.stateWaiting', 'Waiting for the Companion'],
  connecting: ['phoneLive.stateConnecting', 'Connecting'],
  reconnecting: ['phoneLive.stateReconnecting', 'Reconnecting'],
};

const humanise = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/_/g, ' ');

/**
 * Virtual > the phone view (`/virtual/live`): the dashboard Xpeed Companion is drawing on the PC, live, relayed by the server. Full screen, dark,
 * for a phone held upright (two columns when wide). Only the signed-in person's own stream is read. The screen stays awake while frames flow.
 * The page tells the server the room it has for the panel, so Xpeed Companion 0.16+ draws the panel itself for this screen (held upright or on
 * its side) and the page shows that picture as it is.
 */
/** The room an element gives, in CSS pixels, settled for a moment (a rotation fires several resizes) and with the screen's pixel ratio. */
function useRoom() {
  const ref = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<LiveScreen | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      const style = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      const h = el.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
      if (w < 50 || h < 50) return;
      const next = { w: Math.round(w), h: Math.round(h), dpr: window.devicePixelRatio || 1 };
      setRoom((was) => (was && was.w === next.w && was.h === next.h && was.dpr === next.dpr ? was : next));
    };
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(look, 300);
    };
    look();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settle);
    observer?.observe(el);
    window.addEventListener('resize', settle);
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener('resize', settle);
    };
  }, []);
  return [ref, room] as const;
}

export default function SimLivePage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [mainRef, room] = useRoom();
  const { state, frame } = useLiveStream(true, room);
  useScreenWakeLock(state === 'live');

  if (state === 'signin') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const [stateKey, stateFallback] = STATE_TEXT[state];
  const showFrame = frame !== null && state !== 'idle' && state !== 'connecting';
  const dashboard = frame?.dashboard;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground" data-testid="live-page" data-state={state}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Link to="/virtual/companion" aria-label={t('phoneLive.back', 'Back to Xpeed Companion')} className="-ml-1 rounded-[2.5px] p-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </Link>
        <BrandLogo className="h-6 w-6" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="live-dashboard-name">
          {dashboard ? t(`phoneLive.dashboards.${dashboard}`, humanise(dashboard)) : t('phoneLive.title', 'Live on your phone')}
        </h1>
        <span
          className={cn('flex shrink-0 items-center gap-1.5 rounded-[2.5px] border px-2 py-0.5 text-xs font-semibold',
            state === 'live' ? 'border-success-line bg-success-soft text-success' : 'border-border text-muted-foreground')}
          data-testid="live-state"
        >
          <span className={cn('h-2 w-2 rounded-[2.5px]', state === 'live' ? 'bg-success' : state === 'reconnecting' ? 'bg-warn' : 'bg-muted-foreground')} aria-hidden="true" />
          {t(stateKey, stateFallback)}
        </span>
      </header>

      {state === 'reconnecting' && showFrame ? (
        <div role="status" className="shrink-0 bg-warn-soft px-3 py-1.5 text-center text-xs font-semibold text-warn" data-testid="live-reconnecting">
          {t('phoneLive.reconnectingBanner', 'The connection dropped. Trying again…')}
        </div>
      ) : null}

      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {showFrame ? <LiveDashboard frame={frame} /> : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="live-waiting">
            <Radio className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold">{t('phoneLive.waitingTitle', 'Waiting for the Companion')}</h2>
            <p className="max-w-xs text-sm text-muted-foreground">
              {t('phoneLive.waitingBody', 'Open a game with “Show the panel on my phone” turned on in the Companion\'s tray menu.')}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
