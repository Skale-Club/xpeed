import { temperatureValue, temperatureLabel } from '@/lib/temperature';
import { useMemo } from 'react';
import { Activity, Fuel, Gauge, SlidersHorizontal, Thermometer, Wind, Zap, type LucideIcon } from 'lucide-react';
import { Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line, Bar, ComposedChart } from 'recharts';
import { Panel } from '@/components/ui/panel';
import { AreaGradient, ChartLegend } from '@/components/ui/chart-kit';
import { CHART_AXIS, CHART_BAR, CHART_GRID, CHART_LINE, CHART_TOOLTIP, type Accent } from '@/lib/chart-theme';
import { useTranslation } from 'react-i18next';
import { formatTripDate } from '@/lib/trips';
import { useSettings } from '@/contexts/SettingsContext';
import type { Session, SessionSummaryItem } from '@/types/session';
import { CHART_PALETTE } from '@/lib/chart-palette';
import type { EngineType } from '@/lib/db';
import { ENGINE_TYPE_CONFIGS } from '@/lib/dashboard-config';

interface DashboardChartsProps {
  sessions: Session[];
  engineType?: EngineType | null;
}

interface ChartPoint {
  date: Date;
  formattedDate: string;
  [seriesKey: string]: number | string | Date | null | undefined;
}

interface ChartConfig {
  id: string;
  title: string;
  type: 'area' | 'line' | 'composed';
  yAxisUnit?: string;
  yAxisDomain?: [number, number];
  series: {
    key: string; // The canonical key or search term
    label: string;
    color: string;
    type?: 'line' | 'bar' | 'area';
    yAxisId?: string;
  }[];
}

/** Each chart's icon and colour in its panel header (Dashboards 2027: colour in breaks, one per block). */
const LOOK: Record<string, { icon: LucideIcon; accent: Accent }> = {
  speed: { icon: Gauge, accent: 'blue' },
  temperature: { icon: Thermometer, accent: 'red' },
  voltage: { icon: Zap, accent: 'green' },
  engine: { icon: Activity, accent: 'purple' },
  fuel_trim: { icon: SlidersHorizontal, accent: 'amber' },
  fuel_econ: { icon: Fuel, accent: 'green' },
  emissions: { icon: Wind, accent: 'pink' },
};

// Definition of available charts and their sensor mappings
const AVAILABLE_CHARTS: ChartConfig[] = [
  {
    id: 'speed',
    title: 'Speed Trend',
    type: 'area',
    yAxisUnit: 'km/h',
    series: [
      { key: 'vehicle_speed', label: 'Max Speed', color: CHART_PALETTE.blue, type: 'area' },
      { key: 'vehicle_speed_avg', label: 'Avg Speed', color: CHART_PALETTE.blueLight, type: 'line' }
    ]
  },
  {
    id: 'temperature',
    title: 'Temperature Monitor',
    type: 'line',
    yAxisUnit: '°C',
    series: [
      { key: 'coolant_temp', label: 'Coolant', color: CHART_PALETTE.red },
      { key: 'intake_air_temp', label: 'Intake', color: CHART_PALETTE.amber },
      { key: 'ambient_air_temp', label: 'Ambient', color: CHART_PALETTE.green },
      { key: 'catalyst_temp', label: 'Catalyst', color: CHART_PALETTE.purple },
      { key: 'oil_temp', label: 'Oil', color: CHART_PALETTE.pink },
      { key: 'transmission_temp', label: 'Trans', color: CHART_PALETTE.indigo }
    ]
  },
  {
    id: 'voltage',
    title: 'Voltage Levels',
    type: 'line',
    yAxisUnit: 'V',
    yAxisDomain: [10, 16],
    series: [
      { key: 'battery_voltage_12v', label: 'Battery Max', color: CHART_PALETTE.green },
      { key: 'obd_module_voltage', label: 'OBD Module', color: CHART_PALETTE.blue },
      { key: 'control_module_voltage', label: 'Control Module', color: CHART_PALETTE.amber }
    ]
  },
  {
    id: 'engine',
    title: 'Engine Performance',
    type: 'composed',
    series: [
      { key: 'engine_rpm', label: 'Max RPM', color: CHART_PALETTE.purple, type: 'bar', yAxisId: 'left' },
      { key: 'engine_load', label: 'Avg Load %', color: CHART_PALETTE.pink, type: 'line', yAxisId: 'right' }
    ]
  },
  {
    id: 'fuel_trim',
    title: 'Fuel Trims (Short Term)',
    type: 'line',
    yAxisUnit: '%',
    series: [
      { key: 'stft_b1', label: 'STFT B1', color: CHART_PALETTE.amber },
      { key: 'stft_b2', label: 'STFT B2', color: CHART_PALETTE.red }
    ]
  },
  {
    id: 'fuel_econ',
    title: 'Fuel Economy',
    type: 'line',
    series: [
      { key: 'mpg_or_fuel_rate', label: 'Fuel Rate', color: CHART_PALETTE.green },
      { key: 'average_fuel_consumption', label: 'Avg Consumption', color: CHART_PALETTE.blue }
    ]
  },
  {
    id: 'emissions',
    title: 'O2 Sensors & Emissions',
    type: 'line',
    yAxisUnit: 'V',
    series: [
      { key: 'o2_b1s1', label: 'O2 B1S1', color: CHART_PALETTE.purple },
      { key: 'o2_b1s2', label: 'O2 B1S2', color: CHART_PALETTE.pink }
    ]
  }
];

