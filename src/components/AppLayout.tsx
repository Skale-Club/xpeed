import { Link } from 'react-router-dom';
import { useEffect } from 'react';
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
import { ModeSwitch } from '@/components/ModeSwitch';
import { useModes } from '@/contexts/ModesContext';
import { MODE_HOME } from '@/lib/modes';

export default function AppLayout({ children, refreshDisabled = false }: { children: React.ReactNode; refreshDisabled?: boolean }) {
  const { t } = useTranslation();
  const { refresh } = usePageRefresh();
  const { mode } = useModes();
  useEffect(restoreUpdatePosition, []);
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: long words (file names, codes) must wrap instead of widening the page on phones. */}
      <SidebarInset className="min-w-0">
        <PullToRefresh onRefresh={refresh} disabled={refreshDisabled}>
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border/60 bg-background/80 px-3 backdrop-blur-xl sm:gap-3 sm:px-4">
          {/* Phones navigate with the tab bar at the bottom; the logo goes home. */}
          <Link to={MODE_HOME[mode]} className="flex shrink-0 items-center gap-2 md:hidden" aria-label="Xpeed">
            <BrandLockup logoClassName="h-7 w-7" nameClassName="text-base" />
          </Link>
          <SidebarTrigger className="hidden md:inline-flex" />
          {/* The car's connection and notifications belong to the Real mode. */}
          {mode === 'real' && <HeaderControls />}
        </header>
        <AppUpdateBanner />

        <main className="w-full flex-1 p-4 sm:p-6">
          {/* Phones: the Real | Virtual switch (the sidebar has it on larger screens). Nothing shows with one mode. */}
          <ModeSwitch className="mb-4 md:hidden" />
          {children}
        </main>

        {/* Phones need room for the bottom tab bar; the desktop footer stays compact. */}
        <footer className="border-t border-border/60 px-20 pb-32 pt-4 text-center md:px-24 md:pb-4">
          {/* The car disclaimer is about the Real mode; the Virtual screens have no such note. */}
          {mode === 'real' && (
            <p className="text-[11px] text-muted-foreground">
              {t('settings.about.disclaimer', 'It gives hints from data, not a diagnosis — for warning lights or serious symptoms, see a mechanic.')}
            </p>
          )}
        </footer>
        </PullToRefresh>
      </SidebarInset>

      <MobileTabBar />
      {mode === 'real' && <ChatBubble />}
      <NewCarDialog />
      <InstallPrompt />
    </SidebarProvider>
  );
}
