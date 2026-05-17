import { useEffect, useState, useCallback } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const TYPE_LABELS: Record<MaintenanceType, string> = {
  oil_change: 'Oil change',
  coolant_flush: 'Coolant flush',
  brake_pads_front: 'Front brake pads',
  brake_pads_rear: 'Rear brake pads',
  brake_fluid: 'Brake fluid',
  transmission_fluid: 'Transmission fluid',
  air_filter: 'Air filter',
  cabin_filter: 'Cabin filter',
  spark_plugs: 'Spark plugs',
  battery_12v: '12V battery',
  battery_hv: 'HV battery',
  tires: 'Tires',
  tire_rotation: 'Tire rotation',
  wheel_alignment: 'Wheel alignment',
  timing_belt: 'Timing belt',
  serpentine_belt: 'Serpentine / accessory belt',
  inspection: 'Inspection',
  other: 'Other',
};

const TYPE_ORDER: MaintenanceType[] = [
  'oil_change', 'tire_rotation', 'air_filter', 'cabin_filter',
  'coolant_flush', 'brake_fluid', 'brake_pads_front', 'brake_pads_rear',
  'transmission_fluid', 'spark_plugs', 'battery_12v', 'battery_hv',
  'tires', 'wheel_alignment', 'timing_belt', 'serpentine_belt',
  'inspection', 'other',
];

export default function MaintenancePage() {
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
      toast({ title: 'Error', description: 'Failed to load maintenance events', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [selectedCarId, toast]);

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
      toast({ title: 'Service event added' });
      setIsAddOpen(false);
      setType('oil_change');
      setDate(new Date().toISOString().slice(0, 10));
      setOdometer(''); setCost(''); setShop(''); setNotes('');
    } catch (err) {
      toast({ title: 'Error', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMaintenanceEvent(id);
      setEvents(prev => prev.filter(e => e.id !== id));
    } catch (err) {
      toast({ title: 'Error', description: String(err), variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-mono font-bold text-foreground">
              Maintenance Log {selectedCar && <span className="text-muted-foreground font-normal">— {selectedCar.name}</span>}
            </h2>
          </div>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" disabled={!selectedCarId}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                Add Service Event
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Record a service event</DialogTitle>
                <DialogDescription>
                  Service history feeds the AI assistant and powers due-soon reminders.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 py-4">
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="m-type">Service type *</Label>
                  <Select value={type} onValueChange={(v) => setType(v as MaintenanceType)}>
                    <SelectTrigger id="m-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_ORDER.map(t => (
                        <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-date">Date *</Label>
                  <Input id="m-date" type="date" value={date} onChange={e => setDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-odo">Odometer (km)</Label>
                  <Input id="m-odo" type="number" placeholder="120000" value={odometer} onChange={e => setOdometer(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-cost">Cost</Label>
                  <Input id="m-cost" type="number" placeholder="80.00" value={cost} onChange={e => setCost(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="m-shop">Shop</Label>
                  <Input id="m-shop" placeholder="Optional" value={shop} onChange={e => setShop(e.target.value)} />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="m-notes">Notes</Label>
                  <Input id="m-notes" placeholder="e.g. used 5W-30 synthetic" value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                <Button onClick={handleAdd} disabled={saving}>
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {!selectedCarId ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Select a vehicle to view its maintenance history.
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
              <h3 className="text-sm font-mono font-semibold text-foreground mb-2">No service history yet</h3>
              <p className="text-xs text-muted-foreground mb-4">
                Record what you've done — oil changes, brake pads, tire rotations — to power smarter insights.
              </p>
              <Button size="sm" onClick={() => setIsAddOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                Add First Service
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
                      <span className="text-sm font-mono font-semibold text-foreground">{TYPE_LABELS[ev.event_type]}</span>
                      <span className="text-xs text-muted-foreground font-mono">{new Date(ev.performed_at).toLocaleDateString()}</span>
                      {ev.odometer_km != null && (
                        <span className="text-xs text-muted-foreground font-mono">{ev.odometer_km.toLocaleString()} km</span>
                      )}
                      {ev.cost != null && (
                        <span className="text-xs text-muted-foreground font-mono">${ev.cost.toFixed(2)}</span>
                      )}
                      {ev.shop && (
                        <span className="text-xs text-muted-foreground">@ {ev.shop}</span>
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
