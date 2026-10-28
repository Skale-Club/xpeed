import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FuelTypePicker } from '@/components/FuelTypePicker';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import type { EngineType } from '@/lib/db';
import { decodeVin } from '@/lib/vin-decoder';

interface AddVehicleFormProps {
  onSuccess: (carId: string) => void;
  onCancel: () => void;
}

export function AddVehicleForm({ onSuccess, onCancel }: AddVehicleFormProps) {
  const { t } = useTranslation();
  const { createCar } = useCarsContext();
  const { toast } = useToast();

  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [trim, setTrim] = useState('');
  const [vin, setVin] = useState('');
  const [notes, setNotes] = useState('');
  const [engineType, setEngineType] = useState<EngineType | null>(null);
  const [creating, setCreating] = useState(false);
  const [decoding, setDecoding] = useState(false);

  const handleDecodeVin = async () => {
    if (vin.trim().length !== 17) {
      toast({ title: t('vehicle.vinInvalid', 'The chassis number (VIN) has 17 characters.'), variant: 'destructive' });
      return;
    }
    setDecoding(true);
    try {
      const decoded = await decodeVin(vin.trim());
      if (!decoded) {
        toast({ title: t('vehicle.vinNoData', "Couldn't find this car by its chassis number — fill it in by hand."), variant: 'destructive' });
        return;
      }
      if (decoded.year) setYear(String(decoded.year));
      if (decoded.make) setMake(decoded.make);
      if (decoded.model) setModel(decoded.model);
      if (decoded.trim) setTrim(decoded.trim);
      if (decoded.engineType) setEngineType(decoded.engineType);
      toast({ title: t('vehicle.vinFound', 'Found it'), description: `${decoded.year || ''} ${decoded.make || ''} ${decoded.model || ''}`.trim() });
    } catch (err) {
      console.error(err);
      toast({ title: t('vehicle.vinNoData', "Couldn't find this car by its chassis number — fill it in by hand."), variant: 'destructive' });
    } finally {
      setDecoding(false);
    }
  };

  const handleSubmit = async () => {
    const trimmedMake = make.trim();
    const trimmedModel = model.trim();
    const trimmedYear = year.trim();

    if (!trimmedYear || !trimmedMake || !trimmedModel) {
      toast({ title: t('vehicle.missing', 'Fill in year, brand and model.'), variant: 'destructive' });
      return;
    }
    const yearNum = parseInt(trimmedYear, 10);
    if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2100) {
      toast({ title: t('vehicle.badYear', 'Check the year.'), variant: 'destructive' });
      return;
    }
    const trimmedVin = vin.trim();
    if (trimmedVin && trimmedVin.length !== 17) {
      toast({ title: t('vehicle.vinInvalid', 'The chassis number (VIN) has 17 characters.'), variant: 'destructive' });
      return;
    }

    setCreating(true);
    try {
      const car = await createCar({
        year: yearNum,
        make: trimmedMake,
        model: trimmedModel,
        trim: trim.trim() || null,
        vin: trimmedVin || null,
        notes: notes.trim() || null,
        engine_type: engineType,
      });
      toast({ title: t('vehicle.added', 'Car added'), description: car.name });
      onSuccess(car.id);
    } catch (error) {
      console.error(error);
      toast({ title: t('vehicle.addFailed', "Couldn't add the car. Try again."), variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="av-year">{t('vehicle.year', 'Year')} *</Label>
          <Input id="av-year" type="number" min={1900} max={2100} placeholder="2020" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="av-make">{t('vehicle.make', 'Brand')} *</Label>
          <Input id="av-make" placeholder="Toyota" value={make} onChange={(e) => setMake(e.target.value)} />
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label htmlFor="av-model">{t('vehicle.model', 'Model')} *</Label>
          <Input id="av-model" placeholder="Corolla" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label>{t('vehicle.fuel', 'Fuel')}</Label>
          <FuelTypePicker value={engineType} onChange={setEngineType} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="av-trim">{t('vehicle.trim', 'Version')}</Label>
          <Input id="av-trim" placeholder="XEi" value={trim} onChange={(e) => setTrim(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="av-vin">{t('vehicle.vin', 'Chassis number (optional)')}</Label>
          <div className="flex gap-1">
            <Input
              id="av-vin"
              placeholder={t('vehicle.vinPlaceholder', '17 characters')}
              maxLength={17}
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase())}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              title={t('vehicle.vinFill', 'Fill in from the chassis number')}
              aria-label={t('vehicle.vinFill', 'Fill in from the chassis number')}
              onClick={handleDecodeVin}
              disabled={decoding || vin.trim().length !== 17}
              className="px-2 shrink-0"
            >
              {decoding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label htmlFor="av-notes">{t('vehicle.notes', 'Notes')}</Label>
          <Input id="av-notes" placeholder={t('vehicle.notesPlaceholder', 'e.g. bought in 2023 with 42,000 km')} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} disabled={creating}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button onClick={handleSubmit} disabled={creating}>
          {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {t('vehicle.add', 'Add car')}
        </Button>
      </div>
    </div>
  );
}
