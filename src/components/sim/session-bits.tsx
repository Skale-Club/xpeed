import { useTranslation } from 'react-i18next';
import { Award } from 'lucide-react';
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

/**
 * The game as a solid tag that reads before the smaller pills around it: its cover and its name. Where the full-size cover is already on
 * screen next to it (a session row, a car card), pass `cover={false}` so the same picture is not repeated as a tiny thumbnail.
 */
export function GameBadge({ game, cover = true }: { game: string; cover?: boolean }) {
  const games = useGames();
  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted py-1 pr-2.5 text-sm font-semibold leading-5 text-foreground ${cover ? 'pl-1' : 'pl-2.5'}`}
      data-testid="session-game"
    >
      {cover && <GameCover game={game} className="w-5 self-center rounded-[3px] border-0" />}
      <span className="truncate">{games.name(game)}</span>
    </span>
  );
}

/**
 * The game inside a line of text (the quiet line of a row: "when · game"): its cover, small, and its name. Wherever a game is named in a
 * list, its cover is beside the name; a head or a card uses `GameBadge`, a line of text uses this.
 */
export function GameName({ game, className = '' }: { game: string; className?: string }) {
  const games = useGames();
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle ${className}`} data-testid="session-game">
      <GameCover game={game} className="w-3 self-center rounded-[2px] border-0" />
      <span className="truncate">{games.name(game)}</span>
    </span>
  );
}

/**
 * The personal-best mark next to a lap time: a small green pill with the award icon. The label is trimmed to its capitals so "PB" sits on the
 * icon's centre line instead of riding high over the font's descender space.
 */
export function PbBadge({ title, testId }: { title?: string; testId?: string }) {
  const { t } = useTranslation();
  return (
    <Badge variant="success" className="shrink-0 gap-1 px-1.5 py-0.5 text-2xs leading-none" title={title} data-testid={testId}>
      <Award className="h-3 w-3" aria-hidden="true" />
      <span className="[text-box:trim-both_cap_alphabetic]">{t('sessionsDash.row.pb', 'PB')}</span>
    </Badge>
  );
}
