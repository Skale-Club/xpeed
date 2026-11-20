import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useModes } from '@/contexts/ModesContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { ADMIN_ITEM, ADVANCED_ITEMS, NAV, SETTINGS_ITEM, matchPlaces, type NavEntry } from '@/lib/mode-nav';
import { cn } from '@/lib/utils';

/**
 * "Go to…" in the top bar: a box that opens a list of the pages of the current mode, filtered as you type; Enter opens the
 * highlighted one, the arrow keys move. Ctrl K (⌘ K on a Mac) opens it from anywhere. It only goes to pages: it does not search
 * sessions, tracks or cars. Dashboards 2027, phase 2 (owner approved 2026-11-20). Wider screens only.
 */
export function QuickNav() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { mode } = useModes();
  const { advancedTools } = useSettings();
  const { isAdmin } = useAdminStatus();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const places = useMemo(() => {
    const entries: NavEntry[] = [...NAV[mode], ...(mode === 'real' && advancedTools ? ADVANCED_ITEMS : []), SETTINGS_ITEM, ...(isAdmin ? [ADMIN_ITEM] : [])];
    return entries.map((entry) => ({ to: entry.to, icon: entry.icon, label: t(entry.i18nKey, entry.i18nKey.split('.').pop() ?? '') }));
  }, [mode, advancedTools, isAdmin, t]);
  const shown = matchPlaces(places, query);

  const close = (value: boolean) => {
    setOpen(value);
    if (!value) { setQuery(''); setIndex(0); }
  };
  const go = (to: string) => { close(false); navigate(to); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter' && shown[index]) { event.preventDefault(); go(shown[index].to); }
  };
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-8 w-60 items-center gap-2 rounded-[9px] border border-border bg-foreground/[0.03] px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
        data-testid="quick-nav-open"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left">{t('nav.goTo', 'Go to…')}</span>
        <kbd className="rounded-[5px] border border-border-strong px-1.5 font-mono text-[10.5px]">{mac ? '⌘ K' : 'Ctrl K'}</kbd>
      </button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="top-[18%] max-w-md translate-y-0 gap-0 overflow-hidden p-0" data-testid="quick-nav">
          <DialogTitle className="sr-only">{t('nav.goToTitle', 'Go to a page')}</DialogTitle>
          <DialogDescription className="sr-only">{t('nav.goToPlaceholder', 'Type the name of a page')}</DialogDescription>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={input}
              id="quick-nav-input"
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
              onKeyDown={onKeyDown}
              placeholder={t('nav.goToPlaceholder', 'Type the name of a page')}
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-expanded="true"
              aria-controls="quick-nav-list"
              aria-activedescendant={shown[index] ? `quick-nav-${index}` : undefined}
            />
          </div>
          <ul id="quick-nav-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
            {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t('nav.goToEmpty', 'No page with that name.')}</li>}
            {shown.map((place, i) => (
              <li
                key={place.to}
                id={`quick-nav-${i}`}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(place.to)}
                className={cn('flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm', i === index ? 'bg-accent text-accent-foreground' : 'text-secondary-foreground')}
              >
                <place.icon className={cn('h-4 w-4 shrink-0', i === index ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                <span className="flex-1 truncate">{place.label}</span>
                {i === index && <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
