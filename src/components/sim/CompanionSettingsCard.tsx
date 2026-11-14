import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { isOnline } from '@/lib/sim/companion';
import { useOverview } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { useNow } from './use-now';

/**
 * Settings, Virtual mode: the Windows app that sends the laps. A short summary (how many computers, whether one is online) and the two things
 * a person does here: manage the computers and download the app. The full page (steps, games, each computer) is one click away.
 */
export function CompanionSettingsCard() {
  const { t } = useTranslation();
  const now = useNow();
  const { data: overview } = useOverview();
  const devices = overview?.companion.devices ?? [];
  const online = devices.filter((device) => isOnline(device.lastSeenAt, now)).length;

  let summary: string;
  if (!overview) summary = t('common.loading', 'Loading…');
  else if (devices.length === 0) summary = t('modes.overview.connectBody', 'Connect Xpeed Companion on the computer you race on, and your laps arrive here by themselves.');
  else summary = t('communityDash.companion.settingsSummary', '{{count}} computer connected · {{online}} online now', { count: devices.length, online });

  return (
    <Card className="bg-card border-border" data-testid="settings-companion">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Radio className="h-5 w-5 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t('modes.nav.xpeedSim', 'Xpeed Companion')}</h3>
          {overview && devices.length > 0 && (
            <span
              className={cn('h-2 w-2 rounded-full', online > 0 ? 'bg-success' : 'bg-muted-foreground/50')}
              role="img"
              aria-label={online > 0 ? t('communityDash.companion.online', 'Online') : t('communityDash.companion.offline', 'Offline')}
              data-testid="settings-companion-dot"
            />
          )}
        </div>
        <p className="text-sm text-muted-foreground" data-testid="settings-companion-summary">{summary}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/virtual/companion" data-testid="settings-companion-manage">{t('communityDash.companion.settingsManage', 'Manage computers and games')}</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/companion" data-testid="settings-companion-download"><Download className="mr-2 h-4 w-4" aria-hidden="true" />{t('modes.states.install', 'Get Xpeed Companion')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
