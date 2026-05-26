import { useState, useEffect, useMemo } from 'react';
import { Car, Upload, CheckCircle, ArrowRight, ArrowLeft, LogOut, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import UploadCard from '@/components/UploadCard';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '@/lib/logout';
import { useBrand, isDefaultBrand } from '@/hooks/use-brand';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useCarsContext } from '@/contexts/CarsContext';
import { getMakesForYear, getModelsForMakeYear } from '@/lib/vehicle-library';

type StepKey = 'welcome' | 'name' | 'phone' | 'country' | 'year' | 'make' | 'model' | 'upload' | 'done';

interface OnboardingWizardProps {
  onComplete: () => void;
}

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const queryClient = useQueryClient();
  const brand = useBrand();
  const { user } = useAuth();
  const { createCar } = useCarsContext();

  const [name, setName] = useState(user?.user_metadata?.full_name ?? '');
  const [phone, setPhone] = useState(user?.user_metadata?.phone ?? '');
  const [country, setCountry] = useState('US');
  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [makeQuery, setMakeQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loadingMakes, setLoadingMakes] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [makesError, setMakesError] = useState('');
  const [modelsError, setModelsError] = useState('');
  const [carId, setCarId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const steps = useMemo<StepKey[]>(() => {
    const s: StepKey[] = ['welcome'];
    if (!user?.user_metadata?.full_name) s.push('name');
    if (!user?.user_metadata?.phone) s.push('phone');
    s.push('country', 'year', 'make', 'model', 'upload', 'done');
    return s;
  }, [user]);

  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = steps[stepIndex];

  const goNext = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  const dotsCount = steps.filter((s) => s !== 'done').length;
  const dotIndex = steps.indexOf(currentStep);

  // Load makes when entering make step
  useEffect(() => {
    if (currentStep !== 'make' || country !== 'US') return;
    const yearNum = parseInt(year, 10);
    if (!yearNum) return;
    setLoadingMakes(true);
    setMakesError('');
    getMakesForYear(yearNum, country)
      .then(setMakes)
      .catch(() => setMakesError('Could not load makes.'))
      .finally(() => setLoadingMakes(false));
  }, [currentStep, year, country]);

  // Load models when entering model step
  useEffect(() => {
    if (currentStep !== 'model' || country !== 'US') return;
    const yearNum = parseInt(year, 10);
    if (!yearNum || !make) return;
    setLoadingModels(true);
    setModelsError('');
    getModelsForMakeYear(make, yearNum, country)
      .then(setModels)
      .catch(() => setModelsError('Could not load models.'))
      .finally(() => setLoadingModels(false));
  }, [currentStep, year, make, country]);

  const filteredMakes = useMemo(() => {
    if (!makeQuery.trim()) return makes;
    const q = makeQuery.toLowerCase();
    return makes.filter((m) => m.toLowerCase().includes(q));
  }, [makes, makeQuery]);

  const filteredModels = useMemo(() => {
    if (!modelQuery.trim()) return models;
    const q = modelQuery.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, modelQuery]);

  const handleSaveName = async () => {
    if (!name.trim()) return;
    await supabase.auth.updateUser({ data: { full_name: name.trim() } });
    goNext();
  };

  const handleSavePhone = async () => {
    if (!phone.trim()) { goNext(); return; }
    await supabase.auth.updateUser({ data: { phone: phone.trim() } });
    goNext();
  };

  const handleCreateVehicle = async (selectedModel: string) => {
    setCreating(true);
    setCreateError('');
    try {
      const car = await createCar({
        year: parseInt(year, 10),
        make: make.trim(),
        model: selectedModel.trim(),
        country: country === 'other' ? null : country,
      });
      setCarId(car.id);
      setModel(selectedModel);
      goNext();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create vehicle.');
    } finally {
      setCreating(false);
    }
  };

  const isCustomLogo = !isDefaultBrand(brand);
  const yearNum = parseInt(year, 10);
  const currentYear = new Date().getFullYear();
  const yearValid = yearNum >= 1980 && yearNum <= currentYear + 1;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-4 text-muted-foreground gap-1.5"
        onClick={() => logout(queryClient)}
      >
        <LogOut className="w-3.5 h-3.5" />
        Sign Out
      </Button>

      <Card className="w-full max-w-lg border-border">
        <CardContent className="pt-8 pb-8 px-8">
          {currentStep !== 'done' && (
            <>
              <div className="flex gap-1.5 justify-center mb-3">
                {Array.from({ length: dotsCount }).map((_, i) => (
                  <div
                    key={i}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      i === dotIndex
                        ? 'bg-primary'
                        : i < dotIndex
                        ? 'bg-primary/60'
                        : 'bg-primary/20'
                    }`}
                  />
                ))}
              </div>
              <div className="text-xs text-muted-foreground font-mono text-center mb-6">
                Step {dotIndex + 1} of {dotsCount}
              </div>
            </>
          )}

          <div key={currentStep} className="animate-in fade-in duration-200">

            {/* WELCOME */}
            {currentStep === 'welcome' && (
              <div className="text-center space-y-5">
                <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                  {isCustomLogo ? (
                    <img src={brand.logo_url} alt="Logo" className="w-12 h-12 object-contain" />
                  ) : (
                    <Car className="w-8 h-8 text-primary" />
                  )}
                </div>
                <div>
                  <h2 className="text-xl font-mono font-bold mb-2">Welcome to Xpeed</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Let's set up your vehicle profile in a few quick steps.
                  </p>
                </div>
                <Button onClick={goNext} size="lg" className="font-mono text-xs">
                  Get Started <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {/* NAME */}
            {currentStep === 'name' && (
              <div className="space-y-5">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold mb-1">What's your name?</h2>
                  <p className="text-sm text-muted-foreground">So we know what to call you.</p>
                </div>
                <Input
                  autoFocus
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && name.trim() && handleSaveName()}
                />
                <div className="flex justify-between">
                  <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                    <ArrowLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button onClick={handleSaveName} disabled={!name.trim()} className="font-mono text-xs">
                    Continue <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </div>
            )}

            {/* PHONE */}
            {currentStep === 'phone' && (
              <div className="space-y-5">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold mb-1">What's your phone number?</h2>
                  <p className="text-sm text-muted-foreground">Optional — used for support and alerts.</p>
                </div>
                <Input
                  autoFocus
                  type="tel"
                  placeholder="+1 555 000 0000"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSavePhone()}
                />
                <div className="flex justify-between">
                  <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                    <ArrowLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={goNext} className="font-mono text-xs">
                      Skip
                    </Button>
                    <Button onClick={handleSavePhone} disabled={!phone.trim()} className="font-mono text-xs">
                      Continue <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* COUNTRY */}
            {currentStep === 'country' && (
              <div className="space-y-5">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold mb-1">Where is your vehicle from?</h2>
                  <p className="text-sm text-muted-foreground">
                    This determines which vehicle database we use.
                  </p>
                </div>
                <div className="grid gap-2">
                  {[
                    { code: 'US', label: '🇺🇸 United States' },
                    { code: 'other', label: '🌐 Other' },
                  ].map((c) => (
                    <button
                      key={c.code}
                      onClick={() => { setCountry(c.code); goNext(); }}
                      className={`w-full text-left px-4 py-3 rounded-lg border font-mono text-sm transition-colors hover:border-primary/60 ${
                        country === c.code ? 'border-primary bg-primary/5' : 'border-border'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs w-full">
                  <ArrowLeft className="w-4 h-4 mr-1" /> Back
                </Button>
              </div>
            )}

            {/* YEAR */}
            {currentStep === 'year' && (
              <div className="space-y-5">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold mb-1">What year is your vehicle?</h2>
                </div>
                <Input
                  autoFocus
                  type="number"
                  min={1980}
                  max={currentYear + 1}
                  placeholder={String(currentYear)}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && yearValid && goNext()}
                  className="text-center text-2xl font-mono h-14"
                />
                <div className="flex justify-between">
                  <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                    <ArrowLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button onClick={goNext} disabled={!yearValid} className="font-mono text-xs">
                    Continue <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </div>
            )}

            {/* MAKE */}
            {currentStep === 'make' && (
              <div className="space-y-4">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold mb-1">What's the make?</h2>
                  <p className="text-sm text-muted-foreground">{year} vehicles</p>
                </div>

                {country === 'US' && !makesError ? (
                  loadingMakes ? (
                    <div className="flex items-center justify-center py-10">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      <Input
                        autoFocus
                        placeholder="Search make…"
                        value={makeQuery}
                        onChange={(e) => setMakeQuery(e.target.value)}
                      />
                      <div className="max-h-52 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                        {filteredMakes.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-4 font-mono">
                            No results
                          </p>
                        ) : (
                          filteredMakes.map((m) => (
                            <button
                              key={m}
                              onClick={() => { setMake(m); setMakeQuery(''); goNext(); }}
                              className="w-full text-left px-4 py-2.5 text-sm font-mono hover:bg-muted/50 transition-colors"
                            >
                              {m}
                            </button>
                          ))
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground text-center">
                        Can't find it?{' '}
                        <button
                          onClick={() => setCountry('other')}
                          className="underline hover:text-foreground"
                        >
                          Enter manually
                        </button>
                      </p>
                    </>
                  )
                ) : (
                  <>
                    {makesError && (
                      <p className="text-xs text-destructive text-center">{makesError}</p>
                    )}
                    <Input
                      autoFocus
                      placeholder="e.g. Toyota"
                      value={make}
                      onChange={(e) => setMake(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && make.trim() && goNext()}
                    />
                    <div className="flex justify-between">
                      <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                        <ArrowLeft className="w-4 h-4 mr-1" /> Back
                      </Button>
                      <Button onClick={goNext} disabled={!make.trim()} className="font-mono text-xs">
                        Continue <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    </div>
                  </>
                )}

                {country === 'US' && !loadingMakes && !makesError && (
                  <div className="flex justify-start">
                    <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                      <ArrowLeft className="w-4 h-4 mr-1" /> Back
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* MODEL */}
            {currentStep === 'model' && (
              <div className="space-y-4">
                <div className="text-center">
                  <h2 className="text-xl font-mono font-bold mb-1">What's the model?</h2>
                  <p className="text-sm text-muted-foreground">{year} {make}</p>
                </div>

                {createError && (
                  <p className="text-xs text-destructive text-center">{createError}</p>
                )}

                {country === 'US' && !modelsError ? (
                  loadingModels ? (
                    <div className="flex items-center justify-center py-10">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      <Input
                        autoFocus
                        placeholder="Search model…"
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                      />
                      <div className="max-h-52 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                        {filteredModels.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-4 font-mono">
                            No results
                          </p>
                        ) : (
                          filteredModels.map((m) => (
                            <button
                              key={m}
                              onClick={() => !creating && handleCreateVehicle(m)}
                              disabled={creating}
                              className="w-full text-left px-4 py-2.5 text-sm font-mono hover:bg-muted/50 transition-colors disabled:opacity-50"
                            >
                              {creating && model === m ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-2" />
                              ) : null}
                              {m}
                            </button>
                          ))
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground text-center">
                        Can't find it?{' '}
                        <button
                          onClick={() => setCountry('other')}
                          className="underline hover:text-foreground"
                        >
                          Enter manually
                        </button>
                      </p>
                    </>
                  )
                ) : (
                  <>
                    {modelsError && (
                      <p className="text-xs text-destructive text-center">{modelsError}</p>
                    )}
                    <Input
                      autoFocus
                      placeholder="e.g. Camry"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && model.trim() && !creating && handleCreateVehicle(model)
                      }
                    />
                    <div className="flex justify-between">
                      <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                        <ArrowLeft className="w-4 h-4 mr-1" /> Back
                      </Button>
                      <Button
                        onClick={() => handleCreateVehicle(model)}
                        disabled={!model.trim() || creating}
                        className="font-mono text-xs"
                      >
                        {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Continue <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    </div>
                  </>
                )}

                {country === 'US' && !loadingModels && !modelsError && (
                  <div className="flex justify-start">
                    <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs">
                      <ArrowLeft className="w-4 h-4 mr-1" /> Back
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* UPLOAD */}
            {currentStep === 'upload' && (
              <div className="space-y-5">
                <div className="text-center">
                  <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center mb-3">
                    <Upload className="w-7 h-7 text-primary" />
                  </div>
                  <h2 className="text-xl font-mono font-bold mb-1">Upload Your First Session</h2>
                  <p className="text-sm text-muted-foreground">
                    Drop a CSV from Torque Pro, OBD Fusion, or any OBD2 logger.
                  </p>
                </div>
                {carId && (
                  <UploadCard carProfileId={carId} onComplete={goNext} variant="default" />
                )}
                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={goNext}
                    className="text-xs text-muted-foreground hover:text-foreground underline font-mono"
                  >
                    Skip for now — I'll upload later
                  </button>
                </div>
              </div>
            )}

            {/* DONE */}
            {currentStep === 'done' && (
              <div className="text-center space-y-5">
                <div className="w-16 h-16 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-green-500" />
                </div>
                <div>
                  <h2 className="text-xl font-mono font-bold mb-2">You're all set!</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Your vehicle profile is ready. Let's go.
                  </p>
                </div>
                <Button onClick={onComplete} size="lg" className="font-mono text-xs">
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
