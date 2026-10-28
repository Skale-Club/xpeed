import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import {
  listMaintenanceEvents, createMaintenanceEvent, deleteMaintenanceEvent,
  type MaintenanceEvent, type MaintenanceType,
} from '@/lib/db-extras';
import { Wrench, Plus, Trash2, Loader2 } from 'lucide-react';

// English defaults; translations live under maint.types.<type>.
const TYPE_LABELS: Record<MaintenanceType, string> = {
  oil_change: 'Oil change',
  coolant_flush: 'Coolant (radiator fluid) change',
  brake_pads_front: 'Front brake pads',
  brake_pads_rear: 'Rear brake pads',
  brake_fluid: 'Brake fluid',
  transmission_fluid: 'Gearbox oil',
  air_filter: 'Engine air filter',
  cabin_filter: 'Cabin (A/C) air filter',
  spark_plugs: 'Spark plugs',
  battery_12v: 'Car battery (12V)',
  battery_hv: 'Hybrid / electric battery',
  tires: 'New tires',
  tire_rotation: 'Tire rotation',
  wheel_alignment: 'Wheel alignment',
  timing_belt: 'Timing belt',
  serpentine_belt: 'Accessory (fan) belt',
  inspection: 'General check-up',
  other: 'Other',
};

const TYPE_ORDER: MaintenanceType[] = [
  'oil_change', 'tire_rotation', 'air_filter', 'cabin_filter',
  'coolant_flush', 'brake_fluid', 'brake_pads_front', 'brake_pads_rear',
  'transmission_fluid', 'spark_plugs', 'battery_12v', 'battery_hv',
  'tires', 'wheel_alignment', 'timing_belt', 'serpentine_belt',
  'inspection', 'other',
];

// Costs are shown in the currency of the app language; how they are stored is unchanged.
const CURRENCY_BY_LANGUAGE: Record<string, string> = {
  en: 'USD',
  'pt-BR': 'BRL',
  'es-ES': 'EUR',
};

