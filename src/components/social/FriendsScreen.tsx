import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Ban, Check, Loader2, Search, Trophy, UserCheck, UserMinus, UserPlus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadMore, QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import {
  driverPath, leaderboardPath, useAcceptFriend, useBlockDriver, useDeclineFriend, useFriends, useRemoveFriend, useSendFriendRequest, type Friend, type FriendStatus,
} from '@/lib/sim/social-client';
import { DriverName, ErrorLine } from './social-bits';
import { atHandle } from './social-utils';
import { useErrorText } from './use-error-text';

type TabId = 'friends' | 'requests' | 'blocked';
const TABS: readonly TabId[] = ['friends', 'requests', 'blocked'];

/** One person in a list: who they are, since when, and the buttons that fit the list they are in. */
function PersonRow({ friend, children }: { friend: Friend; children: ReactNode }) {
  const when = useWhen('date');
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3" data-testid="friend-row" data-handle={friend.handle}>
      <div className="min-w-0">
        <DriverName handle={friend.handle} displayName={friend.displayName} link={friend.status !== 'blocked'} />
        <p className="text-xs text-muted-foreground">{t('social.friends.since', 'Since {{when}}', { when: when(Date.parse(friend.since)) })}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </li>
  );
}

/** A list of people of one kind, a page at a time, with its own empty text. */
function PeopleList({ status, empty, row }: { status: FriendStatus; empty: string; row: (friend: Friend) => ReactNode }) {
  const list = useFriends(status);
  return (
    <QueryGate query={list} empty={list.items.length === 0} emptyNode={<p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid={`empty-${status}`}>{empty}</p>}>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid={`list-${status}`}>
        {list.items.map((friend) => <PersonRow key={friend.handle} friend={friend}>{row(friend)}</PersonRow>)}
      </ul>
      <LoadMore hasNextPage={!!list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} />
    </QueryGate>
  );
}

/**
 * Virtual > Friends: add a driver by handle (the search only runs when you press Enter or the button), and three lists: your friends,
 * the requests (to you, and by you), and the people you blocked. Every action says what it did. A friend's profile is a link; the
 * friends' best times are on the friends leaderboard.
 */
export function FriendsScreen() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [params, setParams] = useSearchParams();
  const tab: TabId = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabId) : 'friends';
  const incoming = useFriends('incoming');

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

  const add = async () => {
    const wanted = handle.trim().replace(/^@/, '').toLowerCase();
    if (!wanted) return;
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

  const incomingCount = incoming.items.length;

  return (
    <div className="space-y-4" data-testid="friends-screen">
      <Card className="bg-card border-border">
        <CardContent className="space-y-2 p-4">
          <form
            className="flex flex-wrap items-end gap-2"
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
                  maxLength={25}
                  data-testid="friend-handle"
                />
              </div>
            </div>
            <Button type="submit" disabled={!handle.trim() || send.isPending} data-testid="friend-add">
              {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              {t('social.friends.add', 'Send request')}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">{t('social.friends.addHelp', 'Ask for a friendship by the handle you were given. They have to accept.')}</p>
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
        <div className="space-y-5" data-testid="panel-requests">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('social.friends.incoming', 'Asked to be your friend')}</h3>
            <PeopleList
              status="incoming"
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
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('social.friends.outgoing', 'Waiting for their answer')}</h3>
            <PeopleList
              status="outgoing"
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
