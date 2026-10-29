import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { EngineType } from '@/lib/db';
import { isValidCarYear } from '@/lib/car-year';
import { guessBodyType, type BodyType, type CarColor } from '@/lib/car-look';
import { BodyTypePicker, ColorPicker } from '@/components/car/CarLookPickers';

export interface CarAnswers {
  make: string;
  model: string;
  year: number;
  /** How the car is drawn in the app; null when skipped. */
  color: CarColor | null;
  body_type: BodyType | null;
  engine_type: EngineType | null;
}

type Question = 'make' | 'model' | 'year' | 'color' | 'body' | 'fuel';
// Colour before shape, so the shapes are already drawn in the car's colour.
const QUESTIONS: Question[] = ['make', 'model', 'year', 'color', 'body', 'fuel'];

// Best sellers in Brazil, so most people answer with one tap.
const POPULAR_MAKES = ['Chevrolet', 'Volkswagen', 'Fiat', 'Toyota', 'Hyundai', 'Honda', 'Jeep', 'Renault', 'Nissan', 'Ford'];

const FUELS: { value: EngineType; label: string }[] = [
  { value: 'flex', label: 'Flex (gasoline/ethanol)' },
  { value: 'petrol', label: 'Gasoline' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'electric', label: 'Electric' },
];

interface CarQuestionsProps {
  initial?: Partial<CarAnswers>;
  /** Saves the car; throw to stay on the last question and show an error. */
  onSubmit: (answers: CarAnswers) => Promise<void>;
  /** Called by the back button on the first question. */
  onExit: () => void;
  exitLabel?: string;
}

