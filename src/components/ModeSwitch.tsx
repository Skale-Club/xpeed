import { Car, Gamepad } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useModes } from '@/contexts/ModesContext';
import { modeEntryPath, type Mode } from '@/lib/modes';
import { cn } from '@/lib/utils';

const ICON = { real: Car, virtual: Gamepad } as const;

/**
 * Real | Virtual, as a segmented control. It is there only for someone who
 * chose both modes: with one mode there is nothing to switch, so nothing shows.
 */
export function ModeSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { modes, mode, hasBoth } = useModes();
  if (!hasBoth) return null;

  const go = (target: Mode) => {
    if (target !== mode) navigate(modeEntryPath(target));
  };

  return (
    <div
      role="tablist"
      aria-label={t('modes.switchLabel', 'Switch mode')}
      data-testid="mode-switch"
      className={cn('flex rounded-xl border border-border bg-muted/40 p-1', className)}
    >
      {modes.map((item) => {
        const Icon = ICON[item];
        const active = item === mode;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`mode-${item}`}
            onClick={() => go(item)}
            className={cn(
              'flex min-h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors',
              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{t(`modes.${item}`, item === 'real' ? 'Real' : 'Virtual')}</span>
          </button>
        );
      })}
    </div>
  );
}
