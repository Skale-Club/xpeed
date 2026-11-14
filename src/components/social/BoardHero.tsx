import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Flag, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SimCarIdentity } from '@/components/sim/SimCarIdentity';
import { GameBadge } from '@/components/sim/session-bits';
import { useSettings } from '@/contexts/SettingsContext';
import { formatLapTime, type DistanceUnit } from '@/lib/sim/analysis';
import { formatDistance } from '@/lib/sim/dashboard';
import { trackPagePath } from '@/lib/sim/social-client';
import { TrackThumb } from './TrackThumb';
import { copyText } from './social-utils';

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background/50 px-2 py-2 sm:px-3">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="whitespace-nowrap font-mono text-sm font-semibold tabular-nums sm:text-base" data-testid={testId}>{value}</p>
    </div>
  );
}

/**
 * The top of the leaderboards: the track (its map when Xpeed Companion sent the layout) and the car, the game, how many drivers are on the
 * board, the fastest time and yours; the Public / Friends choice; a link to the track page and a button that copies the address of the board.
 * The pickers are the children, so they sit in the same card.
 */
export function BoardHero({ trackId, trackName, lengthM, layoutId, carName, carClass, game, total, leaderMs, myMs, scopeTabs, children }: {
  trackId: string | null;
  trackName: string;
  lengthM: number | null | undefined;
  layoutId: string | null | undefined;
  carName: string;
  carClass: string | null | undefined;
  game: string | null;
  /** How many drivers are on the board; null while it is not known. */
  total: number | null;
  leaderMs: number | null;
  myMs: number | null;
  scopeTabs: ReactNode;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { distanceUnit } = useSettings();
  const lang = i18n.resolvedLanguage || 'en';
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const dash = '–';
  return (
    <Card className="space-y-4 bg-card p-4" data-testid="board-hero">
      <div className="flex items-start gap-3 sm:gap-4">
        <TrackThumb layoutId={layoutId} name={trackName} className="h-16 w-16 sm:h-24 sm:w-24" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="flex items-center gap-2 text-lg font-bold leading-tight sm:text-xl" data-testid="board-title">
            <Flag className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 truncate">{trackName || dash}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {typeof lengthM === 'number' && lengthM > 0 && <span data-testid="board-length">{formatDistance(lengthM, distanceUnit as DistanceUnit, lang)}</span>}
            {game && <GameBadge game={game} />}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {carName ? <SimCarIdentity name={carName} /> : <span className="text-muted-foreground">{dash}</span>}
            {carClass && <Badge variant="secondary" data-testid="board-car-class">{carClass}</Badge>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2" data-testid="board-stats">
        <Stat label={t('social.leaderboard.statDrivers', 'Drivers')} value={total === null ? dash : new Intl.NumberFormat(lang).format(total)} testId="board-stat-drivers" />
        <Stat label={t('social.leaderboard.statFastest', 'Fastest')} value={leaderMs === null ? dash : formatLapTime(leaderMs)} testId="board-stat-fastest" />
        <Stat label={t('social.leaderboard.yourBest', 'Your best')} value={myMs === null ? dash : formatLapTime(myMs)} testId="board-stat-yours" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {scopeTabs}
        <div className="flex flex-wrap items-center gap-2">
          {trackId && (
            <Button asChild size="sm" variant="outline">
              <Link to={trackPagePath(trackId)} data-testid="board-track-page">{t('social.leaderboard.trackPage', 'Track page')}</Link>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={async () => setCopied((await copyText(window.location.href, null)) ? 'yes' : 'no')}
            data-testid="board-copy-link"
          >
            {copied === 'yes' ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            {copied === 'yes' ? t('social.leaderboard.linkCopied', 'Link copied') : t('social.leaderboard.copyLink', 'Copy link to this board')}
          </Button>
        </div>
      </div>
      {copied === 'no' && <p className="text-xs text-muted-foreground" role="status">{t('social.leaderboard.copyFailed', 'Could not copy. Copy the address from the browser bar.')}</p>}

      <div className="border-t border-border pt-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Users className="h-3.5 w-3.5" aria-hidden="true" />{t('social.leaderboard.choose', 'Choose a board')}</p>
        {children}
      </div>
    </Card>
  );
}
