import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LapAnalysis } from '@/components/sim/LapAnalysis';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatGap, formatLapTime, incomparableReason } from '@/lib/sim/analysis';
import { compareParams } from '@/lib/sim/compare-url';
import { forget, loadSaved, remember, setPinned, type SavedComparison } from '@/lib/sim/compare-recent';
import { useLayoutFinder } from '@/lib/sim/use-track-layouts';
import { useLapFile } from '@/lib/sim/use-lap-file';
import { usePbs, useUserId, type V1Lap } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { DeltaBlock } from './compare/DeltaBlock';
import { deltaTone } from './compare/delta-tone';
import { describeLap } from './compare/describe-lap';
import { LapPanel } from './compare/LapPanel';
import { QuickPickers } from './compare/QuickPickers';
import { SavedChips } from './compare/SavedChips';
import { CompareStart } from './compare/CompareStart';
import { LapPicker, type PickerStart } from './LapPicker';
import { useReadAllPages } from './use-read-all-pages';
import { OptionSelect } from '@/components/ui/option-select';
import { comparisonGoal, referenceDifferences, type ComparisonGoal } from '@/lib/sim/reference-context';

/**
 * Virtual > a lap's analysis. It is opened from a lap elsewhere in the app (there is no menu entry): the address names the laps by their ids
 * (`?a=<lap>&b=<reference>`); with no lap in it, `CompareStart` offers the latest laps and the comparisons kept. A lap with no reference is measured against the personal best of the same track and car; the reference can be changed, picked
 * from three quick choices (my best, the previous session's best, another car) or found with the picker. The header shows the two laps with the gap between
 * them big and coloured, and a swap button; under it, the comparisons made lately and the ones saved, as chips. Laps are downloaded once and kept on the device as a cache.
 */
