import { useTranslation } from 'react-i18next';
import { useCarsContext } from '@/contexts/CarsContext';
import { useObd, useObdLive } from '@/contexts/ObdScannerContext';
import { Card, CardContent } from './ui/card';
export function HybridPanel() {
  const { selectedCar } = useCarsContext(); const { status } = useObd(); const { values } = useObdLive(); const { t } = useTranslation();
  if (selectedCar?.engine_type !== 'hybrid' && !/prius/i.test(selectedCar?.model || '')) return null;
  const read = (pattern: RegExp) => { if (status !== 'live') return null; const key = Object.keys(values).find(key => pattern.test(key)); const value = key ? values[key] : null; return value != null && Number.isFinite(value) ? value : null; };
  const tank = read(/^Fuel level /i), battery = read(/^(?:Hybrid battery remaining life|Hybrid\/EV battery pack remaining charge) /i), voltage = read(/^HV pack voltage /i);
  return <Card><CardContent className="space-y-3 p-4"><h3 className="font-semibold">{t('hybrid.title', 'Hybrid system')}</h3><div className="grid grid-cols-3 gap-2">{[[t('hybrid.tank', 'Fuel tank'), tank, '%'], [t('hybrid.battery', 'Reported battery'), battery, '%'], [t('hybrid.voltage', 'HV pack'), voltage, 'V']].map(([label,value,unit]) => <div key={String(label)} className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="font-semibold tabular-nums">{typeof value === 'number' ? `${value.toFixed(1)} ${unit}` : '\u2014'}</p>{typeof value === 'number' && unit === '%' && <meter className="mt-2 w-full" min={0} max={100} value={value} aria-label={String(label)} />}</div>)}</div>
    <div className="grid grid-cols-3 gap-1 text-center text-sm text-muted-foreground" aria-label={t('hybrid.unavailable', 'Power indicator unavailable')}>{['CHG','ECO','POWER'].map(label => <span key={label} className="rounded border border-border p-2">{label}</span>)}</div>
    <p className="text-xs text-muted-foreground">{t('hybrid.hint', 'Only supported sensor readings are shown. Battery percentage is not a battery-health diagnosis. CHG/ECO/POWER needs a validated manufacturer signal; RPM and throttle are not used as substitutes.')}</p>
  </CardContent></Card>;
}
