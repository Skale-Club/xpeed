import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatLapTime } from '@/lib/sim/analysis';
import { isOnline } from '@/lib/sim/companion';
import { useOverview } from '@/lib/sim/v1-client';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAge } from './use-age';
import { useNow } from './use-now';

/**
 * Virtual mode, in the header of the app: one quiet line, a dot (green when the server heard from a computer in the last three minutes, grey when
 * not) and the name of the computer. The last lap and the state are in the tooltip and in the label for a screen reader. It shows nothing while it
 * loads, when the read fails, or when no computer is paired (the Overview carries the invitation to connect one).
 */
export function CompanionStatus({ className }: { className?: string }) {
  const { t } = useTranslation();
  const age = useAge();
  const now = useNow();
  const { data: overview } = useOverview();
  const devices = overview?.companion.devices ?? [];
  const newest = [...devices].sort((p, q) => Date.parse(q.lastSeenAt ?? q.pairedAt) - Date.parse(p.lastSeenAt ?? p.pairedAt))[0];
  if (!overview || !newest) return null;

  const online = devices.some((device) => isOnline(device.lastSeenAt, now));
  const state = online ? t('communityDash.companion.online', 'Online') : t('communityDash.companion.offline', 'Offline');
  const name = `${newest.name}${devices.length > 1 ? ` +${devices.length - 1}` : ''}`;
  const lastLap = overview.companion.lastLap;
  const detail = lastLap
    ? t('modes.overview.dash.chipLastLap', 'last lap {{time}} · {{track}} · {{car}} · {{when}}', {
        time: formatLapTime(lastLap.timeMs), track: lastLap.track?.name ?? '–', car: lastLap.car?.name ?? '–', when: age(Date.parse(lastLap.startedAt)),
      })
    : t('modes.overview.noLapYet', 'No lap received yet. Drive a lap with a game open.');

  return (
    <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/virtual/companion"
          aria-label={`${t('modes.nav.xpeedSim', 'Xpeed Companion')}: ${state}, ${name}. ${detail}`}
          className={cn(
            'ml-auto flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          data-testid="companion-status"
          data-state={online ? 'online' : 'offline'}
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-full', online ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" data-testid="companion-dot" />
          <span className="hidden min-w-0 truncate font-medium sm:inline" data-testid="companion-device">{name}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-xs text-xs" data-testid="companion-tooltip">
        <p className="font-medium">{state} · {name}</p>
        <p className="text-muted-foreground">{detail}</p>
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
}
