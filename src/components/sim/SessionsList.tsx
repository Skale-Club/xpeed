import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, ChevronDown, ChevronRight, FolderOpen, Loader2, Trash2, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useSettings } from '@/contexts/SettingsContext';
import { useLapLibrary } from '@/hooks/use-lap-library';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { importLapFiles, type ImportFailure, type ImportResult } from '@/lib/sim/import-laps';
import { compareUrl } from '@/lib/sim/compare-url';
import { clearLibrary, removeLaps } from '@/lib/sim/library';
import { groupSessions, type Session } from '@/lib/sim/sessions';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Pending = { kind: 'session'; session: Session } | { kind: 'all' } | null;

/**
 * Virtual > Sessions: the laps kept on this device, grouped into sessions (one car, one track, no long break).
 * Laps come from lap files added by hand (or a whole folder: the one Xpeed Sim writes into); nothing is
 * uploaded, and each account sees only its own.
 */
export function SessionsList() {
  const { t, i18n } = useTranslation();
  const { timezone } = useSettings();
  const library = useLapLibrary();
  const navigate = useNavigate();
  const sessions = useMemo(() => groupSessions(library.laps), [library.laps]);
  const totalBytes = useMemo(() => library.laps.reduce((sum, lap) => sum + lap.size, 0), [library.laps]);

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  const when = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(ms);
    } catch {
      return new Date(ms).toISOString();
    }
  };

  const run = async (list: File[], fromFolder: boolean) => {
    if (!library.userId || list.length === 0) return;
    setReport(null);
    setProgress({ done: 0, total: list.length });
    try {
      setReport(await importLapFiles(library.userId, list, { fromFolder, onProgress: (done, total) => setProgress({ done, total }) }));
    } finally {
      setProgress(null);
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void run(Array.from(event.dataTransfer.files), false);
  };

  const togglePicked = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current.slice(-1), id]));

  const reasonText = (reason: ImportFailure) =>
    ({
      too_big: t('modes.compare.reasons.too_big', 'it is too large to be a lap'),
      not_a_lap: t('modes.compare.reasons.not_a_lap', 'it is not a lap file'),
      unreadable: t('modes.compare.reasons.unreadable', 'it could not be read'),
      full: t('modes.sessions.reasons.full', 'there is no room left on this device'),
      unavailable: t('modes.sessions.reasons.unavailable', 'this browser cannot keep laps on the device'),
      failed: t('modes.sessions.reasons.failed', 'it could not be kept'),
    })[reason];

  const confirmRemoval = async () => {
    const what = pending;
    setPending(null);
    if (!what || !library.userId) return;
    if (what.kind === 'all') await clearLibrary(library.userId);
    else await removeLaps(library.userId, what.session.laps.map((lap) => lap.id));
    setPicked([]);
  };

  return (
    <div className="space-y-4" data-testid="sessions">
      <Card
        className={cn('bg-card border-border border-dashed transition-colors', dragging && 'border-primary bg-primary/5')}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="sessions-dropzone"
      >
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            {t('modes.sessions.intro', 'Your laps, grouped into sessions: the same car on the same track without a long break.')}{' '}
            {t('modes.compare.private', 'The files stay in your browser; nothing is uploaded.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => files.current?.click()} disabled={!library.userId || library.status === 'unavailable' || progress !== null}>
              <Upload className="mr-2 h-4 w-4" /> {t('modes.sessions.add', 'Add lap files')}
            </Button>
            <Button variant="outline" onClick={() => folder.current?.click()} disabled={!library.userId || library.status === 'unavailable' || progress !== null}>
              <FolderOpen className="mr-2 h-4 w-4" /> {t('modes.sessions.addFolder', 'Add a folder')}
            </Button>
            {library.laps.length > 0 && (
              <Button variant="ghost" onClick={() => setPending({ kind: 'all' })}>
                <Trash2 className="mr-2 h-4 w-4" /> {t('modes.sessions.removeAll', 'Remove everything')}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{t('modes.sessions.drop', 'or drop lap files here')}</span>
          </div>
          <input
            ref={files}
            type="file"
            multiple
            accept=".gz,.xlap,application/gzip,application/x-gzip,application/octet-stream"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('modes.sessions.add', 'Add lap files')}
            data-testid="sessions-files"
            onChange={(event) => {
              void run(Array.from(event.target.files ?? []), false);
              event.target.value = '';
            }}
          />
          <input
            ref={folder}
            type="file"
            multiple
            // Not in the standard, but every current browser takes it: it hands over the files of a whole folder.
            {...({ webkitdirectory: '' } as object)}
            className="sr-only"
            tabIndex={-1}
            aria-label={t('modes.sessions.addFolder', 'Add a folder')}
            data-testid="sessions-folder"
            onChange={(event) => {
              void run(Array.from(event.target.files ?? []), true);
              event.target.value = '';
            }}
          />
          {progress && (
            <p className="flex items-center gap-2 text-sm" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('modes.sessions.importing', 'Adding laps… {{done}} of {{total}}', progress)}
            </p>
          )}
        </CardContent>
      </Card>

      {report && (
        <div role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="import-report">
          <p>
            {t('modes.sessions.result', 'Added {{added}}, already there {{duplicates}}, other files skipped {{ignored}}.', {
              added: report.added,
              duplicates: report.duplicates,
              ignored: report.ignored,
            })}
          </p>
          {report.failed.map((failure) => (
            <p key={failure.name} role="alert" className="text-destructive">
              {t('modes.compare.readError', '{{name}}: {{reason}}', { name: failure.name, reason: reasonText(failure.reason) })}
            </p>
          ))}
          {report.stopped && <p className="text-destructive">{t('modes.sessions.stopped', 'Stopped: nothing more could be kept.')}</p>}
        </div>
      )}

      {library.status === 'loading' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading', 'Loading…')}
        </p>
      )}
      {library.status === 'unavailable' && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {t('modes.sessions.unavailable', 'This browser cannot keep laps on the device. You can still open lap files directly in Compare laps.')}{' '}
          <Link to="/sim/compare" className="underline">{t('modes.nav.compare', 'Compare laps')}</Link>
        </p>
      )}
      {library.status === 'failed' && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {t('modes.sessions.failed', 'Your laps could not be read from this device.')}
          <Button size="sm" variant="outline" onClick={() => void library.refresh()}>{t('modes.sessions.retry', 'Try again')}</Button>
        </p>
      )}
      {library.status === 'ready' && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="sessions-empty">
          {t('modes.sessions.empty', 'No laps yet. Add the lap files Xpeed Sim writes (or its whole output folder) and they show up here, grouped into sessions.')}
        </p>
      )}

      {sessions.map((session, index) => {
        const expanded = open[session.id] ?? index === 0;
        const best = session.best;
        return (
          <Card key={session.id} className="bg-card border-border" data-testid="session">
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{session.trackName} · {session.carName}</h3>
                  <p className="text-xs text-muted-foreground">
                    {when(session.startedAt)} · {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.laps.length })}
                    {' '}({t('modes.sessions.validCount', '{{count}} valid', { count: session.validCount })})
                    {best ? ` · ${t('modes.sessions.best', 'Best: {{time}}', { time: formatLapTime(best.summary.timeMs) })}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {session.carClass && <Badge variant="secondary">{session.carClass}</Badge>}
                  <Badge variant="outline" className="uppercase">{session.game}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={t('modes.sessions.removeSession', 'Remove session')}
                    title={t('modes.sessions.removeSession', 'Remove session')}
                    onClick={() => setPending({ kind: 'session', session })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 h-7 px-2"
                aria-expanded={expanded}
                onClick={() => setOpen((current) => ({ ...current, [session.id]: !expanded }))}
              >
                {expanded ? <ChevronDown className="mr-1 h-4 w-4" /> : <ChevronRight className="mr-1 h-4 w-4" />}
                {expanded ? t('modes.sessions.hide', 'Hide laps') : t('modes.sessions.show', 'Show laps')}
              </Button>

              {expanded && (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs sm:text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="w-8" />
                          <th scope="col" className="pr-2 sm:pr-3 font-normal">{t('modes.compare.lap', 'Lap')}</th>
                          <th scope="col" className="pr-2 sm:pr-3 text-right font-normal">{t('modes.sessions.time', 'Time')}</th>
                          <th scope="col" className="whitespace-nowrap pr-2 sm:pr-3 text-right font-normal">{t('modes.sessions.gap', 'Gap to best')}</th>
                          <th scope="col" className="pr-2 sm:pr-3 font-normal">{t('modes.sessions.status', 'Status')}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {session.laps.map((lap) => {
                          const isBest = best?.id === lap.id;
                          return (
                            <tr key={lap.id} className={cn('border-t border-border', isBest && 'bg-primary/5')} data-testid="session-lap">
                              <td className="py-1.5">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                                  checked={picked.includes(lap.id)}
                                  onChange={() => togglePicked(lap.id)}
                                  aria-label={t('modes.sessions.select', 'Select lap {{lap}} to compare', { lap: lap.summary.lapNumber })}
                                />
                              </td>
                              <td className="whitespace-nowrap py-1.5 pr-2 sm:pr-3">{lap.summary.lapNumber}</td>
                              <td className="whitespace-nowrap py-1.5 pr-2 sm:pr-3 text-right font-mono tabular-nums">{formatLapTime(lap.summary.timeMs)}</td>
                              <td className="whitespace-nowrap py-1.5 pr-2 sm:pr-3 text-right font-mono tabular-nums text-muted-foreground">
                                {best && !isBest && lap.summary.valid ? `${formatGap((lap.summary.timeMs - best.summary.timeMs) / 1000)} s` : '–'}
                              </td>
                              <td className="whitespace-nowrap py-1.5 pr-2 sm:pr-3 text-xs">
                                {isBest ? t('modes.sessions.isBest', 'Best lap') : lap.summary.valid ? t('modes.compare.valid', 'valid') : t('modes.compare.notValid', 'not valid')}
                              </td>
                              <td className="py-1.5 text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!best || isBest}
                                  aria-label={t('modes.sessions.vsBest', 'Compare with best')}
                                  title={t('modes.sessions.vsBest', 'Compare with best')}
                                  onClick={() => best && navigate(compareUrl(lap.id, best.id))}
                                >
                                  {/* A phone has no room for the words: the icon says it, and the name is still read out. */}
                                  <ArrowLeftRight className="h-4 w-4 sm:mr-2" />
                                  <span className="hidden sm:inline">{t('modes.sessions.vsBest', 'Compare with best')}</span>
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={picked.length !== 2}
                      onClick={() => navigate(compareUrl(picked[0], picked[1]))}
                    >
                      {t('modes.sessions.compareTwo', 'Compare the two selected')}
                    </Button>
                    {picked.length !== 2 && <span className="text-xs text-muted-foreground">{t('modes.sessions.pickTwo', 'Pick two laps to compare them.')}</span>}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}

      {library.laps.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('modes.sessions.storage', 'Kept on this device only ({{size}}). Clearing your browser data removes them.', { size: formatBytes(totalBytes) })}
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title={pending?.kind === 'all' ? t('modes.sessions.confirmAllTitle', 'Remove all your laps?') : t('modes.sessions.confirmSessionTitle', 'Remove this session?')}
        description={
          pending?.kind === 'all'
            ? t('modes.sessions.confirmAllBody', 'Every lap kept on this device is removed. The files you added stay wherever they are.')
            : t('modes.sessions.confirmSessionBody', '{{count}} laps are removed from this device. The files you added stay wherever they are.', {
                count: pending?.kind === 'session' ? pending.session.laps.length : 0,
              })
        }
        confirmLabel={t('modes.sessions.confirmRemove', 'Remove')}
        onConfirm={() => void confirmRemoval()}
      />
    </div>
  );
}
