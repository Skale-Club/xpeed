import { Link } from 'react-router-dom';
import { Suspense, lazy, useEffect, type CSSProperties } from 'react';
import { restoreUpdatePosition } from '@/lib/update-position';
import { useTranslation } from 'react-i18next';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { ChatBubble } from '@/components/ChatBubble';
import { InstallPrompt } from '@/components/InstallPrompt';
import { AppUpdateBanner } from '@/components/AppUpdateBanner';
import { MobileTabBar } from '@/components/MobileTabBar';
import { NewCarDialog } from '@/components/trip/NewCarDialog';
import { BrandLockup } from '@/components/BrandLockup';
import { PullToRefresh } from '@/components/PullToRefresh';
import { usePageRefresh } from '@/contexts/PageRefreshContext';
import { HeaderControls } from '@/components/header/HeaderControls';
import { PageTrail } from '@/components/header/PageTrail';
import { QuickNav } from '@/components/header/QuickNav';
import { ModeSwitch } from '@/components/ModeSwitch';
// Only the Virtual side shows it, so the Real side never downloads it.
const CompanionStatus = lazy(() => import('@/components/sim/CompanionStatus').then((m) => ({ default: m.CompanionStatus })));
import { ExampleBanner } from '@/components/sim/Example';
import { useModes } from '@/contexts/ModesContext';
import { MODE_HOME } from '@/lib/modes';
import { isCompanionShell } from '@/lib/companion-shell';

export default function AppLayout({ children, refreshDisabled = false }: { children: React.ReactNode; refreshDisabled?: boolean }) {
  const { t } = useTranslation();
  const { refresh } = usePageRefresh();
  const { mode } = useModes();
  useEffect(restoreUpdatePosition, []);
  // Inside the Companion the window draws the header and menu: only the page content shows.
  if (isCompanionShell()) {
    return (
      <SidebarProvider style={{ '--sidebar-width': '17rem' } as CSSProperties}>
        <SidebarInset className="min-w-0">
          <PullToRefresh onRefresh={refresh} disabled={refreshDisabled}>
            {mode === 'virtual' && <ExampleBanner />}
            <main className="w-full flex-1 p-4 sm:p-6">{children}</main>
          </PullToRefresh>
        </SidebarInset>
        <ChatBubble mode={mode} />
        <NewCarDialog />
      </SidebarProvider>
    );
  }
  return (
    // 17rem: the inset menu keeps 8 px around itself, so the car's name still fits whole (it did at 16rem without the inset).
    <SidebarProvider style={{ '--sidebar-width': '17rem' } as CSSProperties}>
      <AppSidebar />
      {/* min-w-0: long words (file names, codes) must wrap instead of widening the page on phones. */}
      {/* Wider screens: the content is a card floating beside the menu, one step lighter than the page (Dashboards 2027, phase 2). */}
      <SidebarInset className="min-w-0 md:peer-data-[variant=inset]:rounded-panel md:peer-data-[variant=inset]:border md:peer-data-[variant=inset]:border-border/70 md:peer-data-[variant=inset]:bg-surface-inset md:peer-data-[variant=inset]:shadow-card">
        <PullToRefresh onRefresh={refresh} disabled={refreshDisabled}>
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border/60 bg-background/80 px-3 backdrop-blur-xl sm:gap-3 sm:px-4 md:rounded-t-panel md:bg-surface-inset/85">
          {/* Phones navigate with the tab bar at the bottom; the logo goes home. */}
          <Link to={MODE_HOME[mode]} className="flex shrink-0 items-center gap-2 md:hidden" aria-label="Xpeed">
            <BrandLockup logoClassName="h-7 w-7" nameClassName="text-base" />
          </Link>
          <SidebarTrigger className="hidden md:inline-flex" />
          {/* Where you are: the mode and the page's menu entry. */}
          <PageTrail />
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            {/* Go to any page of the mode; Ctrl K. */}
            <QuickNav />
            {/* The car's connection and notifications belong to the Real mode. */}
            {mode === 'real' && <HeaderControls />}
            {/* Virtual: whether the Windows app is online, as one quiet dot and a name. */}
            {mode === 'virtual' && <Suspense fallback={null}><CompanionStatus /></Suspense>}
          </div>
        </header>
        <AppUpdateBanner />
        {/* Virtual: while the example is on (made-up laps), every page says so. */}
        {mode === 'virtual' && <ExampleBanner />}

        <main className="w-full flex-1 p-4 sm:p-6">
          {/* Phones: the Real | Virtual switch (the sidebar has it on larger screens). Nothing shows with one mode. */}
          <ModeSwitch className="mb-4 md:hidden" />
          {children}
        </main>

        {/* Phones need room for the bottom tab bar; the desktop footer stays compact. */}
        <footer className="border-t border-border/60 px-20 pb-32 pt-4 text-center md:px-24 md:pb-4">
          {/* The car disclaimer is about the Real mode; the Virtual screens have no such note. */}
          {mode === 'real' && (
            <p className="text-2xs text-muted-foreground">
              {t('settings.about.disclaimer', 'It gives hints from data, not a diagnosis — for warning lights or serious symptoms, see a mechanic.')}
            </p>
          )}
        </footer>
        </PullToRefresh>
      </SidebarInset>

      <MobileTabBar />
      {/* The assistant: about the car on Real, about the driver's racing on Virtual. */}
      <ChatBubble mode={mode} />
      <NewCarDialog />
      <InstallPrompt />
    </SidebarProvider>
  );
}
