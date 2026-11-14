import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { cleanShare, spreadSentence, spreadSeconds } from '@/lib/sim/dashboard';
import { timeTicks } from '@/lib/sim/progress';
import type { V1Stats } from '@/lib/sim/v1-client';
import { Panel, Quiet } from './parts';
import { useDashFormat } from './use-format';

const AXIS = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' } as const;
const TOOLTIP = { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 } as const;

/**
 * Consistency: how much a driver's clean laps differ from each other in a session (the standard deviation of the valid laps that are not in or
 * out laps), over the latest sessions of the period, one plain sentence from numbers and a translation key, and the share of clean laps.
 */
export function ConsistencyPanel({ stats }: { stats: V1Stats }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const sessions = stats.consistency;
  const sentence = useMemo(() => spreadSentence(sessions), [sessions]);
  const share = useMemo(() => cleanShare(sessions), [sessions]);
  const rows = useMemo(() => sessions.flatMap((session, index) => (session.spreadMs === null ? [] : [{ index, day: session.startedAt.slice(0, 10), s: session.spreadMs / 1000 }])), [sessions]);
  const high = rows.length ? Math.max(...rows.map((row) => row.s)) : 0;
  const axis = useMemo(() => timeTicks(0, Math.max(0.1, Math.ceil(high * 10) / 10), 3), [high]);
  const alt = rows.length
    ? t('modes.overview.dash.spreadAlt', 'Lap spread of the latest {{count}} sessions: from {{first}} s to {{last}} s.', { count: rows.length, first: spreadSeconds(rows[0].s * 1000), last: spreadSeconds(rows[rows.length - 1].s * 1000) })
    : '';

  return (
    <Panel title={t('modes.overview.dash.consistencyTitle', 'Consistency')} testId="overview-consistency">
      {sentence ? (
        <p className="text-sm" data-testid="consistency-sentence" data-key={sentence.key}>{t(sentence.key, sentence.values)}</p>
      ) : (
        <Quiet testId="consistency-empty">{t('modes.overview.dash.consistencyEmpty', 'Drive at least 3 clean laps in a session to see this.')}</Quiet>
      )}
      {share !== null && (
        <p className="text-xs text-muted-foreground" data-testid="consistency-clean">{t('modes.overview.dash.cleanShare', 'Clean laps: {{percent}}%', { percent: share })}</p>
      )}
      {rows.length > 0 && (
        <div className="h-24" role="img" aria-label={alt} data-testid="consistency-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="index" type="number" domain={[0, Math.max(1, sessions.length - 1)]} hide />
              <YAxis domain={[0, axis.ticks[axis.ticks.length - 1] ?? 1]} ticks={axis.ticks} tick={AXIS} width={34} tickLine={false} axisLine={false} tickFormatter={(value: number) => value.toFixed(axis.step < 0.1 ? 2 : axis.step < 1 ? 1 : 0)} />
              <Tooltip
                contentStyle={TOOLTIP}
                labelFormatter={(_, payload) => (payload?.[0]?.payload ? format.day((payload[0].payload as { day: string }).day, 'long') : '')}
                formatter={(value: number) => [`${value.toFixed(2)} s`, t('modes.overview.dash.spreadName', 'Lap spread')]}
              />
              <Line dataKey="s" type="linear" stroke={CHART_PALETTE.purple} strokeWidth={2} dot={{ r: 3, fill: CHART_PALETTE.purple, stroke: 'hsl(var(--card))', strokeWidth: 1.5 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}