/** Adds a car one question per screen: brand, model, year, colour, kind of car, fuel. */
export function CarQuestions({ initial, onSubmit, onExit, exitLabel }: CarQuestionsProps) {
  const { t } = useTranslation();
  // Coming back to answers already given resumes on the last question.
  const [step, setStep] = useState<Question>(initial?.year ? 'fuel' : 'make');
  const [make, setMake] = useState(initial?.make ?? '');
  const [otherMake, setOtherMake] = useState(!!initial?.make && !POPULAR_MAKES.includes(initial.make));
  const [model, setModel] = useState(initial?.model ?? '');
  const [year, setYear] = useState(initial?.year ? String(initial.year) : '');
  const [color, setColor] = useState<CarColor | null>(initial?.color ?? null);
  const [body, setBody] = useState<BodyType | null>(initial?.body_type ?? null);
  const [fuel, setFuel] = useState<EngineType | null | undefined>(initial?.engine_type);
  const [yearError, setYearError] = useState(false);
  const [saving, setSaving] = useState<EngineType | 'unknown' | null>(null);
  const [error, setError] = useState('');

  const index = QUESTIONS.indexOf(step);
  const goBack = () => (index === 0 ? onExit() : setStep(QUESTIONS[index - 1]));

  const yearNum = parseInt(year, 10);
  const yearValid = isValidCarYear(yearNum);

  const pickMake = (value: string) => {
    setMake(value);
    setOtherMake(false);
    setStep('model');
  };

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'make' && make.trim()) setStep('model');
    else if (step === 'model' && model.trim()) setStep('year');
    else if (step === 'year') {
      if (yearValid) setStep('color');
      else setYearError(true);
    }
    else if (step === 'color') setStep('body');
    else if (step === 'body') setStep('fuel');
  };

  // The kind of car starts as a guess from the model (Corolla → sedan, Hilux → pickup).
  const goToBody = (picked: CarColor | null) => {
    setColor(picked);
    if (!body) setBody(guessBodyType(model));
    setStep('body');
  };

  const finish = async (value: EngineType | null) => {
    setFuel(value);
    setSaving(value ?? 'unknown');
    setError('');
    try {
      await onSubmit({ make: make.trim(), model: model.trim(), year: yearNum, color, body_type: body, engine_type: value });
    } catch (err) {
      console.error(err);
      setError(t('vehicle.addFailed', "Couldn't add the car. Try again."));
    } finally {
      setSaving(null);
    }
  };

  const canContinue = (step === 'make' && !!make.trim()) || (step === 'model' && !!model.trim()) || (step === 'year' && !!year)
    || (step === 'color' && !!color) || (step === 'body' && !!body);

  return (
    <form onSubmit={next} className="space-y-5 py-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5" aria-label={t('carQ.progress', 'Question {{n}} of {{total}}', { n: index + 1, total: QUESTIONS.length })}>
          {QUESTIONS.map((q, i) => (
            <div key={q} className={`h-1.5 w-6 rounded-full ${i <= index ? 'bg-primary' : 'bg-primary/20'}`} />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('carQ.progress', 'Question {{n}} of {{total}}', { n: index + 1, total: QUESTIONS.length })}
        </span>
      </div>

      <div key={step} className="animate-in fade-in duration-200 space-y-4">
        {step === 'make' && (
          <>
            <h3 className="text-lg font-semibold">{t('carQ.makeQ', 'What brand is your car?')}</h3>
            <div className="grid grid-cols-2 gap-2">
              {POPULAR_MAKES.map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={make === m && !otherMake ? 'default' : 'outline'}
                  className="h-11"
                  onClick={() => pickMake(m)}
                >
                  {m}
                </Button>
              ))}
              <Button
                type="button"
                variant={otherMake ? 'default' : 'outline'}
                className="h-11 col-span-2"
                onClick={() => {
                  setOtherMake(true);
                  if (POPULAR_MAKES.includes(make)) setMake('');
                }}
              >
                {t('carQ.otherMake', 'Other brand')}
              </Button>
            </div>
            {otherMake && (
              <Input
                autoFocus
                aria-label={t('vehicle.make', 'Brand')}
                placeholder={t('vehicle.make', 'Brand')}
                value={make}
                onChange={(e) => setMake(e.target.value)}
                className="h-11"
              />
            )}
          </>
        )}

        {step === 'model' && (
          <>
            <h3 className="text-lg font-semibold">{t('carQ.modelQ', 'Which {{make}} model?', { make: make.trim() })}</h3>
            <Input
              autoFocus
              aria-label={t('vehicle.model', 'Model')}
              placeholder={t('carQ.modelPlaceholder', 'e.g. Corolla, Civic, Golf')}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-11"
            />
          </>
        )}

        {step === 'year' && (
          <>
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{t('carQ.yearQ', 'What year is it?')}</h3>
              <p className="text-sm text-muted-foreground">{t('carQ.yearHint', "The model year, as on the car's papers.")}</p>
            </div>
            <Input
              autoFocus
              type="number"
              inputMode="numeric"
              aria-label={t('vehicle.year', 'Year')}
              placeholder="2020"
              value={year}
              onChange={(e) => {
                setYear(e.target.value);
                setYearError(false);
              }}
              className="h-11"
            />
            {yearError && <p className="text-sm text-destructive">{t('vehicle.badYear', 'Check the year.')}</p>}
          </>
        )}

        {step === 'color' && (
          <>
            <h3 className="text-lg font-semibold">{t('carLook.colorQ', 'What color is it?')}</h3>
            <ColorPicker value={color} onChange={goToBody} />
            <button type="button" onClick={() => goToBody(null)} className="min-h-10 text-sm text-muted-foreground underline-offset-4 hover:underline">
              {t('carLook.skip', 'Skip this')}
            </button>
          </>
        )}

        {step === 'body' && (
          <>
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{t('carLook.bodyQ', 'What kind of car is it?')}</h3>
              <p className="text-sm text-muted-foreground">{t('carLook.bodyHint', 'Just to draw it in the app; you can change it later.')}</p>
            </div>
            <BodyTypePicker
              value={body}
              color={color}
              onChange={(picked) => {
                setBody(picked);
                setStep('fuel');
              }}
            />
          </>
        )}

        {step === 'fuel' && (
          <>
            <h3 className="text-lg font-semibold">{t('carQ.fuelQ', 'What fuel does it use?')}</h3>
            <div className="space-y-2">
              {FUELS.map(({ value, label }) => (
                <Button
                  key={value}
                  type="button"
                  variant={fuel === value ? 'default' : 'outline'}
                  className="w-full h-11 justify-start"
                  disabled={saving !== null}
                  onClick={() => void finish(value)}
                >
                  {saving === value && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {t(`vehicle.fuelType.${value}`, label)}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                className="w-full h-11 justify-start text-muted-foreground"
                disabled={saving !== null}
                onClick={() => void finish(null)}
              >
                {saving === 'unknown' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('carQ.fuelUnknown', "I don't know")}
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}
      </div>

      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={goBack} disabled={saving !== null}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          {index === 0 ? exitLabel ?? t('common.cancel', 'Cancel') : t('onboard.back', 'Back')}
        </Button>
        {step !== 'fuel' && (step !== 'make' || otherMake) && (
          <Button type="submit" disabled={!canContinue}>
            {t('onboard.next', 'Continue')} <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        )}
      </div>
    </form>
  );
}
