import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Ban, CalendarDays, Check, Gamepad2, Trophy, UserCheck, UserMinus, UserPlus, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { QueryGate } from '@/components/sim/SimStates';
import { SimCarIdentity } from '@/components/sim/SimCarIdentity';
import { GameBadge } from '@/components/sim/session-bits';
import { useWhen } from '@/components/sim/use-when';
import { formatLapTime } from '@/lib/sim/analysis';
import {
  cleanName, leaderboardPath, trackPagePath, useAcceptFriend, useBlockDriver, useDeclineFriend, useDriver, useRemoveFriend, useSendFriendRequest,
  type DriverPage as Driver,
} from '@/lib/sim/social-client';
import { V1Error } from '@/lib/sim/v1-client';
import { ReportButton } from './ReportDialog';
import { Avatar, ErrorLine } from './social-bits';
import { atHandle } from './social-utils';
import { useErrorText } from './use-error-text';

/** One neutral page for a driver who is private, hidden, blocked or does not exist: it never says which. */
export function DriverNotFound() {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-6 text-center" data-testid="driver-not-found">
      <h3 className="text-lg font-semibold">{t('social.driver.notFound', 'Driver not found')}</h3>
      <p className="text-sm text-muted-foreground">{t('social.driver.notFoundBody', 'There is no driver at this address, or you cannot see this page.')}</p>
      <Button asChild size="sm" variant="outline"><Link to="/virtual/leaderboards">{t('social.driver.toBoards', 'Go to the leaderboards')}</Link></Button>
    </div>
  );
}

/** The friend action(s) that fit how this person stands with you. */
function RelationActions({ driver }: { driver: Driver }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const send = useSendFriendRequest();
  const accept = useAcceptFriend();
  const decline = useDeclineFriend();
  const remove = useRemoveFriend();
  const block = useBlockDriver();
  const [confirm, setConfirm] = useState<'remove' | 'block' | null>(null);
  const busy = send.isPending || accept.isPending || decline.isPending || remove.isPending || block.isPending;
  const failure = send.error ?? accept.error ?? decline.error ?? remove.error ?? block.error;

  return (
    <div className="space-y-2" data-testid="driver-actions">
      <div className="flex flex-wrap items-center gap-2">
        {driver.relation === 'none' && (
          <Button size="sm" disabled={busy} onClick={() => send.mutate(driver.handle)} data-testid="action-add">
            <UserPlus className="mr-2 h-4 w-4" /> {t('social.driver.add', 'Add friend')}
          </Button>
        )}
        {driver.relation === 'requested' && (
          <>
            <Badge variant="secondary" className="gap-1" data-testid="relation-requested"><Check className="h-3 w-3" /> {t('social.driver.requested', 'Requested')}</Badge>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => remove.mutate(driver.handle)} data-testid="action-cancel">
              {t('social.driver.cancelRequest', 'Cancel request')}
            </Button>
          </>
        )}
        {driver.relation === 'incoming' && (
          <>
            <Button size="sm" disabled={busy} onClick={() => accept.mutate(driver.handle)} data-testid="action-accept">
              <UserCheck className="mr-2 h-4 w-4" /> {t('social.driver.accept', 'Accept')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => decline.mutate(driver.handle)} data-testid="action-decline">
              {t('social.driver.decline', 'Decline')}
            </Button>
          </>
        )}
        {driver.relation === 'friend' && (
          <>
            <Badge className="gap-1" data-testid="relation-friends"><UserCheck className="h-3 w-3" /> {t('social.driver.friends', 'Friends')}</Badge>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('remove')} data-testid="action-remove">
              <UserMinus className="mr-2 h-4 w-4" /> {t('social.driver.remove', 'Remove friend')}
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('block')} data-testid="action-block">
          <Ban className="mr-2 h-4 w-4" /> {t('social.driver.block', 'Block')}
        </Button>
        <ReportButton targets={[{ kind: 'profile', handle: driver.handle }]} label={t('social.driver.report', 'Report this driver')} className="h-9 w-9" />
      </div>
      {failure && <ErrorLine testId="driver-error">{errorText(failure)}</ErrorLine>}

      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('social.friends.removeTitle', 'Remove this friend?')}
        description={t('social.friends.removeBody', 'You stop being friends. You can send a new request later.')}
        confirmLabel={t('social.driver.remove', 'Remove friend')}
        onConfirm={() => remove.mutate(driver.handle)}
      />
      <ConfirmDialog
        open={confirm === 'block'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('social.friends.blockTitle', 'Block this driver?')}
        description={t('social.friends.blockBody', 'You will not see each other: no page, no leaderboard row, no requests. They are not told. You can unblock them in Friends.')}
        confirmLabel={t('social.driver.block', 'Block')}
        onConfirm={() => block.mutate(driver.handle, { onSuccess: () => navigate('/virtual/friends?tab=blocked', { replace: true }) })}
      />
    </div>
  );
}

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <Card className="min-w-0 space-y-0.5 bg-card p-3">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <p className="truncate text-2xl font-semibold tabular-nums leading-tight" data-testid={testId}>{value}</p>
      <p className="min-h-4 truncate text-xs text-muted-foreground">{sub ?? ' '}</p>
    </Card>
  );
}

