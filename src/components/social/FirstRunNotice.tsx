import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { dismissNotice, noticeDismissed } from './social-utils';

/**
 * The first time someone opens a Virtual page after the social side arrived: "Your racing profile is public by default. Choose who can
 * see it", with a button to the profile settings. It can be dismissed, and then it never comes back. It does not show on the profile
 * and privacy pages themselves, where the choice is already in front of the person.
 */
export function FirstRunNotice() {
  const { t } = useTranslation();
  const userId = useAuth().user?.id ?? null;
  const { pathname } = useLocation();
  const [hidden, setHidden] = useState(false);
  if (!userId || hidden || noticeDismissed(userId)) return null;
  if (pathname.startsWith('/virtual/profile') || pathname.startsWith('/virtual/privacy')) return null;
  const done = () => {
    dismissNotice(userId);
    setHidden(true);
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 p-3" role="region" aria-label={t('social.notice.label', 'Your racing profile')} data-testid="profile-notice">
      <Globe className="h-5 w-5 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 basis-60 text-sm">{t('social.notice.body', 'Your racing profile is public by default. Choose who can see it.')}</p>
      <Button asChild size="sm" onClick={done}>
        <Link to="/virtual/profile" data-testid="profile-notice-go">{t('social.notice.choose', 'Choose who can see it')}</Link>
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={done} aria-label={t('social.notice.dismiss', 'Dismiss')} data-testid="profile-notice-dismiss">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
