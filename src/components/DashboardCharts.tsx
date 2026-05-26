import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend, BarChart, Bar, ComposedChart } from 'recharts';
import { format } from 'date-fns';
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
  const { distanceUnit } = useSettings();

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
        formattedDate: format(sessionDate, 'MMM d, HH:mm'), // Added time for better distinction
      };

      // Extract all potential values
      AVAILABLE_CHARTS.forEach(chart => {
        chart.series.forEach(serie => {
            // Special handling for units or types
            const type = serie.key.endsWith('_avg') ? 'avg' : 'max';
            // If it's the "avg" pseudo-key, we strip the suffix for the search
            const searchKey = serie.key.endsWith('_avg') ? serie.key.replace('_avg', '') : serie.key;
            
            let val = findValue(summaries, searchKey, type);

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
  }, [sessions, distanceUnit, engineType]);

  if (sessions.length === 0) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {activeCharts.map(chart => (
        <Card key={chart.id} className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono text-muted-foreground">
                {chart.title} {chart.yAxisUnit ? `(${chart.yAxisUnit})` : ''}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                {chart.type === 'composed' ? (
                  <ComposedChart data={processedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                    <XAxis dataKey="formattedDate" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="left" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="right" orientation="right" stroke="#666" fontSize={12} tickLine={false} axisLine={false} unit="%" />
                    <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }} labelStyle={{ color: '#888' }} />
                    <Legend />
                    {chart.series.map(s => {
                      if (s.type === 'bar') {
                        return (
                          <Bar 
                            key={s.key}
                            yAxisId={s.yAxisId || 'left'}
                            dataKey={s.key} 
                            name={s.label} 
                            fill={s.color} 
                            radius={[4, 4, 0, 0]}
                            hide={!processedData.some(d => d[s.key] != null)}
                          />
                        );
                      }
                      // Default to line for ComposedChart if not specified as bar
                      return (
                        <Line
                          key={s.key}
                          yAxisId={s.yAxisId || 'left'}
                          type="monotone"
                          dataKey={s.key}
                          name={s.label}
                          stroke={s.color}
                          strokeWidth={2}
                          dot={{ r: 4, fill: s.color }}
                          hide={!processedData.some(d => d[s.key] != null)}
                        />
                      );
                    })}
                  </ComposedChart>
                ) : chart.type === 'line' ? (
                  <LineChart data={processedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                    <XAxis dataKey="formattedDate" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis 
                        stroke="#666" 
                        fontSize={12} 
                        tickLine={false} 
                        axisLine={false} 
                        unit={chart.yAxisUnit ? ` ${chart.yAxisUnit}` : ''} 
                        domain={chart.yAxisDomain || ['auto', 'auto']}
                    />
                    <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }} labelStyle={{ color: '#888' }} />
                    <Legend />
                    {chart.series.map(s => (
                      <Line 
                        key={s.key}
                        type="monotone" 
                        dataKey={s.key} 
                        name={s.label} 
                        stroke={s.color} 
                        strokeWidth={2}
                        dot={{ r: 4, fill: s.color }}
                        connectNulls={true}
                        hide={!processedData.some(d => d[s.key] != null)}
                      />
                    ))}
                  </LineChart>
                ) : chart.type === 'bar' ? (
                     <BarChart data={processedData}>
                        {/* ... similar implementation ... */}
                     </BarChart>
                ) : (
                  // Default to Area/Line (AreaChart can handle lines too if fill is transparent)
                  <AreaChart data={processedData}>
                    <defs>
                      {chart.series.map((s, i) => (
                        <linearGradient key={s.key} id={`color-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={s.color} stopOpacity={0.3}/>
                          <stop offset="95%" stopColor={s.color} stopOpacity={0}/>
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                    <XAxis dataKey="formattedDate" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis 
                        stroke="#666" 
                        fontSize={12} 
                        tickLine={false} 
                        axisLine={false} 
                        unit={chart.yAxisUnit ? ` ${chart.yAxisUnit}` : ''} 
                        domain={chart.yAxisDomain || ['auto', 'auto']}
                    />
                    <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }} labelStyle={{ color: '#888' }} />
                    <Legend />
                    {chart.series.map(s => (
                      <Area 
                        key={s.key}
                        type="monotone" 
                        dataKey={s.key} 
                        name={s.label} 
                        stroke={s.color} 
                        fill={s.type === 'area' ? `url(#color-${s.key})` : 'transparent'} 
                        fillOpacity={1}
                        strokeWidth={2}
                        connectNulls={true}
                        hide={!processedData.some(d => d[s.key] != null)}
                      />
                    ))}
                  </AreaChart>
                )}
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
