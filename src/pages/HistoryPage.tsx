import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, Route, Play, Loader2 } from 'lucide-react';
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
import { formatDistance, formatDuration, formatTripDate, tripDate, tripDistanceKm, tripProblems, tripTitle } from '@/lib/trips';
import type { Session, SessionFlag } from '@/types/session';

type Trip = Session & { active_dtcs?: string[] | null };

/** Trips shown at a time; their flags are fetched with them, in chunks of FLAG_CHUNK ids. */
const PAGE_SIZE = 50;
const FLAG_CHUNK = 50;

export default function HistoryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { selectedCarId, selectedCar } = useCarsContext();
  const { distanceUnit } = useSettings();
  const [trips, setTrips] = useState<Trip[]>([]);
  // Only trips whose flags have been fetched have an entry here (an empty list = nothing wrong).
  const [flags, setFlags] = useState<Record<string, SessionFlag[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;
  const [shown, setShown] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
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
      setShown(PAGE_SIZE);
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
  }, [selectedCarId, toast, fetchFlags, retry]);

  const showMore = async () => {
    const next = shown + PAGE_SIZE;
    setLoadingMore(true);
    try {
      const grouped = await fetchFlags(trips.slice(shown, next).map((s) => s.id));
      setFlags((prev) => ({ ...prev, ...grouped }));
      setShown(next);
    } catch (err) {
      console.error(err);
      toast({ title: t('history.loadFailed', "Couldn't load your trips"), variant: 'destructive' });
    } finally {
      setLoadingMore(false);
    }
  };

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

  if (loading) {
    return (
      <AppLayout>
        <PageLoader fullScreen={false} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-4">
        <div>
          <h2 className="text-xl font-bold">{t('history.title', 'Trips')}</h2>
          {selectedCar && <p className="text-sm text-muted-foreground">{selectedCar.name}</p>}
        </div>

        {loadFailed ? (
          <Card role="alert">
            <CardContent className="py-8 text-center space-y-3">
              <p>{t('history.loadFailed', "Couldn't load your trips")}</p>
              <Button onClick={() => setRetry((n) => n + 1)}>{t('problems.retry', 'Try again')}</Button>
            </CardContent>
          </Card>
        ) : trips.length === 0 ? (
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
            {trips.slice(0, shown).map((trip) => {
              const checked = flags[trip.id] !== undefined;
              const problems = tripProblems(flags[trip.id] ?? [], trip.active_dtcs);
              const urgent = problems.some((p) => p.severity === 'critical');
              const facts = [
                formatDuration(trip.duration_seconds),
                formatDistance(tripDistanceKm(trip), distanceUnit),
              ].filter(Boolean);
              return (
                <Card key={trip.id} data-testid="trip-row">
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
                          {[formatTripDate(tripDate(trip), i18n.resolvedLanguage), ...facts].join(' · ')}
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
              );
            })}
            {trips.length > shown && (
              <Button variant="outline" className="w-full" onClick={() => void showMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('history.showMore', 'Show older trips')}
              </Button>
            )}
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
