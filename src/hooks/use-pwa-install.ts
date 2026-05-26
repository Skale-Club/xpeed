import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'pwa-install-dismissed';

function isRunningStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function isIOSDevice(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as { MSStream?: unknown }).MSStream;
}

export interface UsePwaInstall {
  showPrompt: boolean;
  isIOS: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
}

export function usePwaInstall(): UsePwaInstall {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const isIOS = isIOSDevice();

  useEffect(() => {
    // Never show if already installed or user dismissed before
    if (isRunningStandalone()) return;
    if (localStorage.getItem(DISMISSED_KEY)) return;

    if (isIOS) {
      // iOS has no install event — show manual instructions immediately
      setShowPrompt(true);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredEvent(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [isIOS]);

  const install = async () => {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    const { outcome } = await deferredEvent.userChoice;
    if (outcome === 'accepted') {
      setShowPrompt(false);
      setDeferredEvent(null);
    }
  };

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setShowPrompt(false);
  };

  return { showPrompt, isIOS, install, dismiss };
}
