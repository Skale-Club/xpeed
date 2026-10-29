import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { readObdDiagnostics } from '@/lib/obd/diagnostic-log';
import { formatValue } from '@/lib/obd/format';
import { useTranslation } from 'react-i18next';
import {
  Activity, Bluetooth, BluetoothOff, Loader2, Maximize, Minimize, Circle, Square, Settings2, ArrowUp, ArrowDown, Trash2, Plus, RotateCcw,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { rememberedAdapterName } from '@/lib/obd/elm327';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useCarsContext } from '@/contexts/CarsContext';
import { channelLabel } from '@/lib/obd/pid-names';
import { useObd, useObdLive } from '@/contexts/ObdScannerContext';
import { useSettings } from '@/contexts/SettingsContext';
import { WaitingNotice } from '@/components/trip/WaitingNotice';
import { BlocksWidget, ChartWidget, GaugeWidget, ValueWidget } from '@/components/live/widgets';
import { coolantTone } from '@/components/trip/QuickGauge';
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
  const { status, connection, channels, recording } = obd;
  const { values } = useObdLive();
  const { selectedCar, selectedCarId } = useCarsContext();
  const { advancedTools, distanceUnit } = useSettings();
  const [searchParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(() => searchParams.get('sensor'));
  const [timelineMs, setTimelineMs] = useState(5 * 60_000);
  const [diagnostics, setDiagnostics] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const sensorUnit = (header: string) => distanceUnit === 'mi' && byHeader.get(header)?.unit === 'km/h' ? 'mph' : byHeader.get(header)?.unit ?? header.match(/\(([^)]*)\)$/)?.[1] ?? '';
  const sensorValue = (header: string, value: number | null | undefined) => value == null ? null
    : distanceUnit === 'mi' && byHeader.get(header)?.unit === 'km/h' ? value * 0.621371 : value;
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
    const label = ch ? channelLabel(ch, t) : w.channel?.replace(/ \([^)]*\)$/, '') ?? '';
    const unit = w.channel ? sensorUnit(w.channel) : '';
    const value = w.channel ? sensorValue(w.channel, values[w.channel]) : null;
    if (w.kind === 'gauge') {
      // Engine temperature is coloured by how warm it is, like on the trip card.
      const coolant = ch?.def?.pid === 0x05;
      return (
        <GaugeWidget
          label={label}
          unit={unit}
          value={value}
          min={coolant ? 40 : ch?.min ?? 0}
          max={coolant ? 120 : ch?.def?.pid === 0x0c ? 6000 : w.channel ? sensorValue(w.channel, ch?.max ?? 100) ?? 100 : 100}
          tone={coolant ? coolantTone(value ?? null) : 'primary'}
        />
      );
    }
    if (w.kind === 'chart') {
      const points = history.map((h) => ({ at: h.at, v: w.channel ? sensorValue(w.channel, h.values[w.channel]) : null }));
      return <ChartWidget label={label} unit={unit} points={points} now={chartNow} windowMs={CHART_WINDOW_MS} min={w.channel ? sensorValue(w.channel, ch?.min ?? 0) ?? 0 : 0} max={w.channel ? sensorValue(w.channel, ch?.def?.pid === 0x0c ? 6000 : ch?.max) ?? undefined : undefined} />;
    }
    return <ValueWidget label={label} unit={unit} value={value} min={w.channel ? sensorValue(w.channel, ch?.min) ?? undefined : undefined} max={w.channel ? sensorValue(w.channel, ch?.max) ?? undefined : undefined} />;
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

          {/* Says what it does: it starts, or ends, the recording of a trip. */}
          {live && (recording?.active ? (
            <Button size="sm" variant="destructive" onClick={obd.stopTrip}>
              <Square className="w-3.5 h-3.5 mr-2" />
              {t('trip.stop', 'End trip')} · <span className="tabular-nums">{formatElapsed((now - recording.startedAt.getTime()) / 1000)}</span>
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void obd.startTrip()} disabled={channels.length === 0}>
              <Circle className="w-3.5 h-3.5 mr-2 text-destructive" />
              {t('trip.start', 'Start trip')}
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
              <LayoutEditor widgets={widgets} available={available} byHeader={byHeader} hasBlocks={blockChannels.length > 0} onChange={setWidgets} />
            </SheetContent>
          </Sheet>

          <Button size="sm" variant="outline" onClick={toggleFullscreen} aria-label={fullscreen ? t('live.exitFullscreen', 'Exit fullscreen') : t('live.fullscreen', 'Fullscreen')}>
            {fullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
          </Button>
        </div>

        {!live ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 flex flex-col items-center text-center gap-3">
              {status === 'waiting' || status === 'reconnecting' ? (
                <WaitingNotice status={status} alwaysOn={obd.alwaysOn} onDisconnect={obd.disconnect} />
              ) : (
                <>
                  <Bluetooth className="w-8 h-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground max-w-md">
                    {status === 'unsupported'
                      ? t('scanner.unsupportedTitle', 'Bluetooth is not available in this browser')
                      : t('live.connectHint', 'Connect to your car to see its readings live. The connection stays on while you move around the app.')}
                  </p>
                  {obd.error && <p className="text-xs text-destructive">{obd.error}</p>}
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => void obd.connect()} disabled={status !== 'idle'}>
                      {status === 'connecting' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Bluetooth className="w-4 h-4 mr-2" />}
                      {status === 'connecting' ? t('scanner.connecting', 'Connecting…') : t('trip.connect', 'Connect to the car')}
                    </Button>
                    {/* The Scanner is for mechanics: only offered when Advanced tools is on. */}
                    {advancedTools && (
                      <Button variant="ghost" asChild>
                        <Link to="/scanner">{t('nav.scanner', 'Scanner (advanced)')}</Link>
                      </Button>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : widgets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('live.empty', 'No widgets — use Customize to add some.')}</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {widgets.map((w) => (
              <Card key={w.id} className={`bg-card border-border ${SPAN[w.kind]}`} data-testid={`widget-${w.kind}`}>
                <CardContent className="p-3 h-full">
                  {w.channel ? <button type="button" className="block w-full h-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setExpanded(w.channel!)} aria-label={t('live.expand', 'Open timeline: {{sensor}}', { sensor: byHeader.has(w.channel) ? channelLabel(byHeader.get(w.channel)!, t) : w.channel })}>{renderWidget(w)}</button> : renderWidget(w)}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
      {(obd.linkOpen || connection) && <Card className="mt-4" data-testid="adapter-connection">
        <CardContent className="p-3">
          <button type="button" className="flex w-full items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setConfirmDisconnect(true)}>
            <Bluetooth className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{t('live.adapter', 'OBD2 adapter')}</span><span className="block truncate font-semibold">{connection?.deviceName || rememberedAdapterName() || 'OBD2'}</span><span className="block text-xs text-muted-foreground">{connection?.transport === 'classic' ? 'Bluetooth Classic (SPP)' : connection?.transport === 'ble' ? 'Bluetooth LE (BLE)' : 'Bluetooth'}</span></span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground"><BluetoothOff className="h-4 w-4" />{t('scanner.disconnect', 'Disconnect')}</span>
          </button>
        </CardContent>
      </Card>}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('live.disconnectTitle', 'Disconnect the adapter?')}</AlertDialogTitle><AlertDialogDescription>{t('live.disconnectHint', 'This closes the Bluetooth connection. An active trip recording will also end.')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel><AlertDialogAction onClick={obd.disconnect}>{t('scanner.disconnect', 'Disconnect')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      {live && <details>
        <summary className="cursor-pointer py-3 text-sm font-semibold">{t('live.allSensors', 'All available sensors')} ({channels.length})</summary>
        <dl className="divide-y divide-border">{channels.map((channel) => <div key={channel.header} className="flex justify-between gap-3 py-2 text-sm">
          <dt><button className="text-left text-primary hover:underline" onClick={() => setExpanded(channel.header)}>{channelLabel(channel, t)}</button></dt>
          <dd className="font-mono tabular-nums">{formatValue(sensorValue(channel.header, values[channel.header]), sensorUnit(channel.header))} {sensorUnit(channel.header)}</dd>
        </div>)}</dl>
      </details>}
      <details onToggle={(event) => { if (event.currentTarget.open) setDiagnostics(JSON.stringify(readObdDiagnostics(), null, 2)); }}>
        <summary className="cursor-pointer py-3 text-sm text-muted-foreground">{t('live.diagnostics', 'Connection diagnostics')}</summary>
        <p className="mb-2 text-xs text-muted-foreground">{t('live.diagnosticsHint', 'Local connection and recording events from this device. No previous events can be recovered before logging was installed.')}</p>
        <textarea readOnly aria-label={t('live.diagnostics', 'Connection diagnostics')} value={diagnostics} className="h-48 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" />
      </details>
      <Dialog open={expanded !== null} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{expanded && (byHeader.has(expanded) ? channelLabel(byHeader.get(expanded)!, t) : expanded)}</DialogTitle>
            <DialogDescription>{t('live.timelineHint', 'Live history from this connection, up to 30 minutes. Missing readings remain gaps.')}</DialogDescription>
          </DialogHeader>
          <select className="rounded-md border border-border bg-background p-2 text-sm" aria-label={t('live.timelinePeriod', 'Timeline period')} value={timelineMs} onChange={(event) => setTimelineMs(Number(event.target.value))}>
            {[1, 5, 15, 30].map((minutes) => <option key={minutes} value={minutes * 60_000}>{minutes} min</option>)}
          </select>
          {expanded && <ChartWidget large label={byHeader.has(expanded) ? channelLabel(byHeader.get(expanded)!, t) : expanded} unit={sensorUnit(expanded)} now={chartNow} windowMs={timelineMs}
            points={history.map((point) => ({ at: point.at, v: sensorValue(expanded, point.values[expanded]) }))}
            min={sensorValue(expanded, byHeader.get(expanded)?.min ?? 0) ?? 0} max={sensorValue(expanded, byHeader.get(expanded)?.def?.pid === 0x0c ? 6000 : byHeader.get(expanded)?.max) ?? undefined} />}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

const KIND_LABEL: Record<WidgetKind, string> = { gauge: 'Gauge', chart: 'Chart', value: 'Number', blocks: 'HV blocks' };

function LayoutEditor({ widgets, available, byHeader, hasBlocks, onChange }: {
  widgets: LiveWidget[];
  available: string[];
  byHeader: Map<string, LiveChannel>;
  hasBlocks: boolean;
  onChange: (w: LiveWidget[] | null) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<WidgetKind>('gauge');
  const [channel, setChannel] = useState('');
  const kindLabel = (k: WidgetKind) => t(`live.kind.${k}`, KIND_LABEL[k]);
  // Names in the app language, like on the panel itself; the raw header only if the car's channel is gone.
  const nameOf = (header: string) => {
    const ch = byHeader.get(header);
    return ch ? channelLabel(ch, t) : header.replace(/ \([^)]*\)$/, '');
  };
  const selectClass = 'h-10 rounded-md border border-input bg-background px-2 text-sm';

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
          <div key={w.id} className="flex items-center gap-1 rounded-md border border-border py-1 pl-2 pr-1 text-sm">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{kindLabel(w.kind)}</span>
            <span className="flex-1 truncate" title={w.channel ? nameOf(w.channel) : undefined}>{w.kind === 'blocks' || !w.channel ? '—' : nameOf(w.channel)}</span>
            <Button size="icon" variant="ghost" disabled={i === 0} aria-label={t('live.moveUp', 'Move up')} onClick={() => onChange(moveWidget(widgets, w.id, -1))}>
              <ArrowUp className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" disabled={i === widgets.length - 1} aria-label={t('live.moveDown', 'Move down')} onClick={() => onChange(moveWidget(widgets, w.id, 1))}>
              <ArrowDown className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" aria-label={t('live.remove', 'Remove')} onClick={() => onChange(widgets.filter((x) => x.id !== w.id))}>
              <Trash2 className="w-4 h-4" />
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
              {available.map((h) => <option key={h} value={h}>{nameOf(h)}</option>)}
            </select>
          )}
          <Button variant="outline" onClick={add} disabled={kind !== 'blocks' && !channel}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t('live.add', 'Add')}
          </Button>
        </div>
        {available.length === 0 && <p className="text-[11px] text-muted-foreground">{t('live.connectFirst', 'Connect the adapter to list the parameters your car reports.')}</p>}
      </div>

      <Button variant="ghost" onClick={() => onChange(null)}>
        <RotateCcw className="w-3.5 h-3.5 mr-2" />
        {t('live.reset', 'Reset to default')}
      </Button>
    </div>
  );
}
