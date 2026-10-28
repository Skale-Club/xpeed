import { useTranslation } from 'react-i18next';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { ChatBubble } from '@/components/ChatBubble';
import { PWAInstallPrompt } from '@/components/PWAInstallPrompt';
import { ConnectionPill } from '@/components/trip/ConnectionPill';
import { AppUpdateBanner } from '@/components/AppUpdateBanner';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: long words (file names, codes) must wrap instead of widening the page on phones. */}
      <SidebarInset className="min-w-0">
        <header className="flex h-12 items-center gap-3 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4">
          <SidebarTrigger />
          <ConnectionPill />
        </header>
        <AppUpdateBanner />

        <main className="flex-1 p-4 sm:p-6">
          {children}
        </main>

        {/* Bottom padding keeps the text clear of the floating chat button. */}
        <footer className="border-t border-border pt-3 pb-20 px-4 text-center">
          <p className="text-[10px] text-muted-foreground">
            {t('settings.about.disclaimer', 'It gives hints from data, not a diagnosis — for warning lights or serious symptoms, see a mechanic.')}
          </p>
        </footer>
      </SidebarInset>

      <ChatBubble />
      <PWAInstallPrompt />
    </SidebarProvider>
  );
}
