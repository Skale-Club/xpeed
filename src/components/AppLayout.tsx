import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { ChatBubble } from '@/components/ChatBubble';
import { InstallPrompt } from '@/components/InstallPrompt';
import { ConnectionPill } from '@/components/trip/ConnectionPill';
import { AppUpdateBanner } from '@/components/AppUpdateBanner';
import { MobileTabBar } from '@/components/MobileTabBar';
import { NewCarDialog } from '@/components/trip/NewCarDialog';
import { BrandLogo } from '@/components/BrandLogo';
import { PullToRefresh } from '@/components/PullToRefresh';
import { usePageRefresh } from '@/contexts/PageRefreshContext';
import { VehicleNotificationBell } from '@/components/VehicleNotificationBell';

export default function AppLayout({ children, refreshDisabled = false }: { children: React.ReactNode; refreshDisabled?: boolean }) {
  const { t } = useTranslation();
  const { refresh } = usePageRefresh();
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: long words (file names, codes) must wrap instead of widening the page on phones. */}
      <SidebarInset className="min-w-0">
        <PullToRefresh onRefresh={refresh} disabled={refreshDisabled}>
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur-xl">
          {/* Phones navigate with the tab bar at the bottom; the logo goes home. */}
          <Link to="/" className="flex items-center gap-2 md:hidden" aria-label="Xpeed">
            <BrandLogo className="h-7 w-7" alt="" />
            <span className="text-base font-bold tracking-tight">Xpeed</span>
          </Link>
          <SidebarTrigger className="hidden md:inline-flex" />
          <ConnectionPill />
          <VehicleNotificationBell />
        </header>
        <AppUpdateBanner />

        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
          {children}
        </main>

        {/* Phones need room for the bottom tab bar; the desktop footer stays compact. */}
        <footer className="border-t border-border/60 px-20 pb-32 pt-4 text-center md:px-24 md:pb-4">
          <p className="text-[11px] text-muted-foreground">
            {t('settings.about.disclaimer', 'It gives hints from data, not a diagnosis — for warning lights or serious symptoms, see a mechanic.')}
          </p>
        </footer>
        </PullToRefresh>
      </SidebarInset>

      <MobileTabBar />
      <ChatBubble />
      <NewCarDialog />
      <InstallPrompt />
    </SidebarProvider>
  );
}
