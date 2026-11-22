import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, History, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LapAnalysis } from '@/components/sim/LapAnalysis';
import { useIsMobile } from '@/hooks/use-mobile';
import { advancedOpenByDefault } from '@/lib/advanced';
import { formatGap, formatLapTime, incomparableReason } from '@/lib/sim/analysis';
import { compareParams } from '@/lib/sim/compare-url';
import { forget, loadSaved, remember, setPinned, type SavedComparison } from '@/lib/sim/compare-recent';
import { useLayoutFinder } from '@/lib/sim/use-track-layouts';
import { useLapMeta } from '@/lib/sim/use-lap-meta';
import { useLapFile } from '@/lib/sim/use-lap-file';
import { sameTrackIdentity } from '@/lib/sim/track-file';
import { usePbs, useUserId, type V1Lap } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { DeltaBlock } from './compare/DeltaBlock';
import { deltaTone } from './compare/delta-tone';
import { describeLap } from './compare/describe-lap';
import { LapPanel } from './compare/LapPanel';
import { QuickPickers } from './compare/QuickPickers';
import { SavedChips } from './compare/SavedChips';
import { CompareStart } from './compare/CompareStart';
import { GameName } from './session-bits';
import { SimCarIdentity } from './SimCarIdentity';
import { TrackLayoutThumb } from './TrackLayoutThumb';
import { LapPicker, type PickerLock } from './LapPicker';
import { useReadAllPages } from './use-read-all-pages';
import { OptionSelect } from '@/components/ui/option-select';
import { comparisonGoal, referenceDifferences, referenceVersionContext, type ComparisonGoal } from '@/lib/sim/reference-context';

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
  const aMeta = useLapMeta(aId).data;
  // The comparisons made lately, under the header's "Recent" button: closed until asked for.
  const [recentOpen, setRecentOpen] = useState(false);
  const aHeader = aFile.data?.header;
  const [goalChoice, setGoalChoice] = useState<{ lapId: string | null; goal: ComparisonGoal } | null>(null);
  const goal = goalChoice && goalChoice.lapId === aId ? goalChoice.goal : comparisonGoal(aHeader);

  // The file carries the source identity. Catalog names may have been translated
  // or renamed. Try exact metadata first and validate the reference file below.
  const pbs = usePbs({ game: aHeader?.game }, { enabled: !!aHeader });
  useReadAllPages(pbs);
  const pb = useMemo(() => {
    if (!aHeader) return null;
    const car = aHeader.car.name.trim().toLowerCase();
    const candidates = pbs.items.filter((entry) => (entry.car.sourceName ?? entry.car.name).trim().toLowerCase() === car && sameTrackIdentity(
      aHeader,
      { game: entry.game, track: { name: entry.track.sourceName ?? entry.track.name, variant: entry.track.variant === undefined ? aHeader.track.variant : entry.track.variant } },
    ));
    return candidates.find((entry) => entry.track.variant !== undefined) ?? candidates[0] ?? null;
  }, [pbs.items, aHeader]);
  // Race pace is contextual: never silently use an all-time personal best as the race reference.
  const candidateRef = goal !== 'race' && pb && pb.lapId !== aId ? pb.lapId : null;
  const bFile = useLapFile(bParam ?? candidateRef);
  // Legacy summaries can lack a variant. Verify the downloaded header before selecting a reference.
  const rejectedDefault = !bParam && !!candidateRef && !!aFile.data && !!bFile.data && (incomparableReason(aFile.data, bFile.data) !== null || aFile.data.header.car.name.trim().toLowerCase() !== bFile.data.header.car.name.trim().toLowerCase());
  const defaultRef = candidateRef && bFile.data && !rejectedDefault ? candidateRef : null;
  const bId = bParam ?? defaultRef;
  const conditionDifferences = aFile.data && bFile.data && bId ? referenceDifferences(aFile.data, bFile.data) : [];
  const versionContext = aHeader && bFile.data && bId ? referenceVersionContext(aHeader, bFile.data.header) : null;

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

  // A reference only makes sense on the same game, track and car (owner, 2026-11-22): the picker for it is fixed to those of the
  // lap, by their ids in the lap's metadata (names do not match: the file has the game's own, the lists the account's).
  const lock: PickerLock | undefined = aMeta?.game && aMeta.track?.id && aMeta.car?.id
    ? { game: aMeta.game, track: aMeta.track.id, car: aMeta.car.id }
    : undefined;
  const showPicker = picking !== null;
  const usingDefault = !bParam && !!defaultRef;
  const isPb = !!aId && !!pb && pb.lapId === aId;

  const bMeta = useLapMeta(bId).data;
  const aInfo = aFile.data ? describeLap(aFile.data, aMeta) : null;
  const bInfo = bFile.data && bId ? describeLap(bFile.data, bMeta) : null;
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
        <span className={cn('shrink-0 font-mono text-xs font-bold tabular-nums', deltaTone(delta) === 'loss' && 'text-destructive', deltaTone(delta) === 'gain' && 'text-success')} data-testid="sticky-delta">
          {formatGap(delta)} s
        </span>
      )}
      <Button size="sm" variant="outline" className="h-10 px-3 text-xs" onClick={() => setEditing(!editing)} aria-expanded={editing} data-testid="sticky-change">
        {t('modes.compare.change', 'Change')}
      </Button>
    </div>
  );

  // The fine print of the comparison (its objective, the game versions, recording notes) starts closed unless the person works with the advanced level.
  const [finePrint, setFinePrint] = useState(advancedOpenByDefault);
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
        <Card className="overflow-hidden border-border bg-card" data-testid="compare-header">
          {/*
            The header of a comparison (owner, 2026-11-22: "messy"), in three bands. On top, what both laps share, said once: the track with its
            map, the car and the game, and the button that opens the comparisons made lately. In the middle the two laps with the gap between them.
            At the base, what they are compared with and the comparison's fine print.
          */}
          {aInfo && aHeader && (
            <div className="flex items-center gap-3 border-b border-border px-4 py-3" data-testid="compare-context">
              <TrackLayoutThumb trackId={aMeta?.track?.id} name={aInfo.track} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <h2 className="truncate text-base font-semibold" title={aInfo.track}>{aInfo.track}</h2>
                <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <SimCarIdentity name={aInfo.car} size="line" className="text-xs" />
                  <GameName game={aHeader.game} />
                </p>
              </div>
              {saved.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant={recentOpen ? 'secondary' : 'ghost'}
                  className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
                  onClick={() => setRecentOpen(!recentOpen)}
                  aria-expanded={recentOpen}
                  aria-controls="comparison-recent"
                  data-testid="recent-toggle"
                >
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t('sessionsDash.compare.savedShort', 'Recent')}</span>
                  <span className="rounded-full bg-muted px-1.5 font-mono text-2xs tabular-nums">{saved.length}</span>
                </Button>
              )}
            </div>
          )}

          <CardContent className="space-y-4 p-4">
            {/* The comparisons made lately and the saved ones, under the header's "Recent" button. */}
            <div id="comparison-recent" hidden={!recentOpen} className="rounded-lg border border-border bg-muted/20 p-3" data-testid="recent-panel">
              <SavedChips
                quiet
                onTrack={aInfo?.track ?? null}
                items={saved}
                a={aId}
                b={bParam}
                onPin={(item, pinned) => setSaved(setPinned(userId, saved, item, pinned))}
                onForget={(item) => setSaved(forget(userId, saved, item))}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center" data-testid="compare-slots">
              <LapPanel
                side="lap"
                label={t('modes.compare.yourLap', 'Your lap')}
                testId="slot-lap"
                hint={t('modes.compare.noLap', 'No lap chosen yet.')}
                file={aFile}
                lapId={aId}
                onChange={() => setPicking(picking === 'a' ? null : 'a')}
                badge={isPb ? t('modes.session.pb', 'Personal best') : undefined}
                context={aInfo}
              />
              <DeltaBlock seconds={delta} note={deltaNote} canSwap={!!bId} onSwap={swap} />
              <LapPanel
                side="reference"
                label={t('modes.compare.comparedWith', 'Compared with')}
                testId="slot-reference"
                hint={isPb ? t('modes.compare.isPb', 'This is your personal best on this track and car, so there is nothing to compare it with. Choose a reference to compare it with.') : pbs.isPending && !!aHeader ? t('modes.compare.lookingForPb', 'Looking for your personal best…') : t('modes.compare.noReference', 'No reference. Choose a lap to compare with.')}
                file={bFile}
                lapId={bId}
                onChange={() => setPicking(picking === 'b' ? null : 'b')}
                onClear={bParam ? () => go({ b: null }) : undefined}
                clearLabel={defaultRef ? t('modes.compare.useMyBest', 'Use my personal best as the reference') : t('modes.compare.removeReference', 'Remove the reference')}
                badge={usingDefault || (!!pb && bId === pb.lapId) ? t('modes.compare.yourBest', 'Your personal best') : undefined}
                context={aInfo}
              />
            </div>

            {aFile.data && (
              <div className="space-y-2 border-t border-border pt-3" data-testid="reference-context">
                <QuickPickers
                  lapId={aId}
                  header={aFile.data.header}
                  referenceId={bId}
                  pb={rejectedDefault ? null : pb}
                  onChoose={(lapId) => go({ b: lapId })}
                  trailing={(
                    <button
                      type="button"
                      onClick={() => setFinePrint(!finePrint)}
                      aria-expanded={finePrint}
                      aria-controls="comparison-fine-print"
                      className="inline-flex shrink-0 items-center gap-1 self-start rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:ml-auto sm:self-center"
                      data-testid="reference-details-toggle"
                    >
                      <Info className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('modes.advanced.comparisonDetails', 'About this comparison')}
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', finePrint && 'rotate-180')} aria-hidden="true" />
                    </button>
                  )}
                />
                {/* What must be seen: the laps were not driven in the same conditions, or the personal best cannot be the comparison. */}
                {conditionDifferences.length > 0 && <p className="text-xs text-warn" data-testid="reference-conditions">{t('modes.referenceContext.conditionsDiffer', 'Recorded conditions differ: {{conditions}}.', { conditions: conditionDifferences.map((key) => t(`modes.referenceContext.condition_${key}`, key)).join(', ') })}</p>}
                {rejectedDefault && <p role="status" className="text-xs text-warn" data-testid="default-reference-refused">{t('modes.referenceContext.defaultRefused')}</p>}
                {/* The fine print of a comparison (what it is for, the game versions, how the laps were recorded): the second level. */}
                <div id="comparison-fine-print" hidden={!finePrint} className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" data-testid="reference-details">
                  <div className="flex flex-wrap items-center gap-2">
                    <span id="comparison-goal-label" className="text-xs text-muted-foreground">{t('modes.referenceContext.goal', 'What this comparison is for')}</span>
                    <OptionSelect size="sm" className="w-full sm:w-56" aria-labelledby="comparison-goal-label" value={goal} onChange={(value) => setGoalChoice({ lapId: aId, goal: value as ComparisonGoal })} options={[
                      { value: 'practice', label: t('modes.referenceContext.practice', 'Practice') },
                      { value: 'qualifying', label: t('modes.referenceContext.qualifying', 'Qualifying / time trial') },
                      { value: 'race', label: t('modes.referenceContext.race', 'Race') },
                    ]} data-testid="comparison-goal" />
                  </div>
                  <p className="text-xs text-muted-foreground">{goal === 'race'
                    ? t('modes.referenceContext.raceReference', 'Choose a pace reference with similar tyres, fuel and weather. Your all-time best is not selected automatically.')
                    : t('modes.referenceContext.fastReference', 'Your personal best is a starting reference. Check tyres, fuel and weather, or choose another lap.')}</p>
                  {versionContext && <p className="text-xs text-muted-foreground" data-testid="reference-versions">{t('modes.referenceContext.versionPair', { a: aHeader?.recorder?.gameBuild ?? t('modes.referenceContext.unknown'), b: bFile.data?.header.recorder?.gameBuild ?? t('modes.referenceContext.unknown') })} {t(`modes.referenceContext.build_${versionContext.gameBuild}`)}</p>}
                  {versionContext?.coordinatesUnknown && <p className="text-xs text-warn" data-testid="reference-coordinates-unknown">{t('modes.referenceContext.coordinatesUnknown')}</p>}
                </div>
              </div>
            )}

            {showPicker && (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-sm font-medium">{picking === 'b' ? t('modes.compare.pickReference', 'Choose the reference lap') : t('modes.compare.pickLap', 'Choose a lap')}</p>
                <LapPicker onPick={pick} lock={picking === 'b' ? lock : undefined} exclude={picking === 'b' && aId ? [aId] : []} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {analysis}
    </div>
  );
}
