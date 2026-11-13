import { PublicSharePage } from '@/components/social/PublicShare';

/** `/s/:token`: a shared lap or session, open to anybody with the link (no sign-in, no menu). */
export default function SocialSharePage() {
  return <PublicSharePage />;
}
