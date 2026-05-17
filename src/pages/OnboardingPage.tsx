import { useNavigate } from 'react-router-dom';
import OnboardingWizard from '@/components/OnboardingWizard';

export const ONBOARDING_KEY = 'onboarding_completed';

export default function OnboardingPage() {
  const navigate = useNavigate();

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
    navigate('/', { replace: true });
  };

  return <OnboardingWizard onComplete={handleComplete} />;
}
