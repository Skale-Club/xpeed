import { ChevronRight } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useModes } from '@/contexts/ModesContext';
import { trailEntry } from '@/lib/mode-nav';

/**
 * Where you are, at the left of the top bar: the mode, then the menu entry of the page ("Virtual › Sessions").
 * Dashboards 2027, phase 2 (owner approved 2026-11-20). Wider screens only: phones show the logo there.
 */
export function PageTrail() {
  const { t } = useTranslation();
  const { mode, hasBoth } = useModes();
  const { pathname } = useLocation();
  const entry = trailEntry(mode, pathname);
  const modeName = t(`modes.${mode}`, mode === 'real' ? 'Real' : 'Virtual');
  if (!entry && !hasBoth) return null;
  return (
    <nav aria-label={t('nav.trail', 'You are here')} className="hidden min-w-0 items-center gap-1.5 text-sm md:flex" data-testid="page-trail">
      {hasBoth && <span className="shrink-0 text-muted-foreground">{modeName}</span>}
      {hasBoth && entry && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
      {entry && (
        <span className="truncate font-semibold text-foreground" aria-current="page">
          {t(entry.i18nKey, entry.i18nKey.split('.').pop() ?? '')}
        </span>
      )}
    </nav>
  );
}
