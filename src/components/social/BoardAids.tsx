import { Ban, Cog, Route } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { AidBoard, BoardConditions as Conditions, LapAids } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { showAidChips } from './social-utils';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * "Aids: All, No TC & ABS (12), No aids (5)": the boards of laps driven with traction control and ABS off, and with every aid off. A lap whose aids
 * are not known (every lap from before the Companion wrote them, some games) is only on All. The counts follow the tyre that is chosen. Under it, in
 * one line, why it is marked beta: what the aids say is what the game reports, and it is still being checked game by game. The choice belongs to the
 * address (see LeaderboardScreen), so a link to a filtered board opens filtered.
 */
export function AidChips({ conditions, aids, onAids }: { conditions: Conditions | undefined; aids: AidBoard; onAids: (aids: AidBoard) => void }) {
  const { t } = useTranslation();
  if (!showAidChips(conditions, aids)) return null;
  const drivers = (name: Exclude<AidBoard, 'all'>) => conditions?.aids?.find((entry) => entry.class === name)?.drivers ?? 0;
  const options: Array<{ value: AidBoard; label: string; count: number | null }> = [
    { value: 'all', label: t('social.leaderboard.aidsAll', 'All'), count: null },
    { value: 'no_tc_abs', label: t('social.leaderboard.aidsNoTcAbs', 'No TC & ABS'), count: drivers('no_tc_abs') },
    { value: 'none', label: t('social.leaderboard.aidsNone', 'No aids'), count: drivers('none') },
  ];
  const chip = (active: boolean) => cn(
    'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors hover:bg-muted/60',
    FOCUS,
    active ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border bg-muted/30 text-muted-foreground',
  );
  return (
    <div role="group" aria-label={t('social.leaderboard.aidsGroup', 'Filter by driving aids')} className="flex flex-wrap items-center gap-2" data-testid="board-aids">
      <span className="text-xs text-muted-foreground">{t('social.leaderboard.aids', 'Aids')}</span>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={aids === option.value} className={chip(aids === option.value)} onClick={() => onAids(option.value)} data-testid="aid-chip" data-aids={option.value}>
          <span>{option.label}</span>
          {option.count !== null && option.count > 0 && (
            <span className="font-mono tabular-nums text-muted-foreground" aria-label={t('social.leaderboard.aidsDrivers', 'Drivers: {{count}}', { count: option.count })}>{option.count}</span>
          )}
        </button>
      ))}
      <div className="flex basis-full items-center gap-1.5 text-2xs text-muted-foreground" data-testid="aids-beta">
        <Badge variant="outline" className="px-1.5 py-0 text-2xs font-normal uppercase">{t('social.leaderboard.aidsBeta', 'beta')}</Badge>
        <span>{t('social.leaderboard.aidsBetaNote', 'Aids are what the game reports and are still being verified game by game.')}</span>
      </div>
    </div>
  );
}

const level = (value: number) => Math.round(value * 100) / 100;

/** The aids a lap was driven with, as words, in the order the icons show them. Only what is on; empty when nothing is on. */
function aidWords(aids: LapAids, t: (key: string, fallback: string, options?: Record<string, unknown>) => string): string[] {
  const words: string[] = [];
  if (aids.tcMax !== undefined && aids.tcMax > 0) words.push(t('social.leaderboard.aidTc', 'Traction control {{level}}', { level: level(aids.tcMax) }));
  if (aids.absMax !== undefined && aids.absMax > 0) words.push(t('social.leaderboard.aidAbs', 'ABS {{level}}', { level: level(aids.absMax) }));
  if (aids.stability !== undefined && aids.stability > 0) words.push(t('social.leaderboard.aidStability', 'Stability control'));
  if (aids.autoShift) words.push(t('social.leaderboard.aidGears', 'Automatic gears'));
  if (aids.autoClutch) words.push(t('social.leaderboard.aidClutch', 'Automatic clutch'));
  if (aids.autoBlip) words.push(t('social.leaderboard.aidBlip', 'Automatic throttle blip'));
  if (aids.idealLine) words.push(t('social.leaderboard.aidLine', 'Ideal line'));
  return words;
}

/**
 * The aids of one row, compact: TC and ABS as small text badges (with the highest level), automatic gears and the ideal line as icons, and a
 * crossed-circle icon when TC and ABS are known to be off and nothing else is on. One element carries the whole sentence for assistive technology
 * and as a tooltip, so the icons themselves are decoration. Nothing when the lap has no aids (null or absent: an older lap, or a claim that did not hold up).
 */
export function AidIcons({ aids, className }: { aids: LapAids | null | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!aids) return null;
  const words = aidWords(aids, (key, fallback, options) => t(key, fallback, options));
  const tc = aids.tcMax !== undefined && aids.tcMax > 0, abs = aids.absMax !== undefined && aids.absMax > 0;
  const off = aids.tcMax === 0 && aids.absMax === 0 && words.length === 0;
  if (words.length === 0 && !off) return null;
  const label = off ? t('social.leaderboard.aidsRowNone', 'No driving aids') : t('social.leaderboard.aidsRow', 'Driving aids: {{list}}', { list: words.join(', ') });
  const badge = 'rounded border border-border bg-muted/40 px-1 font-mono text-2xs font-semibold leading-4 text-muted-foreground';
  return (
    <span role="img" aria-label={label} title={label} className={cn('inline-flex shrink-0 items-center gap-1', className)} data-testid="aid-icons">
      {off && <Ban className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" data-aid="none" />}
      {tc && <span className={badge} aria-hidden="true" data-aid="tc">{t('social.leaderboard.aidTcShort', 'TC')}</span>}
      {abs && <span className={badge} aria-hidden="true" data-aid="abs">{t('social.leaderboard.aidAbsShort', 'ABS')}</span>}
      {aids.autoShift && <Cog className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" data-aid="gears" />}
      {aids.idealLine && <Route className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" data-aid="line" />}
    </span>
  );
}
