import { useTranslation } from 'react-i18next';
import { Check, Circle, Flag, Gamepad2, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { gameRows, type GameRow, type GameTier } from '@/lib/sim/companion';
import { useGames } from '@/lib/sim/games';
import type { V1Overview } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { useAge } from './use-age';

function GameItem({ row, known }: { row: GameRow; known: boolean }) {
  const { t, i18n } = useTranslation();
  const games = useGames();
  const age = useAge();
  const cover = games.cover(row.game);
  const received = row.laps > 0;
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-background/50 px-3 py-2" data-testid="game-row" data-game={row.game} data-tier={row.tier} data-laps={row.laps}>
      {cover ? <img src={cover} alt="" className="h-8 w-8 shrink-0 rounded object-cover" loading="lazy" /> : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"><Gamepad2 className="h-4 w-4" aria-hidden="true" /></span>}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{games.name(row.game)}</p>
        {known && (
          <p className={cn('flex items-center gap-1 truncate text-xs', received ? 'text-foreground' : 'text-muted-foreground')} data-testid="game-status">
            {received ? <Check className="h-3 w-3 shrink-0 text-success" aria-hidden="true" /> : <Circle className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="truncate">
              {received && row.lastDrivenAt
                ? t('communityDash.companion.gameLaps', '{{laps}} laps · last driven {{when}}', { laps: new Intl.NumberFormat(i18n.resolvedLanguage || 'en').format(row.laps), when: age(Date.parse(row.lastDrivenAt)) })
                : t('communityDash.companion.gameNone', 'No laps yet')}
            </span>
          </p>
        )}
      </div>
    </li>
  );
}

function Tier({ tier, rows, known }: { tier: GameTier; rows: GameRow[]; known: boolean }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const certified = tier === 'certified';
  return (
    <div className="space-y-2" data-testid={`games-${tier}`}>
      <div className="space-y-0.5">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          {certified ? <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" /> : <Flag className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          {certified ? t('companionSite.certified', 'Certified') : t('companionSite.beta', 'Beta')}
          <Badge variant={certified ? 'default' : 'outline'} className="px-1.5 py-0 text-[11px]">{rows.length}</Badge>
        </h4>
        <p className="text-xs text-muted-foreground">
          {certified ? t('companionSite.certifiedText', 'Tested with the real game: laps, track map and inputs are checked.') : t('companionSite.betaText', 'Supported, but still being checked with the real game. Some data may be missing.')}
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">{rows.map((row) => <GameItem key={row.game} row={row} known={known} />)}</ul>
    </div>
  );
}

/**
 * The games Xpeed Companion supports, the certified ones first (Assetto Corsa and Automobilista 2), then the beta ones, each with what the account
 * holds in it: the laps received and when it was last driven. While the account's numbers are read there is a skeleton; if they cannot be read the
 * list is still there, without the numbers.
 */
export function CompanionGames({ overview, loading }: { overview: V1Overview | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const rows = gameRows(overview?.lapsPerGame);
  const known = !!overview;
  return (
    <Card className="space-y-4 bg-card p-4" data-testid="companion-games">
      <h3 className="font-semibold">{t('companionSite.gamesTitle', 'Games')}</h3>
      {loading ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading', 'Loading…')}><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
      ) : (
        <>
          <Tier tier="certified" rows={rows.filter((row) => row.tier === 'certified')} known={known} />
          <Tier tier="beta" rows={rows.filter((row) => row.tier === 'beta')} known={known} />
        </>
      )}
    </Card>
  );
}
