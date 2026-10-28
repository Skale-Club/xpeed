import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MessageCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatContainer } from './chat/ChatContainer';

export function ChatBubble() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {/* Floating Button */}
      <Button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "fixed bottom-[5.5rem] right-4 md:bottom-6 md:right-6 h-14 w-14 rounded-full shadow-[0_8px_30px_-6px_hsl(var(--primary)/0.5)] z-50 transition-all duration-300",
          isOpen ? "rotate-90 scale-0 opacity-0" : "scale-100 opacity-100"
        )}
        size="icon"
        aria-label={t('assistant.open', 'Ask the car assistant')}
      >
        <MessageCircle className="h-6 w-6" />
      </Button>

      {/* Chat Window */}
      <ChatContainer
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}
