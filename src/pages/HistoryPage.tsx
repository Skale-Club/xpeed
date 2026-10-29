import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, Route, Play } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { PageLoader } from '@/components/PageLoader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useToast } from '@/hooks/use-toast';
import { deleteSession, getFlagsForSessions, getSessions, updateSession } from '@/lib/db';
import { formatDistance, formatDuration, tripDate, tripDistanceKm, tripProblems, tripTitle } from '@/lib/trips';
import { formatAppDate } from '@/lib/app-date';
import { tripDayKey } from '@/lib/trip-history';
import { useObd } from '@/contexts/ObdScannerContext';
import { ActiveTripRow } from '@/components/trip/ActiveTripRow';
import { TripCalendar } from '@/components/trip/TripCalendar';
import type { Session, SessionFlag } from '@/types/session';

type Trip = Session & { active_dtcs?: string[] | null };

/** Trips shown at a time; their flags are fetched with them, in chunks of FLAG_CHUNK ids. */
const PAGE_SIZE = 20;
const FLAG_CHUNK = 50;

export default function HistoryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { selectedCarId, selectedCar } = useCarsContext();
  const { distanceUnit, timezone } = useSettings();
  const { recording, recordingCarId, status, lastTrip, savingTrip } = useObd();
  const active = recording?.active && recordingCarId === selectedCarId ? recording : null;
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? '';
  const day = params.get('day') ?? '';
  const search = params.get('q') ?? '';
  const [trips, setTrips] = useState<Trip[]>([]);
  const calendarDays = useMemo(() => {
    const days = new Map<string, number>();
    for (const trip of trips) { const key = tripDayKey(tripDate(trip), timezone); days.set(key, (days.get(key) ?? 0) + 1); }
    return days;
  }, [trips, timezone]);
  const filtered = trips.filter((trip) => {
    const date = tripDayKey(tripDate(trip), timezone);
    return (!month || date.startsWith(month)) && (!day || date === day) && (!search || tripTitle(trip, t).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  });
  // Only trips whose flags have been fetched have an entry here (an empty list = nothing wrong).
  const [flags, setFlags] = useState<Record<string, SessionFlag[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get('page'))) || 1));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const visibleKey = visible.map((trip) => trip.id).join('|');
  const [flagsFailed, setFlagsFailed] = useState(false);
  const changeFilter = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous); next.delete('page');
    if (value) next.set(key, value); else next.delete(key);
    if (key === 'month') next.delete('day');
    if (key === 'day' && value) next.set('month', value.slice(0, 7));
    return next;
  });
  const goPage = (value: number) => setParams((previous) => {
    const next = new URLSearchParams(previous); next.set('page', String(value)); return next;
  });
  const [renaming, setRenaming] = useState<Trip | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<Trip | null>(null);

  /** The flags of these trips, a few ids per request so the URL never grows without limit. */
  const fetchFlags = useCallback(async (ids: string[]) => {
    const grouped: Record<string, SessionFlag[]> = {};
    for (let i = 0; i < ids.length; i += FLAG_CHUNK) {
      const chunk = ids.slice(i, i + FLAG_CHUNK);
      const found = (await getFlagsForSessions(chunk)) as unknown as SessionFlag[];
      for (const id of chunk) grouped[id] = [];
      for (const f of found) (grouped[f.session_id] ??= []).push(f);
    }
    return grouped;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadFailed(false);
      setTrips([]);

      setFlags({});
      if (!selectedCarId) {
        setTrips([]);
        setLoading(false);
        return;
      }
      try {
        const list = ((await getSessions(selectedCarId)) as unknown as Trip[])
          .sort((a, b) => tripDate(b).getTime() - tripDate(a).getTime());
        if (cancelled) return;
        setTrips(list);
        const grouped = await fetchFlags(list.slice(0, PAGE_SIZE).map((s) => s.id));
        if (cancelled) return;
        setFlags(grouped);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setLoadFailed(true);
          toast({ title: tRef.current('history.loadFailed', "Couldn't load your trips"), variant: 'destructive' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // The list is for the car, not for the language: switching language must not refetch it.
  }, [selectedCarId, toast, fetchFlags, retry, lastTrip?.sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (loading || loadFailed || !visible.length) return;
    const ids = visible.map((trip) => trip.id).filter((id) => flags[id] === undefined);
    if (!ids.length) return;
    setFlagsFailed(false);
    void fetchFlags(ids).then((grouped) => {
      if (!cancelled) setFlags((previous) => ({ ...previous, ...grouped }));
    }).catch(() => { if (!cancelled) setFlagsFailed(true); });
    return () => { cancelled = true; };
    // The visible id set drives page loads; cached flags do not retrigger requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, selectedCarId, loading, loadFailed, fetchFlags]);

  const saveName = async () => {
    if (!renaming || !newName.trim()) return;
    try {
      await updateSession(renaming.id, { source_filename: newName.trim() });
      setTrips((prev) => prev.map((s) => (s.id === renaming.id ? { ...s, source_filename: newName.trim() } : s)));
      setRenaming(null);
    } catch (err) {
      console.error(err);
      toast({ title: t('history.renameFailed', "Couldn't rename the trip"), variant: 'destructive' });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteSession(deleting.id);
      setTrips((prev) => prev.filter((s) => s.id !== deleting.id));
    } catch (err) {
      console.error(err);
      toast({ title: t('history.deleteFailed', "Couldn't delete the trip"), variant: 'destructive' });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-4">
        <div>
          <h2 className="text-xl font-bold">{t('history.title', 'Trips')}</h2>
          {selectedCar && <p className="text-sm text-muted-foreground">{selectedCar.name}</p>}
        </div>
        {active && <ActiveTripRow startedAt={active.startedAt} waiting={status !== 'live'} />}
        {!active && savingTrip && <p role="status" className="text-sm text-muted-foreground">{t('trip.saving', 'Saving your last trip…')}</p>}

        {(trips.length > 0 || active) && <div className="space-y-3 rounded-xl border border-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">{t('history.month', 'Month')}<Input type="month" value={month} onChange={(event) => changeFilter('month', event.target.value)} /></label>
            <label className="space-y-1 text-xs">{t('history.day', 'Calendar date')}<Input type="date" value={day} onChange={(event) => changeFilter('day', event.target.value)} /></label>
          </div>
          <label className="block space-y-1 text-xs">{t('history.search', 'Search trip names')}<Input type="search" value={search} onChange={(event) => changeFilter('q', event.target.value)} /></label>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('history.matchCount', '{{count}} completed trips found', { count: filtered.length })}</span>
            {(month || day || search) && <Button variant="ghost" size="sm" onClick={() => setParams({})}>{t('history.clearFilters', 'Clear filters')}</Button>}
          </div>
        </div>}
        {(trips.length > 0 || active) && <TripCalendar month={month} selectedDay={day} days={calendarDays} activeStart={active?.startedAt} timezone={timezone} onMonth={(value) => changeFilter('month', value)} onDay={(value) => changeFilter('day', value)} />}
            {filtered.length > PAGE_SIZE && <nav aria-label={t('history.pagination', 'Trip pages')} className="flex items-center justify-between gap-2 pt-3">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goPage(page - 1)}>{t('history.previous', 'Previous')}</Button>
              <label className="flex items-center gap-2 text-sm">{t('history.page', 'Page')}<select className="rounded border border-border bg-background p-2" value={page} onChange={(event) => goPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} / {pages}</option>)}</select></label>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => goPage(page + 1)}>{t('history.next', 'Next')}</Button>
            </nav>}
        {flagsFailed && <p role="alert" className="text-sm text-warn">{t('history.flagsFailed', 'Some problem checks could not be loaded. Pull down to retry.')}</p>}
        {loading ? <PageLoader fullScreen={false} /> : loadFailed ? (
          <Card role="alert">
            <CardContent className="py-8 text-center space-y-3">
              <p>{t('history.loadFailed', "Couldn't load your trips")}</p>
              <Button onClick={() => setRetry((n) => n + 1)}>{t('problems.retry', 'Try again')}</Button>
            </CardContent>
          </Card>
        ) : trips.length === 0 && (active || savingTrip) ? <p className="text-sm text-muted-foreground">{t('history.noCompleted', 'Completed trips will appear here after saving.')}</p> : trips.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center space-y-3">
              <Route className="w-10 h-10 text-muted-foreground/40 mx-auto" />
              <p className="font-medium">{t('history.empty', 'No trips yet')}</p>
              <p className="text-sm text-muted-foreground">{t('history.emptyHint', 'Connect the adapter and drive — trips are saved here by themselves.')}</p>
              <Button onClick={() => navigate('/')}>
                <Play className="w-4 h-4 mr-2" /> {t('trip.start', 'Start trip')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.length === 0 && <p className="py-8 text-center text-muted-foreground">{t('history.noMatches', 'No trips match these filters.')}</p>}
            {visible.map((trip, index) => {
              const checked = flags[trip.id] !== undefined;
              const problems = tripProblems(flags[trip.id] ?? [], trip.active_dtcs);
              const urgent = problems.some((p) => p.severity === 'critical');
              const facts = [
                formatDuration(trip.duration_seconds),
                formatDistance(tripDistanceKm(trip), distanceUnit),
              ].filter(Boolean);
              return (
                <Fragment key={trip.id}>
                  {(index === 0 || tripDayKey(tripDate(visible[index - 1]), timezone).slice(0, 7) !== tripDayKey(tripDate(trip), timezone).slice(0, 7)) && <h3 className="pt-4 text-lg font-semibold">{formatAppDate(tripDate(trip), i18n.resolvedLanguage, { month: 'long', year: 'numeric' })}</h3>}
                  {(index === 0 || tripDayKey(tripDate(visible[index - 1]), timezone) !== tripDayKey(tripDate(trip), timezone)) && <h4 className="pt-2 text-sm font-medium text-muted-foreground">{formatAppDate(tripDate(trip), i18n.resolvedLanguage, { weekday: 'long', day: 'numeric', month: 'short' })}</h4>}
                <Card data-testid="trip-row">
                  <CardContent className="p-0 flex items-center">
                    <Link to={`/session/${trip.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-l-2xl p-3.5 hover:bg-accent/40">
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${!checked && problems.length === 0 ? 'bg-muted text-muted-foreground' : problems.length === 0 ? 'bg-success/15 text-success' : urgent ? 'bg-destructive/15 text-destructive' : 'bg-warn/15 text-warn'}`}
                        aria-hidden
                      >
                        <Route className="h-[18px] w-[18px]" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{tripTitle(trip, t)}</p>
                        <p className="text-xs text-muted-foreground">
                          {[formatAppDate(tripDate(trip), i18n.resolvedLanguage, { hour: '2-digit', minute: '2-digit' }), ...facts].join(' · ')}
                        </p>
                        {/* No verdict for a trip whose flags aren't loaded: "All good" would be a guess. */}
                        {(checked || problems.length > 0) && (
                          <p className={`text-xs font-medium ${problems.length === 0 ? 'text-success' : urgent ? 'text-destructive' : 'text-warn'}`}>
                            {problems.length === 0
                              ? t('history.noProblems', 'All good')
                              : t('history.problems', { count: problems.length, defaultValue: '{{count}} problems' })}
                          </p>
                        )}
                      </div>
                    </Link>
                    <div className="flex items-center gap-0.5 pr-2">
                      <Button
                        size="icon" variant="ghost" className="rounded-full text-muted-foreground"
                        aria-label={t('history.rename', 'Rename')}
                        onClick={() => { setRenaming(trip); setNewName(tripTitle(trip, t)); }}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="rounded-full text-muted-foreground hover:text-destructive"
                        aria-label={t('history.delete', 'Delete')}
                        onClick={() => setDeleting(trip)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                </Fragment>
              );
            })}

          </div>
        )}
      </div>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('history.renameTitle', 'Rename trip')}</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label={t('history.newName', 'Trip name')}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveName(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={() => void saveName()} disabled={!newName.trim()}>{t('common.save', 'Save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('history.deleteTitle', 'Delete this trip?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('history.deleteBody', "Its data and charts will be removed. The car's problem list keeps its history.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>{t('history.delete', 'Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
