import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Award, Loader2, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LapAnalysis } from '@/components/sim/LapAnalysis';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareParams } from '@/lib/sim/compare-url';
import { LapReadError } from '@/lib/sim/read-lap-file';
import type { LapFile } from '@/lib/sim/lap-file';
import { useLayoutFinder } from '@/lib/sim/use-track-layouts';
import { useLapFile } from '@/lib/sim/use-lap-file';
import { V1Error, isSignedOut, usePbs, type V1Lap } from '@/lib/sim/v1-client';
import { LapPicker, type PickerStart } from './LapPicker';
import { useReadAllPages } from './use-read-all-pages';
import { SimCarIdentity } from './SimCarIdentity';

const describe = (lap: LapFile) => {
  const { track, car, lap: info } = lap.header;
  return { track: track.name, car: car.name, number: info.number, timeMs: info.timeMs, valid: info.valid };
};

/** One of the two laps of the comparison: what it is, and what it is doing (downloading, failed, loaded). */
function LapSlot({ label, testId, hint, file, lapId, onChange, onClear, clearLabel, badge, hideChange }: {
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
  const info = file.data ? describe(file.data) : null;
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
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid={testId}>
      <span className="w-20 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
        {!lapId ? (
          <p className="text-sm text-muted-foreground">{hint}</p>
        ) : file.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="lap-downloading">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('modes.compare.downloading', 'Downloading the lap…')}
          </p>
        ) : why ? (
          <p role="alert" className="text-sm text-destructive" data-testid="lap-failed">
            {why}
          </p>
        ) : info ? (
          <>
            <p className="truncate text-sm font-medium">
              {info.track} · {t('modes.compare.lapN', 'Lap {{n}}', { n: info.number })} · <span className="font-mono tabular-nums">{formatLapTime(info.timeMs)}</span>
            </p>
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <SimCarIdentity name={info.car} className="text-xs" />
              <span>{info.valid ? t('modes.compare.valid', 'valid') : t('modes.compare.notValid', 'not valid')}</span>
              {badge && <Badge variant="secondary" className="gap-1"><Award className="h-3 w-3" />{badge}</Badge>}
            </div>
          </>
        ) : null}
      </div>
      {lapId && error && !gone && !(error instanceof LapReadError) && !isSignedOut(error) && (
        <Button size="sm" variant="outline" onClick={() => void file.refetch()} disabled={file.isFetching}>
          <RefreshCw className="mr-2 h-4 w-4" /> {t('modes.states.retry', 'Try again')}
        </Button>
      )}
      {isSignedOut(error) && (
        <Button asChild size="sm"><Link to="/login">{t('modes.states.signIn', 'Sign in')}</Link></Button>
      )}
      {!hideChange && (
        <Button size="sm" variant="outline" onClick={onChange}>
          {lapId ? t('modes.compare.change', 'Change') : t('modes.compare.choose', 'Choose a lap')}
        </Button>
      )}
      {onClear && lapId && (
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={clearLabel} title={clearLabel} onClick={onClear}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}

/**
 * Virtual > Compare laps. The laps come from the account only: a link names them by their ids (`?a=<lap>&b=<reference>`), or they
 * are found with the picker (game, track, car, lap). A lap with no reference is measured against the personal best of the same
 * track and car; the reference can be changed. Laps are downloaded once and kept on the device as a cache.
 */
export function CompareScreen() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useSearchParams();
  const { a: aId, b: bParam } = compareParams(params);
  const [picking, setPicking] = useState<'a' | 'b' | null>(null);

  const aFile = useLapFile(aId);
  const aHeader = aFile.data?.header;

  // The personal best of the lap's track and car (by the names the lap file carries) is the reference unless one was chosen.
  const pbs = usePbs({ game: aHeader?.game }, { enabled: !!aHeader });
  useReadAllPages(pbs);
  const pb = useMemo(() => {
    if (!aHeader) return null;
    const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
    return pbs.items.find((entry) => entry.game === aHeader.game && same(entry.track.name, aHeader.track.name) && same(entry.car.name, aHeader.car.name)) ?? null;
  }, [pbs.items, aHeader]);
  const defaultRef = pb && pb.lapId !== aId ? pb.lapId : null;
  const bId = bParam ?? defaultRef;
  const bFile = useLapFile(bId);

  const go = (next: { a?: string | null; b?: string | null }) => {
    const out = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) out.set(key, value);
      else out.delete(key);
    }
    setParams(out);
  };
  const pick = (lap: V1Lap) => {
    // With nothing chosen yet (no `picking`), the lap picked is the lap itself.
    if (picking === 'b') go({ b: lap.id });
    else go({ a: lap.id, b: bParam === lap.id ? null : bParam });
    setPicking(null);
  };
  const swap = () => {
    if (aId && bId) go({ a: bId, b: aId });
  };

  // Track layouts are the ones Xpeed Companion sent to the account: copied onto this device once, then looked in.
  const { findLayout, listKeptLayouts, linkLayout } = useLayoutFinder();

  const start: PickerStart | undefined = aHeader ? { game: aHeader.game, trackName: aHeader.track.name, carName: aHeader.car.name } : undefined;
  // With nothing chosen yet the picker is open: that is how a comparison starts.
  const showPicker = picking !== null || !aId;
  const usingDefault = !bParam && !!defaultRef;
  const isPb = !!aId && !!pb && pb.lapId === aId;

  // On a phone the two laps stay in view as a slim bar while the page scrolls; "Change" opens the full selector.
  const slim = mobile && !!aId && !!aFile.data;
  const aInfo = aFile.data ? describe(aFile.data) : null;
  const bInfo = bFile.data && bId ? describe(bFile.data) : null;
  const slimBar = slim && aInfo && (
    <div className="sticky top-14 z-30 -mx-4 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur" data-testid="sticky-laps">
      <div className="min-w-0 flex-1 text-xs leading-tight">
        <p className="truncate font-medium" data-testid="sticky-lap">
          {t('modes.compare.lap', 'Lap')} {aInfo.number} · <span className="font-mono tabular-nums">{formatLapTime(aInfo.timeMs)}</span> · {aInfo.track}
        </p>
        <p className="truncate text-muted-foreground" data-testid="sticky-reference">
          {bInfo
            ? <>{t('modes.compare.reference', 'Reference')} {bInfo.number} · <span className="font-mono tabular-nums">{formatLapTime(bInfo.timeMs)}</span></>
            : bFile.isPending && !!bId
              ? t('modes.compare.downloading', 'Downloading the lap…')
              : t('modes.compare.noReference', 'No reference. Choose a lap to compare with.')}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => setEditing(!editing)} aria-expanded={editing} data-testid="sticky-change">
        {t('modes.compare.change', 'Change')}
      </Button>
    </div>
  );

  const analysis =
    aId && aFile.data ? (
      <LapAnalysis
        key={`${aId}|${bId ?? ''}`}
        lap={{ id: aId, lap: aFile.data }}
        reference={bFile.data && bId ? { id: bId, lap: bFile.data } : null}
        findLayout={findLayout}
        listKeptLayouts={listKeptLayouts}
        linkLayout={linkLayout}
      />
    ) : null;

  return (
    <div className="space-y-4" data-testid="compare">
      {slimBar}
      {(!slim || editing || picking !== null) && (
      <Card className="bg-card border-border">
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            {t('modes.compare.intro', 'Pick a lap from your account to look at it closely, and compare it with another one. A lap on its own is measured against your personal best on the same track and car.')}
          </p>
          <ul className="divide-y divide-border" data-testid="compare-slots">
            <LapSlot label={t('modes.compare.lap', 'Lap')} testId="slot-lap" hint={t('modes.compare.noLap', 'No lap chosen yet.')} file={aFile} lapId={aId} onChange={() => setPicking(picking === 'a' ? null : 'a')} hideChange={!aId} badge={isPb ? t('modes.session.pb', 'Personal best') : undefined} />
            {aId && (
              <LapSlot
                label={t('modes.compare.reference', 'Reference')}
                testId="slot-reference"
                hint={isPb ? t('modes.compare.isPb', 'This is your personal best on this track and car, so there is nothing to compare it with. Choose a reference to compare it with.') : pbs.isPending && !!aHeader ? t('modes.compare.lookingForPb', 'Looking for your personal best…') : t('modes.compare.noReference', 'No reference. Choose a lap to compare with.')}
                file={bFile}
                lapId={bId}
                onChange={() => setPicking(picking === 'b' ? null : 'b')}
                onClear={bParam ? () => go({ b: null }) : undefined}
                clearLabel={defaultRef ? t('modes.compare.useMyBest', 'Use my personal best as the reference') : t('modes.compare.removeReference', 'Remove the reference')}
                badge={usingDefault ? t('modes.compare.myBest', 'My personal best (default)') : undefined}
              />
            )}
          </ul>
          {aId && bId && (
            <Button size="sm" variant="ghost" onClick={swap}>
              <ArrowLeftRight className="mr-2 h-4 w-4" /> {t('modes.compare.swap', 'Swap the lap and the reference')}
            </Button>
          )}
          {showPicker && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">{picking === 'b' ? t('modes.compare.pickReference', 'Choose the reference lap') : t('modes.compare.pickLap', 'Choose a lap')}</p>
              <LapPicker onPick={pick} start={picking === 'b' ? start : undefined} exclude={picking === 'b' && aId ? [aId] : []} />
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {analysis}
    </div>
  );
}
