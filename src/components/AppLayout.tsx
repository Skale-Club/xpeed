import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { ChatBubble } from '@/components/ChatBubble';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />

      <SidebarInset>
        <header className="flex h-12 items-center gap-3 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4">
          <SidebarTrigger />
        </header>

        <main className="flex-1 p-6">
          {children}
        </main>

        <footer className="border-t border-border py-3 px-4 text-center">
          <p className="text-[10px] text-muted-foreground">
            This is a data-based hint, not a diagnosis. If you have warning lights or symptoms, consult a professional.
          </p>
        </footer>
      </SidebarInset>

      <ChatBubble />
    </SidebarProvider>
  );
}