// Helper to normalize keys for searching
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Mapping of variations to canonical keys (for fallback)
const KEY_MAPPING: Record<string, string[]> = {
  'vehicle_speed': ['vehicle_speed', 'speed', 'vss', 'velocity', '0x0d'],
  'vehicle_speed_avg': ['vehicle_speed', 'speed', 'vss', 'velocity', '0x0d'], // Special handling for avg
  'coolant_temp': ['coolant_temp', 'coolant', 'ect', 'water temp', '0x05'],
  'intake_air_temp': ['intake_air_temp', 'intake', 'iat', '0x0f'],
  'ambient_air_temp': ['ambient_air_temp', 'ambient', 'outside', '0x46'],
  'catalyst_temp': ['catalyst_temp', 'catalyst', 'cat temp', '0x3c'],
  'oil_temp': ['oil_temp', 'engine oil', 'eot'],
  'battery_voltage_12v': ['battery_voltage_12v', 'battery', 'vpwr', '0x42'],
  'obd_module_voltage': ['obd module voltage', 'adapter voltage'],
  'control_module_voltage': ['control module voltage', 'cmv'],
  'engine_rpm': ['engine_rpm', 'rpm', 'engine speed', '0x0c'],
  'engine_load': ['engine_load', 'load', '0x04'],
  'stft_b1': ['stft_b1', 'short term fuel trim bank 1', 'stft1'],
  'stft_b2': ['stft_b2', 'short term fuel trim bank 2', 'stft2'],
  'mpg_or_fuel_rate': ['mpg_or_fuel_rate', 'fuel rate', 'instant fuel'],
  'average_fuel_consumption': ['average_fuel_consumption', 'avg fuel', 'kpl', 'mpg'],
  'o2_b1s1': ['o2_b1s1', 'oxygen sensor 1', 'o2s1'],
  'o2_b1s2': ['o2_b1s2', 'oxygen sensor 2', 'o2s2']
};

