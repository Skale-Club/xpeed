import { ArrowLeft, ArrowLeftRight } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { CompareScreen } from '@/components/sim/CompareScreen';

/**
 * Virtual > a lap's analysis, against a reference. It has no menu entry: it is opened from a lap (a session, a track, a car, a leaderboard, the
 * overview), so "Back" goes to where the person came from, or to Sessions when the page was opened straight from an address.
 */
export default function SimComparePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // The first page of a visit has the key "default": there is nothing in the app to go back to.
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate('/virtual/sessions'));
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={back} aria-label={t('modes.compare.back', 'Back')} title={t('modes.compare.back', 'Back')} data-testid="compare-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <ArrowLeftRight className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-xl font-bold">{t('modes.compare.title', 'Lap analysis')}</h2>
        </div>
        <CompareScreen />
      </div>
    </AppLayout>
  );
}
