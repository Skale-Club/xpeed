import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Small, dismissible header panel: no full-screen overlay or blocked dashboard. */
export function HeaderPanel({ open, onOpenChange, trigger, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactNode;
  title: string; description: string; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content className="fixed right-3 top-[calc(env(safe-area-inset-top,0px)+3.75rem)] z-50 flex max-h-[55dvh] w-[calc(100%-1.5rem)] max-w-sm flex-col rounded-2xl border border-border bg-card text-card-foreground shadow-xl focus:outline-none">
        <div className="relative shrink-0 border-b border-border p-4 pr-12">
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">{description}</Dialog.Description>
          <Dialog.Close className="absolute right-2 top-2 inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={t('common.close', 'Close')}><X className="h-4 w-4" /></Dialog.Close>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
