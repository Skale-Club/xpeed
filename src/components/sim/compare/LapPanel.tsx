import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Award, Loader2, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatLapTime } from '@/lib/sim/analysis';
import { LapReadError } from '@/lib/sim/read-lap-file';
import { V1Error, isSignedOut } from '@/lib/sim/v1-client';
import type { useLapFile } from '@/lib/sim/use-lap-file';
import { cn } from '@/lib/utils';
import { SimCarIdentity } from '../SimCarIdentity';
import { describeLap } from './describe-lap';

/**
 * One of the two laps of the comparison, as a card: which side it is (the lap, in the brand colour like its line on the charts, or the reference, in blue
 * like its dashed line), its time big, its number, track, car and whether the game counted it, and what it is doing when it is not there yet (downloading, failed,
 * gone). The buttons are to change it, and to drop a reference that was chosen.
 */
export function LapPanel({ side, label, testId, hint, file, lapId, onChange, onClear, clearLabel, badge, hideChange }: {
  side: 'lap' | 'reference';
  label: string;
  testId: string;
  hint?: string;
  file: ReturnType<typeof useLapFile>;
  lapId: string | null;
  onChange: () => void;
  onClear?: () => void;
  clearLabel?: string;
  badge?: string;
  /** The picker is already open for this lap: no button to open it. */
  hideChange?: boolean;
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
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card/60 p-3 border-t-2', side === 'lap' ? 'border-t-primary' : 'border-t-blue-500')} data-testid={testId} data-side={side}>
      <div className="flex items-center justify-between gap-2">
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
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onChange}>
              {lapId ? t('modes.compare.change', 'Change') : t('modes.compare.choose', 'Choose a lap')}
            </Button>
          )}
          {onClear && lapId && (
            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={clearLabel} title={clearLabel} onClick={onClear}>
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
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-2xl font-semibold tabular-nums" data-testid={`${testId}-time`}>{formatLapTime(info.timeMs)}</span>
              <span className="text-sm font-medium">{t('modes.compare.lapN', 'Lap {{n}}', { n: info.number })}</span>
            </p>
            <p className="truncate text-sm" title={info.track}>{info.track}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <SimCarIdentity name={info.car} className="text-xs" />
              <span className={cn(!info.valid && 'text-destructive')}>{info.valid ? t('modes.compare.valid', 'valid') : t('modes.compare.notValid', 'not valid')}</span>
              {badge && <Badge variant="secondary" className="gap-1"><Award className="h-3 w-3" aria-hidden="true" />{badge}</Badge>}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
