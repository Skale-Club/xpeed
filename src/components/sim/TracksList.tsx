import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FolderOpen, Loader2, Minus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useSettings } from '@/contexts/SettingsContext';
import { useTrackLibrary } from '@/hooks/use-track-library';
import { lengthIn, type DistanceUnit } from '@/lib/sim/analysis';
import { TrackReadError } from '@/lib/sim/read-track-file';
import { TrackLibraryError, addTrackFile, loadTrack, removeTracks, type LibraryTrack } from '@/lib/sim/track-library';
import { deleteAccountTrack, syncAccountTracks, type SyncResult } from '@/lib/sim/account-tracks';
import type { TrackFile } from '@/lib/sim/track-file';
import { cn } from '@/lib/utils';

/** The games whose files Xpeed Sim reads track layouts from, by the id a layout file uses. */
const GAME_NAMES: Record<string, string> = { ac: 'Assetto Corsa', sce: 'Stock Car Extreme' };
const gameName = (id: string) => GAME_NAMES[id] ?? id.toUpperCase();

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The shape of the track, small: its centre line, z down like the big map. */
function TrackThumb({ layout }: { layout: TrackFile | null }) {
  if (!layout) return <div className="h-16 w-24 shrink-0 rounded-md bg-muted/40" aria-hidden />;
  const { x, z } = layout.centerline;
  const step = Math.max(1, Math.ceil(x.length / 300));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < x.length; i++) {
    minX = Math.min(minX, x[i]);
    maxX = Math.max(maxX, x[i]);
    minZ = Math.min(minZ, z[i]);
    maxZ = Math.max(maxZ, z[i]);
  }
  const margin = Math.max(maxX - minX, maxZ - minZ) * 0.06 + 1;
  const points: string[] = [];
  for (let i = 0; i < x.length; i += step) points.push(`${(x[i] - minX + margin).toFixed(0)},${(z[i] - minZ + margin).toFixed(0)}`);
  return (
    <svg viewBox={`0 0 ${(maxX - minX + 2 * margin).toFixed(0)} ${(maxZ - minZ + 2 * margin).toFixed(0)}`} className="h-16 w-24 shrink-0 rounded-md bg-muted/40 text-primary" aria-hidden data-testid="track-thumb">
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Feature({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', !on && 'text-muted-foreground/60 line-through')}>
      {on ? <Check className="h-3 w-3" /> : <Minus className="h-3 w-3" />} {label}
    </span>
  );
}

function TrackRow({ entry, userId, unit, onRemove }: { entry: LibraryTrack; userId: string; unit: DistanceUnit; onRemove: () => void }) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<TrackFile | null>(null);
  useEffect(() => {
    let live = true;
    loadTrack(userId, entry.id).then((found) => live && setLayout(found), () => undefined);
    return () => {
      live = false;
    };
  }, [userId, entry.id]);
  const { summary } = entry;
  const title = summary.title ?? summary.trackName;
  const length = summary.lengthM !== undefined ? `${(lengthIn(summary.lengthM, unit) / (unit === 'mi' ? 5280 : 1000)).toFixed(2)} ${unit === 'mi' ? 'mi' : 'km'}` : null;
  return (
    <li className="flex items-center gap-3 py-3" data-testid="track-row">
      <TrackThumb layout={layout} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {title}
          {summary.variant ? <span className="text-muted-foreground"> · {summary.variant}</span> : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {gameName(summary.game)}
          {length ? ` · ${length}` : ''} · {entry.fileName} · {formatBytes(entry.size)}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
          <Feature on={summary.hasEdges} label={t('modes.tracks.edges', 'edges')} />
          <Feature on={summary.hasIdealLine} label={t('modes.tracks.idealLine', 'ideal line')} />
          <Feature on={summary.hasPitLane} label={t('modes.tracks.pitLane', 'pit lane')} />
        </p>
      </div>
      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={`${t('modes.tracks.remove', 'Remove')} ${title}`} onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

/**
 * Virtual > Tracks: the track layouts kept on this device (the real shape of each circuit, read by Xpeed Sim from the
 * game's own files). A lap is drawn on the layout of its track on the compare screen.
 */
export function TracksList() {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const library = useTrackLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [added, setAdded] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<LibraryTrack | null>(null);
  const [account, setAccount] = useState<SyncResult | null>(null);

  // The layouts Xpeed Sim sent to the account are copied onto this device when the screen opens.
  useEffect(() => {
    if (!library.userId) return;
    let live = true;
    syncAccountTracks(library.userId).then((result) => live && setAccount(result), () => undefined);
    return () => {
      live = false;
    };
  }, [library.userId]);

  const remove = async (entry: LibraryTrack) => {
    if (!library.userId) return;
    const inAccount = account?.byKey.get(entry.id.slice(library.userId.length + 1));
    if (inAccount && (await deleteAccountTrack(inAccount.id))) {
      account?.byKey.delete(entry.id.slice(library.userId.length + 1));
    }
    await removeTracks(library.userId, [entry.id]);
  };

  const addFiles = async (files: File[]) => {
    if (!library.userId || files.length === 0) return;
    setBusy(true);
    setProblems([]);
    setAdded(null);
    const bad: string[] = [];
    let count = 0;
    for (const file of files) {
      try {
        await addTrackFile(library.userId, file);
        count++;
      } catch (error) {
        const reason =
          error instanceof TrackReadError
            ? { too_big: t('modes.tracks.reasons.too_big', 'it is too large to be a track layout'), not_a_track: t('modes.tracks.reasons.not_a_track', 'it is not a track layout file'), unreadable: t('modes.tracks.reasons.unreadable', 'it could not be read') }[error.reason]
            : error instanceof TrackLibraryError && error.code === 'full'
              ? t('modes.tracks.reasons.full', 'there is no room left on this device')
              : t('modes.tracks.reasons.failed', 'it could not be kept');
        bad.push(t('modes.compare.readError', '{{name}}: {{reason}}', { name: file.name, reason }));
      }
    }
    setBusy(false);
    setProblems(bad);
    setAdded(count);
  };

  const sorted = [...library.tracks].sort((p, q) => (p.summary.title ?? p.summary.trackName).localeCompare(q.summary.title ?? q.summary.trackName));

  return (
    <div className="space-y-4" data-testid="tracks-list">
      <Card
        className={cn('bg-card border-border border-dashed transition-colors', dragging && 'border-primary bg-primary/5')}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            {t('modes.tracks.intro', 'The real shape of each circuit: the road between its edges, the game’s ideal line and the pit lane, read by Xpeed Sim from the game’s own files (Assetto Corsa and Stock Car Extreme). Your laps are drawn on them on the compare screen.')}{' '}
            {t('modes.tracks.private', 'Xpeed Sim sends them to your account by itself when you drive a track; a copy is kept on this device.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => input.current?.click()} disabled={busy || !library.userId}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-2 h-4 w-4" />}
              {t('modes.tracks.open', 'Add track layout files')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('modes.tracks.drop', 'or drop .xtrk files here')}</span>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept=".xtrk,.gz,application/gzip,application/octet-stream"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('modes.tracks.open', 'Add track layout files')}
            data-testid="track-input"
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </CardContent>
      </Card>

      {account?.reached && account.copied > 0 && (
        <p role="status" className="text-sm" data-testid="tracks-from-account">
          {t('modes.tracks.fromAccount', { count: account.copied, defaultValue: '{{count}} track layouts sent by Xpeed Sim were added from your account.', defaultValue_one: '1 track layout sent by Xpeed Sim was added from your account.' })}
        </p>
      )}
      {added !== null && added > 0 && (
        <p role="status" className="text-sm" data-testid="tracks-added">
          {t('modes.tracks.added', { count: added, defaultValue: '{{count}} track layouts kept.', defaultValue_one: '1 track layout kept.' })}
        </p>
      )}
      {problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {problems.map((problem) => <p key={problem}>{problem}</p>)}
        </div>
      )}

      {library.status === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">{t('modes.tracks.unavailable', 'This browser cannot keep track layouts on the device.')}</p>
      ) : library.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading', 'Loading…')}
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="tracks-empty">
          {t('modes.tracks.empty', 'No track layouts yet. Add the .xtrk files Xpeed Sim writes, or open one on the compare screen.')}
        </p>
      ) : (
        <Card className="bg-card border-border">
          <CardContent className="py-1">
            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <span>{t('modes.tracks.count', { count: sorted.length, defaultValue: '{{count}} track layouts', defaultValue_one: '1 track layout' })}</span>
              <Badge variant="secondary">{formatBytes(sorted.reduce((sum, entry) => sum + entry.size, 0))}</Badge>
            </div>
            <ul className="divide-y divide-border">
              {sorted.map((entry) => (
                <TrackRow key={entry.id} entry={entry} userId={library.userId!} unit={distanceUnit as DistanceUnit} onRemove={() => setPending(entry)} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        title={t('modes.tracks.removeTitle', 'Remove this track layout?')}
        description={t('modes.tracks.removeText', 'It is removed from this device and from your account. Laps on this track will be drawn without it until Xpeed Sim sends it again or its file is added.')}
        confirmLabel={t('modes.tracks.remove', 'Remove')}
        onConfirm={() => {
          if (pending) void remove(pending).catch(() => undefined);
          setPending(null);
        }}
      />
    </div>
  );
}
