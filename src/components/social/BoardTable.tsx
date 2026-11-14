import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useWhen } from '@/components/sim/use-when';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { gapShare } from '@/lib/sim/leaderboard';
import type { LeaderboardEntry } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { ReportButton } from './ReportDialog';
import { Avatar, DriverName } from './social-bits';

/** The gap to the leader in seconds, as the rest of the app writes it (`+0.123`). */
const gapText = (gapMs: number) => (gapMs <= 0 ? '' : formatGap(gapMs / 1000));

const MEDAL = ['text-amber-500', 'text-slate-400', 'text-orange-500'] as const;

/** One row of the board; the person's own row is highlighted. Compare is only offered for one's own lap; Report for everybody else's. */
function BoardRow({ entry, maxGapMs }: { entry: LeaderboardEntry; maxGapMs: number }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const share = gapShare(entry.gapMs, maxGapMs);
  return (
    <tr
      className={cn('border-t border-border', entry.isMe && 'bg-primary/10 font-medium')}
      aria-current={entry.isMe ? 'true' : undefined}
      data-testid="board-row"
      data-rank={entry.rank}
      data-me={entry.isMe ? 'true' : 'false'}
    >
      <td className={cn('w-9 py-2 pl-2 pr-1 text-right font-mono tabular-nums', entry.rank <= 3 && `font-semibold ${MEDAL[entry.rank - 1]}`)} data-testid="board-rank">{entry.rank}</td>
      <td className="w-full min-w-0 max-w-0 py-2 pr-2 sm:w-auto sm:max-w-none">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar handle={entry.handle} displayName={entry.displayName} size="sm" />
          <DriverName handle={entry.handle} displayName={entry.displayName} className="min-w-0 flex-1 flex-col gap-0 overflow-hidden sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2" />
          {entry.isMe && <Badge variant="secondary" className="hidden sm:inline-flex" data-testid="board-you">{t('social.leaderboard.you', 'You')}</Badge>}
        </div>
        {entry.isMe && <span className="mt-0.5 inline-block text-[11px] font-semibold text-primary sm:hidden" aria-hidden="true">{t('social.leaderboard.you', 'You')}</span>}
      </td>
      <td className="whitespace-nowrap py-2 pr-2 text-right font-mono tabular-nums" data-testid="board-time">{formatLapTime(entry.timeMs)}</td>
      <td className="w-20 py-2 pr-2 text-right sm:w-36 sm:pr-3">
        <span className="block whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground" data-testid="board-gap">{gapText(entry.gapMs) || '–'}</span>
        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span
            className={cn('block h-full rounded-full', entry.isMe ? 'bg-primary' : 'bg-muted-foreground/50')}
            style={{ width: `${Math.max(share > 0 ? 4 : 0, share * 100)}%` }}
            data-testid="board-gap-bar"
            data-share={share.toFixed(3)}
          />
        </span>
      </td>
      <td className="hidden whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground sm:table-cell">{when(Date.parse(entry.achievedAt))}</td>
      <td className="whitespace-nowrap py-2 pr-1 text-right sm:pr-2">
        {entry.isMe ? (
          <Button asChild size="sm" variant="outline" className="h-8 px-2">
            <Link to={compareUrl(entry.lapId)} aria-label={t('social.leaderboard.compareMine', 'Compare my lap')} data-testid="board-compare">
              <LineChart className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('social.leaderboard.compare', 'Compare')}</span>
            </Link>
          </Button>
        ) : (
          <ReportButton targets={[{ kind: 'lap', lapId: entry.lapId }, { kind: 'profile', handle: entry.handle }]} />
        )}
      </td>
    </tr>
  );
}

/**
 * The ranked table: rank, driver, time, the gap to the leader with a bar (the longest bar is the slowest driver loaded), the date, and the
 * action that fits the row. Ties share a rank (1, 2, 2, 4), the way the server sends them.
 */
export function BoardTable({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const { t } = useTranslation();
  const maxGapMs = useMemo(() => entries.reduce((most, entry) => Math.max(most, entry.gapMs), 0), [entries]);
  return (
    <Card className="overflow-hidden bg-card" data-testid="board-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="board-table">
          <caption className="sr-only">{t('social.leaderboard.caption', 'Best valid lap of each driver, fastest first')}</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-2 pr-1 text-right font-normal">{t('social.leaderboard.rank', 'Rank')}</th>
              <th scope="col" className="py-2 pr-2 font-normal">{t('social.leaderboard.driver', 'Driver')}</th>
              <th scope="col" className="py-2 pr-2 text-right font-normal">{t('social.leaderboard.time', 'Time')}</th>
              <th scope="col" className="py-2 pr-2 text-right font-normal sm:pr-3">{t('social.leaderboard.gap', 'Gap')}</th>
              <th scope="col" className="hidden py-2 pr-3 font-normal sm:table-cell">{t('social.leaderboard.date', 'Date')}</th>
              <th scope="col" className="py-2 pr-2 font-normal"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <BoardRow key={`${entry.rank}-${entry.lapId}`} entry={entry} maxGapMs={maxGapMs} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
