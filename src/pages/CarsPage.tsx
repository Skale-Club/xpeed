import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCarsContext } from '@/contexts/CarsContext';
import type { CarProfile, EngineType } from '@/lib/db';
import { FuelTypePicker } from '@/components/FuelTypePicker';
import { PageLoader } from '@/components/PageLoader';
import { Car, Plus, Trash2, Edit2, Check, X, Loader2 } from 'lucide-react';
import { AddVehicleForm } from '@/components/AddVehicleForm';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

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
  const [editingCar, setEditingCar] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);

  // Edit form state
  const [editYear, setEditYear] = useState('');
  const [editMake, setEditMake] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editTrim, setEditTrim] = useState('');
  const [editVin, setEditVin] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editEngine, setEditEngine] = useState<EngineType | null>(null);
  const { t } = useTranslation();

  const handleUpdateCar = async (id: string) => {
    const trimmedMake = editMake.trim();
    const trimmedModel = editModel.trim();
    if (!trimmedMake || !trimmedModel) {
      toast({ title: t('vehicle.missingEdit', 'Fill in brand and model.'), variant: 'destructive' });
      return;
    }
    const yearNum = editYear ? parseInt(editYear, 10) : undefined;
    if (editYear && (isNaN(yearNum!) || yearNum! < 1900 || yearNum! > 2100)) {
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
      await updateCar(id, {
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

  const handleDeleteCar = async (id: string) => {
    setIsDeleting(id);
    try {
      await deleteCar(id);
      toast({ title: t('vehicle.deleted', 'Car removed') });
    } catch (error) {
      console.error(error);
      toast({ title: t('vehicle.deleteFailed', "Couldn't remove the car"), variant: 'destructive' });
    } finally {
      setIsDeleting(null);
    }
  };

  const startEditing = (car: CarProfile) => {
    setEditingCar(car.id);
    setEditYear(car.year?.toString() ?? '');
    setEditMake(car.make ?? '');
    setEditModel(car.model ?? '');
    setEditTrim(car.trim ?? '');
    setEditVin(car.vin ?? '');
    setEditNotes(car.notes ?? '');
    setEditEngine((car as CarProfile & { engine_type?: EngineType | null }).engine_type ?? null);
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-mono font-bold text-foreground">{t('vehicle.myCars', 'My cars')}</h2>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="font-mono text-xs">
                <Plus className="w-3.5 h-3.5 mr-2" />
                {t('vehicle.add', 'Add car')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('sidebar.addCar', 'Add a car')}</DialogTitle>
                <DialogDescription>
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
              <h3 className="text-sm font-mono font-semibold text-foreground mb-2">{t('vehicle.none', 'No cars yet')}</h3>
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cars.map((car) => {
              const headline = buildHeadline(car);
              const isEditing = editingCar === car.id;
              return (
                <Card
                  key={car.id}
                  className={`group bg-card border-border cursor-pointer transition-all ${
                    selectedCarId === car.id ? 'ring-2 ring-primary' : 'hover:border-primary/50'
                  }`}
                  onClick={() => !isEditing && selectCar(car.id)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <Car className="w-5 h-5 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <div className="grid grid-cols-2 gap-1.5">
                              <Input
                                value={editYear}
                                onChange={(e) => setEditYear(e.target.value)}
                                className="h-7 text-xs col-span-1"
                                placeholder={t('vehicle.year', 'Year')}
                                type="number"
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Input
                                value={editMake}
                                onChange={(e) => setEditMake(e.target.value)}
                                className="h-7 text-xs col-span-1"
                                placeholder={`${t('vehicle.make', 'Brand')} *`}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Input
                                value={editModel}
                                onChange={(e) => setEditModel(e.target.value)}
                                className="h-7 text-xs col-span-2"
                                placeholder={`${t('vehicle.model', 'Model')} *`}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Input
                                value={editTrim}
                                onChange={(e) => setEditTrim(e.target.value)}
                                className="h-7 text-xs col-span-1"
                                placeholder={t('vehicle.trim', 'Version')}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Input
                                value={editVin}
                                onChange={(e) => setEditVin(e.target.value.toUpperCase())}
                                className="h-7 text-xs col-span-1"
                                placeholder={t('vehicle.vinShort', 'Chassis')}
                                maxLength={17}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Input
                                value={editNotes}
                                onChange={(e) => setEditNotes(e.target.value)}
                                className="h-7 text-xs col-span-2"
                                placeholder={t('vehicle.notes', 'Notes')}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <div className="col-span-2" onClick={(e) => e.stopPropagation()}>
                                <FuelTypePicker value={editEngine} onChange={setEditEngine} />
                              </div>
                            </div>
                          ) : (
                            <>
                              <CardTitle className="text-sm font-mono truncate">{headline}</CardTitle>
                              {car.trim && (
                                <p className="text-xs text-muted-foreground mt-0.5">{car.trim}</p>
                              )}
                              {car.vin && (
                                <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
                                  {t('vehicle.vinShort', 'Chassis')} {car.vin}
                                </p>
                              )}
                              {(car as CarProfile & { engine_type?: EngineType | null }).engine_type && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {t(`vehicle.fuelType.${(car as CarProfile & { engine_type?: EngineType | null }).engine_type}`)}
                                </p>
                              )}
                              {car.notes && (
                                <p className="text-xs text-muted-foreground line-clamp-1 mt-1">{car.notes}</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {isEditing ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUpdateCar(car.id);
                              }}
                              disabled={isUpdating}
                            >
                              {isUpdating ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Check className="w-3.5 h-3.5 text-success" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingCar(null);
                              }}
                            >
                              <X className="w-3.5 h-3.5 text-destructive" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              aria-label={t('vehicle.edit', 'Edit')}
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditing(car);
                              }}
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                  aria-label={t('vehicle.delete', 'Remove')}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>{t('vehicle.deleteTitle', 'Remove this car?')}</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t('vehicle.deleteBody', '"{{name}}" and all its trips and problems will be deleted.', { name: headline })}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => handleDeleteCar(car.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    disabled={isDeleting === car.id}
                                  >
                                    {isDeleting === car.id && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                                    {t('vehicle.delete', 'Remove')}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {selectedCarId === car.id && !isEditing && (
                      <div className="flex items-center gap-2 text-xs text-primary font-medium">
                        <Check className="w-3.5 h-3.5" />
                        {t('vehicle.selected', 'Selected')}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
