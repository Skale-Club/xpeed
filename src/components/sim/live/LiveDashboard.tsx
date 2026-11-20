// The rows of a frame, in order: each row holds one or two widget ids side by side. A frame's widgets are keyed by id, so nothing is mounted again
// from one frame to the next, and each one draws again only when its own part of the model changed.
import { cn } from '@/lib/utils';
import type { LiveFrame } from '@/lib/sim/live-frame';
import { WidgetSlot } from './LiveWidgets';

export function LiveDashboard({ frame }: { frame: LiveFrame }) {
  const { rows, model } = frame;
  // Xpeed Companion 0.16+ draws the panel itself for this screen: shown as it is, nothing redrawn here.
  if (frame.image) {
    return (
      <div className="flex h-full w-full items-center justify-center" data-testid="live-dashboard" data-dashboard={frame.dashboard}>
        <img src={frame.image} alt="" className="max-h-full max-w-full object-contain" data-testid="live-picture" draggable={false} />
      </div>
    );
  }
  const banner = model.banner;
  return (
    <div className="space-y-2" data-testid="live-dashboard" data-dashboard={frame.dashboard}>
      {banner?.title ? (
        <div role="status" className="rounded-[2.5px] border border-warn-line bg-warn-soft px-3 py-2 text-sm" data-testid="live-banner">
          <div className="font-semibold text-warn">{banner.title}</div>
          {banner.note ? <div className="text-xs text-muted-foreground">{banner.note}</div> : null}
        </div>
      ) : null}
      {model.track || model.car ? (
        <div className="flex items-baseline justify-between gap-2 px-0.5 text-xs text-muted-foreground" data-testid="live-context">
          <span className="truncate font-semibold text-foreground">{model.track}</span>
          <span className="truncate text-right">{[model.car, model.session].filter(Boolean).join(' · ')}</span>
        </div>
      ) : null}
      {/* On a wide screen (a tablet, a phone on its side) the rows flow into two columns. */}
      <div className="grid gap-2 md:grid-cols-2 md:items-start">
        {rows.map((row, i) => (
          <div key={row.join('+') || i} className={cn('grid min-w-0 items-start gap-2', row.length > 1 ? 'grid-cols-2' : 'grid-cols-1')} data-row={row.join(',')}>
            {row.map((id) => <WidgetSlot key={id} id={id} model={model} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
