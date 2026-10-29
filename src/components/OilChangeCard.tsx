import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Droplets, Loader2, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useVehicleCare } from '@/hooks/use-vehicle-care';
import { useSettings } from '@/contexts/SettingsContext';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/hooks/use-toast';
import { vehicleCareRequest } from '@/lib/vehicle-care-api';
import { KM_PER_MILE, oilPlanCompleted, oilReminder, validCare } from '@/lib/vehicle-care';
import { tripDayKey } from '@/lib/trip-history';
import { holdAppUpdates } from '@/lib/pwa-update';

export function CarMileage({ carId }: { carId: string }) {
  const { t, i18n } = useTranslation();
  const { distanceUnit } = useSettings();
  const care = useVehicleCare(carId);
  if (care.data?.state.odometerKm == null) return null;
  const value = care.data.state.odometerKm / (distanceUnit === 'mi' ? KM_PER_MILE : 1);
  return <span className="mt-1 block text-xs text-muted-foreground">{t('oil.registeredMileage', 'Recorded mileage: {{value}} {{unit}}', { value: new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 0 }).format(value), unit: distanceUnit })}</span>;
}

export function OilChangeCard({ carId }: { carId: string }) {
  const { t, i18n } = useTranslation();
  const { distanceUnit, timezone } = useSettings();
  const { user } = useAuth();
  const care = useVehicleCare(carId), client = useQueryClient();
  const factor = distanceUnit === 'mi' ? KM_PER_MILE : 1;
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 0 }).format(value / factor);
  const dateLabel = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    return new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' }).format(new Date(year, month - 1, day));
  };
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ odometer: '', due: '', date: '', before: '0', days: '14', enabled: true });
  const [initial, setInitial] = useState('');
  const dirty = open && JSON.stringify(draft) !== initial;
  useEffect(() => dirty || saving ? holdAppUpdates() : undefined, [dirty, saving]);
  const edit = () => {
    if (!care.data) return;
    const state = care.data.state;
    const input = (value: number | null) => value === null ? '' : String(Number((value / factor).toFixed(3)));
    const next = { odometer: input(state.odometerKm), due: input(state.oilDueKm), date: state.oilDueDate ?? '', before: input(state.warnBeforeKm), days: String(state.warnBeforeDays), enabled: state.enabled };
    setDraft(next); setInitial(JSON.stringify(next)); setOpen(true);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!care.data || saving) return;
    const state = { ...care.data.state, odometerKm: draft.odometer === '' ? null : Number(draft.odometer) * factor,
      oilDueKm: draft.due === '' ? null : Number(draft.due) * factor, oilDueDate: draft.date || null,
      warnBeforeKm: Number(draft.before) * factor, warnBeforeDays: Number(draft.days), enabled: draft.enabled };
    if (!validCare(state)) { toast({ title: t('oil.invalid', 'Check the mileage and reminder date.'), variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const saved = await vehicleCareRequest(carId, { ...care.data, state });
      client.setQueryData(['vehicle-care', user?.id, carId], saved);
      setOpen(false);
      toast({ title: t('oil.saved', 'Mileage and oil reminder saved'), variant: 'success' });
    } catch (error) {
      toast({ title: error instanceof Error && error.message === 'changed_reload' ? t('oil.conflict', 'These details changed on another device. Close this form and refresh before saving again.') : t('oil.failedSave', 'Could not save. Your changes are still in the form.'), variant: 'destructive' });
    } finally { setSaving(false); }
  };
  const reminder = care.data ? oilReminder(care.data, tripDayKey(new Date(), timezone), timezone) : null;
  const complete = care.data && oilPlanCompleted(care.data, timezone);
  return <Card><CardContent className="space-y-3 p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><Droplets className="h-4 w-4 text-primary" />{t('oil.title', 'Mileage & oil change')}</h3>
      <Button variant="ghost" size="sm" disabled={!care.data || care.isError} onClick={edit}><Pencil className="mr-2 h-3.5 w-3.5" />{t('oil.edit', 'Edit')}</Button></div>
    {care.isPending && <p role="status" className="text-sm text-muted-foreground">{t('common.loading', 'Loading…')}</p>}
    {care.isError && <div role="alert" className="space-y-2"><p className="text-sm">{t('oil.failedLoad', 'Could not load mileage and reminders.')}</p><Button variant="outline" size="sm" onClick={() => void care.refetch()}>{t('common.retry', 'Try again')}</Button></div>}
    {care.data && <>
      <p className="text-sm">{care.data.state.odometerKm === null ? t('oil.noMileage', 'Add the mileage currently shown on the car’s odometer.') : t('oil.registeredMileage', 'Recorded mileage: {{value}} {{unit}}', { value: number(care.data.state.odometerKm), unit: distanceUnit })}</p>
      {care.data.state.odometerAt && <p className="text-xs text-muted-foreground">{t('oil.asOf', 'Entered on {{date}}', { date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'short', timeZone: timezone }).format(new Date(care.data.state.odometerAt)) })}</p>}
      <p className="text-xs text-muted-foreground">{t('oil.manual', 'Mileage is entered by you. Update it to keep distance reminders accurate.')}</p>
      {care.data.lastOil && <p className="text-sm">{t('oil.last', 'Last oil change')}: {dateLabel(care.data.lastOil.performed_at)}{care.data.lastOil.odometer_km !== null && ` · ${number(care.data.lastOil.odometer_km)} ${distanceUnit}`}</p>}
      {complete ? <p className="text-sm">{t('oil.setNext', 'Oil change recorded. Update the next reminder after each service.')}</p> : <>
        {care.data.state.oilDueKm !== null && <p className="text-sm">{t('oil.nextAt', 'Next oil change at {{value}} {{unit}}', { value: number(care.data.state.oilDueKm), unit: distanceUnit })}</p>}
        {care.data.state.oilDueDate && <p className="text-sm">{t('oil.nextDate', 'Due by {{date}} (or the mileage limit, if set)', { date: dateLabel(care.data.state.oilDueDate) })}</p>}
        {care.data.state.oilDueKm === null && !care.data.state.oilDueDate && <p className="text-sm text-muted-foreground">{t('oil.notSet', 'Set the next oil change using the schedule for your car and oil.')}</p>}
        {reminder && <p role="status" className="text-sm font-medium text-warn">{reminder.status === 'due' ? t('oil.due', 'Oil change due') : t('oil.soon', 'Oil change coming up')}</p>}
      </>}
      {!care.data.state.enabled && <p className="text-xs text-muted-foreground">{t('oil.paused', 'Oil reminders are off.')}</p>}
    </>}
    <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}><DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>{t('oil.title', 'Mileage & oil change')}</DialogTitle><DialogDescription>{t('oil.schedule', 'Use your service schedule. These reminders appear in the app’s notification bell.')}</DialogDescription></DialogHeader>
      <form onSubmit={(event) => void save(event)} className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1.5"><Label htmlFor="oil-odo">{t('oil.current', 'Current odometer')} ({distanceUnit})</Label><Input id="oil-odo" type="number" min="0" step="any" inputMode="decimal" value={draft.odometer} disabled={saving} onChange={e => setDraft(d => ({ ...d, odometer: e.target.value }))} /></div>
        <div className="col-span-2 space-y-1.5"><Label htmlFor="oil-due">{t('oil.nextMileage', 'Next oil change: odometer')} ({distanceUnit})</Label><Input id="oil-due" type="number" min="0" step="any" inputMode="decimal" value={draft.due} disabled={saving} onChange={e => setDraft(d => ({ ...d, due: e.target.value }))} /></div>
        <div className="col-span-2 space-y-1.5"><Label htmlFor="oil-date">{t('oil.date', 'Due date (optional)')}</Label><Input id="oil-date" type="date" value={draft.date} disabled={saving} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))} /></div>
        <div className="space-y-1.5"><Label htmlFor="oil-before">{t('oil.before', 'Distance before due')} ({distanceUnit})</Label><Input id="oil-before" type="number" min="0" step="any" value={draft.before} disabled={saving} onChange={e => setDraft(d => ({ ...d, before: e.target.value }))} /></div>
        <div className="space-y-1.5"><Label htmlFor="oil-days">{t('oil.days', 'Days before due')}</Label><Input id="oil-days" type="number" min="0" max="365" step="1" value={draft.days} disabled={saving} onChange={e => setDraft(d => ({ ...d, days: e.target.value }))} /></div>
        <label className="col-span-2 flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} />{t('oil.enable', 'Remind me in the app')}</label>
        <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
        <Button type="submit" disabled={saving || !dirty}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('common.save', 'Save')}</Button>
      </form>
    </DialogContent></Dialog>
  </CardContent></Card>;
}
