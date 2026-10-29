// Layout of the live panel: an ordered list of widgets bound to channel
// headers (see pidHeader()). Saved per vehicle in this browser.

export type WidgetKind = 'gauge' | 'chart' | 'value' | 'blocks';

export interface LiveWidget {
  id: string;
  kind: WidgetKind;
  /** Channel header; unused by the 'blocks' widget. */
  channel?: string;
}

/** Channels the HV-blocks widget draws, e.g. "HV block 03 (V)" → 3. */
export const HV_BLOCK_RE = /^HV block (\d+) \(V\)$/;

let seq = 0;
export function newWidgetId(): string {
  seq += 1;
  return `w_${Date.now().toString(36)}_${seq}`;
}

// Preferred defaults, in order; only those the car reports are used.
const DEFAULT_GAUGES = [
  'Engine RPM (rpm)',
  'Vehicle speed (km/h)',
  'Engine coolant temperature (°C)',
  'Hybrid battery remaining life (%)',
];
const DEFAULT_CHARTS = ['Engine RPM (rpm)', 'Vehicle speed (km/h)'];
const DEFAULT_VALUES = [
  'HV pack voltage (V)',
  'HV block spread (V)',
  'Control module voltage (V)',
  'Battery voltage (V)',
  'Calculated engine load (%)',
  'Throttle position (%)',
  'Intake air temperature (°C)',
  'Long term fuel trim B1 (%)',
  'Short term fuel trim B1 (%)',
  'Mass air flow (g/s)',
  'Manifold absolute pressure (kPa)',
  'Fuel level (%)',
];

export function defaultLayout(available: string[]): LiveWidget[] {
  const has = (h: string) => available.includes(h);
  const widgets: LiveWidget[] = [
    ...DEFAULT_GAUGES.filter(has).map((channel) => ({ id: newWidgetId(), kind: 'gauge' as const, channel })),
    ...DEFAULT_VALUES.filter(has).slice(0, 6).map((channel) => ({ id: newWidgetId(), kind: 'value' as const, channel })),
  ];
  if (available.some((h) => HV_BLOCK_RE.test(h))) widgets.push({ id: newWidgetId(), kind: 'blocks' });
  widgets.push(...DEFAULT_CHARTS.filter(has).map((channel) => ({ id: newWidgetId(), kind: 'chart' as const, channel })));
  return widgets.map((widget) => ({ ...widget, id: `default:${widget.kind}:${widget.channel ?? 'blocks'}` }));
}

const KINDS: WidgetKind[] = ['gauge', 'chart', 'value', 'blocks'];
const storageKey = (carId: string | null) => `xpeed.obd.liveLayout.${carId ?? 'default'}`;

/** Saved layout, or null when this vehicle has none yet. */
export function loadLayout(carId: string | null): LiveWidget[] | null {
  try {
    const raw = localStorage.getItem(storageKey(carId));
    if (!raw) return null;
    const list = JSON.parse(raw) as LiveWidget[];
    if (!Array.isArray(list)) return null;
    return list.filter((w) => w && typeof w.id === 'string' && KINDS.includes(w.kind) && (w.kind === 'blocks' || typeof w.channel === 'string'));
  } catch {
    return null;
  }
}

export function saveLayout(carId: string | null, widgets: LiveWidget[] | null): void {
  try {
    if (widgets) localStorage.setItem(storageKey(carId), JSON.stringify(widgets));
    else localStorage.removeItem(storageKey(carId));
  } catch {
    // Storage blocked: the layout just won't persist.
  }
}

export function moveWidget(widgets: LiveWidget[], id: string, delta: -1 | 1): LiveWidget[] {
  const i = widgets.findIndex((w) => w.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= widgets.length) return widgets;
  const next = [...widgets];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
