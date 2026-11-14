import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Ban, Check, Loader2, Trophy, UserCheck, UserMinus, UserPlus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadMore, QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { formatLapTime } from '@/lib/sim/analysis';
import {
  driverPath, leaderboardPath, useAcceptFriend, useBlockDriver, useDeclineFriend, useDriver, useFriendRequestCount, useFriends, useRemoveFriend, useSendFriendRequest,
  type Friend, type FriendStatus,
} from '@/lib/sim/social-client';
import { usePbs } from '@/lib/sim/v1-client';
import { Avatar, DriverName, ErrorLine } from './social-bits';
import { atHandle, handleProblem, normalizeHandle, type HandleProblem } from './social-utils';
import { useErrorText } from './use-error-text';

type TabId = 'friends' | 'requests' | 'blocked';
const TABS: readonly TabId[] = ['friends', 'requests', 'blocked'];
/** Only this many friend cards read their driver page for the latest best lap (a driver page read is rate limited, 120 a minute). */
const ACTIVITY_LIMIT = 12;

/** Which tracks and cars (as "track|car") the person has a personal best on: the friends' laps on the same ones are on a board both can see. */
function useMyPairs(): Set<string> {
  const pbs = usePbs();
  return useMemo(() => new Set(pbs.items.map((pb) => `${pb.track.id}|${pb.car.id}`)), [pbs.items]);
}

/** A friend's newest personal best, and, when you drove the same track and car, a shortcut to the friends board where you are side by side. */
function FriendActivity({ handle, pairs }: { handle: string; pairs: Set<string> }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const driver = useDriver(handle);
  if (driver.isPending) return <Skeleton className="h-10 w-full rounded-md" data-testid="friend-activity-loading" />;
  const latest = [...(driver.data?.bestLaps ?? [])].sort((p, q) => Date.parse(q.achievedAt) - Date.parse(p.achievedAt))[0];
  if (!latest) return null;
  const both = pairs.has(`${latest.track.id}|${latest.car.id}`);
  return (
    <div className="space-y-1 rounded-lg border border-border bg-background/50 p-2.5 text-xs" data-testid="friend-activity">
      <p className="font-medium text-muted-foreground">{t('social.friends.latest', 'Latest personal best')}</p>
      <p className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{latest.track.name}</span>
        <span className="shrink-0 font-mono text-sm font-semibold tabular-nums" data-testid="friend-activity-time">{formatLapTime(latest.timeMs)}</span>
      </p>
      <p className="truncate text-muted-foreground">{latest.car.name} · {when(Date.parse(latest.achievedAt))}</p>
      {both && (
        <Link
          to={leaderboardPath({ track: latest.track.id, car: latest.car.id, game: latest.game, scope: 'friends' })}
          className="inline-flex items-center gap-1 pt-0.5 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="friend-board-shortcut"
        >
          <Trophy className="h-3.5 w-3.5" aria-hidden="true" /> {t('social.friends.bothDrove', 'You both drove this: see the friends board')}
        </Link>
      )}
    </div>
  );
}

/** One person as a card: who they are, since when, what they did last (for friends), and the buttons that fit the list they are in. */
function PersonCard({ friend, activity, pairs, children }: { friend: Friend; activity: boolean; pairs: Set<string>; children: ReactNode }) {
  const when = useWhen('date');
  const { t } = useTranslation();
  return (
    <li data-testid="friend-row" data-handle={friend.handle}>
      <Card className="flex h-full flex-col gap-3 bg-card p-4">
        <div className="flex items-center gap-3">
          <Avatar handle={friend.handle} displayName={friend.displayName} size="lg" />
          <div className="min-w-0">
            <DriverName handle={friend.handle} displayName={friend.displayName} link={friend.status !== 'blocked'} className="flex-col items-start gap-0" />
            <p className="mt-0.5 text-xs text-muted-foreground">{t('social.friends.since', 'Since {{when}}', { when: when(Date.parse(friend.since)) })}</p>
          </div>
        </div>
        {activity && <FriendActivity handle={friend.handle} pairs={pairs} />}
        <div className="mt-auto flex flex-wrap items-center gap-2">{children}</div>
      </Card>
    </li>
  );
}

/** A list of people of one kind as a grid of cards, a page at a time, with its own empty text. */
function PeopleList({ status, empty, row, activity = false, pairs }: { status: FriendStatus; empty: string; row: (friend: Friend) => ReactNode; activity?: boolean; pairs: Set<string> }) {
  const list = useFriends(status);
  return (
    <QueryGate
      query={list}
      empty={list.items.length === 0}
      emptyNode={<p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid={`empty-${status}`}>{empty}</p>}
      skeleton={<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>}
    >
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid={`list-${status}`}>
        {list.items.map((friend, index) => <PersonCard key={friend.handle} friend={friend} activity={activity && index < ACTIVITY_LIMIT} pairs={pairs}>{row(friend)}</PersonCard>)}
      </ul>
      <LoadMore hasNextPage={!!list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} />
    </QueryGate>
  );
}