export default function DashboardCharts({ sessions, engineType }: DashboardChartsProps) {
  const { distanceUnit, temperatureUnit } = useSettings();
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage;

  const { processedData, activeCharts } = useMemo(() => {
    if (sessions.length === 0) return { processedData: [], activeCharts: [] };

    // 1. Sort sessions
    const sortedSessions = [...sessions].sort((a, b) => {
      const dateA = a.session_start ? new Date(a.session_start) : new Date(a.uploaded_at);
      const dateB = b.session_start ? new Date(b.session_start) : new Date(b.uploaded_at);
      return dateA.getTime() - dateB.getTime();
    });

    // 2. Scan all sessions to see which keys are actually present
    const availableKeys = new Set<string>();
    
    // Helper to find value in a session summary
    const findValue = (summaryItems: SessionSummaryItem[], targetKey: string, type: 'max' | 'avg' | 'min' = 'max'): number | null => {
      const searchTerms = KEY_MAPPING[targetKey] || [targetKey];

      const item = summaryItems.find((s) =>
        searchTerms.some(term => {
          const nTerm = normalize(term);
          return (
            (s.canonical_key && normalize(s.canonical_key) === nTerm) ||
            (s.parameter_key && normalize(s.parameter_key).includes(nTerm)) ||
            (s.label && normalize(s.label).includes(nTerm))
          );
        })
      );

      if (item) {
        availableKeys.add(targetKey);
        const raw = item[type];
        return typeof raw === 'number' ? raw : null;
      }
      return null;
    };

    // 3. Build data points
    const data: ChartPoint[] = sortedSessions.map(session => {
      const summaries: SessionSummaryItem[] = session.summary?.summaries || [];
      const sessionDate = session.session_start ? new Date(session.session_start) : new Date(session.uploaded_at);

      const point: ChartPoint = {
        date: sessionDate,
        formattedDate: formatTripDate(sessionDate, language), // date and time, in the app language
      };

      // Extract all potential values
      AVAILABLE_CHARTS.forEach(chart => {
        chart.series.forEach(serie => {
            // Special handling for units or types
            const type = serie.key.endsWith('_avg') ? 'avg' : 'max';
            // If it's the "avg" pseudo-key, we strip the suffix for the search
            const searchKey = serie.key.endsWith('_avg') ? serie.key.replace('_avg', '') : serie.key;
            
            let val = findValue(summaries, searchKey, type);

            if (val != null && chart.yAxisUnit === '°C') val = temperatureValue(val, '°C', temperatureUnit);
            // Unit conversions
            if (val != null) {
                // Speed conversion
                if ((searchKey === 'vehicle_speed') && distanceUnit === 'mi') {
                    val *= 0.621371;
                }
            }
            
            if (val != null) {
                point[serie.key] = Math.round(val * 100) / 100; // Round to 2 decimals
            }
        });
      });

      return point;
    });

    // 4. Determine which charts to show based on available data
    const available = AVAILABLE_CHARTS.filter(chart =>
      chart.series.some(s => availableKeys.has(s.key))
    );

    // Reorder to put engine-type priority charts first
    const priorityIds = engineType ? ENGINE_TYPE_CONFIGS[engineType]?.priorityChartIds ?? [] : [];
    const active = priorityIds.length > 0
      ? [
          ...priorityIds.map(id => available.find(c => c.id === id)).filter((c): c is ChartConfig => !!c),
          ...available.filter(c => !priorityIds.includes(c.id)),
        ]
      : available;

    return { processedData: data, activeCharts: active };
  }, [sessions, distanceUnit, temperatureUnit, engineType, language]);

  if (sessions.length === 0) return null;

  // The speed chart is converted to the chosen distance unit above; label it to match.
  const unitOf = (chart: ChartConfig) => (chart.id === 'speed' && distanceUnit === 'mi' ? 'mph' : temperatureLabel(chart.yAxisUnit ?? '', temperatureUnit));

  // Dashboards 2027, phase 4 (owner approved 2026-11-20): each chart is a feature panel with its own colour and icon, the legend as chips in
  // its header, thin lines with no dot on each value, a fading area under the main series and a faint horizontal grid (lib/chart-theme).
  return (
    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2" data-testid="home-charts">
      {activeCharts.map((chart) => {
        const series = chart.series.filter((s) => processedData.some((d) => d[s.key] != null));
        const look = LOOK[chart.id] ?? LOOK.speed;
        const unit = unitOf(chart);
        const right = chart.type === 'composed';
        return (
          <Panel
            key={chart.id}
            variant="feature"
            title={t(`dashboard.charts.${chart.id}`, chart.title)}
            description={unit || undefined}
            icon={look.icon}
            accent={look.accent}
            action={<ChartLegend items={series.map((s) => ({ label: t(`dashboard.series.${s.key}`, s.label), color: s.color }))} />}
            testId={`home-chart-${chart.id}`}
          >
            <div className="h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={processedData} margin={{ top: 8, right: right ? 0 : 8, bottom: 0, left: -4 }}>
                  <defs>
                    {series.filter((s) => s.type === 'area').map((s) => <AreaGradient key={s.key} id={`home-${chart.id}-${s.key}`} color={s.color} />)}
                  </defs>
                  <CartesianGrid {...CHART_GRID} />
                  <XAxis dataKey="formattedDate" {...CHART_AXIS} interval="preserveStartEnd" minTickGap={32} />
                  {right ? (
                    <>
                      <YAxis yAxisId="left" {...CHART_AXIS} width={44} />
                      <YAxis yAxisId="right" orientation="right" {...CHART_AXIS} width={40} unit="%" />
                    </>
                  ) : (
                    // The unit is under the panel title, so the ticks stay short numbers.
                    <YAxis yAxisId="left" {...CHART_AXIS} width={40} domain={chart.yAxisDomain || ['auto', 'auto']} />
                  )}
                  <Tooltip {...CHART_TOOLTIP} />
                  {series.map((s) => {
                    const name = t(`dashboard.series.${s.key}`, s.label);
                    const axis = right ? s.yAxisId || 'left' : 'left';
                    if (s.type === 'bar') return <Bar key={s.key} yAxisId={axis} dataKey={s.key} name={name} fill={s.color} {...CHART_BAR} maxBarSize={28} />;
                    if (s.type === 'area') return <Area key={s.key} yAxisId={axis} dataKey={s.key} name={name} {...CHART_LINE} stroke={s.color} fill={`url(#home-${chart.id}-${s.key})`} connectNulls />;
                    return <Line key={s.key} yAxisId={axis} dataKey={s.key} name={name} {...CHART_LINE} stroke={s.color} connectNulls />;
                  })}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
