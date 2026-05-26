import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Car, Upload, CheckCircle, ArrowRight, LogOut } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import UploadCard from '@/components/UploadCard';
import { AddVehicleForm } from '@/components/AddVehicleForm';
import { supabase } from '@/integrations/supabase/client';

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 1 | 2 | 3 | 4;

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [newCarId, setNewCarId] = useState<string | null>(null);

  const goTo = (step: Step) => setCurrentStep(step);

  const handleLogout = async () => {
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    Object.keys(localStorage)
      .filter(k => k.startsWith('sb-'))
      .forEach(k => localStorage.removeItem(k));
    sessionStorage.clear();
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-4 text-muted-foreground gap-1.5"
        onClick={handleLogout}
      >
        <LogOut className="w-3.5 h-3.5" />
        Sign Out
      </Button>
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
            {t('common.step', 'Step')} {currentStep} {t('common.of', 'of')} 4
          </div>

          <div key={currentStep} className="transition-opacity duration-300 opacity-100 animate-in fade-in">
            {currentStep === 1 && (
              <div className="text-center space-y-5">
                <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                  <Car className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-mono font-bold text-foreground mb-2">
                    {t('onboarding.welcome_title')}
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {t('onboarding.welcome_body')}
                  </p>
                </div>
                <Button onClick={() => goTo(2)} className="font-mono text-xs" size="lg">
                  {t('onboarding.get_started')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-4">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold text-foreground mb-1">Add Your Car</h2>
                  <p className="text-sm text-muted-foreground">
                    Tell us about the vehicle you&apos;ll be tracking.
                  </p>
                </div>
                <AddVehicleForm
                  onSuccess={(carId) => { setNewCarId(carId); goTo(3); }}
                  onCancel={() => goTo(1)}
                />
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
                    onComplete={() => goTo(4)}
                    variant="default"
                  />
                )}
                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => goTo(4)}
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
                    {t('onboarding.done_title')}
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {t('onboarding.done_body')}
                  </p>
                </div>
                <Button onClick={onComplete} className="font-mono text-xs" size="lg">
                  {t('onboarding.go_to_dashboard')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
