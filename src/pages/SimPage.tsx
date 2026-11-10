import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { NAV } from '@/lib/mode-nav';

/**
 * Every Virtual screen, until each one has its own page: the name of the screen
 * and a note that it is being built. The routes exist so the mode, its menu and
 * the switch can be used end to end.
 */
export default function SimPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const entry = NAV.virtual.find((item) => item.to === path) ?? NAV.virtual[0];
  const Icon = entry.icon;

  return (
    <AppLayout>
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center gap-2">
          <Icon className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold">{t(entry.i18nKey)}</h2>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">
              {t('modes.placeholder', 'This area is being built. Your sessions and laps will appear here.')}
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
