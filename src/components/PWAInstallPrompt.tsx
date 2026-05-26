import { X, Download, Share, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePwaInstall } from '@/hooks/use-pwa-install';
import { useBrand } from '@/hooks/use-brand';

export function PWAInstallPrompt() {
  const { showPrompt, isIOS, install, dismiss } = usePwaInstall();
  const brand = useBrand();

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 animate-in slide-in-from-bottom-4 duration-300">
      <div className="max-w-lg mx-auto bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 pb-3">
          <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted flex-shrink-0 flex items-center justify-center border border-border">
            {brand.logo_url ? (
              <img src={brand.logo_url} alt="App icon" className="w-full h-full object-cover" />
            ) : (
              <Download className="w-6 h-6 text-primary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground leading-tight">Add to Home Screen</p>
            <p className="text-xs text-muted-foreground mt-0.5">Install for the best experience</p>
          </div>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* iOS instructions */}
        {isIOS ? (
          <div className="px-4 pb-4 space-y-3">
            <p className="text-xs text-muted-foreground">Follow these steps in Safari:</p>
            <div className="space-y-2">
              {[
                { icon: <Share className="w-4 h-4 text-primary flex-shrink-0" />, text: 'Tap the Share button in the browser toolbar' },
                { icon: <Plus className="w-4 h-4 text-primary flex-shrink-0" />, text: 'Scroll down and tap "Add to Home Screen"' },
                { icon: <Download className="w-4 h-4 text-primary flex-shrink-0" />, text: 'Tap "Add" to confirm' },
              ].map(({ icon, text }, i) => (
                <div key={i} className="flex items-center gap-3 bg-muted/50 rounded-xl px-3 py-2">
                  <span className="text-xs font-mono text-muted-foreground w-4 text-center">{i + 1}</span>
                  {icon}
                  <span className="text-xs text-foreground">{text}</span>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" className="w-full mt-1" onClick={dismiss}>
              Got it
            </Button>
          </div>
        ) : (
          /* Android / Chrome */
          <div className="px-4 pb-4 flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={dismiss}>
              Not now
            </Button>
            <Button size="sm" className="flex-1 gap-2" onClick={install}>
              <Download className="w-3.5 h-3.5" />
              Install
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
