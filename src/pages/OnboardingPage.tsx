import { useNavigate } from 'react-router-dom';
import OnboardingWizard from '@/components/OnboardingWizard';
import { writePreference } from '@/lib/browser-storage';

export const ONBOARDING_KEY = 'onboarding_completed';

export default function OnboardingPage() {
  const navigate = useNavigate();

  const handleComplete = () => {
    writePreference(ONBOARDING_KEY, 'true');
    navigate('/', { replace: true });
  };

  return <OnboardingWizard onComplete={handleComplete} />;
}
