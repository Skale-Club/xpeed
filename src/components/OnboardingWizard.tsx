import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Car, ArrowRight, ArrowLeft, LogOut, Bluetooth, ShoppingCart, CheckCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CarQuestions, type CarAnswers } from '@/components/CarQuestions';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '@/lib/logout';
import { useBrand, isDefaultBrand } from '@/hooks/use-brand';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useCarsContext } from '@/contexts/CarsContext';

type StepKey = 'welcome' | 'car' | 'connect';
type ConnectChoice = 'adapter' | 'none' | null;

interface OnboardingWizardProps {
  onComplete: () => void;
}

/**
 * First run in three steps: hello (and name, if we don't have it), the car
 * one question per screen, then whether there is an adapter. Nothing asks for
 * country, phone or technical data.
 */
export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const brand = useBrand();
  const { user } = useAuth();
  const { createCar, updateCar } = useCarsContext();

  const needsName = !user?.user_metadata?.full_name;
  const [name, setName] = useState(user?.user_metadata?.full_name ?? '');
  const [answers, setAnswers] = useState<CarAnswers | null>(null);
  const [carId, setCarId] = useState<string | null>(null);
  const [choice, setChoice] = useState<ConnectChoice>(null);
  const [step, setStep] = useState<StepKey>('welcome');

  const STEPS: StepKey[] = ['welcome', 'car', 'connect'];
  const stepIndex = STEPS.indexOf(step);

  const handleWelcome = async () => {
    if (needsName && name.trim()) {
      try {
        await supabase.auth.updateUser({ data: { full_name: name.trim() } });
      } catch (err) {
        console.warn('Could not save name:', err);
      }
    }
    setStep('car');
  };

  // Going back from the last step and answering again updates the same car.
  const handleCar = async (next: CarAnswers) => {
    if (carId) {
      await updateCar(carId, { ...next, name: `${next.year} ${next.make} ${next.model}` });
    } else {
      const car = await createCar(next);
      setCarId(car.id);
    }
    setAnswers(next);
    setStep('connect');
  };

  const choices: { key: Exclude<ConnectChoice, null>; icon: typeof Bluetooth; title: string; hint: string }[] = [
    { key: 'adapter', icon: Bluetooth, title: t('onboard.adapter', 'I have a Bluetooth adapter'), hint: t('onboard.adapterHint', 'The small device that plugs in under the steering wheel.') },
    { key: 'none', icon: ShoppingCart, title: t('onboard.none', "I don't have an adapter yet"), hint: t('onboard.noneHint', "We'll tell you which one to get.") },
  ];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Button variant="ghost" size="sm" className="absolute top-4 right-4 text-muted-foreground gap-1.5" onClick={() => logout(queryClient)}>
        <LogOut className="w-3.5 h-3.5" />
        {t('sidebar.signOut', 'Sign out')}
      </Button>

      <Card className="w-full max-w-lg border-border">
        <CardContent className="pt-8 pb-8 px-6 sm:px-8">
          {/* The car questions show their own progress; one bar at a time. */}
          <div className={`flex gap-1.5 justify-center mb-6 ${step === 'car' ? 'hidden' : ''}`} aria-label={t('onboard.progress', 'Step {{n}} of {{total}}', { n: stepIndex + 1, total: STEPS.length })}>
            {STEPS.map((s, i) => (
              <div key={s} className={`h-1.5 w-8 rounded-full ${i <= stepIndex ? 'bg-primary' : 'bg-primary/20'}`} />
            ))}
          </div>

          <div key={step} className="animate-in fade-in duration-200 space-y-5">
            {step === 'welcome' && (
              <>
                <div className="text-center space-y-3">
                  <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {!isDefaultBrand(brand) ? <img src={brand.logo_url} alt="" className="w-12 h-12 object-contain" /> : <Car className="w-8 h-8 text-primary" />}
                  </div>
                  <h2 className="text-xl font-bold">{t('onboard.welcome', 'Welcome to Xpeed')}</h2>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    <li>{t('onboard.point1', 'See if your car is OK, in plain words')}</li>
                    <li>{t('onboard.point2', 'Your trips are recorded by themselves')}</li>
                    <li>{t('onboard.point3', 'Know what to do — and what to tell the mechanic')}</li>
                  </ul>
                </div>
                {needsName && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-name">{t('onboard.name', 'What should we call you?')}</Label>
                    <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('onboard.namePlaceholder', 'Your name')} />
                  </div>
                )}
                <Button size="lg" className="w-full" onClick={() => void handleWelcome()}>
                  {t('onboard.start', 'Get started')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </>
            )}

            {step === 'car' && (
              <CarQuestions
                initial={answers ?? undefined}
                onSubmit={handleCar}
                onExit={() => setStep('welcome')}
                exitLabel={t('onboard.back', 'Back')}
              />
            )}

            {step === 'connect' && (
              <>
                <div className="text-center">
                  <h2 className="text-xl font-bold">{t('onboard.connectTitle', 'How will you read your car?')}</h2>
                </div>
                <div className="space-y-2">
                  {choices.map(({ key, icon: Icon, title, hint }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setChoice(key)}
                      className={`w-full text-left flex items-start gap-3 rounded-lg border p-3 transition-colors ${choice === key ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
                    >
                      <Icon className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                      <span>
                        <span className="block font-medium text-sm">{title}</span>
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {choice === 'adapter' && (
                  <p className="text-sm text-muted-foreground">
                    {t('onboard.adapterNext', 'On the next screen, tap "Start trip" with the car on. The app finds the adapter and records every trip from then on.')}
                  </p>
                )}
                {choice === 'none' && (
                  <p className="text-sm text-muted-foreground">
                    {t('onboard.noneNext', 'Get an OBD2 adapter with "Bluetooth LE" or "BLE" in the name (for example Veepeak OBDCheck BLE or Vgate iCar Pro BLE). Cheap "Bluetooth 2.0" or Wi-Fi models do not work with Xpeed.')}
                  </p>
                )}
                {choice && (
                  <Button size="lg" className="w-full" onClick={onComplete}>
                    <CheckCircle className="w-4 h-4 mr-2" /> {t('onboard.finish', 'Go to my car')}
                  </Button>
                )}
                <div className="flex justify-between">
                  <Button variant="ghost" onClick={() => setStep('car')}>
                    <ArrowLeft className="w-4 h-4 mr-1" /> {t('onboard.back', 'Back')}
                  </Button>
                  {!choice && (
                    <Button variant="ghost" onClick={onComplete}>{t('onboard.later', 'Decide later')}</Button>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
