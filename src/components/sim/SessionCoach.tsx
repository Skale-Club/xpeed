import { lazy, Suspense, useId, useMemo, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { ChatScope } from '@/lib/chat/types';
import { isCoachEnabled, setCoachEnabled } from '@/lib/sim/coach-preferences';
import { DEMO_USER_ID, isDemoMode, useDemoMode } from '@/lib/sim/demo/mode';
import { gameName } from '@/lib/sim/games';
import type { V1Session } from '@/lib/sim/v1-client';

const ChatContainer = lazy(() =>
  import('../chat/ChatContainer').then((module) => ({ default: module.ChatContainer })),
);

interface SessionCoachProps {
  userId: string | null;
  session: Pick<V1Session, 'id' | 'game' | 'car' | 'track' | 'kind'>;
}

export function SessionCoach({ userId, session }: SessionCoachProps) {
  const demo = useDemoMode();
  if (!userId || demo || userId === DEMO_USER_ID) return null;
  return <CoachLauncher key={`${userId}:${session.id}`} userId={userId} session={session} />;
}

function CoachLauncher({ userId, session }: SessionCoachProps & { userId: string }) {
  const { t } = useTranslation();
  const headingId = useId();
  const launchButton = useRef<HTMLButtonElement>(null);
  const [enabled, setEnabled] = useState(() => isCoachEnabled(userId));
  const [hasOpened, setHasOpened] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const kind = session.kind === 'unknown' ? null : t(`modes.sessions.kind.${session.kind}`);
  const label = [session.track.name, session.car.name, gameName(session.game), kind].filter(Boolean).join(' · ');
  const scope = useMemo<ChatScope>(() => ({ mode: 'virtual', sessionId: session.id, label }), [session.id, label]);

  const launch = () => {
    if (isDemoMode()) return;
    if (enabled) {
      setIsOpen(true);
      setHasOpened(true);
    } else {
      setCoachEnabled(userId, true);
      setEnabled(true);
    }
  };

  const disable = () => {
    if (isDemoMode()) return;
    setCoachEnabled(userId, false);
    setEnabled(false);
    setIsOpen(false);
    setHasOpened(false);
    launchButton.current?.focus();
  };

  return (
    <Card role="region" className="border-border bg-card" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
            <MessageCircle className="h-4 w-4 text-primary" aria-hidden="true" />
            {t('modes.coach.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('modes.coach.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={launchButton} size="sm" variant="outline" onClick={launch} aria-haspopup={enabled ? 'dialog' : undefined}>
            {enabled ? t('modes.coach.open') : t('modes.coach.enable')}
          </Button>
          {enabled && <Button size="sm" variant="ghost" onClick={disable}>{t('modes.coach.disable')}</Button>}
        </div>
      </div>
      {enabled && hasOpened && (
        <Suspense fallback={<p className="px-4 pb-4 text-sm text-muted-foreground" role="status">{t('common.loading', 'Loading…')}</p>}>
          <ChatContainer
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            restoreFocus={() => launchButton.current?.focus()}
            scope={scope}
          />
        </Suspense>
      )}
    </Card>
  );
}
