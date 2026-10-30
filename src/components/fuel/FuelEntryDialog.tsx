import { useSettings } from '@/contexts/SettingsContext';
import { zonedDateTimeInput, parseZonedDateTime } from '@/lib/app-date';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarDays, ChevronDown, Loader2 } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Dialog, DialogPortal, DialogOverlay, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveFuelEntry } from '@/lib/fuel-api';
import { US_GALLON, validateFuelEntry, type FuelEntry } from '@/lib/fuel-ledger';
import { KM_PER_MILE } from '@/lib/vehicle-care';
import { holdAppUpdates } from '@/lib/pwa-update';
import { publicAppUrl } from '@/lib/trips';
import { litresPerUnit } from '@/lib/fuel-units';
import { parseFuelNumber } from '@/lib/fuel-entry';

const REGIONS = { NUS: 'U.S.', R10: 'East Coast', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast' };
export function FuelEntryDialog({ carId, kind, currency, price, distanceUnit, onClose, onSaved }: {
  carId: string; kind: 'fill' | 'reference'; currency: FuelEntry['currency']; price: FuelEntry | null;
  distanceUnit: 'km' | 'mi'; onClose: () => void; onSaved: (entry: FuelEntry) => void;
}) {
  const { t, i18n } = useTranslation();
  const { timezone, volumeUnit } = useSettings();
  const localTime = (date: Date) => zonedDateTimeInput(date, timezone);
  const fill = kind === 'fill', factor = litresPerUnit(volumeUnit), unit = volumeUnit;
  const [recordedAt] = useState(() => new Date());
  const [intentId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState({ at: localTime(recordedAt), amount: '', paid: '', price: !fill && price && price.currency === currency ? String(Number((price.pricePerLitre * factor).toFixed(4))) : '', odometer: '', fullTank: false, currency, note: '', source: 'manual' as 'manual' | 'regional', region: '', sourceUrl: '' });
  const [initial] = useState(() => JSON.stringify(draft));
  const [saving, setSaving] = useState(false), [lookingUp, setLookingUp] = useState(false);
  const [region, setRegion] = useState('NUS'), [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== initial, busy = saving || lookingUp;
  const paid = parseFuelNumber(draft.paid), amount = parseFuelNumber(draft.amount), unitPrice = parseFuelNumber(draft.price);
  const canSave = fill ? paid > 0 && amount > 0 : unitPrice > 0;
  const symbol = { USD: '$', BRL: 'R$', EUR: '€' }[draft.currency];
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
    const enteredAt = parseZonedDateTime(draft.at, timezone);
    if (!enteredAt) { setError(t('fuel.invalid', 'Check the date, quantity and price.')); return; }
    const litres = fill ? amount * factor : 0;
    const at = draft.at === localTime(recordedAt) && draft.source !== 'regional' ? recordedAt.toISOString() : enteredAt.toISOString();
    const entry = { kind, at, litres, totalPaid: fill ? paid : null,
      pricePerLitre: fill ? paid / litres : unitPrice / factor, currency: draft.currency,
      odometerKm: fill && draft.odometer ? Number(draft.odometer) * (distanceUnit === 'mi' ? KM_PER_MILE : 1) : null,
      fullTank: fill && draft.fullTank, source: fill ? 'receipt' as const : draft.source, region: fill ? '' : draft.region, sourceUrl: fill ? '' : draft.sourceUrl, note: draft.note.trim() };
    if (!validateFuelEntry(entry)) { setError(t('fuel.invalid', 'Check the date, quantity and price.')); return; }
    setSaving(true);
    try { onSaved(await saveFuelEntry(carId, entry, intentId)); onClose(); }
    catch (error) { setError(error instanceof Error && error.message==='fuel_intent_conflict' ? t('fuel.retryConflict','This fill-up was already saved with different details. Check your history before adding it again.') : t('fuel.saveFailed', 'Could not save. Your entries are still in the form.')); }
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
  const amountField = fill ? 'fuel-paid' : 'fuel-price';
  const placeholder = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 2 }).format(0);
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose(); }}><DialogPortal><DialogOverlay />
    <DialogPrimitive.Content
      className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-background text-foreground outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[420px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-border sm:shadow-xl"
      onInteractOutside={event => { if (dirty || busy) event.preventDefault(); }}
      onOpenAutoFocus={event => { event.preventDefault(); document.getElementById(amountField)?.focus(); }}>
      <div className="shrink-0 border-b border-border/60 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
        <div className="flex items-center gap-3"><Button type="button" variant="ghost" size="icon" className="shrink-0 rounded-full" disabled={busy} onClick={onClose} aria-label={t('common.cancel', 'Cancel')}><ArrowLeft className="h-5 w-5" /></Button>
          <DialogTitle className="text-lg font-semibold">{fill ? t('fuel.simple.fillTitle', 'Fill-up') : t('fuel.simple.price', 'Fuel price')}</DialogTitle>
        </div>
        <DialogDescription className="sr-only">{fill ? t('fuel.simple.receiptHint', 'Copy these two numbers from your receipt or the pump.') : t('fuel.simple.priceHint', 'The price you pay per gallon or litre helps estimate trip costs.')}</DialogDescription>
      </div>
      <form onSubmit={event => void save(event)} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pb-6 pt-8">
          <div className="space-y-2">
            <Label htmlFor={amountField} className="text-sm text-muted-foreground">{fill ? t('fuel.simple.paidLabel', 'Total paid') : t('fuel.simple.price', 'Fuel price')}</Label>
            <div className="flex items-center gap-2 border-b-2 border-border pb-2 focus-within:border-primary">
              <span className="text-4xl font-semibold" aria-hidden="true">{symbol}</span>
              <input id={amountField} className="h-20 min-w-0 flex-1 border-0 bg-transparent p-0 text-5xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/35 disabled:opacity-50" type="text" inputMode="decimal" autoComplete="off" placeholder={placeholder} required disabled={busy} value={fill ? draft.paid : draft.price}
                onChange={event => setDraft(d => fill ? { ...d, paid: event.target.value } : { ...d, ...manual(), price: event.target.value })} />
              {!fill && <span className="shrink-0 self-end pb-4 text-sm text-muted-foreground">/ {unit}</span>}
            </div>
          </div>
          {fill && <div className="space-y-2"><Label htmlFor="fuel-quantity" className="text-sm text-muted-foreground">{t('fuel.simple.quantityLabel', 'Quantity')}</Label>
            <div className="flex items-center gap-3 border-b border-border focus-within:border-primary"><input id="fuel-quantity" className="h-14 min-w-0 flex-1 border-0 bg-transparent p-0 text-2xl font-medium outline-none placeholder:text-muted-foreground/40 disabled:opacity-50" type="text" inputMode="decimal" autoComplete="off" placeholder="0" required disabled={busy} value={draft.amount} onChange={event => setDraft(d => ({ ...d, amount: event.target.value }))} /><span className="shrink-0 text-sm text-muted-foreground">{unit}</span></div>
            {amount > 0 && paid > 0 && <p className="pt-1 text-sm text-muted-foreground">{money(paid / amount)} / {unit}</p>}
          </div>}
          <details className="border-b border-border/60 pb-3"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground"><CalendarDays className="h-4 w-4" />{t('fuel.simple.editDetails', 'Date & other options')}<ChevronDown className="ml-auto h-4 w-4" /></summary>
            <div className="space-y-4 pb-2 pt-4">
              <div className="space-y-2"><Label htmlFor="fuel-date">{t('fuel.simple.date', 'Date and time')}</Label><Input id="fuel-date" type="datetime-local" disabled={busy} value={draft.at} onChange={event => setDraft(d => ({ ...d, ...manual(), at: event.target.value }))} /></div>
              <div className="space-y-2"><Label htmlFor="fuel-currency">{t('fuel.currency', 'Currency')}</Label><select id="fuel-currency" className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={draft.currency} disabled={busy} onChange={event => setDraft(d => ({ ...d, ...manual(), currency: event.target.value as FuelEntry['currency'] }))}>{['USD', 'BRL', 'EUR'].map(value => <option key={value}>{value}</option>)}</select></div>
              {fill && <><div className="space-y-2"><Label htmlFor="fuel-odometer">{t('fuel.odometer', 'Odometer (optional)')} ({distanceUnit})</Label><Input id="fuel-odometer" type="number" inputMode="decimal" min="0" step="any" disabled={busy} value={draft.odometer} onChange={event => setDraft(d => ({ ...d, odometer: event.target.value }))} /></div>
                <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} checked={draft.fullTank} onChange={event => setDraft(d => ({ ...d, fullTank: event.target.checked }))} />{t('fuel.simple.fullTank', 'I filled the tank completely')}</label></>}
              <div className="space-y-2"><Label htmlFor="fuel-note">{t('fuel.note', 'Station or note (optional)')}</Label><Input id="fuel-note" maxLength={1000} disabled={busy} value={draft.note} onChange={event => setDraft(d => ({ ...d, note: event.target.value }))} /></div>
            </div>
          </details>
          {!fill && <details><summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm text-muted-foreground">{t('fuel.simple.average', 'Use a U.S. average instead')}<ChevronDown className="h-4 w-4" /></summary><div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">{t('fuel.simple.averageHint', 'Optional weekly average for regular gasoline. Review the price and date before saving.')}</p>
            <select aria-label={t('fuel.region', 'Price region')} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" disabled={busy} value={region} onChange={event => setRegion(event.target.value)}>{Object.entries(REGIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
            <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void lookup()}>{lookingUp && <Loader2 className="h-4 w-4 animate-spin" />}{t('fuel.lookup', 'Look up regional average')}</Button>
          </div></details>}
          {draft.source === 'regional' && <p className="text-xs text-muted-foreground">{draft.region} · {draft.at.slice(0, 10)} · <a href={draft.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">EIA</a> · {t('fuel.estimatedLabel', 'estimated')}</p>}
        </div>
        <div className="shrink-0 space-y-3 border-t border-border/60 bg-background px-6 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] pt-4">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="h-12 w-full text-base" disabled={busy || !canSave}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}{saving ? t('fuel.simple.saving', 'Saving…') : t('common.save', 'Save')}</Button>
        </div>
      </form>
    </DialogPrimitive.Content>
  </DialogPortal></Dialog>;
}
