import { useState, useEffect } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, Globe, Info, Smartphone, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { isNativeApp } from '@/lib/obd/native-ble';
import { installKind } from '@/lib/device';
import { AndroidAppDownload, IosAddToHome, IphoneNoBluetooth } from '@/components/InstallApp';
import { Label } from '@/components/ui/label';
import { useSettings } from '@/contexts/SettingsContext';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import McpTokensSection from '@/components/McpTokensSection';
import { LANGUAGES, currentLanguage } from '@/lib/languages';

/** "Version 1.0 (build 19)" inside the Android app. */
function useAppVersion(): { version: string; build: string } | null {
  const [info, setInfo] = useState<{ version: string; build: string } | null>(null);
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    void import('@capacitor/app')
      .then(({ App }) => App.getInfo())
      .then((i) => { if (!cancelled) setInfo({ version: i.version, build: i.build }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return info;
}

/** What to install on this device: the Android app, Safari's home-screen icon, or nothing. */
function InstallSection() {
  const { t } = useTranslation();
  const kind = installKind();

  return (
    <Card className="bg-card border-border" data-testid="install-section">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Smartphone className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold">
            {kind === 'native' ? t('install.appTitle', 'The app') : t('settings.install.title', 'Install the app')}
          </h3>
        </div>
        {kind === 'native' ? (
          <p className="text-sm text-muted-foreground">
            {t('install.installed', "You're using the Xpeed app.")}
          </p>
        ) : kind === 'android' ? (
          <>
            <p className="text-sm text-muted-foreground">{t('install.android.subtitle', 'Records your trips by itself, even with the screen off.')}</p>
            <AndroidAppDownload />
          </>
        ) : kind === 'ios' ? (
          <>
            <IosAddToHome />
            <IphoneNoBluetooth />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('install.computer', 'To record trips, open xpeed.skale.club on an Android phone and get the app there.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const version = useAppVersion();
  const { distanceUnit, setDistanceUnit, timezone, setTimezone, advancedTools, setAdvancedTools } = useSettings();
  const currentLang = currentLanguage(i18n.resolvedLanguage).code;

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
                    {LANGUAGES.map((l) => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
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

        <InstallSection />

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
            {version && (
              <p className="rounded-md border border-border px-3 py-2 text-sm font-semibold" data-testid="app-version">
                {t('install.version', 'Version {{version}} (build {{build}})', version)}
              </p>
            )}
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
