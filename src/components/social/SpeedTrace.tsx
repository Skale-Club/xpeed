import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { readLapFile } from '@/lib/sim/read-lap-file';
import { fetchPublicShareFile } from '@/lib/sim/social-client';
import { speedPoints } from './social-utils';

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;

/**
 * A small speed trace of one lap a share link covers: the lap file is fetched (no sign-in) and read with the strict reader, then
 * the speed is drawn against the distance. Loaded lazily (this module is a separate chunk), and a failure only hides the chart.
 */
export default function SpeedTrace({ token, lapId }: { token: string; lapId: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['sim-public-share-file', token, lapId],
    queryFn: async () => readLapFile(await fetchPublicShareFile(token, lapId)),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const points = useMemo(() => (query.data ? speedPoints(query.data) : []), [query.data]);
  const label = t('social.public.trace', 'Speed along the lap');

  if (query.isPending) return <Skeleton className="h-40 w-full rounded-lg" data-testid="trace-loading" />;
  if (query.isError || points.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid="trace-unavailable">{t('social.public.traceUnavailable', 'The speed trace is not available for this lap.')}</p>;
  }
  return (
    <figure className="space-y-1" data-testid="speed-trace" data-points={points.length}>
      <figcaption className="text-xs font-medium text-muted-foreground">{label} (km/h)</figcaption>
      <div style={{ height: 160 }} role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="km" tick={AXIS} type="number" domain={[0, 'dataMax']} tickFormatter={(value: number) => `${value.toFixed(1)}`} unit=" km" />
            <YAxis tick={AXIS} width={40} domain={[0, 'auto']} />
            <Tooltip
              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
              formatter={(value: number) => [`${value} km/h`, label]}
              labelFormatter={(value) => `${Number(value).toFixed(2)} km`}
            />
            <Line dataKey="kmh" stroke={CHART_PALETTE.yellow} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