export default function MaintenancePage() {
  const { t, i18n } = useTranslation();
  const { selectedCar, selectedCarId } = useCarsContext();
  const { toast } = useToast();
  const [events, setEvents] = useState<MaintenanceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Add form state
  const [type, setType] = useState<MaintenanceType>('oil_change');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [odometer, setOdometer] = useState('');
  const [cost, setCost] = useState('');
  const [shop, setShop] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const language = i18n.resolvedLanguage || 'en';
  const typeLabel = (value: MaintenanceType) => t(`maint.types.${value}`, TYPE_LABELS[value]);
  const formatMoney = (value: number) =>
    new Intl.NumberFormat(language, { style: 'currency', currency: CURRENCY_BY_LANGUAGE[language] ?? 'USD' }).format(value);
  // Service dates are stored as "YYYY-MM-DD"; parsing that as UTC shows the
  // previous day west of Greenwich (e.g. Brazil), so read it as a local date.
  const formatDate = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
    return date.toLocaleDateString(language);
  };
  const formatKm = (km: number) => new Intl.NumberFormat(language).format(km);

  const load = useCallback(async () => {
    if (!selectedCarId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await listMaintenanceEvents(selectedCarId);
      setEvents(data);
    } catch (err) {
      console.error(err);
      toast({ title: t('maint.loadFailed', "Couldn't load the service history"), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [selectedCarId, t, toast]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!selectedCarId) return;
    setSaving(true);
    try {
      const ev = await createMaintenanceEvent({
        car_profile_id: selectedCarId,
        event_type: type,
        performed_at: date,
        odometer_km: odometer ? parseInt(odometer, 10) : null,
        cost: cost ? parseFloat(cost) : null,
        currency: cost ? 'USD' : null,
        shop: shop.trim() || null,
        notes: notes.trim() || null,
      });
      setEvents(prev => [ev, ...prev]);
      toast({ title: t('maint.added', 'Service saved') });
      setIsAddOpen(false);
      setType('oil_change');
      setDate(new Date().toISOString().slice(0, 10));
      setOdometer(''); setCost(''); setShop(''); setNotes('');
    } catch (err) {
      console.error(err);
      toast({
        title: t('maint.saveFailed', "Couldn't save the service"),
        description: t('maint.tryAgain', 'Please check your connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMaintenanceEvent(id);
      setEvents(prev => prev.filter(e => e.id !== id));
    } catch (err) {
      console.error(err);
      toast({
        title: t('maint.deleteFailed', "Couldn't delete the service"),
        description: t('maint.tryAgain', 'Please check your connection and try again.'),
        variant: 'destructive',
      });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <Wrench className="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h2 className="text-lg font-mono font-bold text-foreground">{t('maint.title', 'Service history')}</h2>
              {selectedCar && <p className="text-sm text-muted-foreground truncate">{selectedCar.name}</p>}
            </div>
          </div>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" disabled={!selectedCarId}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                {t('maint.addButton', 'Add a service')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('maint.dialogTitle', 'Record a service')}</DialogTitle>
                <DialogDescription>
                  {t('maint.dialogDescription', 'Writing down what was done to your car helps the assistant give better advice and remind you when something is due.')}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 py-4">
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="m-type">{t('maint.typeLabel', 'What was done *')}</Label>
                  <Select value={type} onValueChange={(v) => setType(v as MaintenanceType)}>
                    <SelectTrigger id="m-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_ORDER.map(value => (
                        <SelectItem key={value} value={value}>{typeLabel(value)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-date">{t('maint.dateLabel', 'Date *')}</Label>
                  <Input id="m-date" type="date" value={date} onChange={e => setDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-odo">{t('maint.mileageLabel', 'Mileage (km)')}</Label>
                  <Input id="m-odo" type="number" placeholder="120000" value={odometer} onChange={e => setOdometer(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-cost">{t('maint.costLabel', 'Cost')}</Label>
                  <Input id="m-cost" type="number" placeholder="80" value={cost} onChange={e => setCost(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-shop">{t('maint.workshopLabel', 'Workshop')}</Label>
                  <Input id="m-shop" placeholder={t('maint.optional', 'Optional')} value={shop} onChange={e => setShop(e.target.value)} />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="m-notes">{t('maint.notesLabel', 'Notes')}</Label>
                  <Input id="m-notes" placeholder={t('maint.notesPlaceholder', 'e.g. used 5W-30 synthetic oil')} value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
                <Button onClick={handleAdd} disabled={saving}>
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {t('common.save', 'Save')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {!selectedCarId ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {t('maint.noCar', 'Choose a car in the menu to see its service history.')}
            </CardContent>
          </Card>
        ) : loading ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 text-center">
              <Loader2 className="w-5 h-5 text-primary animate-spin mx-auto" />
            </CardContent>
          </Card>
        ) : events.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <Wrench className="w-12 h-12 text-primary/30 mx-auto mb-4" />
              <h3 className="text-sm font-mono font-semibold text-foreground mb-2">{t('maint.emptyTitle', 'No services recorded yet')}</h3>
              <p className="text-xs text-muted-foreground mb-4">
                {t('maint.emptyBody', "Write down what's been done (oil changes, brake pads, tire rotations) so we can give you better advice.")}
              </p>
              <Button size="sm" onClick={() => setIsAddOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                {t('maint.addFirst', 'Add your first service')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {events.map(ev => (
              <Card key={ev.id} className="bg-card border-border">
                <CardContent className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-mono font-semibold text-foreground">{typeLabel(ev.event_type)}</span>
                      <span className="text-xs text-muted-foreground font-mono">{formatDate(ev.performed_at)}</span>
                      {ev.odometer_km != null && (
                        <span className="text-xs text-muted-foreground font-mono">{t('maint.kmValue', '{{km}} km', { km: formatKm(ev.odometer_km) })}</span>
                      )}
                      {ev.cost != null && (
                        <span className="text-xs text-muted-foreground font-mono">{formatMoney(ev.cost)}</span>
                      )}
                      {ev.shop && (
                        <span className="text-xs text-muted-foreground">{t('maint.atWorkshop', 'Workshop: {{name}}', { name: ev.shop })}</span>
                      )}
                    </div>
                    {ev.notes && (
                      <p className="text-xs text-muted-foreground mt-1">{ev.notes}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(ev.id)}
                    aria-label={t('maint.deleteAria', 'Delete this service')}
                    title={t('maint.deleteAria', 'Delete this service')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
