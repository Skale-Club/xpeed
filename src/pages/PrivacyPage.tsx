import LegalDocument from '@/components/legal/LegalDocument';

// The public Privacy Policy (/privacy): no sign-in. The words are in the `legal.privacy` block of the locale files.
export default function PrivacyPage() {
  return <LegalDocument doc="privacy" />;
}
