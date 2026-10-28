import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import { TripCard } from '@/components/trip/TripCard';
import UploadCard from '@/components/UploadCard';
import DashboardCharts from '@/components/DashboardCharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getSessions, getSessionFlags, getFlagsForSessions } from '@/lib/db';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { ArrowRight, Gauge, Car, Activity, Clock, AlertTriangle, AlertCircle, CheckCircle, Calendar, ExternalLink, CheckSquare, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { subDays } from 'date-fns';
import { toast } from 'sonner';
import type { Session, SessionFlag, SessionSummaryItem } from '@/types/session';
import { ProblemsBanner } from '@/components/ProblemsBanner';
import { useOpenProblems } from '@/hooks/use-open-problems';
import { useObd } from '@/contexts/ObdScannerContext';
import HealthGauge from '@/components/HealthGauge';
import StatCard from '@/components/StatCard';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';
import { CarHealthCard, LastTripSummary, TripTotals } from '@/components/home/HomeCards';

interface DashboardStats {
  totalSessions: number;
  totalDurationSeconds: number;
  healthScore: number; // 0-100
  status: 'Excellent' | 'Good' | 'Attention' | 'Critical';
  lastUpload: Date | null;
}

interface TrendData {
  id: string;
  date: string;
  attention: number;
  critical: number;
  score: number;
}

import { PageLoader } from '@/components/PageLoader';

import { LatestTripCard } from '@/components/LatestTripCard';
import { GeneralInfoCard } from '@/components/GeneralInfoCard';
import { AdaptiveMetricsSection } from '@/components/AdaptiveMetricsSection';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ONBOARDING_KEY } from '@/pages/OnboardingPage';

