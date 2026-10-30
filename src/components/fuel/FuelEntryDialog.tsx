import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveFuelEntry } from '@/lib/fuel-api';
import { US_GALLON, validateFuelEntry, type FuelEntry } from '@/lib/fuel-ledger';
import { KM_PER_MILE } from '@/lib/vehicle-care';
import { holdAppUpdates } from '@/lib/pwa-update';
import { publicAppUrl } from '@/lib/trips';

const localTime = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const REGIONS = { NUS: 'U.S.', R10: 'East Coast', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast' };
export function FuelEntryDialog({ carId, kind, currency, price, distanceUnit, onClose, onSaved }: {
  carId: string; kind: 'fill' | 'reference'; currency: FuelEntry['currency']; price: FuelEntry | null;
  distanceUnit: 'km' | 'mi'; onClose: () => void; onSaved: (entry: FuelEntry) => void;
}) {
  const { t, i18n } = useTranslation();
  const fill = kind === 'fill', factor = distanceUnit === 'mi' ? US_GALLON : 1, unit = distanceUnit === 'mi' ? 'US gal' : 'L';
  const [recordedAt] = useState(() => new Date());
  const [draft, setDraft] = useState({ at: localTime(recordedAt), amount: '', paid: '', price: !fill && price ? String(Number((price.pricePerLitre * factor).toFixed(4))) : '', odometer: '', fullTank: false, currency, note: '', source: 'manual' as 'manual' | 'regional', region: '', sourceUrl: '' });
  const [initial] = useState(() => JSON.stringify(draft));
  const [saving, setSaving] = useState(false), [lookingUp, setLookingUp] = useState(false);
  const [region, setRegion] = useState('NUS'), [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== initial, busy = saving || lookingUp;
  useEffect(() => dirty || busy ? holdAppUpdates() : undefined, [dirty, busy]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const money = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: draft.currency, maximumFractionDigits: 3 }).format(value);
  const manual = () => ({ source: 'manual' as const, sourceUrl: '', region: '' });
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    setError('');
    if (!Number.isFinite(Date.parse(draft.at))) { setError(t('fuel.invalid', 'Check the date, quantity and price.')); return; }
    const litres = fill ? Number(draft.amount) * factor : 0;
    const at = draft.at === localTime(recordedAt) && draft.source !== 'regional' ? recordedAt.toISOString() : new Date(draft.at).toISOString();
    const entry = { kind, at, litres, totalPaid: fill ? Number(draft.paid) : null,
      pricePerLitre: fill ? Number(draft.paid) / litres : Number(draft.price) / factor, currency: draft.currency,
      odometerKm: fill && draft.odometer ? Number(draft.odometer) * (distanceUnit === 'mi' ? KM_PER_MILE : 1) : null,
      fullTank: fill && draft.fullTank, source: fill ? 'receipt' as const : draft.source, region: fill ? '' : draft.region, sourceUrl: fill ? '' : draft.sourceUrl, note: draft.note.trim() };
    if (!validateFuelEntry(entry)) { setError(t('fuel.invalid', 'Check the date, quantity and price.')); return; }
    setSaving(true);
    try { onSaved(await saveFuelEntry(carId, entry)); onClose(); }
    catch { setError(t('fuel.saveFailed', 'Could not save. Your entries are still in the form.')); }
    finally { setSaving(false); }
  };
  const lookup = async () => {
    if (busy) return;
    setLookingUp(true); setError('');
    try {
      const response = await fetch(`${publicAppUrl()}/api/fuel-price?region=${region}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error();
      const value = await response.json();
      if (!Number.isFinite(value.price) || value.price <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw Error();
      setDraft(d => ({ ...d, price: (value.price / US_GALLON * factor).toFixed(4), currency: 'USD', at: `${value.date}T12:00`, source: 'regional', region: value.region, sourceUrl: value.sourceUrl }));
    } catch { setError(t('fuel.priceFailed', 'The regional price is unavailable. You can still enter a price manually.')); }
    finally { setLookingUp(false); }
  };
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose(); }}><DialogContent className="max-w-md" onInteractOutside={event => { if (dirty || busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>{fill ? t('fuel.simple.addFill', 'Add a fill-up') : t('fuel.simple.setPrice', 'Set fuel price')}</DialogTitle>
      <DialogDescription>{fill ? t('fuel.simple.receiptHint', 'Copy these two numbers from your receipt or the pump.') : t('fuel.simple.priceHint', 'The price you pay per gallon or litre helps estimate trip costs.')}</DialogDescription></DialogHeader>
    <form onSubmit={event => void save(event)} className="space-y-4">
      {fill ? <>
        <div className="space-y-2"><Label htmlFor="fuel-paid">{t('fuel.simple.paid', 'How much did you pay?')} ({draft.currency})</Label><Input id="fuel-paid" className="h-12 text-lg" type="number" inputMode="decimal" min="0.01" step="any" required disabled={busy} value={draft.paid} onChange={event => setDraft(d => ({ ...d, paid: event.target.value }))} /></div>
        <div className="space-y-2"><Label htmlFor="fuel-quantity">{t('fuel.simple.quantity', 'How much fuel did you add?')} ({unit})</Label><Input id="fuel-quantity" className="h-12 text-lg" type="number" inputMode="decimal" min="0.001" step="any" required disabled={busy} value={draft.amount} onChange={event => setDraft(d => ({ ...d, amount: event.target.value }))} /></div>
        {Number(draft.amount) > 0 && Number(draft.paid) > 0 && <p className="text-sm text-muted-foreground">{money(Number(draft.paid) / Number(draft.amount))} / {unit}</p>}
      </> : <div className="space-y-2"><Label htmlFor="fuel-price">{t('fuel.simple.price', 'Fuel price')} ({draft.currency}/{unit})</Label><Input id="fuel-price" className="h-12 text-lg" type="number" inputMode="decimal" min="0.0001" step="any" required disabled={busy} value={draft.price} onChange={event => setDraft(d => ({ ...d, ...manual(), price: event.target.value }))} /></div>}
      <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('fuel.simple.more', 'More details (optional)')}</summary><div className="mt-4 space-y-4">
        <div className="space-y-2"><Label htmlFor="fuel-date">{t('fuel.simple.date', 'Date and time')}</Label><Input id="fuel-date" type="datetime-local" disabled={busy} value={draft.at} onChange={event => setDraft(d => ({ ...d, ...manual(), at: event.target.value }))} /></div>
        <div className="space-y-2"><Label htmlFor="fuel-currency">{t('fuel.currency', 'Currency')}</Label><select id="fuel-currency" className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={draft.currency} disabled={busy} onChange={event => setDraft(d => ({ ...d, ...manual(), currency: event.target.value as FuelEntry['currency'] }))}>{['USD', 'BRL', 'EUR'].map(value => <option key={value}>{value}</option>)}</select></div>
        {fill && <><div className="space-y-2"><Label htmlFor="fuel-odometer">{t('fuel.odometer', 'Odometer (optional)')} ({distanceUnit})</Label><Input id="fuel-odometer" type="number" inputMode="decimal" min="0" step="any" disabled={busy} value={draft.odometer} onChange={event => setDraft(d => ({ ...d, odometer: event.target.value }))} /></div>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} checked={draft.fullTank} onChange={event => setDraft(d => ({ ...d, fullTank: event.target.checked }))} />{t('fuel.simple.fullTank', 'I filled the tank completely')}</label></>}
        <div className="space-y-2"><Label htmlFor="fuel-note">{t('fuel.note', 'Station or note (optional)')}</Label><Input id="fuel-note" maxLength={1000} disabled={busy} value={draft.note} onChange={event => setDraft(d => ({ ...d, note: event.target.value }))} /></div>
      </div></details>
      {!fill && <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('fuel.simple.average', 'Use a U.S. average instead')}</summary><div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">{t('fuel.simple.averageHint', 'Optional weekly average for regular gasoline. Review the price and date before saving.')}</p>
        <select aria-label={t('fuel.region', 'Price region')} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" disabled={busy} value={region} onChange={event => setRegion(event.target.value)}>{Object.entries(REGIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void lookup()}>{lookingUp && <Loader2 className="h-4 w-4 animate-spin" />}{t('fuel.lookup', 'Look up regional average')}</Button>
      </div></details>}
      {draft.source === 'regional' && <p className="text-xs text-muted-foreground">{draft.region} · {draft.at.slice(0, 10)} · <a href={draft.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">EIA</a> · {t('fuel.estimatedLabel', 'estimated')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="grid grid-cols-2 gap-2 border-t border-border pt-4"><Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal px-3 py-2" disabled={busy} onClick={onClose}>{t('common.cancel', 'Cancel')}</Button><Button type="submit" className="h-auto min-h-11 whitespace-normal px-3 py-2" disabled={busy}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}{fill ? t('fuel.simple.saveFill', 'Save fill-up') : t('fuel.simple.savePrice', 'Save price')}</Button></div>
    </form>
  </DialogContent></Dialog>;
}
