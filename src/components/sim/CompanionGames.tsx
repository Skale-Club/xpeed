import { useTranslation } from 'react-i18next';
import { Gamepad2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { gameRows, type GameRow, type GameTier } from '@/lib/sim/companion';
import { useGames } from '@/lib/sim/games';
import type { V1Overview } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';

/** One game, one line: its name and, when the account's numbers could be read, how many laps it holds (a dot says whether any arrived). */
function GameItem({ row, known }: { row: GameRow; known: boolean }) {
  const { t, i18n } = useTranslation();
  const games = useGames();
  const cover = games.cover(row.game);
  const received = row.laps > 0;
  return (
    <li className="flex items-center gap-2.5 py-1.5" data-testid="game-row" data-game={row.game} data-tier={row.tier} data-laps={row.laps}>
      {cover ? <img src={cover} alt="" className="h-7 w-7 shrink-0 rounded object-cover" loading="lazy" /> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"><Gamepad2 className="h-4 w-4" aria-hidden="true" /></span>}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{games.name(row.game)}</span>
      {known && (
        <span className={cn('flex shrink-0 items-center gap-1.5 text-xs', received ? 'text-foreground' : 'text-muted-foreground')} data-testid="game-status">
          <span className={cn('h-2 w-2 rounded-full', received ? 'bg-success' : 'bg-muted-foreground/40')} aria-hidden="true" />
          {received
            ? t('communityDash.companion.gameLaps', { count: row.laps, laps: new Intl.NumberFormat(i18n.resolvedLanguage || 'en').format(row.laps), defaultValue_one: '{{laps}} lap', defaultValue_other: '{{laps}} laps' })
            : t('communityDash.companion.gameNone', 'No laps yet')}
        </span>
      )}
    </li>
  );
}

function Tier({ tier, rows, known }: { tier: GameTier; rows: GameRow[]; known: boolean }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const certified = tier === 'certified';
  return (
    <div className="space-y-1" data-testid={`games-${tier}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{certified ? t('companionSite.certified', 'Certified') : t('companionSite.beta', 'Beta')}</h4>
      {!certified && <p className="text-xs text-muted-foreground">{t('communityDash.companion.betaNote', 'Beta games are supported but not fully checked yet, so some data may be missing.')}</p>}
      <ul className="divide-y divide-border">{rows.map((row) => <GameItem key={row.game} row={row} known={known} />)}</ul>
    </div>
  );
}

/**
 * The games Xpeed Companion supports, the certified ones first (Assetto Corsa and Automobilista 2), then the beta ones, a line each with the laps
 * the account holds in it. While the account's numbers are read there is a skeleton; if they cannot be read the list is still there, without them.
 */
export function CompanionGames({ overview, loading }: { overview: V1Overview | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const rows = gameRows(overview?.lapsPerGame);
  const known = !!overview;
  return (
    <Card className="space-y-4 bg-card p-4" data-testid="companion-games">
      <h3 className="font-semibold">{t('companionSite.gamesTitle', 'Games')}</h3>
      {loading ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading', 'Loading…')}><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
      ) : (
        <>
          <Tier tier="certified" rows={rows.filter((row) => row.tier === 'certified')} known={known} />
          <Tier tier="beta" rows={rows.filter((row) => row.tier === 'beta')} known={known} />
        </>
      )}
    </Card>
  );
}
