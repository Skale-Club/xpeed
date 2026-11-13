import LegalDocument from '@/components/legal/LegalDocument';

// The public Terms of Use (/terms): no sign-in. The words are in the `legal.terms` block of the locale files.
export default function TermsPage() {
  return <LegalDocument doc="terms" />;
}
