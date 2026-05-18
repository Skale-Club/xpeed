import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import { decodeVin } from '@/lib/vin-decoder';

interface AddVehicleFormProps {
  onSuccess: (carId: string) => void;
  onCancel: () => void;
}

export function AddVehicleForm({ onSuccess, onCancel }: AddVehicleFormProps) {
  const { createCar } = useCarsContext();
  const { toast } = useToast();

  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [trim, setTrim] = useState('');
  const [vin, setVin] = useState('');
  const [notes, setNotes] = useState('');
  const [engineType, setEngineType] = useState<'petrol' | 'diesel' | 'hybrid' | 'electric' | null>(null);
  const [creating, setCreating] = useState(false);
  const [decoding, setDecoding] = useState(false);

  const handleDecodeVin = async () => {
    if (vin.trim().length !== 17) {
      toast({ title: 'Invalid VIN', description: 'VIN must be exactly 17 characters.', variant: 'destructive' });
      return;
    }
    setDecoding(true);
    try {
      const decoded = await decodeVin(vin.trim());
      if (!decoded) {
        toast({ title: 'Could not decode', description: 'NHTSA returned no useful data for this VIN.', variant: 'destructive' });
        return;
      }
      if (decoded.year) setYear(String(decoded.year));
      if (decoded.make) setMake(decoded.make);
      if (decoded.model) setModel(decoded.model);
      if (decoded.trim) setTrim(decoded.trim);
      if (decoded.engineType) setEngineType(decoded.engineType);
      toast({ title: 'VIN decoded', description: `${decoded.year || ''} ${decoded.make || ''} ${decoded.model || ''}`.trim() });
    } catch (err) {
      toast({ title: 'Decode error', description: String(err), variant: 'destructive' });
    } finally {
      setDecoding(false);
    }
  };

  const handleSubmit = async () => {
    const trimmedMake = make.trim();
    const trimmedModel = model.trim();
    const trimmedYear = year.trim();

    if (!trimmedYear || !trimmedMake || !trimmedModel) {
      toast({ title: 'Missing fields', description: 'Year, make, and model are required.', variant: 'destructive' });
      return;
    }
    const yearNum = parseInt(trimmedYear, 10);
    if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2100) {
      toast({ title: 'Invalid year', description: 'Enter a year between 1900 and 2100.', variant: 'destructive' });
      return;
    }
    const trimmedVin = vin.trim();
    if (trimmedVin && trimmedVin.length !== 17) {
      toast({ title: 'Invalid VIN', description: 'VIN must be exactly 17 characters (or left blank).', variant: 'destructive' });
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
      toast({ title: 'Vehicle registered', description: car.name });
      onSuccess(car.id);
    } catch (error) {
      toast({
        title: 'Could not register vehicle',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const ENGINE_TYPES = [
    { value: 'petrol', label: 'Petrol' },
    { value: 'diesel', label: 'Diesel' },
    { value: 'hybrid', label: 'Hybrid' },
    { value: 'electric', label: 'Electric' },
  ] as const;

  return (
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="av-year">Year *</Label>
          <Input
            id="av-year"
            type="number"
            min={1900}
            max={2100}
            placeholder="2023"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="av-make">Make *</Label>
          <Input
            id="av-make"
            placeholder="Toyota"
            value={make}
            onChange={(e) => setMake(e.target.value)}
          />
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label htmlFor="av-model">Model *</Label>
          <Input
            id="av-model"
            placeholder="Camry"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="av-trim">Trim</Label>
          <Input
            id="av-trim"
            placeholder="LX"
            value={trim}
            onChange={(e) => setTrim(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="av-vin">VIN</Label>
          <div className="flex gap-1">
            <Input
              id="av-vin"
              placeholder="17 characters"
              maxLength={17}
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase())}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              title="Auto-fill from VIN via NHTSA"
              onClick={handleDecodeVin}
              disabled={decoding || vin.trim().length !== 17}
              className="px-2 shrink-0"
            >
              {decoding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label>Engine Type</Label>
          <div className="flex gap-2 flex-wrap">
            {ENGINE_TYPES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setEngineType(engineType === value ? null : value)}
                className={`px-3 py-1 rounded-full text-xs font-mono border transition-colors ${
                  engineType === value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-transparent text-muted-foreground border-border hover:border-primary/60'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label htmlFor="av-notes">Notes</Label>
          <Input
            id="av-notes"
            placeholder="Purchased Aug 2023, 42k miles..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} disabled={creating}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={creating}>
          {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Add Vehicle
        </Button>
      </div>
    </div>
  );
}
