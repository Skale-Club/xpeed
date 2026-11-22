import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatLapTime } from '@/lib/sim/analysis';
import { LapReadError } from '@/lib/sim/read-lap-file';
import { V1Error, isSignedOut } from '@/lib/sim/v1-client';
import type { useLapFile } from '@/lib/sim/use-lap-file';
import { cn } from '@/lib/utils';
import { SimCarIdentity } from '../SimCarIdentity';
import { describeLap } from './describe-lap';

/**
 * One of the two laps of the comparison (owner, 2026-11-22: the header was "messy"): no box of its own, a coloured edge saying which side it
 * is (the brand colour like the lap's line on the map and charts, blue like the compared lap's dashed line), the time big, and one quiet line
 * under it: the lap's number, what it is (your personal best) and only what differs from the header above (another car, another track, a lap
 * the game did not count). While it is not there yet it says what it is doing (downloading, failed, gone).
 */
export function LapPanel({ side, label, testId, hint, file, lapId, onChange, onClear, clearLabel, badge, hideChange, context }: {
  side: 'lap' | 'reference';
  label: string;
  testId: string;
  hint?: string;
  file: ReturnType<typeof useLapFile>;
  lapId: string | null;
  onChange: () => void;
  onClear?: () => void;
  clearLabel?: string;
  /** What the lap is, said after its number ("Personal best"). */
  badge?: string;
  /** The picker is already open for this lap: no button to open it. */
  hideChange?: boolean;
  /** The track and the car the header names: the panel says them again only when this lap's differ. */
  context?: { track: string; car: string } | null;
}) {
  const { t } = useTranslation();
  const error = file.error;
  const info = file.data ? describeLap(file.data) : null;
  const why = !error
    ? null
    : isSignedOut(error)
      ? t('modes.states.signedOut', 'You are signed out. Sign in again to see your laps.')
      : error instanceof V1Error && error.status === 404
        ? t('modes.compare.gone', 'This lap is no longer in your account.')
        : error instanceof LapReadError
          ? t('modes.compare.badFile', 'The file of this lap is not a valid lap file.')
          : t('modes.compare.downloadFailed', 'The lap could not be downloaded. Check your connection and try again.');
  const gone = error instanceof V1Error && error.status === 404;
  const otherTrack = info && context && info.track !== context.track;
  const otherCar = info && context && info.car !== context.car;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 border-l-2 pl-3', side === 'lap' ? 'border-l-primary' : 'border-l-blue-500')} data-testid={testId} data-side={side}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1">
          {lapId && error && !gone && !(error instanceof LapReadError) && !isSignedOut(error) && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void file.refetch()} disabled={file.isFetching}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> {t('modes.states.retry', 'Try again')}
            </Button>
          )}
          {isSignedOut(error) && (
            <Button asChild size="sm" className="h-7 px-2 text-xs"><Link to="/login">{t('modes.states.signIn', 'Sign in')}</Link></Button>
          )}
          {!hideChange && (
            <Button size="sm" variant={lapId ? 'ghost' : 'outline'} className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onChange}>
              {lapId ? t('modes.compare.change', 'Change') : t('modes.compare.choose', 'Choose a lap')}
            </Button>
          )}
          {onClear && lapId && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" aria-label={clearLabel} title={clearLabel} onClick={onClear}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </span>
      </div>
      <div className="min-w-0">
        {!lapId ? (
          <p className="text-sm text-muted-foreground">{hint}</p>
        ) : file.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="lap-downloading">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('modes.compare.downloading', 'Downloading the lap…')}
          </p>
        ) : why ? (
          <p role="alert" className="text-sm text-destructive" data-testid="lap-failed">
            {why}
          </p>
        ) : info ? (
          <>
            <p className="font-mono text-3xl font-semibold leading-none tabular-nums" data-testid={`${testId}-time`}>{formatLapTime(info.timeMs)}</p>
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t('modes.compare.lapN', 'Lap {{n}}', { n: info.number })}</span>
              {badge && <><span aria-hidden="true">·</span><span>{badge}</span></>}
              {!info.valid && <><span aria-hidden="true">·</span><span className="text-destructive">{t('modes.compare.notValid', 'not valid')}</span></>}
              {otherCar && <><span aria-hidden="true">·</span><SimCarIdentity name={info.car} size="line" className="text-xs" /></>}
              {otherTrack && <><span aria-hidden="true">·</span><span className="truncate" title={info.track}>{info.track}</span></>}
              {!context && <><span aria-hidden="true">·</span><span className="truncate" title={info.track}>{info.track}</span></>}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
