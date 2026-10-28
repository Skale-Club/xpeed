import { useState, useEffect } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, Globe, Info, Smartphone, Share, Download, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { isNativeApp } from '@/lib/obd/native-ble';
import { Label } from '@/components/ui/label';
import { useSettings } from '@/contexts/SettingsContext';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import McpTokensSection from '@/components/McpTokensSection';

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
  const { t } = useTranslation();
  const { prompt, isInstalled, isIOS, install } = usePWAInstall();

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-3">
          <Smartphone className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold">{t('settings.install.title', 'Install the app')}</h3>
        </div>
        {isInstalled ? (
          <p className="text-sm text-muted-foreground">{t('settings.install.installed', 'Xpeed is installed on this device.')}</p>
        ) : isIOS ? (
          <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
            <li>{t('settings.install.ios1', 'Tap the Share button in Safari')} <Share className="w-3 h-3 inline mb-0.5" /></li>
            <li>{t('settings.install.ios2', 'Choose "Add to Home Screen"')}</li>
            <li>{t('settings.install.ios3', 'Tap "Add"')}</li>
          </ol>
        ) : prompt ? (
          <Button size="sm" className="gap-2" onClick={install}>
            <Download className="w-3.5 h-3.5" />
            {t('settings.install.button', 'Add to Home Screen')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('settings.install.other', 'Open Xpeed in Chrome on Android (or Safari on iPhone) to install it.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const LANGS = [
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'en', label: 'English' },
  { code: 'es-ES', label: 'Español' },
];

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { distanceUnit, setDistanceUnit, timezone, setTimezone, advancedTools, setAdvancedTools } = useSettings();
  const currentLang = LANGS.find((l) => i18n.resolvedLanguage === l.code)?.code ?? 'en';

  const timezones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [Intl.DateTimeFormat().resolvedOptions().timeZone];

  return (
    <AppLayout>
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold">{t('settings.title', 'Settings')}</h2>
        </div>

        {/* Preferences apply immediately — no separate save step */}
        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-semibold">{t('settings.prefs.title', 'Preferences')}</h3>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-lang">{t('settings.prefs.language', 'Language')}</Label>
                <Select value={currentLang} onValueChange={(v) => void i18n.changeLanguage(v)}>
                  <SelectTrigger id="set-lang"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANGS.map((l) => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="set-unit">{t('settings.prefs.distance', 'Distance')}</Label>
                <Select value={distanceUnit} onValueChange={(v: 'km' | 'mi') => setDistanceUnit(v)}>
                  <SelectTrigger id="set-unit"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="km">{t('settings.prefs.km', 'Kilometers (km)')}</SelectItem>
                    <SelectItem value="mi">{t('settings.prefs.mi', 'Miles (mi)')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="set-tz">{t('settings.prefs.timezone', 'Time zone')}</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger id="set-tz"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-[250px]">
                    {timezones.map((tz) => <SelectItem key={tz} value={tz}>{tz.replace(/_/g, ' ')}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.timezoneHint', 'Set automatically from this device; change it only if dates look wrong.')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {!isNativeApp() && <PWASection />}

        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <Switch checked={advancedTools} onCheckedChange={setAdvancedTools} aria-label={t('settings.advanced.title', 'Advanced tools')} />
              <span>
                <span className="text-sm font-semibold flex items-center gap-2"><Wrench className="w-4 h-4" /> {t('settings.advanced.title', 'Advanced tools')}</span>
                <span className="text-sm text-muted-foreground block">
                  {t('settings.advanced.hint', 'For mechanics and enthusiasts: shows the Scanner (terminal, custom PIDs, module discovery, clearing fault codes) and developer integrations.')}
                </span>
              </span>
            </label>
            {advancedTools && (
              <div className="space-y-4 border-t border-border pt-3">
                <Link to="/scanner" className="text-sm text-primary hover:underline">{t('settings.advanced.openScanner', 'Open the Scanner')}</Link>
                <McpTokensSection />
                <p className="text-xs text-muted-foreground">
                  {t('settings.advanced.ai', 'AI features (trip analysis and the assistant) use a shared key set up by the administrator. Daily fair-use limits apply.')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-semibold">{t('settings.about.title', 'About Xpeed')}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('settings.about.body', 'Xpeed reads your car through a small Bluetooth adapter, records your trips and explains in plain words what needs attention.')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('settings.about.disclaimer', 'It gives hints from data, not a diagnosis — for warning lights or serious symptoms, see a mechanic.')}
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
