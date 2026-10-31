import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Fuel, Loader2, Plus, Trash2, ChevronDown } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FuelEntryDialog } from '@/components/fuel/FuelEntryDialog';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useToast } from '@/hooks/use-toast';
import { getSessions } from '@/lib/db';
import { listFuelEntries, deleteFuelEntry } from '@/lib/fuel-api';
import { aggregateFuel, fuelPriceAt, type FuelEntry } from '@/lib/fuel-ledger';
import { tripDayKey } from '@/lib/trip-history';
import { formatAppDate } from '@/lib/app-date';
import { litresPerUnit, fuelEconomy, economyLabel } from '@/lib/fuel-units';
import type { Session } from '@/types/session';

const FuelHistory = lazy(() => import('@/components/fuel/FuelHistory').then(module => ({ default: module.FuelHistory })));
const EMPTY_ENTRIES: FuelEntry[] = [], EMPTY_TRIPS: Session[] = [];
export default function FuelPage() {
  const { selectedCarId, selectedCar } = useCarsContext();
  const { t } = useTranslation();
  return selectedCarId ? <FuelScreen key={selectedCarId} carId={selectedCarId} name={selectedCar?.name ?? ''} /> : <AppLayout><p>{t('trip.noCar', 'Choose your car to save this trip')}</p></AppLayout>;
}
function FuelScreen({ carId, name }: { carId: string; name: string }) {
  const { t, i18n } = useTranslation();
  const { distanceUnit, timezone, volumeUnit, consumptionUnit, currency } = useSettings();
  const { toast } = useToast();
  const client = useQueryClient();
  const ledger = useQuery({ queryKey: ['fuel-entries', carId], queryFn: () => listFuelEntries(carId), staleTime: 60000 });
  const history = useQuery({ queryKey: ['sessions', carId], queryFn: async () => await getSessions(carId) as Session[], staleTime: 60000 });
  const entries = ledger.data ?? EMPTY_ENTRIES, trips = history.data ?? EMPTY_TRIPS;
  const [editor, setEditor] = useState<'fill' | 'reference' | null>(null), [deleting, setDeleting] = useState<FuelEntry | null>(null);
  const [removing, setRemoving] = useState(false), [page, setPage] = useState(1), [details, setDetails] = useState(false);
  const factor = litresPerUnit(volumeUnit), unit = volumeUnit;
  const currentMonth = tripDayKey(new Date(), timezone).slice(0, 7);
  const months = useMemo(() => aggregateFuel(trips, entries, 'month', timezone), [trips, entries, timezone]);
  const month = months.find(row => row.period === currentMonth);
  const fills = entries.filter(entry => entry.kind === 'fill').sort((a, b) => b.at.localeCompare(a.at));
  const price = fuelPriceAt(entries, new Date().toISOString());
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }).format(value);
  const money = (value: number, code: string) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: code }).format(value);
  const payments = ledger.isSuccess && month ? Object.entries(month.paid).map(([code, value]) => money(value, code)).join(' · ') : '';
  const convertedEconomy = fuelEconomy(month?.efficiencyKmPerLitre, consumptionUnit);
  const efficiency = history.isSuccess && convertedEconomy != null ? `${number(convertedEconomy)} ${economyLabel(consumptionUnit)}` : null;
  const saved = (entry: FuelEntry) => {
    client.setQueryData<FuelEntry[]>(['fuel-entries', carId], previous => [entry, ...(previous ?? []).filter(item => item.id !== entry.id)]);
    void client.invalidateQueries({ queryKey: ['fuel-entries', carId] });
    setPage(1);
    toast({ title: entry.kind === 'fill' ? t('fuel.simple.fillSaved', 'Fill-up saved') : t('fuel.simple.priceSaved', 'Fuel price saved'), variant: 'success' });
  };
  const remove = async () => {
    if (!deleting || removing) return;
    setRemoving(true);
    try {
      await deleteFuelEntry(carId, deleting.id);
      client.setQueryData<FuelEntry[]>(['fuel-entries', carId], previous => previous?.filter(entry => entry.id !== deleting.id));
      void client.invalidateQueries({ queryKey: ['fuel-entries', carId] });
      setDeleting(null);
    } catch { toast({ title: t('fuel.deleteFailed', 'Could not delete this fuel record.'), variant: 'destructive' }); }
    finally { setRemoving(false); }
  };
  const lastPage = Math.max(1, Math.ceil(fills.length / 5)), shownPage = Math.min(page, lastPage);
  return <AppLayout refreshDisabled={editor !== null || removing}><div className="mx-auto max-w-2xl space-y-5">
    <div><h2 className="flex items-center gap-2 text-xl font-bold"><Fuel className="h-5 w-5 text-primary" />{t('fuel.title', 'Fuel')}</h2><p className="mt-1 text-sm text-muted-foreground">{name}</p></div>
    {ledger.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('fuel.loading', 'Loading fuel records…')}</p>}
    {(ledger.isError || history.isError) && <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 p-4"><p className="text-sm">{t('fuel.simple.loadFailed', 'Some fuel information could not be loaded.')}</p><Button size="sm" variant="outline" onClick={() => { void ledger.refetch(); void history.refetch(); }}>{t('common.retry', 'Try again')}</Button></div>}
    <Button size="lg" className="w-full" disabled={!ledger.isSuccess} onClick={() => setEditor('fill')}><Plus className="h-5 w-5" />{t('fuel.simple.addFill', 'Add a fill-up')}</Button>
    <Card><CardContent className="space-y-4 p-4"><h3 className="text-sm font-semibold">{t('fuel.thisMonth', 'This month')}</h3>
      <dl className="grid grid-cols-2 gap-4">
        <div><dt className="text-xs text-muted-foreground">{t('fuel.simple.spent', 'Paid at the pump')}</dt><dd className="mt-2 break-words text-xl font-semibold">{payments || '—'}</dd>{!payments && ledger.isSuccess && <p className="mt-1 text-xs text-muted-foreground">{t('fuel.simple.noSpending', 'No fill-ups recorded this month')}</p>}</div>
        <div><dt className="text-xs text-muted-foreground">{t('fuel.simple.economy', 'Fuel economy')}</dt><dd className="mt-2 text-xl font-semibold">{efficiency ?? '—'}</dd>{!efficiency && history.isSuccess && <p className="mt-1 text-xs text-muted-foreground">{t('fuel.simple.needReadings', 'Waiting for enough trip readings')}</p>}</div>
      </dl>
    </CardContent></Card>
    <Card><CardContent className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0"><h3 className="text-sm font-semibold">{t('fuel.simple.price', 'Fuel price')}</h3><p className="mt-1 text-lg font-medium">{ledger.isSuccess && price ? `${money(price.pricePerLitre * factor, price.currency)} / ${unit}` : '—'}</p><p className="mt-1 text-xs text-muted-foreground">{t('fuel.simple.costHint', 'Used to estimate trip costs')}</p>
        {ledger.isSuccess && price && <p className="mt-1 text-xs text-muted-foreground">{formatAppDate(new Date(price.at), i18n.resolvedLanguage, { dateStyle: 'short' })}{price.source === 'regional' && ` · ${t('fuel.simple.averageLabel', 'Regional estimate')}`}</p>}
      </div><Button size="sm" variant="outline" className="shrink-0" disabled={!ledger.isSuccess} onClick={() => setEditor('reference')}>{price ? t('fuel.simple.changePrice', 'Change') : t('fuel.simple.setPrice', 'Set fuel price')}</Button>
    </CardContent></Card>
    {ledger.isSuccess && <section className="space-y-3"><h3 className="text-sm font-semibold">{t('fuel.simple.recent', 'Recent fill-ups')}</h3>
      {fills.length === 0 ? <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{t('fuel.simple.empty', 'Your first fill-up will appear here.')}</p> : <div className="divide-y divide-border rounded-xl border border-border px-4">
        {fills.slice((shownPage - 1) * 5, shownPage * 5).map(entry => <div key={entry.id} className="flex items-center justify-between gap-3 py-4"><div className="min-w-0"><p className="font-semibold">{money(entry.totalPaid!, entry.currency)} <span className="font-normal text-muted-foreground">· {number(entry.litres / factor)} {unit}</span></p><p className="mt-1 text-xs text-muted-foreground">{formatAppDate(new Date(entry.at), i18n.resolvedLanguage, { dateStyle: 'medium' })}</p>{entry.note && <p className="mt-1 break-words text-sm text-muted-foreground">{entry.note}</p>}</div><Button variant="ghost" size="icon" className="shrink-0" aria-label={t('history.delete', 'Delete')} onClick={() => setDeleting(entry)}><Trash2 className="h-4 w-4" /></Button></div>)}
      </div>}
      {lastPage > 1 && <div className="flex items-center justify-between gap-2"><Button size="sm" variant="outline" disabled={shownPage <= 1} onClick={() => setPage(shownPage - 1)}>{t('history.previous', 'Previous')}</Button><span className="text-xs text-muted-foreground">{shownPage} / {lastPage}</span><Button size="sm" variant="outline" disabled={shownPage >= lastPage} onClick={() => setPage(shownPage + 1)}>{t('history.next', 'Next')}</Button></div>}
    </section>}
    {ledger.isSuccess && history.isSuccess && <section className="border-t border-border pt-2"><button className="flex min-h-12 w-full items-center justify-between gap-3 text-left text-sm font-medium" aria-expanded={details} aria-controls="fuel-history" onClick={() => setDetails(value => !value)}>{t('fuel.simple.history', 'History & comparisons')}<ChevronDown className={`h-4 w-4 transition-transform ${details ? 'rotate-180' : ''}`} /></button>
      {details && <div id="fuel-history"><Suspense fallback={<Loader2 className="h-5 w-5 animate-spin" />}><FuelHistory entries={entries} trips={trips} timezone={timezone} volumeUnit={volumeUnit} consumptionUnit={consumptionUnit} onDelete={setDeleting} /></Suspense></div>}
    </section>}
    {editor && <FuelEntryDialog carId={carId} kind={editor} currency={currency} price={price} distanceUnit={distanceUnit} onClose={() => setEditor(null)} onSaved={saved} />}
    <ConfirmDialog open={!!deleting} onOpenChange={value => { if (!value && !removing) setDeleting(null); }} title={t('fuel.deleteTitle', 'Delete this fuel record?')} description={t('fuel.deleteHint', 'Costs and full-tank estimates will be recalculated without this entry.')} confirmLabel={t('history.delete', 'Delete')} onConfirm={() => void remove()} />
  </div></AppLayout>;
}
