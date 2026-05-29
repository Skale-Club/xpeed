import { useState, useEffect } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, Sparkles, Globe, Info, Smartphone, Share, Download, Save, RotateCcw } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useSettings } from '@/contexts/SettingsContext';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import McpTokensSection from '@/components/McpTokensSection';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function usePWAInstall() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    setIsInstalled(standalone);

    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as { MSStream?: unknown }).MSStream;
    setIsIOS(ios);

    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') setPrompt(null);
  };

  return { prompt, isInstalled, isIOS, install };
}

function PWASection() {
  const { prompt, isInstalled, isIOS, install } = usePWAInstall();

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <Smartphone className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-mono font-semibold text-foreground">Install App</h3>
        </div>

        {isInstalled ? (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Xpeed is running as an installed app. To reinstall, remove it from your home screen and use the button below.
          </p>
        ) : isIOS ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              To install on iPhone / iPad:
            </p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Tap the <Share className="w-3 h-3 inline mb-0.5" /> Share button in Safari</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
              <li>Tap <strong>Add</strong> to confirm</li>
            </ol>
          </div>
        ) : prompt ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Install Xpeed on your home screen for faster access and offline support.
            </p>
            <Button size="sm" className="gap-2" onClick={install}>
              <Download className="w-3.5 h-3.5" />
              Add to Home Screen
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Open Xpeed in Chrome or Edge on Android, or Safari on iPhone/iPad, to install it as an app.
            If already installed, remove from home screen first to trigger reinstall.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { distanceUnit, setDistanceUnit, timezone, setTimezone } = useSettings();

  // Pending (unsaved) state — changes are staged here before the user hits Save
  const [pendingUnit, setPendingUnit] = useState<'km' | 'mi'>(distanceUnit);
  const [pendingTZ, setPendingTZ] = useState(timezone);

  // Keep pending in sync if context ever resets (e.g. on first load)
  useEffect(() => { setPendingUnit(distanceUnit); }, [distanceUnit]);
  useEffect(() => { setPendingTZ(timezone); }, [timezone]);

  const isDirty = pendingUnit !== distanceUnit || pendingTZ !== timezone;

  const handleSave = () => {
    setDistanceUnit(pendingUnit);
    setTimezone(pendingTZ);
    toast.success('Settings saved');
  };

  const handleDiscard = () => {
    setPendingUnit(distanceUnit);
    setPendingTZ(timezone);
  };

  const timezones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [Intl.DateTimeFormat().resolvedOptions().timeZone];

  return (
    <AppLayout>
      <div className="space-y-4">
        {/* Header — Save button appears inline on desktop when dirty */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-mono font-bold text-foreground">Settings</h2>
          </div>
          {isDirty && (
            <div className="hidden sm:flex items-center gap-2 animate-in fade-in slide-in-from-right-2 duration-150">
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleDiscard}>
                <RotateCcw className="w-3 h-3" />
                Discard
              </Button>
              <Button size="sm" className="gap-1.5 text-xs" onClick={handleSave}>
                <Save className="w-3.5 h-3.5" />
                Save
              </Button>
            </div>
          )}
        </div>

        {/* Mobile floating Save button — visible only on small screens when dirty */}
        {isDirty && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 sm:hidden animate-in fade-in slide-in-from-bottom-3 duration-200">
            <Button variant="outline" size="sm" className="gap-1.5 shadow-lg bg-background" onClick={handleDiscard}>
              <RotateCcw className="w-3 h-3" />
              Discard
            </Button>
            <Button size="default" className="gap-2 shadow-lg px-6" onClick={handleSave}>
              <Save className="w-4 h-4" />
              Save Changes
            </Button>
          </div>
        )}

        <Tabs defaultValue="app" className="w-full">
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="app" className="text-xs gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              App
            </TabsTrigger>
            <TabsTrigger value="integrations" className="text-xs gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="about" className="text-xs gap-1.5">
              <Info className="w-3.5 h-3.5" />
              About
            </TabsTrigger>
          </TabsList>

          {/* App tab: preferences + PWA */}
          <TabsContent value="app" className="space-y-4 mt-0">
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 mb-4">
                  <Globe className="w-5 h-5 text-primary" />
                  <h3 className="text-sm font-mono font-semibold text-foreground">Preferences</h3>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs font-mono">Distance Unit</Label>
                    <Select value={pendingUnit} onValueChange={(v: 'km' | 'mi') => setPendingUnit(v)}>
                      <SelectTrigger className={`font-mono text-xs ${pendingUnit !== distanceUnit ? 'border-primary' : ''}`}>
                        <SelectValue placeholder="Select unit" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="km">Kilometers (km)</SelectItem>
                        <SelectItem value="mi">Miles (mi)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground">Used for distances and speed.</p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-mono">Timezone</Label>
                    <Select value={pendingTZ} onValueChange={setPendingTZ}>
                      <SelectTrigger className={`font-mono text-xs ${pendingTZ !== timezone ? 'border-primary' : ''}`}>
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent className="max-h-[250px]">
                        {timezones.map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz.replace(/_/g, ' ')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground">Used for displaying dates.</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <PWASection />
          </TabsContent>

          {/* Integrations tab: MCP + AI */}
          <TabsContent value="integrations" className="space-y-4 mt-0">
            <McpTokensSection />

            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 mb-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  <h3 className="text-sm font-mono font-semibold text-foreground">AI Assistant</h3>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  AI features (session analysis + chat) are powered by a shared OpenRouter key configured
                  by the system administrator. No per-user setup required. Daily fair-use limits apply.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* About tab */}
          <TabsContent value="about" className="space-y-4 mt-0">
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 mb-2">
                  <Info className="w-5 h-5 text-primary" />
                  <h3 className="text-sm font-mono font-semibold text-foreground">About Xpeed</h3>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Xpeed is a personal data viewer for OBD2 logs exported from Car Scanner, Torque Pro,
                  and similar apps. Manage multiple vehicles and track their health separately.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed mt-2">
                  Always consult a professional mechanic for serious vehicle issues.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