const Index = () => {
  const navigate = useNavigate();
  const { lastTrip } = useObd();
  const { cars, selectedCar, selectedCarId, loading: carsLoading } = useCarsContext();
  // Same list as the Problems page; refreshed when a trip gets saved.
  const openProblems = useOpenProblems(selectedCarId, lastTrip);
  const { timezone, distanceUnit } = useSettings();
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [dateRange, setDateRange] = useState('30d');
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [generalStats, setGeneralStats] = useState({
    totalDistance: 0,
    avgFuel: 0,
    problemCount: 0,
    healthScore: 100,
    problems: [] as SessionFlag[]
  });
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

  // Improvement E3: subscribe to new sessions for the selected car so
  // the dashboard updates without a manual refresh.
  useEffect(() => {
    if (!selectedCarId) return;
    const channel = supabase
      .channel(`sessions-${selectedCarId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sessions', filter: `car_profile_id=eq.${selectedCarId}` },
        (payload) => {
          toast.message('New session uploaded — refreshing…');
          // Prepend the new session optimistically
          const newSession = payload.new as unknown as Session;
          setAllSessions((prev) => [newSession, ...prev]);
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedCarId]);

  // Computed & Derived State
  
  const filteredSessions = useMemo(() => {
    if (allSessions.length === 0) return [];
    
    const now = new Date();
    let cutoff = new Date(0);
    if (dateRange === '7d') cutoff = subDays(now, 7);
    if (dateRange === '30d') cutoff = subDays(now, 30);
    if (dateRange === '90d') cutoff = subDays(now, 90);

    return allSessions.filter(s => new Date(s.session_start || s.uploaded_at) >= cutoff);
  }, [allSessions, dateRange]);

  const recentSessions = useMemo(() => {
    return allSessions.slice(0, 3);
  }, [allSessions]);

  const [stats, setStats] = useState<DashboardStats>({
    totalSessions: 0,
    totalDurationSeconds: 0,
    healthScore: 100,
    status: 'Excellent',
    lastUpload: null
  });
  const [trendData, setTrendData] = useState<TrendData[]>([]);

  const loadDashboard = useCallback(async () => {
    if (!selectedCarId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setStatsLoading(true);
    try {
      const sessions = await getSessions(selectedCarId);
      setAllSessions(sessions as unknown as Session[]);
    } finally {
      setLoading(false);
    }
  }, [selectedCarId]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Calculate Stats based on filtered sessions
  useEffect(() => {
    const processStats = async () => {
      setStatsLoading(true);
      try {
        if (filteredSessions.length === 0) {
          setStats({
            totalSessions: 0,
            totalDurationSeconds: 0,
            healthScore: 100,
            status: 'Excellent',
            lastUpload: null
          });
          setTrendData([]);
          setStatsLoading(false);
          return;
        }

        // Calculate aggregated stats for the range
        const totalDuration = filteredSessions.reduce((acc, s) => acc + (s.duration_seconds || 0), 0);
        const lastUpload = new Date(allSessions[0].uploaded_at); // Last upload is global

        // Analyze sessions for trends (up to 20 for better granularity in charts)
        const sessionsForTrend = filteredSessions.slice(0, 20).reverse(); // Oldest to newest
        const trends: TrendData[] = [];
        let totalWeightedScore = 0;
        let totalWeight = 0;

        for (const session of sessionsForTrend) {
          const flags = await getSessionFlags(session.id);
          const attention = flags.filter((f) => f.severity === 'attention').length;
          const critical = flags.filter((f) => f.severity === 'critical').length;
          
          // Simple scoring: 100 - (critical * 20) - (attention * 5)
          const sessionScore = Math.max(0, 100 - (critical * 20) - (attention * 5));
          
          trends.push({
            id: session.id,
            date: new Date(session.session_start || session.uploaded_at).toLocaleDateString(undefined, { timeZone: timezone, month: 'short', day: 'numeric' }),
            attention,
            critical,
            score: sessionScore
          });

          const weight = 1; 
          totalWeightedScore += sessionScore * weight;
          totalWeight += weight;
        }

        const avgScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 100;
        
        let status: DashboardStats['status'] = 'Excellent';
        if (avgScore < 60) status = 'Critical';
        else if (avgScore < 80) status = 'Attention';
        else if (avgScore < 95) status = 'Good';

        setStats({
          totalSessions: filteredSessions.length,
          totalDurationSeconds: totalDuration,
          healthScore: avgScore,
          status,
          lastUpload
        });
        setTrendData(trends);
      } catch (error) {
        console.error('Failed to process stats:', error);
      } finally {
        setStatsLoading(false);
      }
    };

    processStats();
  }, [filteredSessions, allSessions, timezone]);

  // Calculate General Stats (Distance, Fuel, Problems)
  useEffect(() => {
    const calculateGeneralStats = async () => {
        if (allSessions.length === 0) return;

        try {
            let totalDist = 0;
            let totalFuelEff = 0;
            let fuelEffCount = 0;

            // Helper to normalize keys
            const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

            allSessions.forEach(session => {
                const summaries: SessionSummaryItem[] = session.summary?.summaries || [];
                const getMetric = (keys: string[]): SessionSummaryItem | undefined => summaries.find((s) =>
                    keys.some(k => {
                        const nKey = normalize(k);
                        return (
                            (s.canonical_key && normalize(s.canonical_key) === nKey) ||
                            (s.parameter_key && normalize(s.parameter_key).includes(nKey)) ||
                            (s.label && normalize(s.label).includes(nKey))
                        );
                    })
                );

                const speed = getMetric(['vehicle_speed', 'speed', 'vss', '0x0d']);
                const durationHours = (session.duration_seconds || 0) / 3600;
                let avgSpeed = speed?.avg || 0;
                
                // Calculate distance
                // Note: We calculate in KM first (base unit), then convert at display time
                // OR we can convert here if GeneralInfoCard expects the unit already
                // Looking at GeneralInfoCard usage, it takes raw numbers.
                // Let's assume we store "distance" in the unit the user wants?
                // No, better to calculate "base distance" (km) and let the UI component handle display if it knows the unit.
                // However, GeneralInfoCard is a "dumb" component that just displays what's passed.
                // So we should convert HERE.
                
                if (distanceUnit === 'mi') {
                    avgSpeed *= 0.621371;
                }

                if (avgSpeed > 0 && durationHours > 0) {
                    totalDist += avgSpeed * durationHours;
                }

                // Fuel Consumption Calculation (Matches LatestTripCard logic)
                // Priority 1: Calculated Robust (Speed / Rate)
                // Priority 2: Average Fuel Consumption (if sane)

                const avgFuelSummary = getMetric(['average_fuel_consumption', 'avg_fuel', 'avg fuel', 'average fuel consumption (today)', 'average fuel consumption']);
                const fuelRateSummary = getMetric(['mpg_or_fuel_rate', 'fuel_rate', 'fuel', '0x5e']);
                
                let sessionMPG = 0;
                let calculatedMPG = 0;

                // Method A: Speed / Rate
                if (fuelRateSummary?.avg && avgSpeed > 0) {
                    const rate = fuelRateSummary.avg;
                    // Note: avgSpeed is already converted to miles if distanceUnit is 'mi'
                    // We need speed in MPH and KPH to determine unit of rate
                    
                    // Recover base speed (km/h) and mph
                    let speedKmh = avgSpeed;
                    let speedMph = avgSpeed;
                    
                    if (distanceUnit === 'mi') {
                        speedKmh = avgSpeed / 0.621371;
                    } else {
                        speedMph = avgSpeed * 0.621371;
                    }

                    if (rate < 2.5) {
                        // Assume Gallons/Hour
                        if (rate > 0) calculatedMPG = speedMph / rate;
                    } else {
                        // Assume Liters/Hour
                        if (rate > 0 && speedKmh > 0) calculatedMPG = (2.35215 * speedKmh) / rate;
                    }
                }

                // Method B: Explicit Value
                if (avgFuelSummary?.avg) {
                    const val = avgFuelSummary.avg;
                    if (val < 150) {
                        calculatedMPG = val; // Assume MPG
                    }
                }

                // Decide which value to accumulate
                // We want to accumulate a value that matches the user's unit preference
                // If calculatedMPG is valid (>0, <200), we use it.
                // If user wants L/100km, we convert MPG -> L/100km
                
                if (calculatedMPG > 0 && calculatedMPG < 200) {
                    if (distanceUnit === 'mi') {
                        sessionMPG = calculatedMPG;
                    } else {
                        // Convert MPG to L/100km for accumulation
                        sessionMPG = 235.215 / calculatedMPG;
                    }
                }

                if (sessionMPG > 0) {
                    totalFuelEff += sessionMPG;
                    fuelEffCount++;
                }
            });

            const avgFuel = fuelEffCount > 0 ? totalFuelEff / fuelEffCount : 0;
            const flags = (await getFlagsForSessions(allSessions.map(s => s.id))) as unknown as SessionFlag[];

            // Filter active flags for KPI count
            const activeFlags = flags.filter((f) => !f.resolved);

            setGeneralStats({
                totalDistance: totalDist,
                avgFuel: avgFuel,
                problemCount: activeFlags.length,
                healthScore: Math.max(0, 100 - (activeFlags.length * 5)),
                problems: flags // per-trip alerts; the Problems list itself comes from useOpenProblems
            });
        } catch (error) {
            console.error('Failed to calculate general stats:', error);
        }
    };

    calculateGeneralStats();
  }, [allSessions, distanceUnit]);

  const handleUploadComplete = useCallback((sessionId: string) => {
    loadDashboard(); 
    setIsUploadOpen(false);
    navigate(`/session/${sessionId}`);
  }, [navigate, loadDashboard]);

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Critical': return 'text-destructive';
      case 'Attention': return 'text-warn';
      case 'Good': return 'text-primary';
      default: return 'text-success';
    }
  };


  if (!selectedCarId && !carsLoading) {
    return (
      <AppLayout>
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <Car className="w-12 h-12 text-primary/30 mx-auto mb-4" />
            <h3 className="text-sm font-mono font-semibold text-foreground mb-2">No Vehicle Selected</h3>
            <p className="text-xs text-muted-foreground mb-4">
              Please select or add a vehicle to view the dashboard.
            </p>
            <Button size="sm" onClick={() => navigate('/cars')}>
              Manage Vehicles
            </Button>
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  if (loading || statsLoading) {
    return (
      <AppLayout>
        <PageLoader fullScreen={false} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-5 max-w-4xl">
        <ProblemsBanner problems={openProblems} />

        <h2 className="text-2xl font-bold text-foreground">{selectedCar?.name || t('home.title', 'Home')}</h2>

        {/* 1. Is my car OK? */}
        <CarHealthCard problems={openProblems} lastTrip={allSessions[0] ?? null} />

        {/* 2. The one action: start / follow a trip */}
        <TripCard />

        {/* 3. Last trip and totals */}
        {allSessions.length > 0 && (
          <>
            <LastTripSummary session={allSessions[0]} />
            <TripTotals sessions={allSessions} />
          </>
        )}

        <p className="text-sm text-muted-foreground">
          {t('home.import', 'Have a recording from another app (Car Scanner, Torque)?')}{' '}
          <button type="button" className="text-primary hover:underline" onClick={() => setIsUploadOpen(true)}>
            {t('home.importAction', 'Import a file')}
          </button>
        </p>

        <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
          <DialogContent className="sm:max-w-md max-sm:top-4 max-sm:translate-y-0 max-sm:left-3 max-sm:right-3 max-sm:w-auto max-sm:max-w-none max-h-[calc(100dvh-6rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('home.importTitle', 'Import a recording')}</DialogTitle>
            </DialogHeader>
            <UploadCard onComplete={handleUploadComplete} carProfileId={selectedCarId || undefined} />
          </DialogContent>
        </Dialog>

        {/* Everything technical stays one tap away, closed by default */}
        {allSessions.length > 0 && (
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowTechnical((v) => !v)}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={showTechnical}
            >
              {showTechnical ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              {t('home.technical', 'Technical details')}
            </button>

            {showTechnical && (
              <div className="space-y-6 mt-4">
                <Select value={dateRange} onValueChange={setDateRange}>
                  <SelectTrigger className="w-[150px] bg-card border-border h-9 text-xs">
                    <Calendar className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                    <SelectValue placeholder="Date Range" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7d">Last 7 Days</SelectItem>
                    <SelectItem value="30d">Last 30 Days</SelectItem>
                    <SelectItem value="90d">Last 3 Months</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                  </SelectContent>
                </Select>

                {stats.totalSessions === 0 ? (
                  <p className="text-sm text-muted-foreground">No sessions in the selected period.</p>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 sm:gap-6 items-center">
                      <div className="flex justify-center">
                        <HealthGauge score={generalStats.healthScore} status={stats.status} size={140} />
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:gap-3">
                        <StatCard icon={Activity} label="Sessions" value={stats.totalSessions} />
                        <StatCard
                          icon={Gauge}
                          label={distanceUnit === 'mi' ? 'Miles' : 'Kilometers'}
                          value={Math.round(generalStats.totalDistance).toLocaleString()}
                        />
                        <StatCard icon={Clock} label="Drive Time" value={`${Math.round(stats.totalDurationSeconds / 60)}`} unit="min" />
                        <StatCard
                          icon={AlertTriangle}
                          label="Active Issues"
                          value={openProblems.length}
                          tone={openProblems.length > 0 ? (openProblems.some(p => p.severity === 'critical') ? 'critical' : 'warn') : 'success'}
                          onClick={() => navigate('/issues')}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <LatestTripCard
                        sessions={allSessions}
                        onUploadClick={() => setIsUploadOpen(true)}
                        onSessionUpdate={loadDashboard}
                      />
                      <GeneralInfoCard
                        stats={{ ...generalStats, problemCount: openProblems.length }}
                        onProblemsClick={() => navigate('/issues')}
                      />
                    </div>

                    <AdaptiveMetricsSection
                      engineType={selectedCar?.engine_type}
                      latestSession={allSessions[0] ?? null}
                      carId={selectedCarId || ''}
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
