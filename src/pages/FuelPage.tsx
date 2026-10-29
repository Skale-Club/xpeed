import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Fuel, Loader2, Trash2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useToast } from '@/hooks/use-toast';
import { getSessions } from '@/lib/db';
import { listFuelEntries, saveFuelEntry, deleteFuelEntry, calculateSavedFuel } from '@/lib/fuel-api';
import { aggregateFuel, compareFuel, tankIntervals, readFuelMetrics, US_GALLON, validateFuelEntry, type FuelEntry } from '@/lib/fuel-ledger';
import { holdAppUpdates } from '@/lib/pwa-update';
import { publicAppUrl } from '@/lib/trips';
import { formatAppDate } from '@/lib/app-date';
import type { Session } from '@/types/session';

const EMPTY_ENTRIES: FuelEntry[] = [], EMPTY_TRIPS: Session[] = [];
const localNow = () => { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const REGIONS = { NUS: 'U.S.', R10: 'East Coast', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast' };

export default function FuelPage() {
  const { selectedCarId, selectedCar } = useCarsContext();
  const { t } = useTranslation();
  return selectedCarId ? <FuelScreen key={selectedCarId} carId={selectedCarId} name={selectedCar?.name ?? ''} /> : <AppLayout><p>{t('trip.noCar', 'Choose your car to save this trip')}</p></AppLayout>;
}
function FuelScreen({ carId, name }: { carId: string; name: string }) {
  const { t, i18n } = useTranslation();
  const { distanceUnit, timezone } = useSettings();
  const { toast } = useToast();
  const client = useQueryClient();
  const ledger = useQuery({ queryKey: ['fuel-entries', carId], queryFn: () => listFuelEntries(carId), staleTime: 60_000 });
  const history = useQuery({ queryKey: ['fuel-sessions', carId], queryFn: async () => await getSessions(carId) as Session[], staleTime: 60_000 });
  const entries = ledger.data ?? EMPTY_ENTRIES, trips = history.data ?? EMPTY_TRIPS;
  const [group, setGroup] = useState<'week' | 'month'>('month');
  const [entryPage, setEntryPage] = useState(1);
  const [saving, setSaving] = useState(false), [calculating, setCalculating] = useState(false), [lookingUp, setLookingUp] = useState(false);
  const [deleting, setDeleting] = useState<FuelEntry | null>(null);
  const [region, setRegion] = useState('NUS');
  const [draft, setDraft] = useState({ kind: 'fill' as 'fill' | 'reference', at: localNow(), amount: '', paid: '', price: '', odometer: '', fullTank: false, currency: (i18n.resolvedLanguage === 'pt-BR' ? 'BRL' : 'USD') as FuelEntry['currency'], source: 'manual' as 'manual' | 'regional', region: '', sourceUrl: '', note: '' });
  const dirty = !!(draft.amount || draft.paid || draft.price || draft.odometer || draft.note);
  const factor = distanceUnit === 'mi' ? US_GALLON : 1, unit = distanceUnit === 'mi' ? 'US gal' : 'L';
  const periods = useMemo(() => aggregateFuel(trips, entries, group, timezone), [trips, entries, group, timezone]);
  const comparison = useMemo(() => compareFuel(trips), [trips]);
  const intervals = useMemo(() => tankIntervals(entries), [entries]);
  const format = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }).format(value);
  const money = (value: number, currency: string) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency }).format(value);
  const monies = (values: Record<string, number>) => Object.entries(values).map(([currency, amount]) => money(amount, currency)).join(' · ') || '—';
  const economy = (value: number | null) => value == null ? '—' : `${format(distanceUnit === 'mi' ? value * .621371 * US_GALLON : value)} ${distanceUnit === 'mi' ? 'MPG' : 'km/L'}`;
  const field = 'rounded-xl border border-input bg-background/60 p-3 text-sm w-full';
  const changed = () => { void client.invalidateQueries({ queryKey: ['fuel-entries', carId] }); };
  useEffect(() => { if (dirty) { const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); } }, [dirty]);

  useEffect(() => dirty ? holdAppUpdates() : undefined, [dirty]);
  useEffect(() => { setEntryPage((page) => Math.min(page, Math.max(1, Math.ceil(entries.length / 10)))); }, [entries.length]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving) return;
    if (!Number.isFinite(Date.parse(draft.at))) { toast({ title: t('fuel.invalid', 'Check the date, quantity and price.'), variant: 'destructive' }); return; }
    const litres = draft.kind === 'fill' ? Number(draft.amount) * factor : 0;
    const paid = draft.kind === 'fill' ? Number(draft.paid) : null;
    const entry = { kind: draft.kind, at: new Date(draft.at).toISOString(), litres, totalPaid: paid, pricePerLitre: draft.kind === 'fill' ? Number(paid) / litres : Number(draft.price) / factor, currency: draft.currency, odometerKm: draft.kind === 'fill' && draft.odometer ? Number(draft.odometer) * (distanceUnit === 'mi' ? 1.609344 : 1) : null, fullTank: draft.kind === 'fill' && draft.fullTank, source: draft.kind === 'fill' ? 'receipt' as const : draft.source, region: draft.region, sourceUrl: draft.sourceUrl, note: draft.note };
    if (!validateFuelEntry(entry)) { toast({ title: t('fuel.invalid', 'Check the date, quantity and price.'), variant: 'destructive' }); return; }
    setSaving(true);
    try {
      await saveFuelEntry(carId, entry); changed(); setEntryPage(1);
      setDraft((d) => ({ ...d, at: localNow(), amount: '', paid: '', price: '', odometer: '', note: '', source: 'manual', region: '', sourceUrl: '' }));
      toast({ title: t('fuel.saved', 'Fuel record saved'), variant: 'success' });
    } catch { toast({ title: t('fuel.saveFailed', 'Could not save. Your entries are still in the form.'), variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  const lookup = async () => {
    setLookingUp(true);
    try {
      const response = await fetch(`${publicAppUrl()}/api/fuel-price?region=${region}`);
      if (!response.ok) throw new Error();
      const value = await response.json();
      setDraft((d) => ({ ...d, kind: 'reference', source: 'regional', price: (value.price / US_GALLON * factor).toFixed(4), currency: 'USD', at: `${value.date}T12:00`, region: value.region, sourceUrl: value.sourceUrl }));
    } catch { toast({ title: t('fuel.priceFailed', 'The regional price is unavailable. You can still enter a price manually.'), variant: 'destructive' }); }
    finally { setLookingUp(false); }
  };
  const calculateOlder = async () => {
    setCalculating(true); let done = 0, failed = 0;
    try {
      for (const trip of trips.filter((item) => !readFuelMetrics(item))) {
        try {
          const fuel = await calculateSavedFuel(carId, trip.id);
          client.setQueryData<Session[]>(['fuel-sessions', carId], (previous) => previous?.map((item) => item.id === trip.id ? { ...item, summary: { ...item.summary, fuel } } : item));
          done++;
        } catch { failed++; }
      }
      toast({ title: t('fuel.calculated', '{{count}} trips checked; {{failed}} unavailable', { count: done, failed }), variant: failed ? 'warning' : 'success' });
    } finally { setCalculating(false); }
  };
  const remove = async () => {
    if (!deleting) return;
    try { await deleteFuelEntry(carId, deleting.id); changed(); setDeleting(null); }
    catch { toast({ title: t('fuel.deleteFailed', 'Could not delete this fuel record.'), variant: 'destructive' }); }
  };
  return <AppLayout refreshDisabled={dirty || saving || calculating}><div className="max-w-4xl space-y-4">
    <h2 className="flex items-center gap-2 text-xl font-bold"><Fuel className="h-5 w-5" />{t('fuel.title', 'Fuel & costs')}</h2><p className="text-sm text-muted-foreground">{name}</p>
    <p className="text-sm text-muted-foreground">{t('fuel.explain', 'Paid at the pump is what you entered from fill-ups. Trip cost is an estimate using fuel consumption and the latest price known at the time. Currencies are kept separate.')}</p>
    {(ledger.isPending || history.isPending) && <p role="status">{t('fuel.loading', 'Loading fuel records…')}</p>}
    {(ledger.isError || history.isError) && <div role="alert" className="space-y-2"><p>{t('fuel.loadFailed', 'Could not load fuel data. No complete totals can be shown.')}</p><Button onClick={() => { void ledger.refetch(); void history.refetch(); }}>{t('common.retry', 'Try again')}</Button></div>}
    {ledger.isSuccess && history.isSuccess && <>
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm">{t('fuel.group', 'Group by')} <select className="rounded border border-border bg-background p-2" value={group} onChange={(event) => setGroup(event.target.value as 'week' | 'month')}><option value="month">{t('trends.month', 'Month')}</option><option value="week">{t('fuel.week', 'Week')}</option></select></label>
      {trips.some((item) => !readFuelMetrics(item)) && <Button size="sm" variant="outline" disabled={calculating} onClick={() => void calculateOlder()}>{calculating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('fuel.calculateOlder', 'Calculate saved trips')}</Button>}</div>
      <Card><CardContent className="space-y-3 p-4">
        <h3 className="font-semibold">{t('fuel.periods', 'Consumption and spending by period')}</h3>
        {!periods.length ? <p className="text-sm text-muted-foreground">{t('fuel.empty', 'Record a fill-up or complete a trip to start.')}</p> : <>
          <div className="h-52 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={periods.slice(0, 36).reverse().map((row) => ({ ...row, economy: row.efficiencyKmPerLitre == null ? null : row.efficiencyKmPerLitre * (distanceUnit === 'mi' ? .621371 * US_GALLON : 1) }))}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="period" /><YAxis /><Tooltip /><Line dataKey="economy" name={distanceUnit === 'mi' ? 'MPG' : 'km/L'} stroke="hsl(var(--primary))" connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['period','fuelUsed','estimatedCost','paid','coverage','economy'].map((key) => <th className="p-2" key={key}>{t(`fuel.${key}`, ({ period: 'Period', fuelUsed: 'Fuel used', estimatedCost: 'Estimated trip cost', paid: 'Paid at pump', coverage: 'Trips covered', economy: 'Fuel economy' } as Record<string, string>)[key])}</th>)}</tr></thead><tbody>{periods.map((row) => <tr key={row.period} className="border-t border-border"><td className="p-2">{row.period}</td><td className="p-2">{row.covered ? <>{format(row.calculatedLitres / factor)} {unit} {t('fuel.calculatedLabel', 'calculated')}<br />{format(row.estimatedLitres / factor)} {unit} {t('fuel.estimatedLabel', 'estimated')}</> : '—'}</td><td className="p-2">{monies(row.tripCost)}<br />{row.priced}/{row.trips} {t('fuel.tripsPriced', 'trips priced')}</td><td className="p-2">{monies(row.paid)}</td><td className="p-2">{row.covered}/{row.trips}</td><td className="p-2">{economy(row.efficiencyKmPerLitre)}</td></tr>)}</tbody></table></div>
        </>}
        <p className="text-xs text-muted-foreground">{t('fuel.coverageHint', 'Only readings with at least 90% coverage contribute to calculated trip totals and efficiency comparisons. Estimates use a previous full-tank interval. Missing data is not zero.')}</p>
      </CardContent></Card>
      <Card><CardContent className="space-y-2 p-4"><h3 className="font-semibold">{t('fuel.trendTitle', 'Is consumption changing?')}</h3>
        {comparison ? <p className={comparison.deltaPct >= 10 ? 'text-warn' : 'text-sm'}>{t('fuel.comparison', 'Consumption per distance changed {{delta}}% across {{current}} recent and {{previous}} earlier comparable trips.', { delta: `${comparison.deltaPct > 0 ? '+' : ''}${format(comparison.deltaPct)}`, current: comparison.currentCount, previous: comparison.previousCount })}</p> : <p className="text-sm text-muted-foreground">{t('fuel.notEnough', 'Not enough comparable readings yet. Each 28-day period needs at least 3 well-covered trips and 20 km in a similar speed and duration group.')}</p>}
        <p className="text-xs text-muted-foreground">{t('fuel.comparisonHint', 'This compares consumption, not gasoline prices. Speed and duration are grouped; route, traffic and weather are not matched. An increase is an observation, not a diagnosis.')}</p>
        <p className="text-sm">{t('fuel.tankAverage', 'Latest full-tank average')}: {economy(intervals.at(-1)?.kmPerLitre ?? null)}</p>
      </CardContent></Card>
    </>}
    <Card><CardContent className="space-y-3 p-4"><h3 className="font-semibold">{t('fuel.add', 'Record a fill-up or reference price')}</h3>
      <form onSubmit={(event) => void save(event)} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">{t('fuel.kind', 'Record type')}<select className={field} value={draft.kind} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, kind: event.target.value as 'fill' | 'reference' }))}><option value="fill">{t('fuel.fill', 'Fill-up paid')}</option><option value="reference">{t('fuel.reference', 'Reference price only')}</option></select></label>
        <label className="space-y-1 text-sm">{t('fuel.date', 'Date and time (device time zone)')}<Input required type="datetime-local" value={draft.at} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, at: event.target.value }))} /></label>
        <label className="space-y-1 text-sm">{t('fuel.currency', 'Currency')}<select className={field} value={draft.currency} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, currency: event.target.value as FuelEntry['currency'] }))}>{['USD','BRL','EUR'].map((value) => <option key={value}>{value}</option>)}</select></label>
        {draft.kind === 'fill' ? <>
          <label className="space-y-1 text-sm">{t('fuel.quantity', 'Quantity')} ({unit})<Input required type="number" min="0.001" step="any" inputMode="decimal" value={draft.amount} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, amount: event.target.value }))} /></label>
          <label className="space-y-1 text-sm">{t('fuel.totalPaid', 'Total actually paid')}<Input required type="number" min="0.01" step="any" inputMode="decimal" value={draft.paid} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, paid: event.target.value }))} /></label>
          <label className="space-y-1 text-sm">{t('fuel.odometer', 'Odometer (optional)')} ({distanceUnit})<Input type="number" min="0" step="any" value={draft.odometer} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, odometer: event.target.value }))} /></label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={draft.fullTank} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, fullTank: event.target.checked }))} />{t('fuel.fullTank', 'Tank filled completely')}</label>
        </> : <label className="space-y-1 text-sm">{t('fuel.unitPrice', 'Price per unit')} ({draft.currency}/{unit})<Input required type="number" min="0.0001" step="any" inputMode="decimal" value={draft.price} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, price: event.target.value, source: 'manual', sourceUrl: '', region: '' }))} /></label>}
        <label className="space-y-1 text-sm sm:col-span-2">{t('fuel.note', 'Station or note (optional)')}<Input value={draft.note} maxLength={1000} disabled={saving} onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))} /></label>
        {draft.source === 'regional' && draft.kind === 'reference' && <p className="text-xs text-muted-foreground sm:col-span-2">{draft.region} · {draft.at.slice(0,10)} · <a className="underline" href={draft.sourceUrl} target="_blank" rel="noopener noreferrer">EIA</a> · {t('fuel.estimatedLabel', 'estimated')}</p>}
        <Button type="submit" disabled={saving || ledger.isPending || ledger.isError} className="sm:col-span-2">{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('common.save', 'Save')}</Button>
      </form>
      <div className="space-y-2 border-t border-border pt-3"><p className="text-xs text-muted-foreground">{t('fuel.regionalHint', 'Optional EIA weekly average for regular gasoline in the U.S.; not a local station quote. Review and save it as an estimated reference price.')}</p><div className="flex flex-wrap gap-2"><select aria-label={t('fuel.region', 'Price region')} className="min-w-0 rounded border border-border bg-background p-2 text-sm" value={region} onChange={(event) => setRegion(event.target.value)}>{Object.entries(REGIONS).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant="outline" size="sm" disabled={lookingUp || saving} onClick={() => void lookup()}>{t('fuel.lookup', 'Look up regional average')}</Button></div></div>
    </CardContent></Card>
    {ledger.isSuccess && entries.length > 0 && <Card><CardContent className="space-y-3 p-4"><h3 className="font-semibold">{t('fuel.records', 'Fuel records')}</h3>{entries.slice((entryPage-1)*10, entryPage*10).map((entry) => <div key={entry.id} className="flex items-start justify-between gap-3 border-t border-border pt-3"><div className="min-w-0 text-sm"><p className="font-semibold">{entry.kind === 'fill' ? `${format(entry.litres/factor)} ${unit} · ${money(entry.totalPaid!, entry.currency)}` : `${money(entry.pricePerLitre*factor,entry.currency)}/${unit} · ${t('fuel.reference', 'Reference price only')}`}</p><p className="text-xs text-muted-foreground">{formatAppDate(new Date(entry.at),i18n.resolvedLanguage,{dateStyle:'medium',timeStyle:'short'})} · {entry.region || entry.source}{entry.odometerKm != null && ` · ${format(entry.odometerKm * (distanceUnit === 'mi' ? .621371 : 1))} ${distanceUnit}`}</p>{entry.note && <p className="break-words">{entry.note}</p>}{entry.sourceUrl && <a href={entry.sourceUrl} className="text-xs underline" target="_blank" rel="noopener noreferrer">{t('fuel.source', 'Source')}</a>}</div><Button variant="ghost" size="icon" aria-label={t('history.delete','Delete')} onClick={() => setDeleting(entry)}><Trash2 className="h-4 w-4" /></Button></div>)}{entries.length>10&&<div className="flex justify-between"><Button variant="outline" size="sm" disabled={entryPage<=1} onClick={()=>setEntryPage((p)=>p-1)}>{t('history.previous','Previous')}</Button><span>{entryPage}/{Math.ceil(entries.length/10)}</span><Button variant="outline" size="sm" disabled={entryPage>=Math.ceil(entries.length/10)} onClick={()=>setEntryPage((p)=>p+1)}>{t('history.next','Next')}</Button></div>}</CardContent></Card>}
    <Link to="/history" className="text-sm text-primary hover:underline">{t('history.title','Trips')}</Link>
    <ConfirmDialog open={!!deleting} onOpenChange={(open)=>{if(!open)setDeleting(null);}} title={t('fuel.deleteTitle','Delete this fuel record?')} description={t('fuel.deleteHint','Costs and full-tank estimates will be recalculated without this entry.')} confirmLabel={t('history.delete','Delete')} onConfirm={()=>void remove()} />
  </div></AppLayout>;
}