/** What the page is waiting for: the header, the four tiles and the cards, in the places they will be. */
function DriverSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="driver-skeleton">
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>
    </div>
  );
}

/**
 * Virtual > a driver: a profile page. The header has the avatar (the initials), the name and handle, when they joined and the friend relation
 * with its actions; four tiles (personal bests, games, tracks and cars of the best laps shown); the games played; and the best laps as cards,
 * each linking to its leaderboard and its track page. Only what the driver chose to show: never an e-mail, a phone number or a real name.
 * A private, hidden, blocked or unknown driver is the same page: "Driver not found".
 */
export function DriverPage() {
  const { handle = '' } = useParams();
  const { t, i18n } = useTranslation();
  const when = useWhen('date');
  const query = useDriver(handle.toLowerCase());
  const driver = query.data ?? null;
  const notFound = query.error instanceof V1Error && query.error.status === 404;
  const lang = i18n.resolvedLanguage || 'en';
  const number = (value: number) => new Intl.NumberFormat(lang).format(value);

  return (
    <div className="space-y-4" data-testid="driver-page">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/virtual/leaderboards"><ArrowLeft className="mr-1 h-4 w-4" /> {t('social.driver.back', 'Leaderboards')}</Link>
      </Button>
      {notFound ? (
        <DriverNotFound />
      ) : (
        <QueryGate query={query} empty={false} skeleton={<DriverSkeleton />}>
          {driver && (
            <>
              <Card className="overflow-hidden bg-card" data-testid="driver-header">
                <div className="h-14 bg-gradient-to-r from-primary/25 via-primary/10 to-transparent" aria-hidden="true" />
                <CardContent className="space-y-3 px-4 pb-4 pt-0">
                  <div className="-mt-8 flex flex-wrap items-end justify-between gap-3">
                    <div className="flex min-w-0 items-end gap-3">
                      <Avatar handle={driver.handle} displayName={driver.displayName} size="xl" className="border-4 border-card" />
                      <div className="min-w-0 pb-0.5">
                        {cleanName(driver.displayName) ? (
                          <>
                            <h3 className="truncate text-xl font-bold leading-tight" data-testid="driver-name">{cleanName(driver.displayName)}</h3>
                            <p className="truncate text-sm text-muted-foreground" data-testid="driver-handle">{atHandle(driver.handle)}</p>
                          </>
                        ) : (
                          <h3 className="truncate text-xl font-bold leading-tight" data-testid="driver-handle">{atHandle(driver.handle)}</h3>
                        )}
                      </div>
                    </div>
                    {driver.isMe && <Badge variant="secondary" data-testid="driver-me">{t('social.driver.thisIsYou', 'This is you')}</Badge>}
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{t('social.driver.joined', 'Joined {{when}}', { when: when(Date.parse(driver.joinedAt)) })}</p>
                  {driver.isMe ? (
                    <div className="space-y-1 text-sm text-muted-foreground">
                      <p>
                        {t('social.driver.mePage', 'This is how your page looks to others.')}{' '}
                        <Link to="/virtual/profile" className="underline">{t('social.driver.editProfile', 'Edit your profile')}</Link>
                      </p>
                      {driver.visibility && (
                        <p data-testid="driver-visibility">
                          {t('social.driver.visibleTo', 'Who can see this page: {{who}}', {
                            who: driver.visibility === 'public' ? t('social.visibility.public', 'Public') : driver.visibility === 'friends' ? t('social.visibility.friends', 'Friends only') : t('social.visibility.private', 'Private'),
                          })}{' '}
                          <Link to="/virtual/privacy" className="underline">{t('social.driver.change', 'Change')}</Link>
                        </p>
                      )}
                    </div>
                  ) : (
                    <RelationActions driver={driver} />
                  )}
                </CardContent>
              </Card>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="driver-tiles">
                <Tile label={t('social.driver.pbs', 'Personal bests')} value={number(driver.personalBestsCount)} testId="driver-pbs" />
                <Tile label={t('social.driver.games', 'Games played')} value={number(driver.gamesPlayed.length)} testId="driver-games-count" />
                <Tile label={t('social.driver.tracks', 'Tracks')} value={number(new Set(driver.bestLaps.map((lap) => lap.track.id)).size)} sub={t('social.driver.inBestLaps', 'in the best laps below')} testId="driver-tracks-count" />
                <Tile label={t('social.driver.cars', 'Cars')} value={number(new Set(driver.bestLaps.map((lap) => lap.car.id)).size)} sub={t('social.driver.inBestLaps', 'in the best laps below')} testId="driver-cars-count" />
              </div>

              <Card className="bg-card">
                <CardContent className="space-y-2 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><Gamepad2 className="h-4 w-4 text-primary" aria-hidden="true" />{t('social.driver.games', 'Games played')}</h3>
                  <div className="flex flex-wrap gap-1.5" data-testid="driver-games">
                    {driver.gamesPlayed.length === 0 ? <span className="text-sm text-muted-foreground">–</span> : driver.gamesPlayed.map((game) => <GameBadge key={game} game={game} />)}
                  </div>
                </CardContent>
              </Card>

              <section className="space-y-3" aria-labelledby="driver-best-title">
                <div>
                  <h3 id="driver-best-title" className="flex items-center gap-2 text-sm font-semibold"><Trophy className="h-4 w-4 text-primary" aria-hidden="true" /> {t('social.driver.bestLaps', 'Best laps')}</h3>
                  <p className="text-xs text-muted-foreground">{t('social.driver.bestLapsHint', 'The most recent personal bests that count on the leaderboards.')}</p>
                </div>
                {driver.bestLaps.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="driver-no-laps">{t('social.driver.noLaps', 'No best laps to show yet.')}</p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="driver-best-laps">
                    {driver.bestLaps.map((lap) => (
                      <li key={lap.lapId} data-testid="driver-best-lap">
                        <Card className="flex h-full flex-col gap-3 bg-card p-4">
                          <div className="min-w-0 space-y-1">
                            <Link to={trackPagePath(lap.track.id)} className="block truncate text-base font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="driver-track-link">{lap.track.name}</Link>
                            <SimCarIdentity name={lap.car.name} className="text-sm text-muted-foreground" />
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <GameBadge game={lap.game} />
                              <span>{when(Date.parse(lap.achievedAt))}</span>
                            </div>
                          </div>
                          <p className="font-mono text-2xl font-semibold tabular-nums" data-testid="driver-lap-time">{formatLapTime(lap.timeMs)}</p>
                          <div className="mt-auto flex flex-wrap gap-2">
                            <Button asChild size="sm" variant="outline">
                              <Link to={leaderboardPath({ track: lap.track.id, car: lap.car.id, game: lap.game })}>{t('social.driver.board', 'Leaderboard')}</Link>
                            </Button>
                            <Button asChild size="sm" variant="ghost">
                              <Link to={trackPagePath(lap.track.id)} aria-label={`${t('social.leaderboard.trackPage', 'Track page')}: ${lap.track.name}`}>{t('social.leaderboard.trackPage', 'Track page')}</Link>
                            </Button>
                          </div>
                        </Card>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {!driver.isMe && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><UserX className="h-3.5 w-3.5" aria-hidden /> {t('social.driver.hint', 'Only what this driver chose to show.')}</p>
              )}
            </>
          )}
        </QueryGate>
      )}
    </div>
  );
}
