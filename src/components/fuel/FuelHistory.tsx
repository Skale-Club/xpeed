import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { aggregateFuel, compareFuel, tankIntervals, type FuelEntry } from '@/lib/fuel-ledger';
import { litresPerUnit, fuelEconomy, economyLabel, type VolumeUnit, type ConsumptionUnit } from '@/lib/fuel-units';
import type { Session } from '@/types/session';
export function FuelHistory({ entries, trips, timezone, volumeUnit, consumptionUnit, onDelete }: { entries: FuelEntry[]; trips: Session[]; timezone: string; volumeUnit: VolumeUnit; consumptionUnit: ConsumptionUnit; onDelete: (entry: FuelEntry) => void }) {
  const { t, i18n } = useTranslation();
  const [group, setGroup] = useState<'month' | 'week'>('month'), [limit, setLimit] = useState(6), [priceLimit, setPriceLimit] = useState(5);
  const periods = useMemo(() => aggregateFuel(trips, entries, group, timezone), [trips, entries, group, timezone]);
  const comparison = useMemo(() => compareFuel(trips), [trips]);
  const intervals = useMemo(() => tankIntervals(entries), [entries]);
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 }).format(value);
  const money = (value: number, currency: string) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency }).format(value);
  const monies = (values: Record<string, number>) => Object.entries(values).map(([currency, value]) => money(value, currency)).join(' · ') || '—';
  const economy = (value: number | null) => {
    const converted = fuelEconomy(value, consumptionUnit);
    return converted == null ? '—' : `${number(converted)} ${economyLabel(consumptionUnit)}`;
  };
  const chart = periods.slice(0, 36).reverse().map(row => ({ period: row.period, economy: row.efficiencyKmPerLitre == null ? null : fuelEconomy(row.efficiencyKmPerLitre, consumptionUnit) }));
  const prices = entries.filter(entry => entry.kind === 'reference');
  const periodLabel = (key: string) => new Intl.DateTimeFormat(i18n.resolvedLanguage, group === 'month' ? { month: 'long', year: 'numeric' } : { dateStyle: 'medium' }).format(new Date(`${key.length === 7 ? `${key}-01` : key}T12:00:00`));
  return <div className="space-y-4 pt-4">
    <div className="flex gap-2" role="group" aria-label={t('fuel.group', 'Group by')}>{(['month', 'week'] as const).map(value => <Button key={value} size="sm" variant={group === value ? 'secondary' : 'outline'} aria-pressed={group === value} onClick={() => { setGroup(value); setLimit(6); }}>{value === 'month' ? t('trends.month', 'Month') : t('fuel.week', 'Week')}</Button>)}</div>
    {chart.filter(row => row.economy !== null).length >= 2 && <div className="h-48"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="period" /><YAxis /><Tooltip /><Line dataKey="economy" name={economyLabel(consumptionUnit)} stroke="hsl(var(--primary))" connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>}
    {periods.length === 0 && <p className="text-sm text-muted-foreground">{t('fuel.simple.noHistory', 'Your recorded trips and fill-ups will appear here.')}</p>}
    {periods.slice(0, limit).map(row => <Card key={row.period}><CardContent className="space-y-3 p-4"><h4 className="text-sm font-semibold capitalize">{periodLabel(row.period)}</h4>
      <dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">{t('fuel.simple.spent', 'Paid at the pump')}</dt><dd className="mt-1 font-medium">{monies(row.paid)}</dd></div><div><dt className="text-xs text-muted-foreground">{t('fuel.simple.economy', 'Fuel economy')}</dt><dd className="mt-1 font-medium">{economy(row.efficiencyKmPerLitre)}</dd></div></dl>
      <div className="border-t border-border pt-3"><p className="text-xs text-muted-foreground">{t('fuel.simple.tripEstimate', 'Estimated fuel cost of trips')}</p><p className="mt-1 font-medium">{monies(row.tripCost)}</p><p className="mt-1 text-xs text-muted-foreground">{t('fuel.simple.pricedTrips', 'Estimate available for {{count}} of {{total}} trips.', { count: row.priced, total: row.trips })}</p></div>
    </CardContent></Card>)}
    {periods.length > limit && <Button variant="outline" className="w-full" onClick={() => setLimit(value => value + 6)}>{t('fuel.simple.showMore', 'Show more')}</Button>}
    <Card><CardContent className="space-y-2 p-4"><h4 className="text-sm font-semibold">{t('fuel.trendTitle', 'Is consumption changing?')}</h4><p className="text-sm text-muted-foreground">{comparison ? t('fuel.simple.change', 'Fuel used per mile/km changed {{change}}% on similar trips.', { change: `${comparison.deltaPct > 0 ? '+' : ''}${number(comparison.deltaPct)}` }) : t('fuel.simple.needTrips', 'More recorded trips are needed to compare consumption.')}</p>
      {intervals.length > 0 && <p className="text-sm">{t('fuel.tankAverage', 'Latest full-tank average')}: {economy(intervals.at(-1)!.kmPerLitre)}</p>}
      <details className="pt-2"><summary className="cursor-pointer text-xs text-muted-foreground">{t('fuel.simple.how', 'How are these numbers calculated?')}</summary><p className="mt-2 text-xs text-muted-foreground">{t('fuel.simple.howHint', 'Trip estimates use available fuel readings and the price saved at the time. Missing readings can leave trips out. Fill-up spending comes from your receipts. Consumption comparisons use similar trips, not fuel prices.')}</p></details>
    </CardContent></Card>
    {prices.length > 0 && <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('fuel.simple.priceHistory', 'Price changes')}</summary><div className="mt-3 divide-y divide-border">{prices.slice(0, priceLimit).map(entry => <div key={entry.id} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{money(entry.pricePerLitre * (litresPerUnit(volumeUnit)), entry.currency)} / {volumeUnit}</p><p className="text-xs text-muted-foreground">{new Date(entry.at).toLocaleDateString(i18n.resolvedLanguage, { timeZone: timezone })}{entry.source === 'regional' && ` · ${entry.region} · ${t('fuel.simple.averageLabel', 'Regional estimate')}`}</p></div><Button variant="ghost" size="sm" onClick={() => onDelete(entry)}>{t('history.delete', 'Delete')}</Button></div>)}</div>{prices.length > priceLimit && <Button variant="outline" size="sm" onClick={() => setPriceLimit(value => value + 5)}>{t('fuel.simple.showMore', 'Show more')}</Button>}</details>}
  </div>;
}
