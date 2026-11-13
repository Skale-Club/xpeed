import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Ban, Check, Trophy, UserCheck, UserMinus, UserPlus, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { QueryGate } from '@/components/sim/SimStates';
import { SimCarIdentity } from '@/components/sim/SimCarIdentity';
import { useWhen } from '@/components/sim/use-when';
import { formatLapTime } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import {
  cleanName, leaderboardPath, trackPagePath, useAcceptFriend, useBlockDriver, useDeclineFriend, useDriver, useRemoveFriend, useSendFriendRequest,
  type DriverPage as Driver,
} from '@/lib/sim/social-client';
import { V1Error } from '@/lib/sim/v1-client';
import { ReportButton } from './ReportDialog';
import { ErrorLine } from './social-bits';
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

/**
 * Virtual > a driver: what anybody signed in sees of a public profile (the name and handle, when they joined, the games they play,
 * how many personal bests, and their best laps linking to the track pages), the friend relation with its action, and Report.
 * A private, hidden, blocked or unknown driver is the same page: "Driver not found".
 */
export function DriverPage() {
  const { handle = '' } = useParams();
  const { t } = useTranslation();
  const when = useWhen('date');
  const games = useGames();
  const query = useDriver(handle.toLowerCase());
  const driver = query.data ?? null;
  const notFound = query.error instanceof V1Error && query.error.status === 404;

  return (
    <div className="space-y-4" data-testid="driver-page">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/virtual/leaderboards"><ArrowLeft className="mr-1 h-4 w-4" /> {t('social.driver.back', 'Leaderboards')}</Link>
      </Button>
      {notFound ? (
        <DriverNotFound />
      ) : (
        <QueryGate query={query} empty={false} skeleton={<Skeleton className="h-64 w-full rounded-lg" />}>
          {driver && (
            <>
              <Card className="bg-card border-border" data-testid="driver-header">
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      {cleanName(driver.displayName) ? (
                        <>
                          <h3 className="truncate text-lg font-bold" data-testid="driver-name">{cleanName(driver.displayName)}</h3>
                          <p className="text-sm text-muted-foreground" data-testid="driver-handle">{atHandle(driver.handle)}</p>
                        </>
                      ) : (
                        <h3 className="truncate text-lg font-bold" data-testid="driver-handle">{atHandle(driver.handle)}</h3>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">{t('social.driver.joined', 'Joined {{when}}', { when: when(Date.parse(driver.joinedAt)) })}</p>
                    </div>
                    {driver.isMe && <Badge variant="secondary" data-testid="driver-me">{t('social.driver.thisIsYou', 'This is you')}</Badge>}
                  </div>
                  {driver.isMe ? (
                    <p className="text-sm text-muted-foreground">
                      {t('social.driver.mePage', 'This is how your page looks to others.')}{' '}
                      <Link to="/virtual/profile" className="underline">{t('social.driver.editProfile', 'Edit your profile')}</Link>
                    </p>
                  ) : (
                    <RelationActions driver={driver} />
                  )}
                </CardContent>
              </Card>

              <div className="grid gap-3 sm:grid-cols-2">
                <Card className="bg-card border-border">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">{t('social.driver.games', 'Games played')}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5" data-testid="driver-games">
                      {driver.gamesPlayed.length === 0 ? <span className="text-sm text-muted-foreground">–</span> : driver.gamesPlayed.map((game) => <Badge key={game} variant="outline">{games.name(game)}</Badge>)}
                    </div>
                  </CardContent>
                </Card>
                <Card className="bg-card border-border">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">{t('social.driver.pbs', 'Personal bests')}</p>
                    <p className="mt-1 font-mono text-2xl tabular-nums" data-testid="driver-pbs">{driver.personalBestsCount}</p>
                  </CardContent>
                </Card>
              </div>

              <Card className="bg-card border-border">
                <CardHeader className="pb-1">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold"><Trophy className="h-4 w-4 text-primary" aria-hidden /> {t('social.driver.bestLaps', 'Best laps')}</CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  {driver.bestLaps.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="driver-no-laps">{t('social.driver.noLaps', 'No best laps to show yet.')}</p>
                  ) : (
                    <ul className="divide-y divide-border" data-testid="driver-best-laps">
                      {driver.bestLaps.map((lap) => (
                        <li key={lap.lapId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2" data-testid="driver-best-lap">
                          <div className="min-w-0">
                            <Link to={trackPagePath(lap.track.id)} className="truncate text-sm font-medium hover:underline" data-testid="driver-track-link">{lap.track.name}</Link>
                            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                              <SimCarIdentity name={lap.car.name} className="text-xs" />
                              <span>{games.name(lap.game)}</span>
                              <span>{when(Date.parse(lap.achievedAt))}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-sm tabular-nums">{formatLapTime(lap.timeMs)}</span>
                            <Button asChild size="sm" variant="ghost" className="h-8 px-2">
                              <Link to={leaderboardPath({ track: lap.track.id, car: lap.car.id, game: lap.game })}>{t('social.driver.board', 'Leaderboard')}</Link>
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              {!driver.isMe && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><UserX className="h-3.5 w-3.5" aria-hidden /> {t('social.driver.hint', 'Only what this driver chose to show is here. Never an e-mail, a phone number or a real name.')}</p>
              )}
            </>
          )}
        </QueryGate>
      )}
    </div>
  );
}
