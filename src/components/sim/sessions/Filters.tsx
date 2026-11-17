import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import { OptionSelect } from '@/components/ui/option-select';
import { FilterSheet } from '@/components/ui/filter-sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { Switch } from '@/components/ui/switch';
import { useGames } from '@/lib/sim/games';
import { SESSION_KINDS, SESSION_PERIODS, activeFilterCount, type FilterKey, type KindFilter, type SessionFilters, type SessionPeriod } from '@/lib/sim/sessions-view';
import { FilterSelect } from '../FilterSelect';

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
  const mobile = useIsMobile();
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
        className={mobile
          ? 'inline-flex h-8 items-center rounded-full border border-border bg-muted/40 pl-3 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          : 'inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'}
        aria-label={t('sessionsDash.filters.removeFilter', 'Remove the filter: {{filter}}', { filter: text })}
        data-testid={`chip-${id}`}
      >
        {text}
        {mobile ? (
          <span className="flex h-8 w-8 items-center justify-center" aria-hidden="true"><X className="h-3 w-3" /></span>
        ) : (
          <X className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
    </li>
  );
  const named = (list: Option[], value: string) => list.find((option) => option.value === value)?.label ?? value;

  const gameFilter = { label: t('modes.sessions.filterGame', 'Game'), all, value: filters.game, key: 'game' as const, options: gameOptions, testId: 'filter-game' };
  const phoneSelects = [
    gameFilter,
    { label: t('modes.sessions.filterTrack', 'Track'), all, value: filters.track, key: 'track' as const, options: trackOptions, testId: 'filter-track' },
    { label: t('modes.sessions.filterCar', 'Car'), all, value: filters.car, key: 'car' as const, options: carOptions, testId: 'filter-car' },
    { label: t('sessionsDash.filters.kindShort', 'Type'), all, value: filters.kind, key: 'kind' as const, options: SESSION_KINDS.map((kind) => ({ value: kind, label: kindLabels[kind] })), testId: 'filter-kind' },
    { label: t('sessionsDash.filters.period', 'Period'), all: t('sessionsDash.filters.anyTime', 'Any time'), value: filters.period, key: 'period' as const, options: SESSION_PERIODS.map((period) => ({ value: period, label: periodLabels[period] })), testId: 'filter-period' },
  ];
  const validLabel = t('sessionsDash.filters.validOnly', 'Valid laps only');

  return (
    <section aria-label={t('sessionsDash.filters.title', 'Filters')} data-testid="session-filters">
      {mobile ? (
        <FilterSheet
          count={count}
          onClear={onClear}
          title={t('sessionsDash.filters.title', 'Filters')}
          testId="filters-open"
          testIds={{ count: 'filters-count', sheet: 'filters-sheet', clear: 'filters-clear-all', apply: 'filters-show-results' }}
          triggerClassName="w-full justify-center"
        >
          {phoneSelects.map((item) => (
            <div key={item.key} className="space-y-1">
              <span className="text-xs text-muted-foreground" aria-hidden="true">{item.label}</span>
              <OptionSelect
                aria-label={item.label}
                value={item.value}
                onChange={(value) => onChange(item.key, value)}
                options={item.options}
                emptyLabel={item.all}
                data-testid={item.testId}
                className="w-full"
              />
            </div>
          ))}
          <label className="flex h-10 cursor-pointer items-center justify-between gap-2 text-sm">
            {validLabel}
            <Switch checked={filters.validOnly} onCheckedChange={(checked) => onChange('validOnly', checked)} data-testid="filter-valid" aria-label={validLabel} />
          </label>
        </FilterSheet>
      ) : (
      /* One row of five small drop-downs (the label inside each) and the switch on the right; it wraps only on a narrow screen. */
      <FilterBar data-testid="filter-toolbar">
        <FilterSelect label={t('modes.sessions.filterGame', 'Game')} allLabel={all} value={filters.game} onChange={(value) => onChange('game', value)} options={gameOptions} testId="filter-game" />
        <FilterSelect label={t('modes.sessions.filterTrack', 'Track')} allLabel={all} value={filters.track} onChange={(value) => onChange('track', value)} options={trackOptions} testId="filter-track" />
        <FilterSelect label={t('modes.sessions.filterCar', 'Car')} allLabel={all} value={filters.car} onChange={(value) => onChange('car', value)} options={carOptions} testId="filter-car" />
        <FilterSelect
          label={t('sessionsDash.filters.kindShort', 'Type')}
          allLabel={all}
          value={filters.kind}
          onChange={(value) => onChange('kind', value)}
          options={SESSION_KINDS.map((kind) => ({ value: kind, label: kindLabels[kind] }))}
          testId="filter-kind"
        />
        <FilterSelect
          label={t('sessionsDash.filters.period', 'Period')}
          allLabel={t('sessionsDash.filters.anyTime', 'Any time')}
          value={filters.period}
          onChange={(value) => onChange('period', value)}
          options={SESSION_PERIODS.map((period) => ({ value: period, label: periodLabels[period] }))}
          testId="filter-period"
          className="sm:w-40"
        />
        <label className="flex h-8 cursor-pointer items-center gap-2 text-xs sm:ml-auto" title={t('sessionsDash.filters.validOnlyHint', 'Hides sessions where the game counted no lap as valid.')}>
          <Switch checked={filters.validOnly} onCheckedChange={(checked) => onChange('validOnly', checked)} data-testid="filter-valid" aria-label={t('sessionsDash.filters.validOnly', 'Valid laps only')} />
          {t('sessionsDash.filters.validOnly', 'Valid laps only')}
        </label>
      </FilterBar>
      )}

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
          <Button type="button" size="sm" variant="ghost" className={mobile ? 'ml-auto h-8 px-3 text-xs' : 'ml-auto h-6 px-2 text-xs'} onClick={onClear} data-testid="clear-filters">
            {t('modes.sessions.clearFilters', 'Clear the filters')}
          </Button>
        </div>
      )}
    </section>
  );
}
