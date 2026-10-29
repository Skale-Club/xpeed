import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Loader2, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/hooks/use-toast';

const THRESHOLD = 64;
export function PullToRefresh({ children, disabled = false, onRefresh }: {
  children: ReactNode; disabled?: boolean; onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const element = root.current;
    if (!element || disabled) return;
    let start: { x: number; y: number } | null = null;
    let pull = 0;
    let suppressClick = false;
    const reset = () => { start = null; pull = 0; setDistance(0); };
    const atTop = (target: EventTarget | null) => {
      if ((document.scrollingElement?.scrollTop ?? window.scrollY) > 0) return false;
      for (let node = target instanceof Element ? target : null; node && node !== element; node = node.parentElement) {
        if (node.scrollTop > 0) return false;
      }
      return true;
    };
    const begin = (event: TouchEvent) => {
      suppressClick = false;
      if (pending.current || event.touches.length !== 1 || !atTop(event.target)) return;
      if (event.target instanceof Element && event.target.closest('input,select,textarea,[role="slider"],[role="switch"],[contenteditable="true"]')) return;
      const point = event.touches[0];
      start = { x: point.clientX, y: point.clientY };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || !atTop(event.target)) { reset(); return; }
      const point = event.touches[0];
      const dy = point.clientY - start.y;
      if (dy <= 0 || Math.abs(point.clientX - start.x) > dy) { reset(); return; }
      if (!event.cancelable) { reset(); return; }
      event.preventDefault();
      pull = Math.min(96, dy * 0.5);
      setDistance(pull);
    };
    const end = () => {
      const trigger = pull >= THRESHOLD;
      reset();
      if (!trigger || pending.current) return;
      suppressClick = true;
      pending.current = true;
      setRefreshing(true);
      void onRefresh().catch(() => {
        toast({ title: t('refresh.failed', 'Could not refresh. Try again.'), variant: 'destructive' });
      }).finally(() => { pending.current = false; setRefreshing(false); });
    };
    // A deliberate pull over a card link/button refreshes instead of activating it.
    const click = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', reset);
    element.addEventListener('click', click, true);
    return () => {
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', reset);
      element.removeEventListener('click', click, true);
    };
  }, [disabled, onRefresh, t]);
  const shown = !disabled && (distance > 0 || refreshing);
  return (
    <div ref={root} className="relative flex flex-1 flex-col">
      {shown && <div className="pointer-events-none absolute inset-x-0 top-14 z-30 mx-auto flex w-fit items-center justify-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-xs text-muted-foreground shadow-lg" role="status" style={{ transform: `translateY(${refreshing ? 12 : Math.max(0, distance - 32)}px)` }}>
        {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : distance >= THRESHOLD ? <RotateCw className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
        {refreshing ? t('refresh.loading', 'Refreshing…') : distance >= THRESHOLD ? t('refresh.release', 'Release to refresh') : t('refresh.pull', 'Pull down to refresh')}
      </div>}
      {children}
    </div>
  );
}