/**
 * Virtual > Friends: add a driver by handle (the handle is checked as you type: 3 to 24 characters of a to z, 0 to 9 and _; the request only
 * goes when you press Enter or the button), and three lists: your friends as cards with their latest personal best and, for a track and car
 * you both drove, a shortcut to the friends board; the requests (to you with Accept and Decline, and by you); and the people you blocked.
 * Every action says what it did.
 */
export function FriendsScreen() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [params, setParams] = useSearchParams();
  const tab: TabId = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabId) : 'friends';
  const waiting = useFriendRequestCount();
  const pairs = useMyPairs();

  const send = useSendFriendRequest();
  const accept = useAcceptFriend();
  const decline = useDeclineFriend();
  const remove = useRemoveFriend();
  const block = useBlockDriver();
  const [handle, setHandle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'remove' | 'block'; friend: Friend } | null>(null);

  const busy = accept.isPending || decline.isPending || remove.isPending || block.isPending;
  const failure = send.error ?? accept.error ?? decline.error ?? remove.error ?? block.error;
  const clearErrors = () => [send, accept, decline, remove, block].forEach((mutation) => mutation.reset());

  const wanted = normalizeHandle(handle);
  const problem: HandleProblem | null = handleProblem(wanted);
  const showProblem = problem !== null && problem !== 'empty';
  const problemText: Record<HandleProblem, string> = {
    empty: '',
    short: t('social.friends.handleShort', 'A handle has at least 3 characters.'),
    long: t('social.friends.handleLong', 'A handle has at most 24 characters.'),
    characters: t('social.friends.handleCharacters', 'Only the letters a to z, the digits 0 to 9 and _ are allowed.'),
  };

  const add = async () => {
    if (problem) return;
    clearErrors();
    setNotice(null);
    try {
      const friend = await send.mutateAsync(wanted);
      setHandle('');
      setNotice(
        friend.status === 'accepted'
          ? t('social.friends.nowFriends', 'You are now friends with {{handle}}.', { handle: atHandle(friend.handle) })
          : t('social.friends.requestSent', 'Request sent to {{handle}}.', { handle: atHandle(friend.handle) }),
      );
    } catch {
      /* shown below */
    }
  };

  const incomingCount = waiting.data ?? 0;

  return (
    <div className="space-y-4" data-testid="friends-screen">
      <Card className="bg-card">
        <CardContent className="space-y-2 p-4">
          <form
            className="flex flex-wrap items-start gap-2"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="min-w-0 flex-1 basis-56 space-y-1">
              <label htmlFor="friend-handle" className="text-sm font-medium">{t('social.friends.addLabel', 'Add a friend by handle')}</label>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground" aria-hidden>@</span>
                <Input
                  id="friend-handle"
                  value={handle}
                  onChange={(event) => { setHandle(event.target.value); setNotice(null); }}
                  placeholder={t('social.friends.addPlaceholder', 'their handle')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={32}
                  aria-invalid={showProblem ? true : undefined}
                  aria-describedby="friend-handle-help"
                  data-testid="friend-handle"
                />
              </div>
              <p id="friend-handle-help" className={showProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} data-testid="friend-handle-help" data-valid={problem === null ? 'true' : 'false'}>
                {showProblem ? problemText[problem] : problem === null ? t('social.friends.handleOk', 'This handle can be sent.') : t('social.friends.addHelp', 'Ask for a friendship by the handle you were given. They have to accept.')}
              </p>
            </div>
            <Button type="submit" className="w-full sm:mt-6 sm:w-auto" disabled={problem !== null || send.isPending} data-testid="friend-add">
              {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
              {t('social.friends.add', 'Send request')}
            </Button>
          </form>
          {notice && <p className="flex items-center gap-1.5 text-sm" role="status" data-testid="friend-notice"><Check className="h-4 w-4 text-green-500" aria-hidden /> {notice}</p>}
          {failure && <ErrorLine testId="friends-error">{errorText(failure)}</ErrorLine>}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(value) => { setParams(value === 'friends' ? {} : { tab: value }, { replace: true }); clearErrors(); }}>
        <TabsList aria-label={t('social.friends.lists', 'Your friends lists')} className="h-auto flex-wrap">
          <TabsTrigger value="friends" data-testid="tab-friends">{t('social.friends.tabFriends', 'Friends')}</TabsTrigger>
          <TabsTrigger value="requests" data-testid="tab-requests" className="gap-2">
            {t('social.friends.tabRequests', 'Requests')}
            {incomingCount > 0 && <Badge className="h-5 px-1.5" data-testid="requests-count">{incomingCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="blocked" data-testid="tab-blocked">{t('social.friends.tabBlocked', 'Blocked')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'friends' && (
        <div className="space-y-3" data-testid="panel-friends">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('social.friends.boardHint', 'The best times of your friends are on the friends leaderboard.')}</p>
            <Button asChild size="sm" variant="outline">
              <Link to={leaderboardPath({ scope: 'friends' })}><Trophy className="mr-2 h-4 w-4" /> {t('social.friends.toBoard', 'Friends leaderboard')}</Link>
            </Button>
          </div>
          <PeopleList
            status="accepted"
            activity
            pairs={pairs}
            empty={t('social.friends.noFriends', 'No friends yet. Add a driver by their handle above.')}
            row={(friend) => (
              <>
                <Button asChild size="sm" variant="outline"><Link to={driverPath(friend.handle)}>{t('social.friends.profile', 'Profile')}</Link></Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm({ kind: 'remove', friend })} data-testid="friend-remove">
                  <UserMinus className="mr-2 h-4 w-4" /> {t('social.friends.remove', 'Remove')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'block', friend })} data-testid="friend-block" aria-label={`${t('social.friends.block', 'Block')} ${atHandle(friend.handle)}`}>
                  <Ban className="h-4 w-4" />
                </Button>
              </>
            )}
          />
        </div>
      )}

      {tab === 'requests' && (
        <div className="space-y-6" data-testid="panel-requests">
          <section className="space-y-2" aria-labelledby="requests-incoming">
            <h3 id="requests-incoming" className="text-sm font-semibold">{t('social.friends.incoming', 'Asked to be your friend')}</h3>
            <PeopleList
              status="incoming"
              pairs={pairs}
              empty={t('social.friends.noIncoming', 'No requests waiting for you.')}
              row={(friend) => (
                <>
                  <Button size="sm" disabled={busy} onClick={() => accept.mutate(friend.handle)} data-testid="request-accept"><UserCheck className="mr-2 h-4 w-4" /> {t('social.driver.accept', 'Accept')}</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => decline.mutate(friend.handle)} data-testid="request-decline"><X className="mr-2 h-4 w-4" /> {t('social.driver.decline', 'Decline')}</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'block', friend })} aria-label={`${t('social.friends.block', 'Block')} ${atHandle(friend.handle)}`}><Ban className="h-4 w-4" /></Button>
                </>
              )}
            />
          </section>
          <section className="space-y-2" aria-labelledby="requests-outgoing">
            <h3 id="requests-outgoing" className="text-sm font-semibold">{t('social.friends.outgoing', 'Waiting for their answer')}</h3>
            <PeopleList
              status="outgoing"
              pairs={pairs}
              empty={t('social.friends.noOutgoing', 'You have no requests waiting.')}
              row={(friend) => (
                <>
                  <Badge variant="secondary" className="gap-1"><UserPlus className="h-3 w-3" /> {t('social.driver.requested', 'Requested')}</Badge>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => remove.mutate(friend.handle)} data-testid="request-cancel">{t('social.driver.cancelRequest', 'Cancel request')}</Button>
                </>
              )}
            />
          </section>
        </div>
      )}

      {tab === 'blocked' && (
        <div className="space-y-3" data-testid="panel-blocked">
          <p className="text-sm text-muted-foreground">{t('social.friends.blockedHint', 'People you blocked cannot see you or find you, and you cannot see them. They are not told.')}</p>
          <PeopleList
            status="blocked"
            pairs={pairs}
            empty={t('social.friends.noBlocked', 'You have not blocked anyone.')}
            row={(friend) => (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => remove.mutate(friend.handle)} data-testid="friend-unblock">{t('social.friends.unblock', 'Unblock')}</Button>
            )}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.kind === 'block' ? t('social.friends.blockTitle', 'Block this driver?') : t('social.friends.removeTitle', 'Remove this friend?')}
        description={
          confirm?.kind === 'block'
            ? t('social.friends.blockBody', 'You will not see each other: no page, no leaderboard row, no requests. They are not told. You can unblock them in Friends.')
            : t('social.friends.removeBody', 'You stop being friends. You can send a new request later.')
        }
        confirmLabel={confirm?.kind === 'block' ? t('social.friends.block', 'Block') : t('social.friends.remove', 'Remove')}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === 'block') block.mutate(confirm.friend.handle);
          else remove.mutate(confirm.friend.handle);
        }}
      />
    </div>
  );
}
