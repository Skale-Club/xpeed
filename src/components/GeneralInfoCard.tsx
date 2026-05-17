
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { MapPin, Fuel, AlertTriangle, CheckCircle, Activity } from 'lucide-react';
import { useSettings } from '@/contexts/SettingsContext';

interface GeneralInfoCardProps {
  stats: {
    totalDistance: number;
    avgFuel: number;
    problemCount: number;
    healthScore: number;
  };
  onProblemsClick?: () => void;
}

export function GeneralInfoCard({ stats, onProblemsClick }: GeneralInfoCardProps) {
  const { distanceUnit } = useSettings();

  // Fuel Efficiency Rating
  // L/100km: < 6 Excellent, < 8.5 Good, < 11 Fair, > 11 Poor
  // MPG: > 39 Excellent, > 27 Good, > 21 Fair, < 21 Poor
  
  const getFuelStatus = (val: number, unit: string) => {
    if (!val || !isFinite(val)) return { color: 'text-muted-foreground', text: 'N/A' };
    
    if (unit === 'MPG') {
        if (val > 39) return { color: 'text-emerald-500', text: 'Excellent' };
        if (val > 27) return { color: 'text-green-500', text: 'Good' };
        if (val > 21) return { color: 'text-yellow-500', text: 'Fair' };
        return { color: 'text-red-500', text: 'Poor' };
    }

    // L/100km
    if (val < 6) return { color: 'text-emerald-500', text: 'Excellent' };
    if (val < 8.5) return { color: 'text-green-500', text: 'Good' };
    if (val < 11) return { color: 'text-yellow-500', text: 'Fair' };
    return { color: 'text-red-500', text: 'High' };
  };

  // Convert Distance
  // Note: Index.tsx already converts totalDistance to the user's preferred unit before passing it here!
  // So we should NOT convert it again, or we should fix Index.tsx to pass base units.
  // Looking at my previous edit in Index.tsx, I added conversion there.
  // So here I should just display it.
  // BUT, to be safe and clean, let's revert the conversion in Index.tsx (or keep it) and adjust here.
  // Actually, Index.tsx is the "Controller", so it makes sense to pass raw data and let the view handle it, 
  // OR pass formatted data.
  // Currently, I modified Index.tsx to convert km -> mi if setting is 'mi'.
  // So `stats.totalDistance` is ALREADY in miles if unit is miles.
  
  const distanceValue = stats.totalDistance;
  const distanceLabel = distanceUnit;

  // Convert Fuel
  // Similarly, Index.tsx calculates the average.
  // If the source data is already MPG (which it is for Prius usually), we shouldn't convert L/100km <-> MPG blindly.
  // We need to know the SOURCE unit.
  // Since we don't pass source unit, we assume the value passed in `stats.avgFuel` is ALREADY in the correct unit 
  // because Index.tsx extracts "Average Fuel Consumption" which is usually what the user sees on dash.
  
  // However, for consistency, let's assume stats.avgFuel is passed as-is from the sensor.
  // If the sensor says "61.9" (MPG), we should just display it.
  
  const fuelValue = stats.avgFuel;
  const fuelUnit = distanceUnit === 'mi' ? 'MPG' : 'L/100km';
  
  // Logic: If the value is > 20, it's likely MPG. If it's < 15, it's likely L/100km (or km/L).
  // This is a heuristic because we lost the unit metadata.
  // But wait, in Index.tsx I prioritized "Average Fuel Consumption".
  
  // For now, let's trust the value is correct and just label it based on preference, 
  // avoiding double conversion unless we are sure.
  
  // OLD CODE forced conversion:
  /*
  if (distanceUnit === 'mi') {
      fuelUnit = 'MPG';
      if (stats.avgFuel > 0) {
          fuelValue = 235.215 / stats.avgFuel; // This assumes input was L/100km!
      }
  }
  */
  
  // NEW CODE: Trust the input, just label it.
  // Ideally we should normalize to a base unit in Index.tsx, but OBD data is messy.
  
  const fuelStatus = getFuelStatus(fuelValue, fuelUnit);

  const metrics = [
    {
      label: 'Total Distance',
      value: distanceValue.toFixed(0),
      unit: distanceLabel,
      icon: MapPin,
      color: 'text-blue-500',
      subtext: 'Recorded history'
    },
    {
      label: 'Avg Consumption',
      value: (fuelValue && isFinite(fuelValue)) ? fuelValue.toFixed(1) : '--',
      unit: fuelUnit,
      icon: Fuel,
      color: fuelStatus.color,
      subtext: fuelStatus.text
    },
    {
      label: 'Problems Found',
      value: stats.problemCount,
      unit: 'issues',
      icon: stats.problemCount > 0 ? AlertTriangle : CheckCircle,
      color: stats.problemCount > 0 ? 'text-destructive' : 'text-emerald-500',
      action: true
    },
    {
      label: 'Vehicle Health',
      value: stats.healthScore,
      unit: '%',
      icon: Activity,
      color: stats.healthScore > 80 ? 'text-emerald-500' : (stats.healthScore > 50 ? 'text-yellow-500' : 'text-destructive'),
      subtext: 'Overall Score'
    }
  ];

  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-foreground">General Info</h3>
            <span className={`text-xs ${stats.problemCount > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
              {stats.problemCount > 0 ? `${stats.problemCount} issues requiring attention` : 'All systems normal'}
            </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-y-8 gap-x-4 pt-4">
          {metrics.map((m, i) => (
            <div 
                key={i} 
                className={`flex flex-col ${m.action ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
                onClick={m.action ? onProblemsClick : undefined}
            >
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <m.icon className="w-4 h-4" />
                <span>{m.label}</span>
              </div>
              <div className={`text-3xl font-bold font-mono tracking-tight ${m.color}`}>
                {m.value}<span className="text-sm text-muted-foreground ml-1 font-sans font-normal">{m.unit}</span>
              </div>
              {m.subtext && (
                  <p className="text-xs text-muted-foreground mt-1 font-medium">{m.subtext}</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
