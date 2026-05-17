import { useState } from 'react';
import { Car, Upload, CheckCircle, ArrowRight, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import UploadCard from '@/components/UploadCard';

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 1 | 2 | 3 | 4;

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { createCar } = useCarsContext();
  const { toast } = useToast();

  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [newCarId, setNewCarId] = useState<string | null>(null);

  // Step 2 form state
  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [trim, setTrim] = useState('');
  const [vin, setVin] = useState('');
  const [notes, setNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const goTo = (step: Step) => setCurrentStep(step);

  const handleCreateCar = async () => {
    const trimmedMake = make.trim();
    const trimmedModel = model.trim();
    const trimmedYear = year.trim();

    if (!trimmedYear || !trimmedMake || !trimmedModel) {
      toast({
        title: 'Missing fields',
        description: 'Year, make, and model are required.',
        variant: 'destructive',
      });
      return;
    }

    const yearNum = parseInt(trimmedYear, 10);
    if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2100) {
      toast({
        title: 'Invalid year',
        description: 'Enter a year between 1900 and 2100.',
        variant: 'destructive',
      });
      return;
    }

    const trimmedVin = vin.trim();
    if (trimmedVin && trimmedVin.length !== 17) {
      toast({
        title: 'Invalid VIN',
        description: 'VIN must be exactly 17 characters (or left blank).',
        variant: 'destructive',
      });
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
      });
      setNewCarId(car.id);
      toast({ title: 'Vehicle registered', description: car.name });
      goTo(3);
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

  const handleUploadDone = () => goTo(4);
  const handleSkipUpload = () => goTo(4);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border-border">
        <CardContent className="pt-8 pb-8 px-8">
          {/* Progress dots */}
          <div className="flex gap-1.5 justify-center mb-3">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`w-2 h-2 rounded-full transition-colors ${
                  s === currentStep ? 'bg-primary' : s < currentStep ? 'bg-primary/60' : 'bg-primary/20'
                }`}
              />
            ))}
          </div>
          <div className="text-xs text-muted-foreground font-mono text-center mb-6">
            Step {currentStep} of 4
          </div>

          {/* Step content (key triggers fade-in remount) */}
          <div key={currentStep} className="transition-opacity duration-300 opacity-100 animate-in fade-in">
            {currentStep === 1 && (
              <div className="text-center space-y-5">
                <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                  <Car className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-mono font-bold text-foreground mb-2">
                    Welcome to Car Insights
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Let&apos;s get you set up. We&apos;ll register your first vehicle and optionally upload your first OBD2 session — takes about a minute.
                  </p>
                </div>
                <Button onClick={() => goTo(2)} className="font-mono text-xs" size="lg">
                  Get Started <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-5">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold text-foreground mb-1">Add Your Car</h2>
                  <p className="text-sm text-muted-foreground">
                    Tell us about the vehicle you&apos;ll be tracking.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="onb-year">Year *</Label>
                    <Input
                      id="onb-year"
                      type="number"
                      min={1900}
                      max={2100}
                      placeholder="2023"
                      value={year}
                      onChange={(e) => setYear(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="onb-make">Make *</Label>
                    <Input
                      id="onb-make"
                      placeholder="Toyota"
                      value={make}
                      onChange={(e) => setMake(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <Label htmlFor="onb-model">Model *</Label>
                    <Input
                      id="onb-model"
                      placeholder="Camry"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="onb-trim">Trim</Label>
                    <Input
                      id="onb-trim"
                      placeholder="LX"
                      value={trim}
                      onChange={(e) => setTrim(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="onb-vin">VIN</Label>
                    <Input
                      id="onb-vin"
                      placeholder="17 characters"
                      maxLength={17}
                      value={vin}
                      onChange={(e) => setVin(e.target.value.toUpperCase())}
                    />
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <Label htmlFor="onb-notes">Notes</Label>
                    <Input
                      id="onb-notes"
                      placeholder="Purchased Aug 2023, 42k miles..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <Button variant="ghost" onClick={() => goTo(1)} disabled={creating}>
                    Back
                  </Button>
                  <Button onClick={handleCreateCar} disabled={creating} className="font-mono text-xs">
                    {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Continue <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </div>
            )}

            {currentStep === 3 && (
              <div className="space-y-5">
                <div className="text-center">
                  <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center mb-3">
                    <Upload className="w-7 h-7 text-primary" />
                  </div>
                  <h2 className="text-xl font-mono font-bold text-foreground mb-1">
                    Upload Your First Session
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Drop a CSV export from Torque Pro, OBD Fusion, or any OBD2 logger.
                  </p>
                </div>

                {newCarId && (
                  <UploadCard
                    carProfileId={newCarId}
                    onComplete={handleUploadDone}
                    variant="default"
                  />
                )}

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={handleSkipUpload}
                    className="text-xs text-muted-foreground hover:text-foreground underline font-mono"
                  >
                    Skip for now — I&apos;ll upload later
                  </button>
                </div>
              </div>
            )}

            {currentStep === 4 && (
              <div className="text-center space-y-5">
                <div className="w-16 h-16 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-green-500" />
                </div>
                <div>
                  <h2 className="text-xl font-mono font-bold text-foreground mb-2">
                    You&apos;re all set!
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Your vehicle is registered. Head to the dashboard to start exploring your data, ask the AI about your trips, or upload more sessions.
                  </p>
                </div>
                <Button onClick={onComplete} className="font-mono text-xs" size="lg">
                  Go to Dashboard <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
