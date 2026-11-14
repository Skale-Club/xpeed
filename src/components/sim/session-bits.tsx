import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { useGames } from '@/lib/sim/games';
import { GameCover } from './GameCover';
import type { SessionKind } from '@/lib/sim/v1-client';

/** The kind of a session as a small badge: practice, qualifying or race (nothing for one the game did not say). */
export function KindBadge({ kind }: { kind: SessionKind }) {
  const { t } = useTranslation();
  if (kind === 'unknown') return null;
  const label = { practice: t('modes.sessions.kind.practice', 'Practice'), qualifying: t('modes.sessions.kind.qualifying', 'Qualifying'), race: t('modes.sessions.kind.race', 'Race') }[kind];
  return <Badge variant="secondary" data-testid="session-kind">{label}</Badge>;
}

/** The game: its cover and its name. */
export function GameBadge({ game }: { game: string }) {
  const games = useGames();
  return (
    <Badge variant="outline" className="gap-1.5" data-testid="session-game">
      <GameCover game={game} className="w-3 rounded-[3px] border-0" />
      {games.name(game)}
    </Badge>
  );
}
