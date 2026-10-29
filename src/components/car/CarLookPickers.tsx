import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BODY_TYPES, CAR_COLORS, DEFAULT_COLOR, type BodyType, type CarColor } from '@/lib/car-look';
import { CarSilhouette } from '@/components/car/CarSilhouette';

export const BODY_LABEL: Record<BodyType, string> = {
  hatch: 'Hatchback', sedan: 'Sedan', suv: 'SUV', pickup: 'Pickup', wagon: 'Station wagon', minivan: 'Minivan / van', coupe: 'Coupe / sports',
};

export const COLOR_LABEL: Record<CarColor, string> = {
  white: 'White', silver: 'Silver', gray: 'Gray', black: 'Black', red: 'Red', wine: 'Wine', blue: 'Blue',
  navy: 'Navy blue', green: 'Green', beige: 'Beige / gold', brown: 'Brown', yellow: 'Yellow', orange: 'Orange',
};

/** Each kind of car as its drawing, in the car's colour, to tap. */
export function BodyTypePicker({ value, color, onChange, disabled }: {
  value: BodyType | null;
  color?: string | null;
  onChange: (body: BodyType) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('carLook.bodyQ', 'What kind of car is it?')}>
      {BODY_TYPES.map((body) => {
        const selected = value === body;
        return (
          <button
            key={body}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(body)}
            className={cn(
              'flex flex-col items-center gap-1 rounded-xl border px-2 pb-2 pt-1 text-sm transition-colors',
              selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-foreground/[0.03] text-muted-foreground hover:border-foreground/30',
            )}
          >
            <CarSilhouette bodyType={body} color={color ?? DEFAULT_COLOR} className="max-w-[140px]" />
            <span className={cn('font-medium', selected && 'text-foreground')}>{t(`carLook.body.${body}`, BODY_LABEL[body])}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The usual car paints as swatches. */
export function ColorPicker({ value, onChange, disabled }: {
  value: CarColor | null;
  onChange: (color: CarColor) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5" role="radiogroup" aria-label={t('carLook.colorQ', 'What color is it?')}>
      {CAR_COLORS.map(({ key, hex }) => {
        const selected = value === key;
        const label = t(`carLook.color.${key}`, COLOR_LABEL[key]);
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(key)}
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-xl border p-2 text-[11px] transition-colors',
              selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:border-foreground/30',
            )}
          >
            <span className="relative flex h-8 w-8 items-center justify-center rounded-full border border-foreground/20" style={{ backgroundColor: hex }}>
              {selected && <Check className={cn('h-4 w-4', ['white', 'silver', 'beige', 'yellow'].includes(key) ? 'text-black' : 'text-white')} />}
            </span>
            <span className="leading-tight">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
