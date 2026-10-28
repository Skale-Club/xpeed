import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import { TripCard } from '@/components/trip/TripCard';
import DashboardCharts from '@/components/DashboardCharts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getSessions } from '@/lib/db';
import { useCarsContext } from '@/contexts/CarsContext';
import { Car, Calendar, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { subDays } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import type { Session } from '@/types/session';
import { useOpenProblems } from '@/hooks/use-open-problems';
import { useObd } from '@/contexts/ObdScannerContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';
import { CarHealthCard, LastTripSummary, TripTotals } from '@/components/home/HomeCards';
import { PageLoader } from '@/components/PageLoader';
import { AdaptiveMetricsSection } from '@/components/AdaptiveMetricsSection';
import { ONBOARDING_KEY } from '@/pages/OnboardingPage';

/** A trip saved on this device announces itself; a realtime insert within this long of it isn't news. */
const OWN_SAVE_WINDOW_MS = 30_000;

const Index = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { lastTrip, savingTrip } = useObd();
  const { user } = useAuth();
  const firstName = (user?.user_metadata?.full_name as string | undefined)?.trim().split(/\s+/)[0];
  const { cars, selectedCar, selectedCarId, loading: carsLoading } = useCarsContext();
  // Same list as the Problems page; refreshed when a trip gets saved. This is
  // the one source for "is my car OK?" on this page.
  const problems = useOpenProblems(selectedCarId, lastTrip);
  const [loading, setLoading] = useState(true);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [dateRange, setDateRange] = useState('30d');
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const { t } = useTranslation();
  // Technical sections are closed by default; remember the choice on this device.
  const [showTechnical, setShowTechnical] = useState<boolean>(() => {
    try { return localStorage.getItem('xpeed.home.technical') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('xpeed.home.technical', showTechnical ? '1' : '0'); } catch { /* ignore */ }
  }, [showTechnical]);

  // First-run redirect: brand-new users with 0 cars should land in the
  // onboarding wizard, not on a blank dashboard. We honor a localStorage flag
  // so users who completed the wizard and then deleted all their cars still
  // see the regular empty state.
  useEffect(() => {
    if (carsLoading) return;
    const alreadyOnboarded = localStorage.getItem(ONBOARDING_KEY) === 'true';
    if (cars.length > 0) {
      // User has vehicles — mark onboarding done so logout+login never re-triggers it
      if (!alreadyOnboarded) localStorage.setItem(ONBOARDING_KEY, 'true');
    } else if (!alreadyOnboarded) {
      navigate('/onboarding', { replace: true });
    }
  }, [carsLoading, cars.length, navigate]);

  // When this device last saved a trip itself (its own "Trip saved" message already told the owner).
  const ownSaveAt = useRef(0);
  useEffect(() => {
    if (savingTrip || lastTrip) ownSaveAt.current = Date.now();
  }, [savingTrip, lastTrip]);

  // A trip recorded elsewhere (another phone, the importer) shows up here by itself.
  useEffect(() => {
    if (!selectedCarId) return;
    const channel = supabase
      .channel(`sessions-${selectedCarId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sessions', filter: `car_profile_id=eq.${selectedCarId}` },
        (payload) => {
          const newSession = payload.new as unknown as Session;
          setAllSessions((prev) => (prev.some((s) => s.id === newSession.id) ? prev : [newSession, ...prev]));
          if (Date.now() - ownSaveAt.current > OWN_SAVE_WINDOW_MS) {
            toast({ title: t('home.newTrip', 'A new trip was added') });
          }
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedCarId, toast, t]);

  // Only the latest answer for the selected car may land: an older, slower
  // request must not overwrite a newer one.
  const requestId = useRef(0);
  const fetchSessions = useCallback(async (carId: string) => {
    const mine = ++requestId.current;
    try {
      const sessions = (await getSessions(carId)) as unknown as Session[];
      if (mine !== requestId.current) return;
      setAllSessions(sessions);
      setSessionsFailed(false);
    } catch (err) {
      console.warn('Could not load trips:', err);
      if (mine === requestId.current) setSessionsFailed(true);
    }
  }, []);

  // The page waits for the first load of the car's trips, and for nothing after that.
  useEffect(() => {
    if (!selectedCarId) {
      requestId.current++;
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setAllSessions([]);
    void fetchSessions(selectedCarId).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedCarId, fetchSessions]);

  // A trip just got saved: refresh the list quietly, without the page loader.
  useEffect(() => {
    if (!lastTrip || !selectedCarId) return;
    void fetchSessions(selectedCarId);
  }, [lastTrip, selectedCarId, fetchSessions]);

  const filteredSessions = useMemo(() => {
    if (allSessions.length === 0) return [];
    const now = new Date();
    let cutoff = new Date(0);
    if (dateRange === '7d') cutoff = subDays(now, 7);
    if (dateRange === '30d') cutoff = subDays(now, 30);
    if (dateRange === '90d') cutoff = subDays(now, 90);
    return allSessions.filter((s) => new Date(s.session_start || s.uploaded_at) >= cutoff);
  }, [allSessions, dateRange]);

  if (!selectedCarId && !carsLoading) {
    return (
      <AppLayout>
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <Car className="w-12 h-12 text-primary/30 mx-auto mb-4" />
            <h3 className="text-sm font-semibold text-foreground mb-2">{t('vehicle.none', 'No cars yet')}</h3>
            <p className="text-xs text-muted-foreground mb-4">{t('vehicle.noneHint', 'Add your car to start checking it.')}</p>
            <Button size="sm" onClick={() => navigate('/cars')}>
              {t('nav.cars', 'My cars')}
            </Button>
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  if (loading) {
    return (
      <AppLayout>
        <PageLoader fullScreen={false} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-5">
        <div>
          {firstName && <p className="text-sm text-muted-foreground">{t('home.hello', 'Hi, {{name}}', { name: firstName })}</p>}
          <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{selectedCar?.name || t('home.title', 'Home')}</h2>
        </div>

        {sessionsFailed && (
          <Card className="border-warn/40" role="alert">
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <p className="flex-1 min-w-0 text-sm">{t('home.tripsFailed', "Couldn't load your trips.")}</p>
              <Button variant="outline" size="sm" onClick={() => selectedCarId && void fetchSessions(selectedCarId)}>
                <RotateCcw className="w-3.5 h-3.5 mr-2" /> {t('problems.retry', 'Try again')}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Phones: one column in this order. Wide screens: the trip on the left, the car's state on the right. */}
        <div className="grid gap-5 lg:grid-cols-5 lg:items-start">
          {/* 1. Is my car OK? */}
          <div className="lg:col-span-2 lg:col-start-4 lg:row-start-1">
            <CarHealthCard
              problems={problems.problems}
              loading={problems.loading}
              error={problems.error}
              onRetry={problems.reload}
              lastTrip={allSessions[0] ?? null}
            />
          </div>

          {/* 2. The one action: start / follow a trip */}
          <div className="lg:col-span-3 lg:col-start-1 lg:row-span-3 lg:row-start-1">
            <TripCard />
          </div>

          {/* 3. Last trip and totals */}
          {allSessions.length > 0 && (
            <>
              <div className="lg:col-span-2 lg:col-start-4">
                <LastTripSummary session={allSessions[0]} />
              </div>
              <div className="lg:col-span-2 lg:col-start-4">
                <TripTotals sessions={allSessions} />
              </div>
            </>
          )}
        </div>

        {/* Everything technical stays one tap away, closed by default */}
        {allSessions.length > 0 && (
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowTechnical((v) => !v)}
              className="inline-flex min-h-10 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={showTechnical}
            >
              {showTechnical ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              {t('home.technical', 'Technical details')}
            </button>

            {showTechnical && (
              <div className="space-y-6 mt-4">
                <Select value={dateRange} onValueChange={setDateRange}>
                  <SelectTrigger className="w-[170px] bg-card border-border h-10 text-xs" aria-label={t('home.range.label', 'Period')}>
                    <Calendar className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7d">{t('home.range.7d', 'Last 7 days')}</SelectItem>
                    <SelectItem value="30d">{t('home.range.30d', 'Last 30 days')}</SelectItem>
                    <SelectItem value="90d">{t('home.range.90d', 'Last 3 months')}</SelectItem>
                    <SelectItem value="all">{t('home.range.all', 'All time')}</SelectItem>
                  </SelectContent>
                </Select>

                {filteredSessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('home.range.none', 'No trips in this period.')}</p>
                ) : (
                  <>
                    <AdaptiveMetricsSection
                      engineType={selectedCar?.engine_type}
                      latestSession={allSessions[0] ?? null}
                    />

                    <DashboardCharts sessions={filteredSessions} engineType={selectedCar?.engine_type} />
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default Index;
