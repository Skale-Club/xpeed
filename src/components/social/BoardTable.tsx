import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useWhen } from '@/components/sim/use-when';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { gapShare } from '@/lib/sim/leaderboard';
import type { LeaderboardEntry } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { AidIcons } from './BoardAids';
import { ReportButton } from './ReportDialog';
import { Avatar, DriverName } from './social-bits';

/** The gap to the leader in seconds, as the rest of the app writes it (`+0.123`). */
const gapText = (gapMs: number) => (gapMs <= 0 ? '' : formatGap(gapMs / 1000));

const MEDAL = ['text-warn', 'text-slate-400', 'text-orange-500'] as const;

/** One row of the board; the person's own row is highlighted (its lap is analysed from the "Your position" card). Report is offered for everybody else's. */
function BoardRow({ entry, maxGapMs, showGap }: { entry: LeaderboardEntry; maxGapMs: number; showGap: boolean }) {
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
          {/* On a phone the aid icons go under the name: beside it they leave the name a letter or two of room. */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <DriverName handle={entry.handle} displayName={entry.displayName} className="min-w-0 flex-1 flex-col gap-0 overflow-hidden sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2" />
            <AidIcons aids={entry.aids} className="self-start sm:self-auto" />
          </div>
          {entry.isMe && <Badge variant="secondary" className="hidden sm:inline-flex" data-testid="board-you">{t('social.leaderboard.you', 'You')}</Badge>}
        </div>
        {entry.isMe && <span className="mt-0.5 inline-block text-2xs font-semibold text-primary sm:hidden" aria-hidden="true">{t('social.leaderboard.you', 'You')}</span>}
      </td>
      <td className="whitespace-nowrap py-2 pr-2 text-right font-mono tabular-nums" data-testid="board-time">{formatLapTime(entry.timeMs)}</td>
      {showGap && <td className="w-20 py-2 pr-2 text-right sm:w-36 sm:pr-3">
        <span className="block whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground" data-testid="board-gap">{gapText(entry.gapMs) || '–'}</span>
        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span
            className={cn('block h-full rounded-full', entry.isMe ? 'bg-primary' : 'bg-muted-foreground/50')}
            style={{ width: `${Math.max(share > 0 ? 4 : 0, share * 100)}%` }}
            data-testid="board-gap-bar"
            data-share={share.toFixed(3)}
          />
        </span>
      </td>}
      <td className="hidden whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground sm:table-cell">{when(Date.parse(entry.achievedAt))}</td>
      <td className="whitespace-nowrap py-2 pr-1 text-right sm:pr-2">
        {!entry.isMe && <ReportButton targets={[{ kind: 'lap', lapId: entry.lapId }, { kind: 'profile', handle: entry.handle }]} />}
      </td>
    </tr>
  );
}

/**
 * The ranked table: rank, driver, time, the gap to the leader with a bar (the longest bar is the slowest driver loaded; no gap column while
 * the leader is alone), the date, and Report on other drivers' rows. Ties share a rank (1, 2, 2, 4), the way the server sends them.
 */
export function BoardTable({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const { t } = useTranslation();
  const maxGapMs = useMemo(() => entries.reduce((most, entry) => Math.max(most, entry.gapMs), 0), [entries]);
  const showGap = entries.length > 1;
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
              {showGap && <th scope="col" className="py-2 pr-2 text-right font-normal sm:pr-3">{t('social.leaderboard.gap', 'Gap')}</th>}
              <th scope="col" className="hidden py-2 pr-3 font-normal sm:table-cell">{t('social.leaderboard.date', 'Date')}</th>
              <th scope="col" className="py-2 pr-2 font-normal"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <BoardRow key={`${entry.rank}-${entry.lapId}`} entry={entry} maxGapMs={maxGapMs} showGap={showGap} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
