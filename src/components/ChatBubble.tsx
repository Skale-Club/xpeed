import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// The chat pulls in react-markdown and micromark (~190 KB); load it the first
// time the bubble is opened instead of with every signed-in page.
const ChatContainer = lazy(() =>
  import('./chat/ChatContainer').then((m) => ({ default: m.ChatContainer })),
);

export function ChatBubble() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  const toggle = () => {
    setIsOpen((open) => !open);
    setHasOpened(true);
  };

  return (
    <>
      {/* Floating Button */}
      <Button
        onClick={toggle}
        className={cn(
          "fixed bottom-[5.5rem] right-4 md:bottom-6 md:right-6 h-14 w-14 rounded-full shadow-[0_8px_30px_-6px_hsl(var(--primary)/0.5)] z-50 transition-all duration-300",
          isOpen ? "rotate-90 scale-0 opacity-0" : "scale-100 opacity-100"
        )}
        size="icon"
        aria-label={t('assistant.open', 'Ask the car assistant')}
      >
        <MessageCircle className="h-6 w-6" />
      </Button>

      {/* Chat Window (mounted from the first open on, so it keeps its state when closed) */}
      {hasOpened && (
        <Suspense fallback={null}>
          <ChatContainer
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
