import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from './ui/card';
import { useSettings } from '@/contexts/SettingsContext';
import { listFuelEntries } from '@/lib/fuel-api';
import { aggregateFuel, tripFuelEstimate, type FuelEntry } from '@/lib/fuel-ledger';
import { litresPerUnit } from '@/lib/fuel-units';
import { formatAppDate } from '@/lib/app-date';
import type { Session } from '@/types/session';
function useLedger(carId: string | null) {
  const [state, setState] = useState<{ carId: string | null; items: FuelEntry[]; ready: boolean; error: boolean }>({ carId, items: [], ready: false, error: false });
  useEffect(() => { let active = true; if (carId) void listFuelEntries(carId).then(items => { if (active) setState({ carId, items, ready: true, error: false }); }, () => { if (active) setState({ carId, items: [], ready: false, error: true }); }); return () => { active = false; }; }, [carId]);
  return state.carId === carId ? state : { items: [], ready: false, error: false };
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
export function TripFuelCost({ session }: { session: Session }) {
  const { t, i18n } = useTranslation(); const { volumeUnit } = useSettings(); const ledger = useLedger(session.car_profile_id);
  const result = tripFuelEstimate(session, ledger.items);
  return <div className="space-y-1 border-t border-border pt-3"><Link to="/fuel" className="text-sm font-semibold text-primary">{t('fuel.estimatedCost', 'Estimated trip cost')}</Link>
    {ledger.ready && result.cost != null && result.price ? <><p className="text-xl font-semibold">{new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: result.price.currency }).format(result.cost)}</p><p className="text-xs text-muted-foreground">{t(result.source === 'calculated' ? 'fuel.costCalculated' : 'fuel.costEstimated', result.source === 'calculated' ? 'From the fuel used on this trip and the price at the time.' : 'Estimated from your last full tank and the price at the time.')} {new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: result.price.currency }).format(result.price.pricePerLitre * litresPerUnit(volumeUnit))} / {volumeUnit}  ·  {formatAppDate(new Date(result.price.at), i18n.resolvedLanguage, {dateStyle:'short'})}  ·  {result.price.region || t('fuel.manualPrice', 'Entered price')}</p></> : <p className="text-xs text-muted-foreground">{ledger.error ? t('fuel.loadFailed', 'Couldn\'t load your fuel data.') : t('fuel.costUnavailable', 'To show this trip\'s cost we need its fuel use and a fuel price. Add a fill-up or set a price.')}</p>}
  </div>;
}
