import { Car, Gamepad, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useModes } from '@/contexts/ModesContext';
import type { Mode } from '@/lib/modes';

/**
 * Settings: which modes this person uses. Real comes first. The card does not
 * exist while Virtual is not built, so nobody sees an option that leads nowhere.
 * Each switch applies at once (unlike the preferences above, there is nothing
 * to review before saving), and one mode always stays on.
 */
export function ModesCard() {
  const { t } = useTranslation();
  const { modes, virtualAvailable, setModes } = useModes();
  if (!virtualAvailable) return null;

  const rows: Array<{ mode: Mode; icon: typeof Car; title: string; hint: string }> = [
    { mode: 'real', icon: Car, title: t('modes.settings.realTitle', 'Real car'), hint: t('modes.settings.realHint', 'Your own car: trips, problems, fuel and maintenance.') },
    { mode: 'virtual', icon: Gamepad, title: t('modes.settings.virtualTitle', 'Racing games'), hint: t('modes.settings.virtualHint', 'Sessions, laps and comparisons from your simulator.') },
  ];
  const toggle = (mode: Mode, on: boolean) => {
    const next = on ? [...modes, mode] : modes.filter((item) => item !== mode);
    if (next.length > 0) setModes(next);
  };

  return (
    <Card className="bg-card border-border" data-testid="modes-card">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Layers className="w-5 h-5 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">{t('modes.settings.title', 'Modes')}</h3>
            <p className="text-sm text-muted-foreground">{t('modes.settings.hint', 'Choose how you use Xpeed. You can change this at any time.')}</p>
          </div>
        </div>
        <div className="space-y-3">
          {rows.map(({ mode, icon: Icon, title, hint }) => {
            const on = modes.includes(mode);
            return (
              <label key={mode} className="flex items-start gap-3 cursor-pointer">
                <Switch checked={on} onCheckedChange={(next) => toggle(mode, next)} disabled={on && modes.length === 1} aria-label={title} />
                <span>
                  <span className="text-sm font-semibold flex items-center gap-2"><Icon className="w-4 h-4" /> {title}</span>
                  <span className="text-sm text-muted-foreground block">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {modes.length === 1 && (
          <p className="text-xs text-muted-foreground">{t('modes.settings.lastOne', 'Keep at least one mode on.')}</p>
        )}
      </CardContent>
    </Card>
  );
}
