import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Info, LineChart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { formatSeconds, spreadLabelValues, spreadOf, standingOf, type Spread } from '@/lib/sim/leaderboard';
import type { LeaderboardEntry, LeaderboardMe, Scope } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { DriverName } from './social-bits';
import { ordinal } from './social-utils';

/** The field on one line: a dot for every driver between the fastest and the slowest time known, the podium shaded, and the person's own dot in front. */
function SpreadBar({ spread, meMs }: { spread: Spread; meMs: number }) {
  const { t } = useTranslation();
  const values = spreadLabelValues(spread, meMs);
  return (
    <div className="space-y-1" data-testid="board-spread">
      <div
        role="img"
        aria-label={t('social.leaderboard.spreadLabel', 'The field: fastest {{fastest}}, you {{you}}, slowest shown {{slowest}}', values)}
        className="relative mx-2 h-6"
      >
        <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        {spread.podiumAt !== null && (
          <span className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/30" style={{ width: `${spread.podiumAt * 100}%` }} data-testid="spread-podium" />
        )}
        {spread.dots.filter((dot) => !dot.isMe).map((dot) => (
          <span key={dot.lapId} className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/60" style={{ left: `${dot.at * 100}%` }} data-testid="spread-dot" />
        ))}
        {spread.dots.filter((dot) => dot.isMe).map((dot) => (
          <span key={dot.lapId} className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary ring-2 ring-primary/40" style={{ left: `${dot.at * 100}%` }} data-testid="spread-me" />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
        <span>{values.fastest}</span>
        <span>{values.slowest}</span>
      </div>
    </div>
  );
}

/** "You are 12th of 25, 0.412 s from the podium and 1.90 s from the leader", in one sentence that fits where the person stands. */
function PlaceSentence({ me, entries, total }: { me: LeaderboardEntry; entries: readonly LeaderboardEntry[]; total: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage || 'en';
  const standing = standingOf(me, total, entries);
  const place = ordinal(me.rank, lang);
  const text =
    standing.kind === 'leader'
      ? standing.leadOverNextMs !== null
        ? t('social.leaderboard.sentenceLeaderLead', 'You are {{place}} of {{total}}, {{lead}} s ahead of the next driver.', { place, total, lead: formatSeconds(standing.leadOverNextMs, lang) })
        : t('social.leaderboard.sentenceLeader', 'You are {{place}} of {{total}}.', { place, total })
      : standing.kind === 'podium'
        ? t('social.leaderboard.sentencePodium', 'You are {{place}} of {{total}}, on the podium and {{leader}} s from the leader.', { place, total, leader: formatSeconds(standing.gapToLeaderMs, lang) })
        : standing.gapToPodiumMs !== null
          ? t('social.leaderboard.sentenceField', 'You are {{place}} of {{total}}, {{podium}} s from the podium and {{leader}} s from the leader.', {
              place, total, podium: formatSeconds(standing.gapToPodiumMs, lang), leader: formatSeconds(standing.gapToLeaderMs, lang),
            })
          : t('social.leaderboard.sentenceNoPodium', 'You are {{place}} of {{total}}, {{leader}} s from the leader.', { place, total, leader: formatSeconds(standing.gapToLeaderMs, lang) });
  // A no-break space before the unit, so "2.20 s" never splits across two lines.
  return <p className="text-sm font-semibold leading-snug" data-testid="board-me-place" data-kind={standing.kind}>{text.replace(/ s(?=[ ,.]|$)/g, ' s')}</p>;
}

/** Why the person is not on the board they are looking at. */
function NotListed({ scope }: { scope: Scope }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" role="status" data-testid="board-not-listed">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <p>
          {scope === 'public'
            ? t('social.leaderboard.notListedPublic', 'You are not listed because your profile is private, or your lap is not valid.')
            : t('social.leaderboard.notListedFriends', 'You are not listed here because you have no valid lap on this track and car.')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('social.leaderboard.notListedHelp', 'Only valid laps that pass the checks count. Public boards also need a public profile.')}{' '}
          <Link to="/virtual/profile" className="underline">{t('social.leaderboard.profileLink', 'Change who can see you')}</Link>
        </p>
      </div>
    </div>
  );
}

/**
 * Your position card: where you stand in one sentence (place, the gap to the podium and to the leader), your time, a line that shows the
 * spread of the field with you on it, and the drivers just above and below you. When you are not on the board, why.
 */
export function BoardPlace({ me, scope, entries }: {
  me: { isPending: boolean; isError: boolean; data: LeaderboardMe | undefined };
  scope: Scope;
  entries: readonly LeaderboardEntry[];
}) {
  const { t } = useTranslation();
  const data = me.data;
  const around = useMemo(() => (data?.me ? [...data.neighbours.above, data.me, ...data.neighbours.below] : []), [data]);
  const spread = useMemo(() => (data?.me ? spreadOf(entries, around) : null), [data, entries, around]);

  if (me.isPending) return <Skeleton className="h-40 w-full rounded-xl" data-testid="board-me-loading" />;
  if (me.isError || !data) return null;
  if (!data.me) return <NotListed scope={scope} />;
  const mine = data.me;
  return (
    <Card className="border-primary/40 bg-primary/5" data-testid="board-me">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('social.leaderboard.yourPosition', 'Your position')}</h3>
            <PlaceSentence me={mine} entries={entries} total={data.total} />
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-lg font-semibold tabular-nums" data-testid="board-me-time">{formatLapTime(mine.timeMs)}</p>
            <p className="text-xs text-muted-foreground">{t('social.leaderboard.yourBest', 'Your best')}</p>
          </div>
        </div>
        {spread && <SpreadBar spread={spread} meMs={mine.timeMs} />}
        {around.length > 1 && (
          <ol className="grid gap-1 text-xs" aria-label={t('social.leaderboard.around', 'The drivers around you')} data-testid="board-neighbours">
            {around.map((entry) => (
              <li key={entry.lapId} className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1', entry.isMe ? 'bg-primary/15 font-medium' : 'bg-background/60')}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="w-6 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{entry.rank}</span>
                  <DriverName handle={entry.handle} displayName={entry.displayName} link={!entry.isMe} className="min-w-0" testId="neighbour-name" />
                </span>
                <span className="shrink-0 font-mono tabular-nums">{formatLapTime(entry.timeMs)}</span>
              </li>
            ))}
          </ol>
        )}
        <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
          <Link to={compareUrl(mine.lapId)} data-testid="board-me-compare"><LineChart className="mr-2 h-4 w-4" />{t('social.leaderboard.compareMine', 'Compare my lap')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
