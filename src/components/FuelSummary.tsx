import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { FuelEntryDialog } from './fuel/FuelEntryDialog';
import { useSettings } from '@/contexts/SettingsContext';
import { useToast } from '@/hooks/use-toast';
import { listFuelEntries } from '@/lib/fuel-api';
import { aggregateFuel, fuelPriceAt, tripFuelEstimate, type FuelEntry } from '@/lib/fuel-ledger';
import { litresPerUnit } from '@/lib/fuel-units';
import { formatAppDate } from '@/lib/app-date';
import type { Session } from '@/types/session';

/** The car's fuel records, shared with the Fuel page (same query), so a price saved anywhere shows everywhere. */
function useLedger(carId: string | null) {
  const query = useQuery({ queryKey: ['fuel-entries', carId], queryFn: () => listFuelEntries(carId!), enabled: !!carId, staleTime: 60000 });
  return { items: query.data ?? [], ready: query.isSuccess, error: query.isError };
}
export function FuelOverview({ carId, sessions }: { carId: string; sessions: Session[] }) {
  const { t, i18n } = useTranslation(); const { timezone, volumeUnit } = useSettings(); const ledger = useLedger(carId);
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const key = `${month.find(x => x.type === 'year')?.value}-${month.find(x => x.type === 'month')?.value}`;
  const current = aggregateFuel(sessions, ledger.items, 'month', timezone).find(row => row.period === key);
  return <Card><CardContent className="space-y-2 p-4"><Link to="/fuel" className="font-semibold text-primary">{t('fuel.title', 'Fuel & costs')}</Link>
    <p className="text-sm">{t('fuel.thisMonth', 'This month')}: {ledger.ready && current?.covered ? `${((current.calculatedLitres + current.estimatedLitres) / litresPerUnit(volumeUnit)).toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 2 })} ${volumeUnit}` : t('fuel.noCompleteTotal', 'No complete total yet')}</p>
    {ledger.ready && current && <p className="text-xs text-muted-foreground">{t('fuel.totalMixed', '{{covered}} of {{total}} trips included.', { covered: current.covered, total: current.trips })}</p>}
    <p className="text-xs text-muted-foreground">{t('fuel.overviewHint', 'See your fuel use, what trips cost and what you paid at the pump.')}</p>
  </CardContent></Card>;
}

/**
 * What one trip cost. The price is the one known at the time, or the first one the owner saved for trips
 * from before it; with no price yet, the owner sets it right here, once, for every trip.
 */
export function TripFuelCost({ session, measured }: { session: Session; measured?: { litres: number; coverage: number | null; method?: 'fuel_rate' | 'air_flow' } | null }) {
  const { t, i18n } = useTranslation();
  const { volumeUnit, currency, distanceUnit } = useSettings();
  const { toast } = useToast();
  const client = useQueryClient();
  const carId = session.car_profile_id;
  const ledger = useLedger(carId);
  const [editing, setEditing] = useState(false);
  const result = tripFuelEstimate(session, ledger.items, measured);
  const money = (value: number, code: string) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: code }).format(value);
  const saved = (entry: FuelEntry) => {
    client.setQueryData<FuelEntry[]>(['fuel-entries', carId], previous => [entry, ...(previous ?? []).filter(item => item.id !== entry.id)]);
    void client.invalidateQueries({ queryKey: ['fuel-entries', carId] });
    toast({ title: t('fuel.simple.priceSaved', 'Fuel price saved'), variant: 'success' });
  };
  const price = result.price;
  const how = result.source === 'calculated'
    ? result.method === 'air_flow'
      ? t('fuel.costAirFlow', "From the fuel worked out from the engine's air flow on this trip.")
      : t('fuel.costCalculated', 'From the fuel used on this trip and the price at the time.')
    : t('fuel.costEstimated', 'Estimated from your last full tank and the price at the time.');
  return <div className="space-y-2 border-t border-border pt-3">
    <Link to="/fuel" className="text-sm font-semibold text-primary">{t('fuel.estimatedCost', 'Estimated trip cost')}</Link>
    {!ledger.ready ? (
      ledger.error && <p className="text-xs text-muted-foreground">{t('fuel.loadFailed', "Couldn't load your fuel data.")}</p>
    ) : result.cost != null && price ? <>
      <p className="text-xl font-semibold" data-testid="trip-cost">{money(result.cost, price.currency)}</p>
      <p className="text-xs text-muted-foreground">{how}</p>
      <p className="text-xs text-muted-foreground">
        {money(price.pricePerLitre * litresPerUnit(volumeUnit), price.currency)} / {volumeUnit}
        {' · '}{result.priceLater
          ? t('fuel.priceFirstSaved', { date: formatAppDate(new Date(price.at), i18n.resolvedLanguage, { dateStyle: 'short' }), defaultValue: 'the first price you saved ({{date}})' })
          : `${formatAppDate(new Date(price.at), i18n.resolvedLanguage, { dateStyle: 'short' })} · ${price.region || t('fuel.manualPrice', 'Entered price')}`}
      </p>
    </> : !price ? <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('fuel.setPriceForCost', 'Set your fuel price once and every trip shows what it cost.')}</p>
      {carId && <Button size="sm" onClick={() => setEditing(true)}>{t('fuel.simple.setPrice', 'Set fuel price')}</Button>}
    </div> : (
      <p className="text-xs text-muted-foreground">{t('fuel.noTripFuel', "Your car didn't report how much fuel this trip used, so its cost can't be worked out. Fill-ups saved with a full tank and the odometer let us estimate it.")}</p>
    )}
    {editing && carId && <FuelEntryDialog carId={carId} kind="reference" currency={currency} price={fuelPriceAt(ledger.items, new Date().toISOString())} distanceUnit={distanceUnit} onClose={() => setEditing(false)} onSaved={saved} />}
  </div>;
}
