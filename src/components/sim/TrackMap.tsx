import { useTranslation } from 'react-i18next';
import type { TrackPath } from '@/lib/sim/analysis';
import { CHART_PALETTE } from '@/lib/chart-palette';

/**
 * The line the car drove, seen from above: the lap being looked at (solid) and the reference (dashed).
 * The game's own axes are drawn as they come, so the map may be mirrored or turned against the real track.
 */
export function TrackMap({ lap, reference }: { lap: TrackPath; reference?: TrackPath | null }) {
  const { t } = useTranslation();
  const paths = reference ? [lap, reference] : [lap];
  const minX = Math.min(...paths.map((p) => p.minX));
  const maxX = Math.max(...paths.map((p) => p.maxX));
  const minZ = Math.min(...paths.map((p) => p.minZ));
  const maxZ = Math.max(...paths.map((p) => p.maxZ));
  const margin = Math.max(maxX - minX, maxZ - minZ) * 0.05 + 1;
  const width = maxX - minX + 2 * margin;
  const height = maxZ - minZ + 2 * margin;
  // z points up on screen, so it is flipped for SVG.
  const line = (path: TrackPath) => path.points.map(([x, z]) => `${(x - minX + margin).toFixed(1)},${(maxZ - z + margin).toFixed(1)}`).join(' ');
  const [startX, startZ] = lap.points[0];

  return (
    <svg
      viewBox={`0 0 ${width.toFixed(1)} ${height.toFixed(1)}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-64 w-full"
      role="img"
      aria-label={t('modes.compare.mapLabel', 'The line driven, seen from above')}
      data-testid="track-map"
    >
      {reference && (
        <polyline points={line(reference)} fill="none" stroke={CHART_PALETTE.blue} strokeWidth={2.5} strokeDasharray="10 8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={0.9} />
      )}
      <polyline points={line(lap)} fill="none" stroke={CHART_PALETTE.yellow} strokeWidth={3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={startX - minX + margin} cy={maxZ - startZ + margin} r={Math.max(width, height) * 0.012} fill={CHART_PALETTE.green} />
    </svg>
  );
}
