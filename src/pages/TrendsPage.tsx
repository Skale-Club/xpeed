import { temperatureValue, temperatureLabel } from '@/lib/temperature';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/PageLoader';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { getSessions } from '@/lib/db';
import { aggregateTrends, trendMetrics } from '@/lib/long-term-trends';
import { CHART_PALETTE } from '@/lib/chart-palette';
import type { Session } from '@/types/session';
const EMPTY_SESSIONS: Session[] = [];

export default function TrendsPage() {
  const { t, i18n } = useTranslation();
  const { selectedCarId, selectedCar } = useCarsContext();
  const { timezone, distanceUnit, temperatureUnit } = useSettings();
  const [group, setGroup] = useState<'month' | 'year'>('month');
  const [period, setPeriod] = useState('12');
  const [chosen, setChosen] = useState('vehicle_speed');
  const query = useQuery({ queryKey: ['trends', selectedCarId], queryFn: async () => await getSessions(selectedCarId!) as Session[], enabled: !!selectedCarId, staleTime: 60_000 });
  const sessions = query.data ?? EMPTY_SESSIONS;
  const metrics = useMemo(() => trendMetrics(sessions), [sessions]);
  const metric = metrics.find((item) => item.key === chosen) ?? metrics[0];
  const data = useMemo(() => {
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - Number(period));
    const selected = period === 'all' ? sessions : sessions.filter((s) => new Date(s.session_start ?? s.uploaded_at) >= cutoff);
    return aggregateTrends(selected, metric?.key ?? '', group, timezone);
  }, [sessions, period, metric?.key, group, timezone]);
  const mph = distanceUnit === 'mi' && /km\/?h/i.test(metric?.unit ?? '');
  const display = data.map((bucket) => ({ ...bucket, avg: bucket.avg == null ? null : temperatureValue(bucket.avg * (mph ? 0.621371 : 1), metric?.unit ?? '', temperatureUnit), min: bucket.min == null ? null : temperatureValue(bucket.min * (mph ? 0.621371 : 1), metric?.unit ?? '', temperatureUnit), max: bucket.max == null ? null : temperatureValue(bucket.max * (mph ? 0.621371 : 1), metric?.unit ?? '', temperatureUnit) }));
  const format = (value: number | null) => value == null ? '—' : new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 }).format(value);
  const selectClass = 'rounded-md border border-border bg-background p-2 text-sm min-w-0';
  return <AppLayout><div className="space-y-4">
    <h2 className="text-xl font-bold">{t('trends.heading', 'How your car is changing')}{selectedCar && ` — ${selectedCar.name}`}</h2>
    <p className="text-sm text-muted-foreground">{t('trends.hint', 'Compare fuel use, temperatures and other readings across your trips to spot changes over time.')}</p>
    {!selectedCarId ? <p>{t('trends.noCar', 'Choose a car to see its history.')}</p> : query.isPending ? <PageLoader /> : query.isError ? <Button onClick={() => void query.refetch()}>{t('common.retry', 'Try again')}</Button> : !metrics.length ? <p>{t('trends.empty', 'Complete a trip to start seeing how your car changes over time.')}</p> : <>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">{t('trends.sensor', 'What to compare')}<select className={selectClass} value={metric?.key} onChange={(e) => setChosen(e.target.value)}>{metrics.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        <label className="flex flex-col gap-1 text-sm">{t('trends.group', 'View by')}<select className={selectClass} value={group} onChange={(e) => setGroup(e.target.value as 'month' | 'year')}><option value="month">{t('trends.month', 'Month')}</option><option value="year">{t('trends.year', 'Year')}</option></select></label>
        <label className="flex flex-col gap-1 text-sm">{t('trends.range', 'History')}<select className={selectClass} value={period} onChange={(e) => setPeriod(e.target.value)}>{[12, 36].map((n) => <option key={n} value={n}>{t('trends.months', '{{count}} months', { count: n })}</option>)}<option value="all">{t('home.range.all', 'All time')}</option></select></label>
      </div>
      <Card><CardContent className="pt-5"><p className="mb-3 font-semibold">{metric?.label} · {mph ? 'mph' : temperatureLabel(metric?.unit ?? '', temperatureUnit)}</p>
        <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={display}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="period" /><YAxis /><Tooltip /><Legend />
          <Line dataKey="min" name={t('trends.min', 'Minimum')} stroke={CHART_PALETTE.blue} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="avg" name={t('trends.avg', 'Average')} stroke={CHART_PALETTE.yellow} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="max" name={t('trends.max', 'Maximum')} stroke={CHART_PALETTE.red} connectNulls={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer></div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['period','trips','coverage','min','avg','max'].map((key) => <th key={key} className="p-2 text-left">{t(`trends.${key}`, key)}</th>)}</tr></thead><tbody>{display.map((row) => <tr key={row.period} className="border-t border-border"><td className="p-2">{row.period}</td><td>{row.trips}</td><td>{row.covered}/{row.trips}</td><td>{format(row.min)}</td><td>{format(row.avg)}</td><td>{format(row.max)}</td></tr>)}</tbody></table></div>
        <p className="mt-3 text-xs text-muted-foreground">{t('trends.chartHint', 'Longer trips carry more weight in the average. Blank periods have no recorded readings.')}</p>
      </CardContent></Card>
    </>}
  </div></AppLayout>;
}