export function CompareScreen() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const userId = useUserId();
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useSearchParams();
  const { a: aId, b: bParam } = compareParams(params);
  const [picking, setPicking] = useState<'a' | 'b' | null>(null);

  const aFile = useLapFile(aId);
  const aHeader = aFile.data?.header;
  const [goalChoice, setGoalChoice] = useState<{ lapId: string | null; goal: ComparisonGoal } | null>(null);
  const goal = goalChoice && goalChoice.lapId === aId ? goalChoice.goal : comparisonGoal(aHeader);

  // The personal best of the lap's track and car (by the names the lap file carries) is the reference unless one was chosen.
  const pbs = usePbs({ game: aHeader?.game }, { enabled: !!aHeader });
  useReadAllPages(pbs);
  const pb = useMemo(() => {
    if (!aHeader) return null;
    const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
    return pbs.items.find((entry) => entry.game === aHeader.game && same(entry.track.name, aHeader.track.name) && same(entry.car.name, aHeader.car.name)) ?? null;
  }, [pbs.items, aHeader]);
  // Race pace is contextual: never silently use an all-time personal best as the race reference.
  const defaultRef = goal !== 'race' && pb && pb.lapId !== aId ? pb.lapId : null;
  const bId = bParam ?? defaultRef;
  const bFile = useLapFile(bId);
  const conditionDifferences = aFile.data && bFile.data ? referenceDifferences(aFile.data, bFile.data) : [];

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
  const showPicker = picking !== null;
  const usingDefault = !bParam && !!defaultRef;
  const isPb = !!aId && !!pb && pb.lapId === aId;

  const aInfo = aFile.data ? describeLap(aFile.data) : null;
  const bInfo = bFile.data && bId ? describeLap(bFile.data) : null;
  const refusal = aFile.data && bFile.data && bId ? incomparableReason(aFile.data, bFile.data) : null;
  const delta = aInfo && bInfo && !refusal ? (aInfo.timeMs - bInfo.timeMs) / 1000 : null;
  const deltaNote = refusal ? t('sessionsDash.compare.noDeltaRefused', 'These laps cannot be compared.') : isPb ? t('sessionsDash.compare.noDeltaPb', 'This is your best: choose a reference.') : undefined;

  // The comparisons made lately and the saved ones: what is on screen is kept once both laps are there.
  const [saved, setSaved] = useState<SavedComparison[]>(() => loadSaved(userId));
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const lastKept = useRef('');
  useEffect(() => {
    setSaved(loadSaved(userId));
    lastKept.current = '';
  }, [userId]);
  const ready = !!aId && !!aInfo && (bId ? !!bInfo : !aHeader || !pbs.isPending);
  useEffect(() => {
    if (!ready || !aId || !aInfo) return;
    const key = `${aId}|${bParam ?? ''}|${bInfo ? 'b' : ''}`;
    if (lastKept.current === key) return;
    lastKept.current = key;
    setSaved(remember(userId, savedRef.current, { a: aId, b: bParam, info: { track: aInfo.track, aLap: aInfo.number, aMs: aInfo.timeMs, bLap: bInfo?.number ?? null, bMs: bInfo?.timeMs ?? null } }));
    // `aInfo` and `bInfo` are rebuilt every render; the key above says when what is on screen really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, aId, bParam, userId, aInfo?.number, bInfo?.number]);

  // On a phone the two laps stay in view as a slim bar while the page scrolls; "Change" opens the full selector.
  const slim = mobile && !!aId && !!aFile.data;
  const slimBar = slim && aInfo && (
    <div className="sticky top-14 z-30 -mx-4 flex h-10 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur" data-testid="sticky-laps">
      <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-xs">
        <p className="min-w-0 flex-1 truncate font-medium" data-testid="sticky-lap">
          {t('modes.compare.lap', 'Lap')} {aInfo.number} · <span className="font-mono tabular-nums">{formatLapTime(aInfo.timeMs)}</span> · {aInfo.track}
        </p>
        <p className="max-w-[45%] shrink-0 truncate text-muted-foreground" data-testid="sticky-reference">
          {bInfo
            ? <>{t('modes.compare.reference', 'Reference')} {bInfo.number} · <span className="font-mono tabular-nums">{formatLapTime(bInfo.timeMs)}</span></>
            : bFile.isPending && !!bId
              ? t('modes.compare.downloading', 'Downloading the lap…')
              : t('modes.compare.noReference', 'No reference. Choose a lap to compare with.')}
        </p>
      </div>
      {delta !== null && (
        <span className={cn('shrink-0 font-mono text-xs font-bold tabular-nums', deltaTone(delta) === 'loss' && 'text-destructive', deltaTone(delta) === 'gain' && 'text-green-500')} data-testid="sticky-delta">
          {formatGap(delta)} s
        </span>
      )}
      <Button size="sm" variant="outline" className="h-10 px-3 text-xs" onClick={() => setEditing(!editing)} aria-expanded={editing} data-testid="sticky-change">
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
        showFinalGap={slim && !editing && picking === null}
      />
    ) : null;

  if (!aId) {
    return (
      <div className="space-y-4" data-testid="compare">
        <CompareStart
          saved={saved}
          onPick={pick}
          onPin={(item, pinned) => setSaved(setPinned(userId, saved, item, pinned))}
          onForget={(item) => setSaved(forget(userId, saved, item))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="compare">
      {slimBar}
      {(!slim || editing || picking !== null) && (
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" data-testid="compare-slots">
              <LapPanel
                side="lap"
                label={t('modes.compare.lap', 'Lap')}
                testId="slot-lap"
                hint={t('modes.compare.noLap', 'No lap chosen yet.')}
                file={aFile}
                lapId={aId}
                onChange={() => setPicking(picking === 'a' ? null : 'a')}
                badge={isPb ? t('modes.session.pb', 'Personal best') : undefined}
              />
              <DeltaBlock seconds={delta} note={deltaNote} canSwap={!!bId} onSwap={swap} />
              <LapPanel
                side="reference"
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
            </div>

            {aFile.data && (
              <div className="space-y-2" data-testid="reference-context">
                <div className="flex flex-wrap items-center gap-2">
                  <span id="comparison-goal-label" className="text-xs text-muted-foreground">{t('modes.referenceContext.goal', 'Comparison objective')}</span>
                  <OptionSelect size="sm" className="w-full sm:w-56" aria-labelledby="comparison-goal-label" value={goal} onChange={(value) => setGoalChoice({ lapId: aId, goal: value as ComparisonGoal })} options={[
                    { value: 'practice', label: t('modes.referenceContext.practice', 'Practice') },
                    { value: 'qualifying', label: t('modes.referenceContext.qualifying', 'Qualifying / time trial') },
                    { value: 'race', label: t('modes.referenceContext.race', 'Race') },
                  ]} data-testid="comparison-goal" />
                </div>
                <p className="text-xs text-muted-foreground">{goal === 'race'
                  ? t('modes.referenceContext.raceReference', 'Choose a pace reference with similar tyres, fuel and weather. Your all-time best is not selected automatically.')
                  : t('modes.referenceContext.fastReference', 'Your personal best is a starting reference. Check tyres, fuel and weather, or choose another lap.')}</p>
                {conditionDifferences.length > 0 && <p className="text-xs text-amber-500" data-testid="reference-conditions">{t('modes.referenceContext.conditionsDiffer', 'Recorded conditions differ: {{conditions}}.', { conditions: conditionDifferences.map((key) => t(`modes.referenceContext.condition_${key}`, key)).join(', ') })}</p>}
                <QuickPickers lapId={aId} referenceId={bId} pb={pb} onChoose={(lapId) => go({ b: lapId })} />
              </div>
            )}

            <SavedChips
              items={saved}
              a={aId}
              b={bParam}
              onPin={(item, pinned) => setSaved(setPinned(userId, saved, item, pinned))}
              onForget={(item) => setSaved(forget(userId, saved, item))}
            />

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
