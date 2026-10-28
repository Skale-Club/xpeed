import { useTranslation } from 'react-i18next';
import type { EngineType } from '@/lib/db';

// Flex first: it's what most cars in Brazil run on.
const FUEL_TYPES: { value: EngineType; label: string }[] = [
  { value: 'flex', label: 'Flex (gasoline/ethanol)' },
  { value: 'petrol', label: 'Gasoline' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'electric', label: 'Electric' },
];

/** Fuel type chips; tapping the selected one clears it. */
export function FuelTypePicker({ value, onChange }: { value: EngineType | null; onChange: (v: EngineType | null) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label={t('vehicle.fuel', 'Fuel')}>
      {FUEL_TYPES.map(({ value: v, label }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(value === v ? null : v)}
          className={`px-3 py-1 rounded-full text-xs border transition-colors ${
            value === v
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-transparent text-muted-foreground border-border hover:border-primary/60'
          }`}
        >
          {t(`vehicle.fuelType.${v}`, label)}
        </button>
      ))}
    </div>
  );
}
