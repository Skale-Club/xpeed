import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CarSilhouette } from '@/components/car/CarSilhouette';
import { guessBodyType } from '@/lib/car-look';
import { useObd } from '@/contexts/ObdScannerContext';

/**
 * The adapter is plugged into a car that isn't in "My cars": offer to add it,
 * already filled in from its VIN. Brand or model are asked only when the VIN
 * didn't tell them (VIN databases are thinner outside the US).
 */
export function NewCarDialog() {
  const { t } = useTranslation();
  const { newCarFound: found, addFoundCar, dismissFoundCar } = useObd();
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMake(found?.make ?? '');
    setModel(found?.model ?? '');
    setFailed(false);
  }, [found]);

  if (!found) return null;
  const known = [found.year, found.make, found.model].filter(Boolean).join(' ');
  const ready = make.trim() !== '' && model.trim() !== '' && !!found.year;

  const add = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await addFoundCar({ make, model });
    } catch (err) {
      console.error(err);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && dismissFoundCar()}>
      <DialogContent className="max-w-md" data-testid="new-car-dialog">
        <DialogHeader className="space-y-3 text-center sm:text-center">
          {/* The kind of car the chassis number says it is (colour unknown yet: neutral grey). */}
          <CarSilhouette bodyType={found.bodyType ?? guessBodyType(found.model) ?? 'sedan'} className="mx-auto max-w-[200px]" />
          <DialogTitle>{t('vin.newTitle', 'New car connected')}</DialogTitle>
          <DialogDescription>
            {known
              ? t('vin.newBody', 'The adapter is in a {{car}} that is not in your cars yet. Add it so its trips and problems stay separate?', { car: known })
              : t('vin.newBodyUnknown', 'The adapter is in a car that is not in your cars yet. Add it so its trips and problems stay separate?')}
          </DialogDescription>
        </DialogHeader>

        {(!found.make || !found.model) && (
          <div className="grid grid-cols-2 gap-3">
            {!found.make && (
              <div className="space-y-1.5">
                <Label htmlFor="vin-make">{t('vehicle.make', 'Brand')}</Label>
                <Input id="vin-make" value={make} onChange={(e) => setMake(e.target.value)} />
              </div>
            )}
            <div className={`space-y-1.5 ${found.make ? 'col-span-2' : ''}`}>
              <Label htmlFor="vin-model">{t('vehicle.model', 'Model')}</Label>
              <Input id="vin-model" value={model} onChange={(e) => setModel(e.target.value)} autoFocus />
            </div>
          </div>
        )}
        <p className="text-center font-mono text-xs text-muted-foreground">
          {t('vehicle.vinShort', 'Chassis')} {found.vin}
        </p>
        {!found.year && <p className="text-sm text-muted-foreground">{t('vin.noYear', "We couldn't tell the year from this VIN. Add the car in My cars instead.")}</p>}
        {failed && <p className="text-sm text-destructive">{t('vehicle.addFailed', "Couldn't add the car. Try again.")}</p>}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={dismissFoundCar} disabled={saving}>{t('vin.notNow', 'Not now')}</Button>
          <Button onClick={() => void add()} disabled={!ready || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('vehicle.add', 'Add car')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
