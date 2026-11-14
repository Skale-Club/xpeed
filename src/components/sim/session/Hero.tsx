import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Clock, Cloud, Flag, Radio, Thermometer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ShareButton } from '@/components/social/ShareDialog';
import { useSettings } from '@/contexts/SettingsContext';
import { useGames } from '@/lib/sim/games';
import { GameCover } from '../GameCover';
import { formatDuration } from '@/lib/sim/dashboard';
import { carPath, trackPath } from '@/lib/sim/routes';
import type { V1Session } from '@/lib/sim/v1-client';
import { temperatureValue } from '@/lib/temperature';
import { GameBadge, KindBadge } from '../session-bits';
import { SimCarIdentity } from '../SimCarIdentity';
import { useDashFormat } from '../overview/use-format';
import { useOrigin } from '../use-session-text';
import { useWhen } from '../use-when';

const WEATHER_WORDS = ['dry', 'wet', 'rain', 'cloudy', 'overcast', 'mixed', 'night', 'snow', 'fog'];

function Fact({ icon, children, testId, title }: { icon: ReactNode; children: ReactNode; testId?: string; title?: string }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs" data-testid={testId} title={title}>
      <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
      {children}
    </li>
  );
}

/**
 * The top of a session page: the game's cover, the track and the car (each a link to its page), the kind and the game, and the facts of the session as
 * chips (when it was driven, how long it ran, and the weather and temperatures when the game said them), with the share and delete buttons.
 */
export function SessionHero({ session, lapCount, shareLabel, onDelete, deleting }: { session: V1Session; /** The laps the server lists now (the session's own counter can be a refresh behind a delete). */ lapCount: number; shareLabel: string; onDelete: () => void; deleting: boolean }) {
  const { t } = useTranslation();
  const when = useWhen();
  const origin = useOrigin();
  const games = useGames();
  const { temperatureUnit } = useSettings();
  const format = useDashFormat();
  const cover = games.cover(session.game);
  const unit = temperatureUnit === 'F' ? 'F' : 'C';
  const degrees = (celsius: number) => `${Math.round(temperatureValue(celsius, '°C', unit))} °${unit}`;
  const length = Date.parse(session.endedAt) - Date.parse(session.startedAt);
  const word = session.weather?.toLowerCase() ?? '';
  const weather = session.weather ? (WEATHER_WORDS.includes(word) ? t(`modes.weather.${word}`, session.weather) : session.weather) : null;

  return (
    <Card className="border-border bg-card" data-testid="session-header">
      <div className="flex gap-3 p-4 sm:gap-4 sm:p-5">
        <GameCover game={session.game} className="hidden w-14 sm:inline-block" testId="session-cover" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <KindBadge kind={session.kind} />
                <GameBadge game={session.game} />
              </div>
              <h2 className="truncate text-xl font-bold leading-tight sm:text-2xl">
                <Link to={trackPath(session.track.id)} className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="session-track-link">{session.track.name}</Link>
              </h2>
              <Link to={carPath(session.car.id)} className="inline-flex min-w-0 hover:underline" data-testid="session-car-link">
                <SimCarIdentity name={session.car.name} className="text-sm text-muted-foreground" />
              </Link>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ShareButton target={{ sessionId: session.id }} label={shareLabel} />
              <Button size="sm" variant="outline" onClick={onDelete} disabled={deleting}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" /> {t('modes.session.delete', 'Delete session')}
              </Button>
            </div>
          </div>
          <ul className="flex flex-wrap gap-2" data-testid="session-facts">
            <Fact icon={<CalendarDays className="h-3.5 w-3.5" />} testId="fact-when">{when(Date.parse(session.startedAt))}</Fact>
            <Fact icon={<Flag className="h-3.5 w-3.5" />} testId="fact-laps">{t('sessionsDash.session.lapsFact', { count: lapCount, defaultValue_one: '{{count}} lap', defaultValue_other: '{{count}} laps' })}</Fact>
            {Number.isFinite(length) && length > 0 && (
              <Fact icon={<Clock className="h-3.5 w-3.5" />} testId="fact-length" title={t('sessionsDash.session.lengthHint', 'From the start of the session to its end.')}>
                {formatDuration(length, format.lang)}
              </Fact>
            )}
            {weather && <Fact icon={<Cloud className="h-3.5 w-3.5" />} testId="fact-weather">{weather}</Fact>}
            {session.airTempC !== null && (
              <Fact icon={<Thermometer className="h-3.5 w-3.5" />} testId="fact-air">{t('modes.sessions.airTemp', 'air {{value}}', { value: degrees(session.airTempC) })}</Fact>
            )}
            {session.trackTempC !== null && (
              <Fact icon={<Thermometer className="h-3.5 w-3.5" />} testId="fact-track">{t('modes.sessions.trackTemp', 'track {{value}}', { value: degrees(session.trackTempC) })}</Fact>
            )}
            <Fact icon={<Radio className="h-3.5 w-3.5" />} testId="fact-origin">{origin(session.origin)}</Fact>
          </ul>
        </div>
      </div>
    </Card>
  );
}
