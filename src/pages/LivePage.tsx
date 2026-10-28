import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity, Bluetooth, Loader2, Maximize, Minimize, Circle, Square, Settings2, ArrowUp, ArrowDown, Trash2, Plus, RotateCcw,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useCarsContext } from '@/contexts/CarsContext';
import { useObd } from '@/contexts/ObdScannerContext';
import { BlocksWidget, ChartWidget, GaugeWidget, ValueWidget } from '@/components/live/widgets';
import {
  HV_BLOCK_RE, defaultLayout, loadLayout, moveWidget, newWidgetId, saveLayout, type LiveWidget, type WidgetKind,
} from '@/lib/obd/live-layout';
import type { LiveChannel } from '@/hooks/use-obd-scanner';

const CHART_WINDOW_MS = 60_000;

const SPAN: Record<WidgetKind, string> = {
  gauge: 'col-span-1',
  value: 'col-span-1',
  chart: 'col-span-2',
  blocks: 'col-span-2 md:col-span-4',
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function LivePage() {
  const { t } = useTranslation();
  const obd = useObd();
  const { status, connection, channels, values, cycleMs, recording } = obd;
  const { selectedCar, selectedCarId } = useCarsContext();
  const live = status === 'live';

  const [saved, setSaved] = useState<LiveWidget[] | null>(() => loadLayout(selectedCarId));
  useEffect(() => setSaved(loadLayout(selectedCarId)), [selectedCarId]);
  const available = channels.map((c) => c.header);
  const availableKey = available.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the channel set changes
  const fallback = useMemo(() => defaultLayout(available), [availableKey]);
  const widgets = saved ?? fallback;
  const setWidgets = (next: LiveWidget[] | null) => {
    setSaved(next);
    saveLayout(selectedCarId, next);
  };

  const byHeader = useMemo(() => new Map(channels.map((c) => [c.header, c])), [channels]);
  const blockChannels = channels
    .flatMap((c) => {
      const m = c.header.match(HV_BLOCK_RE);
      return m ? [{ index: Number(m[1]), header: c.header }] : [];
    })
    .sort((a, b) => a.index - b.index);

  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen();
    } catch {
      // Fullscreen not allowed here; nothing to do.
    }
  };

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!recording?.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording?.active]);

  const history = obd.getHistory();
  const chartNow = history.length ? history[history.length - 1].at : Date.now();

  const renderWidget = (w: LiveWidget) => {
    if (w.kind === 'blocks') {
      return (
        <BlocksWidget
          label={t('live.blocks', 'HV battery blocks')}
          blocks={blockChannels.map((b) => ({ index: b.index, value: values[b.header] ?? null }))}
        />
      );
    }
    const ch: LiveChannel | undefined = w.channel ? byHeader.get(w.channel) : undefined;
    const label = ch?.name ?? w.channel?.replace(/ \([^)]*\)$/, '') ?? '';
    const unit = ch?.unit ?? w.channel?.match(/\(([^)]*)\)$/)?.[1] ?? '';
    const value = w.channel ? values[w.channel] : null;
    if (w.kind === 'gauge') return <GaugeWidget label={label} unit={unit} value={value} min={ch?.min ?? 0} max={ch?.max ?? 100} />;
    if (w.kind === 'chart') {
      const points = history.map((h) => ({ at: h.at, v: w.channel ? h.values[w.channel] ?? null : null }));
      return <ChartWidget label={label} unit={unit} points={points} now={chartNow} windowMs={CHART_WINDOW_MS} />;
    }
    return <ValueWidget label={label} unit={unit} value={value} />;
  };

  return (
    <AppLayout>
      <div ref={containerRef} className={`space-y-4 ${fullscreen ? 'bg-background p-4 overflow-auto h-screen' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground mr-auto">
            {t('live.title', 'Live panel')}
            {selectedCar && <span className="text-muted-foreground font-normal"> — {selectedCar.name}</span>}
          </h2>

          {live && connection && (
            <>
              <Badge variant="outline" className="font-mono">{connection.deviceName}</Badge>
              {cycleMs !== null && <Badge variant="secondary" className="font-mono">{(cycleMs / 1000).toFixed(1)} s</Badge>}
            </>
          )}

          {live && (recording?.active ? (
            <Button size="sm" variant="destructive" onClick={obd.stopTrip}>
              <Square className="w-3.5 h-3.5 mr-2" />
              REC {formatElapsed((now - recording.startedAt.getTime()) / 1000)}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void obd.startTrip()} disabled={channels.length === 0}>
              <Circle className="w-3.5 h-3.5 mr-2 text-destructive" />
              {t('live.record', 'Record')}
            </Button>
          ))}

          <Sheet>
            <SheetTrigger asChild>
              <Button size="sm" variant="outline" aria-label={t('live.customize', 'Customize')}>
                <Settings2 className="w-3.5 h-3.5 sm:mr-2" />
                <span className="hidden sm:inline">{t('live.customize', 'Customize')}</span>
              </Button>
            </SheetTrigger>
            <SheetContent className="overflow-auto">
              <LayoutEditor widgets={widgets} available={available} hasBlocks={blockChannels.length > 0} onChange={setWidgets} />
            </SheetContent>
          </Sheet>

          <Button size="sm" variant="outline" onClick={toggleFullscreen} aria-label={fullscreen ? t('live.exitFullscreen', 'Exit fullscreen') : t('live.fullscreen', 'Fullscreen')}>
            {fullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
          </Button>
        </div>

        {!live ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 flex flex-col items-center text-center gap-3">
              <Bluetooth className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground max-w-md">
                {status === 'unsupported'
                  ? t('scanner.unsupportedTitle', 'Bluetooth is not available in this browser')
                  : t('live.connectHint', 'Connect your OBD2 adapter to see live data. The connection stays on while you move around the app.')}
              </p>
              {obd.error && <p className="text-xs text-destructive">{obd.error}</p>}
              <div className="flex gap-2">
                <Button onClick={() => void obd.connect()} disabled={status !== 'idle'}>
                  {status === 'connecting' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Bluetooth className="w-4 h-4 mr-2" />}
                  {status === 'connecting' ? t('scanner.connecting', 'Connecting…') : t('scanner.connect', 'Connect adapter')}
                </Button>
                <Button variant="ghost" asChild>
                  <Link to="/scanner">{t('nav.scanner', 'Scanner')}</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : widgets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('live.empty', 'No widgets — use Customize to add some.')}</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {widgets.map((w) => (
              <Card key={w.id} className={`bg-card border-border ${SPAN[w.kind]}`} data-testid={`widget-${w.kind}`}>
                <CardContent className="p-3 h-full">{renderWidget(w)}</CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

const KIND_LABEL: Record<WidgetKind, string> = { gauge: 'Gauge', chart: 'Chart', value: 'Number', blocks: 'HV blocks' };

function LayoutEditor({ widgets, available, hasBlocks, onChange }: {
  widgets: LiveWidget[];
  available: string[];
  hasBlocks: boolean;
  onChange: (w: LiveWidget[] | null) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<WidgetKind>('gauge');
  const [channel, setChannel] = useState('');
  const kindLabel = (k: WidgetKind) => t(`live.kind.${k}`, KIND_LABEL[k]);
  const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs';

  const add = () => {
    if (kind === 'blocks') onChange([...widgets, { id: newWidgetId(), kind }]);
    else if (channel) onChange([...widgets, { id: newWidgetId(), kind, channel }]);
  };

  return (
    <div className="space-y-4">
      <SheetHeader>
        <SheetTitle>{t('live.customize', 'Customize')}</SheetTitle>
        <SheetDescription>{t('live.customizeHint', 'Pick what the panel shows. Saved for this vehicle on this device.')}</SheetDescription>
      </SheetHeader>

      <div className="space-y-1">
        {widgets.map((w, i) => (
          <div key={w.id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">{kindLabel(w.kind)}</span>
            <span className="flex-1 truncate" title={w.channel}>{w.kind === 'blocks' ? '—' : w.channel}</span>
            <Button size="icon" variant="ghost" className="h-6 w-6" disabled={i === 0} aria-label={t('live.moveUp', 'Move up')} onClick={() => onChange(moveWidget(widgets, w.id, -1))}>
              <ArrowUp className="w-3 h-3" />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" disabled={i === widgets.length - 1} aria-label={t('live.moveDown', 'Move down')} onClick={() => onChange(moveWidget(widgets, w.id, 1))}>
              <ArrowDown className="w-3 h-3" />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={t('live.remove', 'Remove')} onClick={() => onChange(widgets.filter((x) => x.id !== w.id))}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-2 rounded-md border border-border p-2">
        <p className="text-xs font-medium">{t('live.addWidget', 'Add widget')}</p>
        <div className="flex flex-wrap gap-2">
          <select aria-label={t('live.widgetType', 'Widget type')} className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>
            {(['gauge', 'chart', 'value', ...(hasBlocks ? ['blocks'] : [])] as WidgetKind[]).map((k) => (
              <option key={k} value={k}>{kindLabel(k)}</option>
            ))}
          </select>
          {kind !== 'blocks' && (
            <select aria-label={t('live.widgetChannel', 'Parameter')} className={`${selectClass} flex-1 min-w-0`} value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">{t('live.pickChannel', 'Choose a parameter…')}</option>
              {available.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          )}
          <Button size="sm" variant="outline" onClick={add} disabled={kind !== 'blocks' && !channel}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t('live.add', 'Add')}
          </Button>
        </div>
        {available.length === 0 && <p className="text-[11px] text-muted-foreground">{t('live.connectFirst', 'Connect the adapter to list the parameters your car reports.')}</p>}
      </div>

      <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
        <RotateCcw className="w-3.5 h-3.5 mr-2" />
        {t('live.reset', 'Reset to default')}
      </Button>
    </div>
  );
}
