import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import UploadCard from '@/components/UploadCard';
import DashboardCharts from '@/components/DashboardCharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getSessions, getSessionFlags, getFlagsForSessions, toggleFlagResolved } from '@/lib/db';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { ArrowRight, Gauge, Car, Activity, Clock, AlertTriangle, AlertCircle, CheckCircle, Calendar, ExternalLink, CheckSquare, Square, Eye, EyeOff } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { subDays } from 'date-fns';
import { toast } from 'sonner';
import type { Session, SessionFlag, SessionSummaryItem } from '@/types/session';
import ActiveFlagsBanner from '@/components/ActiveFlagsBanner';
import HealthGauge from '@/components/HealthGauge';
import StatCard from '@/components/StatCard';
import { supabase } from '@/integrations/supabase/client';

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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ONBOARDING_KEY } from '@/pages/OnboardingPage';

const Index = () => {
  const navigate = useNavigate();
  const { cars, selectedCar, selectedCarId, loading: carsLoading } = useCarsContext();
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
  const [isProblemsOpen, setIsProblemsOpen] = useState(false);
  const [showResolvedProblems, setShowResolvedProblems] = useState(false);

  // First-run redirect: brand-new users with 0 cars should land in the
  // onboarding wizard, not on a blank dashboard. We honor a localStorage flag
  // so users who completed the wizard and then deleted all their cars still
  // see the regular empty state.
  useEffect(() => {
    if (carsLoading) return;
    const alreadyOnboarded = localStorage.getItem(ONBOARDING_KEY) === 'true';
    if (!alreadyOnboarded && cars.length === 0) {
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
                problems: flags // Store all, filter in UI based on showResolvedProblems
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

  const handleToggleResolved = async (flagId: string, currentResolved: boolean) => {
    try {
        await toggleFlagResolved(flagId, !currentResolved);
        
        // Optimistic update
        setGeneralStats(prev => {
            const updatedProblems = prev.problems.map(p => 
                p.id === flagId ? { ...p, resolved: !currentResolved } : p
            );
            
            const activeCount = updatedProblems.filter(p => !p.resolved).length;
            
            return {
                ...prev,
                problems: updatedProblems,
                problemCount: activeCount,
                healthScore: Math.max(0, 100 - (activeCount * 5))
            };
        });
        
        toast.success(currentResolved ? 'Issue marked as unresolved' : 'Issue marked as resolved');
    } catch (err) {
        console.error('Failed to toggle resolved status:', err);
        toast.error('Failed to update status');
    }
  };

  const visibleProblems = generalStats.problems.filter(p => showResolvedProblems || !p.resolved);

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
      <div className="space-y-6">
        {/* Mobile-first: active flags banner above everything else */}
        <ActiveFlagsBanner
          flags={generalStats.problems}
          onClick={() => setIsProblemsOpen(true)}
        />

        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-mono font-bold text-foreground">
              {selectedCar?.name || 'Dashboard'}
            </h2>
            <p className="text-xs text-muted-foreground font-mono mt-1">
              Vehicle Health Overview
            </p>
          </div>
          <div className="flex items-center gap-4">
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
            {stats.lastUpload && (
              <div className="text-right hidden sm:block">
                <p className="text-xs text-muted-foreground font-mono">Last Sync</p>
                <p className="text-sm font-medium text-foreground">
                  {stats.lastUpload.toLocaleDateString(undefined, { timeZone: timezone })}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Empty State */}
        {stats.totalSessions === 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <UploadCard onComplete={handleUploadComplete} carProfileId={selectedCarId || undefined} />
            </div>
            <Card className="bg-card border-border">
              <CardContent className="p-4 flex flex-col justify-center h-full">
                <div className="flex items-center gap-2 mb-2">
                  <Gauge className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-mono font-semibold text-foreground">Quick Start</h3>
                </div>
                <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
                  <li>Export CSV from Car Scanner</li>
                  <li>Drop it on the upload area</li>
                  <li>View instant health analysis</li>
                </ol>
              </CardContent>
            </Card>
          </div>
        ) : (
          <>
          {/* At-a-glance: health gauge + key KPIs (mobile-first: stacks vertically) */}
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 sm:gap-6 mb-6 items-center">
            <div className="flex justify-center">
              <HealthGauge score={generalStats.healthScore} status={stats.status} size={140} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <StatCard
                icon={Activity}
                label="Sessions"
                value={stats.totalSessions}
              />
              <StatCard
                icon={Gauge}
                label={distanceUnit === 'mi' ? 'Miles' : 'Kilometers'}
                value={Math.round(generalStats.totalDistance).toLocaleString()}
              />
              <StatCard
                icon={Clock}
                label="Drive Time"
                value={`${Math.round(stats.totalDurationSeconds / 60)}`}
                unit="min"
              />
              <StatCard
                icon={AlertTriangle}
                label="Active Problems"
                value={generalStats.problemCount}
                tone={generalStats.problemCount > 0 ? (generalStats.problems.some(p => !p.resolved && p.severity === 'critical') ? 'critical' : 'warn') : 'success'}
                onClick={() => setIsProblemsOpen(true)}
              />
            </div>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <LatestTripCard
              sessions={allSessions}
              onUploadClick={() => setIsUploadOpen(true)}
              onSessionUpdate={loadDashboard}
            />
            <GeneralInfoCard
              stats={generalStats}
              onProblemsClick={() => setIsProblemsOpen(true)}
            />
          </div>

          <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
              <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                      <DialogTitle>Upload New Trip</DialogTitle>
                  </DialogHeader>
                  <UploadCard onComplete={handleUploadComplete} carProfileId={selectedCarId || undefined} />
              </DialogContent>
          </Dialog>

          <Dialog open={isProblemsOpen} onOpenChange={setIsProblemsOpen}>
              <DialogContent className="sm:max-w-md max-h-[80vh] overflow-hidden flex flex-col">
                  <DialogHeader className="flex flex-row items-center justify-between pr-8">
                      <DialogTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-yellow-500" />
                          Vehicle Health Issues
                      </DialogTitle>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowResolvedProblems(!showResolvedProblems)}
                        title={showResolvedProblems ? "Hide Resolved" : "Show Resolved"}
                      >
                        {showResolvedProblems ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </Button>
                  </DialogHeader>
                  <div className="flex-1 overflow-y-auto pr-2">
                      {visibleProblems.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground text-center">
                              <CheckCircle className="w-16 h-16 mb-4 text-emerald-500 opacity-20" />
                              <p className="text-lg font-medium text-foreground">
                                {generalStats.problems.length > 0 && !showResolvedProblems 
                                    ? "No active issues" 
                                    : "All Systems Normal"}
                              </p>
                              <p className="text-sm mt-1">
                                {generalStats.problems.length > 0 && !showResolvedProblems 
                                    ? "All recorded problems have been marked as resolved." 
                                    : "No diagnostic trouble codes or warnings found in recorded history."}
                              </p>
                          </div>
                      ) : (
                          <div className="space-y-3 py-2">
                              {visibleProblems.map((flag, i) => (
                                  <div key={flag.id || i} className={`flex flex-col gap-1 p-3 rounded-lg border transition-colors ${
                                      flag.resolved 
                                        ? 'bg-muted/10 border-border/30 opacity-60' 
                                        : 'bg-muted/30 border-border/50 hover:bg-muted/50'
                                  }`}>
                                      <div className="flex items-start justify-between gap-2">
                                          <div className="flex items-center gap-2">
                                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                                  flag.severity === 'critical' ? 'bg-destructive/10 text-destructive' : 'bg-yellow-500/10 text-yellow-600'
                                              }`}>
                                                  {flag.severity || 'WARN'}
                                              </span>
                                              <span className={`font-mono font-bold text-sm ${flag.resolved ? 'line-through text-muted-foreground' : ''}`}>
                                                  {flag.canonical_key || flag.parameter_key || 'UNKNOWN'}
                                              </span>
                                          </div>
                                          <div className="flex items-center gap-2">
                                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                                  {new Date(flag.sessions?.uploaded_at).toLocaleDateString(undefined, { timeZone: timezone })}
                                              </span>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 -mr-2 text-muted-foreground hover:text-primary"
                                                onClick={() => handleToggleResolved(flag.id, flag.resolved)}
                                                title={flag.resolved ? "Mark as Unresolved" : "Mark as Resolved"}
                                              >
                                                {flag.resolved ? <CheckSquare className="w-4 h-4 text-emerald-500" /> : <Square className="w-4 h-4" />}
                                              </Button>
                                          </div>
                                      </div>
                                      <p className="text-sm text-foreground/90 leading-snug">
                                          {flag.message || 'No detailed description available for this issue.'}
                                      </p>
                                      <div className="flex items-center justify-between mt-1">
                                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                              <Clock className="w-3 h-3" />
                                              <span>Session: {flag.sessions?.source_filename}</span>
                                          </div>
                                          {(flag.canonical_key || flag.parameter_key) && (
                                              <Button 
                                                variant="ghost" 
                                                size="sm" 
                                                className="h-5 text-[10px] px-2 hover:bg-background"
                                                onClick={() => window.open(`https://www.google.com/search?q=OBD2+issue+${flag.canonical_key || flag.parameter_key}+solution`, '_blank')}
                                              >
                                                Search Solution <ExternalLink className="w-3 h-3 ml-1" />
                                              </Button>
                                          )}
                                      </div>
                                  </div>
                              ))}
                          </div>
                      )}
                  </div>
              </DialogContent>
          </Dialog>

          {/* Sensor Trends */}
          <div className="space-y-4 mt-6">
            <h3 className="text-sm font-mono font-semibold text-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Detailed Analytics & Trends
            </h3>
            <DashboardCharts sessions={filteredSessions} />
          </div>
        </>
      )}
    </div>
  </AppLayout>
);
};

export default Index;
