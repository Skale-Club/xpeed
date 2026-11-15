import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useExample } from '@/lib/sim/demo/mode';

// The pieces of the example mode (src/lib/sim/demo/mode.ts) a person sees: the calm invitation on an empty Overview, the thin banner on every
// Virtual page while it is on, and the quiet panel where a screen has no part in the example.

/** On an Overview with nothing to show yet: look around with made-up laps. Calm on purpose: an outline button and one line. */
export function ExampleInvite() {
  const { t } = useTranslation();
  const { demo, enter } = useExample();
  if (demo) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="example-invite">
      <Button type="button" size="sm" variant="outline" onClick={enter} data-testid="example-enter">
        <Eye className="mr-2 h-4 w-4" aria-hidden="true" />
        {t('demo.see', 'See an example')}
      </Button>
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('demo.seeHint', 'Not sure what to expect? Look around with made-up laps. Nothing is saved.')}</p>
    </div>
  );
}

/** A thin line under the header of every Virtual page while the example is on, with the way out. */
export function ExampleBanner() {
  const { t } = useTranslation();
  const { demo, leave } = useExample();
  const navigate = useNavigate();
  if (!demo) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-primary/30 bg-primary/10 px-4 py-1.5 text-xs sm:px-6" data-testid="example-banner">
      <p className="min-w-0 flex-1">{t('demo.banner', 'You are looking at an example. Your own laps appear here once Xpeed Companion sends them.')}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => {
          leave();
          // A page of the example (one of its sessions, tracks or cars) does not exist in the real account.
          navigate('/virtual');
        }}
        data-testid="example-leave"
      >
        {t('demo.leave', 'Leave the example')}
      </Button>
    </div>
  );
}

/** A screen that is about real people or real computers (leaderboards, friends, profile, the Companion page): in the example it says so, politely. */
export function ExampleGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { demo, leave } = useExample();
  if (!demo) return <>{children}</>;
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-4" data-testid="example-not-part">
      <h3 className="text-base font-semibold">{t('demo.notPartTitle', 'Not part of the example')}</h3>
      <p className="text-sm text-muted-foreground">
        {t('demo.notPartBody', 'This page is about real drivers and your own computers, so it is left out of the example. It opens as soon as you leave the example.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={leave} data-testid="example-not-part-leave">{t('demo.leave', 'Leave the example')}</Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/companion"><Download className="mr-2 h-4 w-4" aria-hidden="true" />{t('modes.states.install', 'Get Xpeed Companion')}</Link>
        </Button>
      </div>
    </div>
  );
}
