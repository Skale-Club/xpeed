import { useTranslation } from 'react-i18next';
import { Crown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { podiumOf, podiumStage } from '@/lib/sim/leaderboard';
import type { LeaderboardEntry } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { Avatar, DriverName } from './social-bits';

/** How tall each step stands, by rank; a tie shares the height of its rank. */
const STEP_HEIGHT = ['min-h-[10.5rem]', 'min-h-[9rem]', 'min-h-[8rem]'] as const;
const MEDAL = ['bg-amber-500 text-black', 'bg-slate-300 text-black', 'bg-orange-500 text-black'] as const;

/**
 * The top three of the board on a podium: the winner in the middle, then second and third at the sides, each with the avatar, the driver,
 * the time and the gap to the winner. A tie shares a step (1, 2, 2). The driver's own step is outlined. Fewer than three drivers: just them.
 */
export function BoardPodium({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const { t } = useTranslation();
  const podium = podiumOf(entries);
  if (podium.length === 0) return null;
  const stage = podiumStage(podium);
  return (
    <section aria-labelledby="podium-title" className="space-y-2" data-testid="board-podium">
      <h3 id="podium-title" className="flex items-center gap-2 text-sm font-semibold"><Crown className="h-4 w-4 text-primary" aria-hidden="true" />{t('social.leaderboard.podium', 'Podium')}</h3>
      <ol
        className={cn('grid items-end gap-2', stage.length < 3 && 'mx-auto max-w-sm')}
        style={{ gridTemplateColumns: `repeat(${stage.length}, minmax(0, 1fr))` }}
        aria-label={t('social.leaderboard.podiumLabel', 'The three fastest drivers')}
      >
        {stage.map((entry) => {
          const step = Math.min(3, Math.max(1, entry.rank)) - 1;
          return (
            <li
              key={entry.lapId}
              className={cn(
                'flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-card px-1.5 pb-3 pt-3 text-center sm:px-3',
                STEP_HEIGHT[step],
                entry.isMe ? 'border-primary ring-1 ring-primary/60' : 'border-border',
              )}
              data-testid="podium-step"
              data-rank={entry.rank}
              data-me={entry.isMe ? 'true' : 'false'}
            >
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', MEDAL[step])} data-testid="podium-rank">
                <span className="sr-only">{t('social.leaderboard.rank', 'Rank')} </span>{entry.rank}
              </span>
              <Avatar handle={entry.handle} displayName={entry.displayName} size="lg" />
              <DriverName handle={entry.handle} displayName={entry.displayName} className="w-full flex-col items-center gap-0 text-sm" testId="podium-name" />
              {entry.isMe && <Badge variant="secondary" className="px-1.5 py-0 text-[11px]" data-testid="podium-you">{t('social.leaderboard.you', 'You')}</Badge>}
              <p className="mt-auto font-mono text-sm font-semibold tabular-nums sm:text-base" data-testid="podium-time">{formatLapTime(entry.timeMs)}</p>
              <p className="font-mono text-xs tabular-nums text-muted-foreground" data-testid="podium-gap">
                {entry.gapMs > 0 ? formatGap(entry.gapMs / 1000) : t('social.leaderboard.leader', 'Leader')}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
