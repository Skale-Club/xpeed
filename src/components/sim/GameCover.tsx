import { Gamepad2 } from 'lucide-react';
import { useGames } from '@/lib/sim/games';
import { cn } from '@/lib/utils';

/**
 * The cover of a game, in the shape the covers have: portrait, 2 : 3 (300 x 450). The box takes its width from `className` and its height
 * from the ratio, so the picture is shown whole, never squeezed into a square and never cropped. Until the cover loads, and for a game
 * without one, a controller icon fills the same box, so nothing jumps when the picture arrives.
 */
export function GameCover({ game, className, testId }: { game: string; className?: string; testId?: string }) {
  const games = useGames();
  const cover = games.cover(game);
  return (
    <span
      className={cn('inline-block aspect-[2/3] shrink-0 overflow-hidden rounded-md border border-border bg-muted align-middle', className)}
      aria-hidden="true"
      data-testid={testId}
    >
      {cover ? (
        <img src={cover} alt="" className="block h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground"><Gamepad2 className="h-1/2 w-1/2 max-h-5 max-w-5" /></span>
      )}
    </span>
  );
}
