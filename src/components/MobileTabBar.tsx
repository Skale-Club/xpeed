import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Gauge, History, Menu } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { useCarsContext } from '@/contexts/CarsContext';
import { useObd } from '@/contexts/ObdScannerContext';
import { useOpenProblems } from '@/hooks/use-open-problems';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', i18nKey: 'nav.dashboard', icon: Gauge },
  { to: '/history', i18nKey: 'nav.history', icon: History },
  { to: '/issues', i18nKey: 'nav.issues', icon: AlertTriangle },
] as const;

/**
 * Phone navigation: the three everyday places always one tap away at the
 * bottom, and "More" opening the full menu (cars, service, settings…).
 * Hidden from md up, where the sidebar is always there.
 */
export function MobileTabBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  const { selectedCarId } = useCarsContext();
  const { lastTrip } = useObd();
  const problems = useOpenProblems(selectedCarId, lastTrip);

  const isActive = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname.startsWith(to));
  const item = 'flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors';

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/90 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label={t('nav.navigation', 'Menu')}
      data-testid="mobile-tab-bar"
    >
      <div className="mx-auto flex h-16 max-w-md items-stretch">
        {TABS.map(({ to, i18nKey, icon: Icon }) => {
          const active = isActive(to);
          const badge = to === '/issues' && problems.length > 0 ? problems.length : null;
          return (
            <Link key={to} to={to} className={cn(item, active ? 'text-primary' : 'text-muted-foreground hover:text-foreground')} aria-current={active ? 'page' : undefined}>
              <span className={cn('relative flex h-8 w-14 items-center justify-center rounded-full transition-colors', active && 'bg-primary/15')}>
                <Icon className="h-5 w-5" />
                {badge !== null && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                    {badge}
                  </span>
                )}
              </span>
              {t(i18nKey)}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpenMobile(true)} className={cn(item, 'text-muted-foreground hover:text-foreground')}>
          <span className="flex h-8 w-14 items-center justify-center rounded-full">
            <Menu className="h-5 w-5" />
          </span>
          {t('nav.more', 'More')}
        </button>
      </div>
    </nav>
  );
}
