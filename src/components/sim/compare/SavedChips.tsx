import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pin, X } from 'lucide-react';
import { compareUrl } from '@/lib/sim/compare-url';
import { formatLapTime } from '@/lib/sim/analysis';
import { isCurrent, type SavedComparison } from '@/lib/sim/compare-recent';
import { cn } from '@/lib/utils';

/**
 * The comparisons made lately and the ones saved, as chips that open them again (kept in this browser). Each chip is a link to the comparison; beside it, a
 * pin saves it (a saved one stays, the recent ones are cut to the latest few) and a cross lets it go. The chip of the comparison on screen is marked.
 */
export function SavedChips({ items, a, b, onPin, onForget }: {
  items: readonly SavedComparison[];
  /** The comparison on screen: its lap and its reference (null for the personal best). */
  a: string | null;
  b: string | null;
  onPin: (item: SavedComparison, pinned: boolean) => void;
  onForget: (item: SavedComparison) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5" aria-label={t('sessionsDash.compare.savedTitle', 'Saved and recent comparisons')} data-testid="saved-comparisons">
      <p className="text-xs font-medium text-muted-foreground">{t('sessionsDash.compare.savedTitle', 'Saved and recent comparisons')}</p>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const current = isCurrent(item, a, b);
          const { info } = item;
          const text = `${info.track} · ${t('modes.compare.lapN', 'Lap {{n}}', { n: info.aLap })} ${formatLapTime(info.aMs)}${
            info.bLap !== null && info.bMs !== null ? ` ⇄ ${t('modes.compare.lapN', 'Lap {{n}}', { n: info.bLap })} ${formatLapTime(info.bMs)}` : ` ⇄ ${t('sessionsDash.compare.myBestShort', 'my best')}`
          }`;
          return (
            <li
              key={`${item.a}|${item.b ?? ''}`}
              className={cn('inline-flex max-w-full items-center rounded-full border text-xs', current ? 'border-primary bg-primary/10' : 'border-border bg-muted/30')}
              data-testid="saved-chip"
              data-pinned={item.pinned ? 'true' : 'false'}
            >
              <Link
                to={compareUrl(item.a, item.b)}
                aria-current={current ? 'true' : undefined}
                className="min-w-0 truncate rounded-full py-1 pl-3 pr-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={text}
                data-testid="saved-chip-link"
              >
                {text}
              </Link>
              <button
                type="button"
                onClick={() => onPin(item, !item.pinned)}
                className="rounded-full p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-pressed={item.pinned}
                aria-label={item.pinned ? t('sessionsDash.compare.unsave', 'Stop saving this comparison') : t('sessionsDash.compare.save', 'Save this comparison')}
                title={item.pinned ? t('sessionsDash.compare.unsave', 'Stop saving this comparison') : t('sessionsDash.compare.save', 'Save this comparison')}
                data-testid="saved-chip-pin"
              >
                <Pin className={cn('h-3.5 w-3.5', item.pinned && 'fill-current')} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onForget(item)}
                className="mr-1 rounded-full p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('sessionsDash.compare.forget', 'Remove this comparison from the list')}
                title={t('sessionsDash.compare.forget', 'Remove this comparison from the list')}
                data-testid="saved-chip-forget"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
