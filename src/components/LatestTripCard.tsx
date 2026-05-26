
import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Info, ChevronRight, ChevronLeft, Fuel, Gauge, Clock, MapPin, BarChart3 } from 'lucide-react';
import { getSessionRows } from '@/lib/db';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '@/contexts/SettingsContext';
import type { Session, SessionSummaryItem } from '@/types/session';

interface LatestTripCardProps {
  sessions: Session[];
  onUploadClick: () => void;
  onSessionUpdate?: () => void;
}

interface TrendPoint {
  date: Date;
  formattedDate?: string;
  value?: number;
  duration?: number;
  maxSpeed?: number;
  avgFuel?: number | null;
  [key: string]: unknown;
}

export function LatestTripCard({ sessions, onUploadClick, onSessionUpdate }: LatestTripCardProps) {
  const navigate = useNavigate();
  const { distanceUnit } = useSettings();
  const [selectedId, setSelectedId] = useState<string>('latest');
  const [chartData, setChartData] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(false);

  // Determine the active session or aggregation mode
  const activeSession = useMemo(() => {
    if (!sessions || sessions.length === 0) return null;
    if (selectedId === 'latest') return sessions[0];
    if (selectedId === 'all') return null; // Aggregated mode
    return sessions.find(s => s.id === selectedId) || sessions[0];
  }, [sessions, selectedId]);

  const isAggregated = selectedId === 'all';

  // Navigation handlers
  const handlePrevTrip = () => {
    if (!sessions.length || isAggregated) return;
    const currentIndex = sessions.findIndex(s => s.id === activeSession?.id);
    if (currentIndex < sessions.length - 1) {
        setSelectedId(sessions[currentIndex + 1].id);
    }
  };

  const handleNextTrip = () => {
    if (!sessions.length || isAggregated) return;
    const currentIndex = sessions.findIndex(s => s.id === activeSession?.id);
    if (currentIndex > 0) {
        setSelectedId(sessions[currentIndex - 1].id);
    } else if (currentIndex === 0 && selectedId !== 'latest') {
        setSelectedId('latest');
    }
  };

  // Check if navigation is possible
  const canGoPrev = !isAggregated && sessions.length > 0 && activeSession && sessions.findIndex(s => s.id === activeSession.id) < sessions.length - 1;
  const canGoNext = !isAggregated && sessions.length > 0 && activeSession && sessions.findIndex(s => s.id === activeSession.id) > 0;


  // Calculate Aggregated Stats
  const aggregatedStats = useMemo(() => {
    if (!isAggregated || !sessions.length) return null;

    let totalDuration = 0;
    let totalDistance = 0;
    let maxSpeed = 0;
    const fuelRates: number[] = [];

    const trendData = sessions.map(session => {
        const summaries: SessionSummaryItem[] = session.summary?.summaries || [];
        // Helper to normalize keys for searching (removes spaces, underscores, case-insensitive)
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

        const getMetric = (keys: string[]): SessionSummaryItem | undefined => {
            return summaries.find((s) =>
            keys.some(k => {
                const nKey = normalize(k);
                return (
                    (s.canonical_key && normalize(s.canonical_key) === nKey) ||
                    (s.parameter_key && normalize(s.parameter_key).includes(nKey)) ||
                    (s.label && normalize(s.label).includes(nKey))
                );
            })
            );
        };

        const speedSummary = getMetric(['vehicle_speed', 'speed', 'vss', '0x0d']);
        const fuelRateSummary = getMetric(['mpg_or_fuel_rate', 'fuel_rate', 'fuel', '0x5e']);
        const avgFuelSummary = getMetric(['average_fuel_consumption', 'avg_fuel', 'avg fuel', 'average fuel consumption (today)', 'average fuel consumption']);

        const durationHours = (session.duration_seconds || 0) / 3600;
        let avgSpeed = speedSummary?.avg || 0;
        
        // Convert speed if needed for calculation
        if (distanceUnit === 'mi') {
            avgSpeed *= 0.621371;
        }

        const dist = avgSpeed * durationHours;

        totalDuration += session.duration_seconds || 0;
        totalDistance += dist;
        
        let sessionMaxSpeed = speedSummary?.max || 0;
        if (distanceUnit === 'mi') {
            sessionMaxSpeed *= 0.621371;
        }
        if (sessionMaxSpeed > maxSpeed) maxSpeed = sessionMaxSpeed;
        
        // Prioritize explicit average fuel consumption, fall back to calculated rate
        if (avgFuelSummary?.avg) {
            fuelRates.push(avgFuelSummary.avg);
        } else if (fuelRateSummary?.avg) {
             fuelRates.push(fuelRateSummary.avg);
        }

        return {
            date: new Date(session.session_start || session.uploaded_at).toLocaleDateString(),
            value: avgSpeed // For graph: Avg Speed trend
        };
    }).reverse(); // Chronological order

    const avgFuel = fuelRates.length > 0 ? fuelRates.reduce((a, b) => a + b, 0) / fuelRates.length : 0;

    return {
        duration: Math.round(totalDuration / 60),
        distance: totalDistance.toFixed(1),
        maxSpeed: Math.round(maxSpeed),
        fuel: avgFuel ? `${avgFuel.toFixed(1)} MPG` : 'N/A',
        trendData
    };
  }, [sessions, isAggregated, distanceUnit]);

  // Session-specific logic
  const durationMinutes = activeSession ? (activeSession.duration_seconds ? Math.round(activeSession.duration_seconds / 60) : 0) : 0;
  
  const summaries: SessionSummaryItem[] = activeSession?.summary?.summaries || [];

  // Helper to normalize keys for searching (removes spaces, underscores, case-insensitive)
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const getMetric = (keys: string[]): SessionSummaryItem | undefined => {
    return summaries.find((s) =>
      keys.some(k => {
        const nKey = normalize(k);
        return (
            (s.canonical_key && normalize(s.canonical_key) === nKey) ||
            (s.parameter_key && normalize(s.parameter_key).includes(nKey)) ||
            (s.label && normalize(s.label).includes(nKey))
        );
      })
    );
  };

  const speedSummary = getMetric(['vehicle_speed', 'speed', 'vss', '0x0d']);
  const fuelRateSummary = getMetric(['mpg_or_fuel_rate', 'fuel_rate', 'fuel', '0x5e']);
  const avgFuelSummary = getMetric(['average_fuel_consumption', 'avg_fuel', 'avg fuel', 'average fuel consumption (today)', 'average fuel consumption']);
  const fuelUsedSummary = getMetric(['fuel_used', 'fuel used', 'fuel_used_total']);
  const distanceSummary = getMetric(['distance_travelled', 'distance travelled', 'distance', 'distance_traveled']);
  
  let avgSpeed = speedSummary?.avg || 0;
  let maxSpeed = speedSummary?.max || 0;

  // Base calculation units (Metric: km/h, km)
  // But if the source is already converted (Torque Pro CSV can be in miles), we need to be careful.
  // However, usually we assume raw values are Metric unless stated.
  // But for calculations below, we try to use Fuel Rate and Speed to derive MPG.

  if (distanceUnit === 'mi') {
      avgSpeed *= 0.621371;
      maxSpeed *= 0.621371;
  }

  const durationHours = activeSession ? (activeSession.duration_seconds || 0) / 3600 : 0;
  const distance = (avgSpeed * durationHours).toFixed(1);
  
  // Logic for display fuel:
  // 1. Try robust calculation: (Speed / FuelRate) or (Distance / FuelUsed)
  // 2. Fallback to "Average Fuel Consumption" ONLY if sane (< 150)
  
  let fuelUsage = 'N/A';
  let calculatedMPG = 0;

  // Method A: Distance / Fuel Used (Best if available)
  // Note: We need to know units of Fuel Used. Assuming Gallons if small relative to distance, Liters if large?
  // Actually, let's skip Method A for now as "Fuel Used" unit is ambiguous (Gal vs L).
  
  // Method B: Speed / Fuel Rate (Robust for averages)
  // MPG = Speed(mph) / FuelRate(gph)
  // L/100km = (FuelRate(L/h) / Speed(km/h)) * 100
  
  if (fuelRateSummary?.avg && avgSpeed > 0) {
      // Guess Unit of Fuel Rate:
      // If < 2.0, likely Gallons/Hour (Prius uses ~0.5-1.5 GPH at cruise)
      // If > 2.0, likely Liters/Hour (Prius uses ~2-6 LPH at cruise)
      // This is a heuristic but effective for Prius.
      
      const rate = fuelRateSummary.avg;
      const speedKmh = speedSummary?.avg || 0;
      const speedMph = speedKmh * 0.621371;

      if (rate < 2.5) {
          // Assume Gallons/Hour
          // MPG = Speed(mph) / Rate(gph)
          if (rate > 0) calculatedMPG = speedMph / rate;
      } else {
          // Assume Liters/Hour
          // MPG = 235.215 / ( (Rate(L/h) / Speed(km/h)) * 100 )
          //     = 235.215 * Speed(km/h) / (Rate * 100)
          //     = 2.35215 * Speed(km/h) / Rate
          if (rate > 0 && speedKmh > 0) calculatedMPG = (2.35215 * speedKmh) / rate;
      }
  }

  // Method C: Trust "Average Fuel Consumption" if sane
  if (avgFuelSummary?.avg) {
      const val = avgFuelSummary.avg;
      // Sanity check: If > 150, assume it's garbage or scaled wrong, so ignore it unless we have no other choice.
      if (val < 150) {
          calculatedMPG = val; // Assume it's MPG (Torque default for US) or we need to detect unit?
          // If it's L/100km, 5.0 is typical. 
          // If MPG, 50.0 is typical.
          // If < 15, assume L/100km? No, 10 MPG is possible.
          // Let's assume the PID unit matches the User's Torque preference (MPG).
      }
  }

  // Final Selection
  if (calculatedMPG > 0 && calculatedMPG < 200) {
      if (distanceUnit === 'mi') {
        fuelUsage = `${calculatedMPG.toFixed(1)} MPG`;
      } else {
        // Convert MPG to L/100km
        const l100 = 235.215 / calculatedMPG;
        fuelUsage = `${l100.toFixed(1)} L/100km`;
      }
  } else if (avgFuelSummary?.avg && avgFuelSummary.avg < 150) {
       // Fallback to explicit value if reasonable
       fuelUsage = `${avgFuelSummary.avg.toFixed(1)} ${distanceUnit === 'mi' ? 'MPG' : 'L/100km'}`;
  } else if (calculatedMPG > 200) {
      // If calculated is massive (EV driving?), cap it or show max
      fuelUsage = distanceUnit === 'mi' ? '199+ MPG' : '0.1 L/100km';
  }

  // Fetch chart data for specific session
  useEffect(() => {
    if (isAggregated || !activeSession) {
        if (isAggregated && aggregatedStats) {
            setChartData(aggregatedStats.trendData);
        }
        return;
    }

    let mounted = true;
    setLoading(true);
    
    const fetchRows = async () => {
      try {
        const rows = await getSessionRows(activeSession.id);
        if (mounted) {
            const speedKey = speedSummary?.parameter_key;
            if (speedKey) {
                const data: TrendPoint[] = rows.map((r) => {
                    const data = r.data as Record<string, unknown>;
                    let val = data[speedKey];
                    if (typeof val === 'number' && distanceUnit === 'mi') {
                        val *= 0.621371;
                    }
                    return { value: typeof val === 'number' ? val : undefined, date: new Date() };
                }).filter((d) => typeof d.value === 'number');
                setChartData(data);
            } else {
                setChartData([]);
            }
        }
      } catch (err) {
        console.error("Failed to fetch sparkline data", err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchRows();
    return () => { mounted = false; };
  }, [activeSession, isAggregated, aggregatedStats, distanceUnit]); // Added aggregatedStats dependency

  if (!sessions || sessions.length === 0) {
      return (
        <Card className="bg-card border-border overflow-hidden h-full flex flex-col justify-center items-center p-6 text-center">
            <div className="bg-primary/10 p-4 rounded-full mb-4">
                <BarChart3 className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No Sessions Yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Upload your first OBD2 CSV file to see session analysis.</p>
            <Button onClick={onUploadClick} className="gap-2">
                <Plus className="w-4 h-4" /> New Session
            </Button>
        </Card>
      );
  }

  // Display values
  const displayDuration = isAggregated ? aggregatedStats?.duration : durationMinutes;
  const displayDistance = isAggregated ? aggregatedStats?.distance : distance;
  const displayFuel = isAggregated ? aggregatedStats?.fuel : fuelUsage;
  const displayMaxSpeed = isAggregated ? aggregatedStats?.maxSpeed : (Math.round(maxSpeed));
  
  const unitLabel = distanceUnit === 'mi' ? 'mi' : 'km';
  const speedUnitLabel = distanceUnit === 'mi' ? 'mph' : 'km/h';

  return (
    <Card className="bg-card border-border overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
             <div className="flex flex-col">
                <h3 className="text-lg font-semibold text-foreground">Session Analysis</h3>
                {activeSession && !isAggregated && (
                    <span className="text-xs text-muted-foreground font-mono">
                        {new Date(activeSession.session_start || activeSession.uploaded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                         {' · '}{new Date(activeSession.session_start || activeSession.uploaded_at).toLocaleDateString()}
                    </span>
                )}
                {isAggregated && (
                    <span className="text-xs text-muted-foreground font-mono">
                        All Time Summary ({sessions.length} sessions)
                    </span>
                )}
             </div>
          </div>
          
          <div className="flex items-center gap-2">
            {!isAggregated && (
                <div className="flex items-center gap-1 mr-2">
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8" 
                        onClick={handlePrevTrip}
                        disabled={!canGoPrev}
                        title="Previous Session (Older)"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8" 
                        onClick={handleNextTrip}
                        disabled={!canGoNext}
                        title="Next Session (Newer)"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </Button>
                </div>
            )}

            <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                    <SelectValue placeholder="Select Session" />
                </SelectTrigger>
                <SelectContent align="end">
                    <SelectItem value="latest">Latest Session</SelectItem>
                    <SelectItem value="all">Merge All (Summary)</SelectItem>
                    <div className="h-px bg-border my-1" />
                    {sessions.map(s => {
                        const date = new Date(s.session_start || s.uploaded_at);
                        return (
                        <SelectItem key={s.id} value={s.id}>
                            {date.toLocaleDateString()} - {date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>

            {!isAggregated && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary hidden sm:inline-block">
                    Completed
                </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wider">
              <Clock className="w-3.5 h-3.5" /> {isAggregated ? 'Total Duration' : 'Duration'}
            </div>
            <div className="text-2xl font-bold font-mono">
              {displayDuration} <span className="text-sm font-normal text-muted-foreground">min</span>
            </div>
          </div>
          
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wider">
              <MapPin className="w-3.5 h-3.5" /> {isAggregated ? 'Total Dist' : 'Distance'}
            </div>
            <div className="text-2xl font-bold font-mono">
              {displayDistance} <span className="text-sm font-normal text-muted-foreground">{unitLabel}</span>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wider">
              <Fuel className="w-3.5 h-3.5" /> Avg Fuel
            </div>
            <div className="text-2xl font-bold font-mono truncate" title={String(displayFuel)}>
              {displayFuel}
            </div>
          </div>
        </div>

        <div className="h-[120px] w-full mt-4 relative group">
            {loading ? (
                <div className="w-full h-full flex items-center justify-center bg-muted/10 rounded-lg animate-pulse">
                    <span className="text-xs text-muted-foreground">Loading chart...</span>
                </div>
            ) : chartData.length > 0 ? (
                <>
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <Tooltip 
                            content={({ active, payload }) => {
                                if (active && payload && payload.length) {
                                return (
                                    <div className="bg-popover border border-border p-2 rounded shadow-lg">
                                        <p className="text-xs font-mono">
                                            {isAggregated 
                                                ? `${payload[0].payload.date}: ${payload[0].value?.toFixed(1)} ${speedUnitLabel}`
                                                : `${payload[0].value?.toFixed(1)} ${speedUnitLabel}`
                                            }
                                        </p>
                                    </div>
                                );
                                }
                                return null;
                            }}
                        />
                        <Area 
                            type="monotone" 
                            dataKey="value" 
                            stroke="hsl(var(--primary))" 
                            fillOpacity={1} 
                            fill="url(#colorSpeed)" 
                            strokeWidth={2}
                        />
                        </AreaChart>
                    </ResponsiveContainer>
                    <div className="absolute bottom-2 right-2 text-[10px] font-mono text-muted-foreground bg-background/80 px-1 rounded backdrop-blur-sm">
                        {isAggregated ? 'Avg Speed Trend' : `Max Speed: ${displayMaxSpeed} ${speedUnitLabel}`}
                    </div>
                </>
            ) : (
                <div className="w-full h-full flex items-center justify-center bg-muted/10 rounded-lg">
                    <span className="text-xs text-muted-foreground">No speed data available</span>
                </div>
            )}
        </div>

        <div className="flex gap-3 mt-6">
            <Button variant="outline" className="flex-1 gap-2 border-dashed" onClick={onUploadClick}>
                <Plus className="w-4 h-4" /> New Session
            </Button>
            <Button 
                className="flex-1 gap-2" 
                onClick={() => {
                    if (activeSession) {
                        navigate(`/session/${activeSession.id}`);
                    }
                }}
                disabled={isAggregated || !activeSession}
            >
                <Info className="w-4 h-4" /> Details
            </Button>
        </div>
      </CardContent>
    </Card>
  );
}
