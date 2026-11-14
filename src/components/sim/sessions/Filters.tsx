import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useGames } from '@/lib/sim/games';
import { SESSION_KINDS, SESSION_PERIODS, activeFilterCount, type FilterKey, type KindFilter, type SessionFilters, type SessionPeriod } from '@/lib/sim/sessions-view';
import { FilterSelect } from '../FilterSelect';
import { Segmented } from './Segmented';

interface Option { value: string; label: string }

/**
 * The header of the Sessions list: game, track and car (the server applies these), the kind and the period and "valid laps only" (applied to the
 * sessions read), and a line that says which filters are on, with one button to clear them. Every choice goes to the address.
 */
export function SessionFilterBar({ filters, onChange, onClear, gameOptions, trackOptions, carOptions }: {
  filters: SessionFilters;
  onChange: (key: FilterKey, value: string | boolean) => void;
  onClear: () => void;
  gameOptions: Option[];
  trackOptions: Option[];
  carOptions: Option[];
}) {
  const { t } = useTranslation();
  const games = useGames();
  const count = activeFilterCount(filters);
  const all = t('modes.sessions.all', 'All');
  const kindLabels: Record<KindFilter, string> = {
    practice: t('modes.sessions.kind.practice', 'Practice'),
    qualifying: t('modes.sessions.kind.qualifying', 'Qualifying'),
    race: t('modes.sessions.kind.race', 'Race'),
  };
  const periodLabels: Record<SessionPeriod, string> = {
    '7d': t('modes.overview.dash.range7d', '7 days'),
    '30d': t('modes.overview.dash.range30d', '30 days'),
    '90d': t('modes.overview.dash.range90d', '90 days'),
    '1y': t('modes.overview.dash.range1y', '12 months'),
  };
  const chip = (id: string, text: string, clear: () => void) => (
    <li key={id}>
      <button
        type="button"
        onClick={clear}
        className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('sessionsDash.filters.removeFilter', 'Remove the filter: {{filter}}', { filter: text })}
        data-testid={`chip-${id}`}
      >
        {text}
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </li>
  );
  const named = (list: Option[], value: string) => list.find((option) => option.value === value)?.label ?? value;

  return (
    <section className="rounded-lg border border-border bg-card p-2" aria-label={t('sessionsDash.filters.title', 'Filters')} data-testid="session-filters">
      {/* One compact row that wraps on a small screen: the three drop-downs (label inside), the two segmented controls, and the switch on the right. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="filter-toolbar">
        <FilterSelect inline label={t('modes.sessions.filterGame', 'Game')} allLabel={all} value={filters.game} onChange={(value) => onChange('game', value)} options={gameOptions} testId="filter-game" />
        <FilterSelect inline label={t('modes.sessions.filterTrack', 'Track')} allLabel={all} value={filters.track} onChange={(value) => onChange('track', value)} options={trackOptions} testId="filter-track" />
        <FilterSelect inline label={t('modes.sessions.filterCar', 'Car')} allLabel={all} value={filters.car} onChange={(value) => onChange('car', value)} options={carOptions} testId="filter-car" />
        <Segmented
          label={t('sessionsDash.filters.kind', 'Kind of session')}
          value={filters.kind}
          onChange={(value) => onChange('kind', value)}
          options={[{ value: '', label: all }, ...SESSION_KINDS.map((kind) => ({ value: kind, label: kindLabels[kind] }))]}
          testId="filter-kind"
          optionTestId={(value) => `kind-${value || 'all'}`}
        />
        <Segmented
          label={t('sessionsDash.filters.period', 'Period')}
          value={filters.period}
          onChange={(value) => onChange('period', value)}
          options={[{ value: '', label: t('sessionsDash.filters.anyTime', 'Any time') }, ...SESSION_PERIODS.map((period) => ({ value: period, label: periodLabels[period] }))]}
          testId="filter-period"
          optionTestId={(value) => `period-${value || 'all'}`}
        />
        <label className="flex h-8 cursor-pointer items-center gap-2 text-xs sm:ml-auto" title={t('sessionsDash.filters.validOnlyHint', 'Hides sessions where the game counted no lap as valid.')}>
          <Switch checked={filters.validOnly} onCheckedChange={(checked) => onChange('validOnly', checked)} data-testid="filter-valid" aria-label={t('sessionsDash.filters.validOnly', 'Valid laps only')} />
          {t('sessionsDash.filters.validOnly', 'Valid laps only')}
        </label>
      </div>

      {count > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2" data-testid="active-filters">
          <span className="text-xs text-muted-foreground">{t('sessionsDash.filters.active', 'Filtering by')}</span>
          <ul className="flex flex-wrap items-center gap-2">
            {filters.game && chip('game', games.name(filters.game), () => onChange('game', ''))}
            {filters.track && chip('track', named(trackOptions, filters.track), () => onChange('track', ''))}
            {filters.car && chip('car', named(carOptions, filters.car), () => onChange('car', ''))}
            {filters.kind && chip('kind', kindLabels[filters.kind], () => onChange('kind', ''))}
            {filters.period && chip('period', periodLabels[filters.period], () => onChange('period', ''))}
            {filters.validOnly && chip('valid', t('sessionsDash.filters.validOnly', 'Valid laps only'), () => onChange('validOnly', false))}
          </ul>
          <Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={onClear} data-testid="clear-filters">
            {t('modes.sessions.clearFilters', 'Clear the filters')}
          </Button>
        </div>
      )}
    </section>
  );
}
