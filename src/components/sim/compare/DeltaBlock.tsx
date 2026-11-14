import { useTranslation } from 'react-i18next';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatGap } from '@/lib/sim/analysis';
import { cn } from '@/lib/utils';
import { deltaTone } from './delta-tone';

/**
 * The middle of the two-lap header: the gap between the lap and the reference, big and coloured (red when the lap is slower, green when it is faster), the
 * words for it, and the button that swaps the two laps. With no gap to show (no reference yet, laps that cannot be compared) it says why in one line.
 */
export function DeltaBlock({ seconds, note, canSwap, onSwap }: { seconds: number | null; note?: string; canSwap: boolean; onSwap: () => void }) {
  const { t } = useTranslation();
  const tone = seconds === null ? null : deltaTone(seconds);
  return (
    <div className="flex flex-row items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 md:min-w-[11rem] md:flex-col md:justify-center" data-testid="delta-block">
      <div className="text-center">
        <p
          className={cn('font-mono text-3xl font-bold tabular-nums leading-none md:text-4xl', tone === 'loss' && 'text-destructive', tone === 'gain' && 'text-green-500', seconds === null && 'text-muted-foreground')}
          data-testid="final-gap"
          data-tone={tone ?? 'none'}
        >
          {seconds === null ? '–' : `${formatGap(seconds)} s`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="delta-words">
          {seconds === null
            ? note ?? t('sessionsDash.compare.noDelta', 'Choose a reference to see the gap.')
            : tone === 'loss' ? t('sessionsDash.compare.slower', 'slower than the reference')
            : tone === 'gain' ? t('sessionsDash.compare.faster', 'faster than the reference')
            : t('sessionsDash.compare.level', 'level with the reference')}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0"
        disabled={!canSwap}
        onClick={onSwap}
        aria-label={t('modes.compare.swap', 'Swap the lap and the reference')}
        title={t('modes.compare.swap', 'Swap the lap and the reference')}
        data-testid="swap"
      >
        <ArrowLeftRight className="h-4 w-4 sm:mr-1.5" aria-hidden="true" />
        <span className="hidden sm:inline">{t('sessionsDash.compare.swapShort', 'Swap')}</span>
      </Button>
    </div>
  );
}
