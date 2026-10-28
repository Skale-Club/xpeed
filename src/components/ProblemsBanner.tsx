import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { VehicleIssue } from '@/lib/db-issues';
import { URGENCY } from '@/lib/problems';

/** Dashboard banner: how many problems need attention, leading to the Problems page. */
export function ProblemsBanner({ problems }: { problems: VehicleIssue[] }) {
  const { t } = useTranslation();
  if (problems.length === 0) return null;

  const urgent = problems.some((p) => URGENCY[p.severity] === 'urgent');
  const Icon = urgent ? AlertCircle : AlertTriangle;

  return (
    <Link to="/issues" data-testid="problems-banner">
      <Card className={`border ${urgent ? 'border-destructive/50 bg-destructive/5' : 'border-warn/50 bg-warn/5'} hover:opacity-90 transition-opacity`}>
        <CardContent className="p-3 flex items-center gap-3">
          <Icon className={`w-5 h-5 shrink-0 ${urgent ? 'text-destructive' : 'text-warn'}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {t('problems.needAttention', { count: problems.length, defaultValue: '{{count}} problems need attention' })}
            </p>
            <p className="text-xs text-muted-foreground">
              {urgent ? t('problems.urgentHint', 'At least one is urgent — see what to do below.') : t('problems.bannerHint', 'Tap to see what to do.')}
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}
