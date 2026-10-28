import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCarsContext } from '@/contexts/CarsContext';
import type { CarProfile, EngineType } from '@/lib/db';
import { FuelTypePicker } from '@/components/FuelTypePicker';
import { PageLoader } from '@/components/PageLoader';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Car, Plus, Trash2, Edit2, Check, Loader2 } from 'lucide-react';
import { AddVehicleForm } from '@/components/AddVehicleForm';
import { useToast } from '@/hooks/use-toast';
import { isValidCarYear } from '@/lib/car-year';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type CarWithEngine = CarProfile & { engine_type?: EngineType | null };

function buildHeadline(car: CarProfile): string {
  if (car.year && car.make && car.model) {
    return `${car.year} ${car.make} ${car.model}`;
  }
  if (car.make && car.model) {
    return `${car.make} ${car.model}`;
  }
  return car.name;
}

export default function CarsPage() {
  const { cars, selectedCarId, selectCar, updateCar, deleteCar, loading } = useCarsContext();
  const { toast } = useToast();

  // Dialog + per-card state
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingCar, setEditingCar] = useState<CarProfile | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [deletingCar, setDeletingCar] = useState<CarProfile | null>(null);

  // Edit form state
  const [editYear, setEditYear] = useState('');
  const [editMake, setEditMake] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editTrim, setEditTrim] = useState('');
  const [editVin, setEditVin] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editEngine, setEditEngine] = useState<EngineType | null>(null);
  const { t } = useTranslation();

  const handleUpdateCar = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!editingCar) return;
    const trimmedMake = editMake.trim();
    const trimmedModel = editModel.trim();
    if (!trimmedMake || !trimmedModel) {
      toast({ title: t('vehicle.missingEdit', 'Fill in brand and model.'), variant: 'destructive' });
      return;
    }
    const yearNum = editYear ? parseInt(editYear, 10) : undefined;
    if (yearNum !== undefined && !isValidCarYear(yearNum)) {
      toast({ title: t('vehicle.badYear', 'Check the year.'), variant: 'destructive' });
      return;
    }
    const trimmedVin = editVin.trim();
    if (trimmedVin && trimmedVin.length !== 17) {
      toast({ title: t('vehicle.vinInvalid', 'The chassis number (VIN) has 17 characters.'), variant: 'destructive' });
      return;
    }

    setIsUpdating(true);
    try {
      const name = yearNum
        ? `${yearNum} ${trimmedMake} ${trimmedModel}`
        : `${trimmedMake} ${trimmedModel}`;
      await updateCar(editingCar.id, {
        name,
        year: yearNum ?? null,
        make: trimmedMake,
        model: trimmedModel,
        trim: editTrim.trim() || null,
        vin: trimmedVin || null,
        notes: editNotes.trim() || null,
        engine_type: editEngine,
      });
      toast({ title: t('vehicle.saved', 'Car updated') });
      setEditingCar(null);
    } catch (error) {
      console.error(error);
      toast({ title: t('vehicle.saveFailed', "Couldn't save the changes"), variant: 'destructive' });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteCar = async (car: CarProfile) => {
    try {
      await deleteCar(car.id);
      toast({ title: t('vehicle.deleted', 'Car removed') });
    } catch (error) {
      console.error(error);
      toast({ title: t('vehicle.deleteFailed', "Couldn't remove the car"), variant: 'destructive' });
    }
  };

  const startEditing = (car: CarProfile) => {
    setEditingCar(car);
    setEditYear(car.year?.toString() ?? '');
    setEditMake(car.make ?? '');
    setEditModel(car.model ?? '');
    setEditTrim(car.trim ?? '');
    setEditVin(car.vin ?? '');
    setEditNotes(car.notes ?? '');
    setEditEngine((car as CarWithEngine).engine_type ?? null);
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-bold text-foreground">{t('vehicle.myCars', 'My cars')}</h2>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-3.5 h-3.5 mr-2" />
                {t('vehicle.add', 'Add car')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('sidebar.addCar', 'Add a car')}</DialogTitle>
                <DialogDescription className="sr-only">
                  {t('sidebar.addCarHint', 'Each car keeps its own trips and problems.')}
                </DialogDescription>
              </DialogHeader>
              <AddVehicleForm
                onSuccess={() => setIsAddDialogOpen(false)}
                onCancel={() => setIsAddDialogOpen(false)}
              />
            </DialogContent>
          </Dialog>
        </div>

        {loading ? (
          <PageLoader fullScreen={false} className="py-12" />
        ) : cars.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <Car className="w-12 h-12 text-primary/30 mx-auto mb-4" />
              <h3 className="text-sm font-semibold text-foreground mb-2">{t('vehicle.none', 'No cars yet')}</h3>
              <p className="text-xs text-muted-foreground mb-4">
                {t('vehicle.noneHint', 'Add your car to start checking it.')}
              </p>
              <Button size="sm" onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                {t('vehicle.add', 'Add car')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cars.map((car) => {
              const headline = buildHeadline(car);
              const selected = selectedCarId === car.id;
              const engine = (car as CarWithEngine).engine_type;
              return (
                <li key={car.id}>
                  <Card className={`bg-card border-border transition-all ${selected ? 'ring-2 ring-primary' : 'hover:border-primary/50'}`}>
                    <CardContent className="flex items-start gap-1 p-4">
                      {/* Choosing the car is a real button: keyboard, screen reader and touch all work. */}
                      <button
                        type="button"
                        onClick={() => selectCar(car.id)}
                        aria-pressed={selected}
                        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <Car className="w-5 h-5 text-primary" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{headline}</span>
                          {car.trim && <span className="mt-0.5 block text-xs text-muted-foreground">{car.trim}</span>}
                          {car.vin && (
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                              {t('vehicle.vinShort', 'Chassis')} {car.vin}
                            </span>
                          )}
                          {engine && <span className="mt-0.5 block text-xs text-muted-foreground">{t(`vehicle.fuelType.${engine}`)}</span>}
                          {car.notes && <span className="mt-1 line-clamp-1 block text-xs text-muted-foreground">{car.notes}</span>}
                          {selected && (
                            <span className="mt-2 flex items-center gap-1.5 text-xs font-medium text-primary">
                              <Check className="w-3.5 h-3.5" />
                              {t('vehicle.selected', 'Selected')}
                            </span>
                          )}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center">
                        <Button size="icon" variant="ghost" aria-label={t('vehicle.edit', 'Edit')} onClick={() => startEditing(car)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          aria-label={t('vehicle.delete', 'Remove')}
                          onClick={() => setDeletingCar(car)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Editing a car: a labelled form in a dialog, not cramped fields inside the card */}
      <Dialog open={!!editingCar} onOpenChange={(open) => { if (!open && !isUpdating) setEditingCar(null); }}>
        <DialogContent>
          <form onSubmit={(e) => void handleUpdateCar(e)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t('vehicle.editTitle', 'Edit your car')}</DialogTitle>
              <DialogDescription className="sr-only">{t('sidebar.addCarHint', 'Each car keeps its own trips and problems.')}</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="car-year">{t('vehicle.year', 'Year')}</Label>
                <Input id="car-year" type="number" inputMode="numeric" value={editYear} onChange={(e) => setEditYear(e.target.value)} placeholder="2020" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="car-make">{t('vehicle.make', 'Brand')} *</Label>
                <Input id="car-make" value={editMake} onChange={(e) => setEditMake(e.target.value)} required />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="car-model">{t('vehicle.model', 'Model')} *</Label>
                <Input id="car-model" value={editModel} onChange={(e) => setEditModel(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="car-trim">{t('vehicle.trim', 'Version')}</Label>
                <Input id="car-trim" value={editTrim} onChange={(e) => setEditTrim(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="car-vin">{t('vehicle.vinShort', 'Chassis')}</Label>
                <Input id="car-vin" value={editVin} maxLength={17} onChange={(e) => setEditVin(e.target.value.toUpperCase())} placeholder={t('vehicle.vinPlaceholder', '17 characters')} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="car-notes">{t('vehicle.notes', 'Notes')}</Label>
                <Input id="car-notes" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>{t('vehicle.fuel', 'Fuel')}</Label>
                <FuelTypePicker value={editEngine} onChange={setEditEngine} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingCar(null)} disabled={isUpdating}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={isUpdating}>
                {isUpdating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('common.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deletingCar}
        onOpenChange={(open) => { if (!open) setDeletingCar(null); }}
        title={t('vehicle.deleteTitle', 'Remove this car?')}
        description={deletingCar ? t('vehicle.deleteBody', '"{{name}}" and all its trips and problems will be deleted.', { name: buildHeadline(deletingCar) }) : undefined}
        confirmLabel={t('vehicle.delete', 'Remove')}
        onConfirm={() => { if (deletingCar) void handleDeleteCar(deletingCar); setDeletingCar(null); }}
      />
    </AppLayout>
  );
}
