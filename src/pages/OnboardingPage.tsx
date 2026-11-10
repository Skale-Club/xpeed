import { useNavigate } from 'react-router-dom';
import OnboardingWizard from '@/components/OnboardingWizard';
import { writePreference } from '@/lib/browser-storage';
import { useModes } from '@/contexts/ModesContext';
import { MODE_HOME } from '@/lib/modes';

export const ONBOARDING_KEY = 'onboarding_completed';

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { modes } = useModes();

  // Real is first, so someone with both lands on their car; someone who chose
  // only racing games lands on Virtual (and never meets the car's first-run redirect).
  const handleComplete = () => {
    writePreference(ONBOARDING_KEY, 'true');
    navigate(MODE_HOME[modes[0] ?? 'real'], { replace: true });
  };

  return <OnboardingWizard onComplete={handleComplete} />;
}
