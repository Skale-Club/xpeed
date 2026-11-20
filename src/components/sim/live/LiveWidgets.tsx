// The widgets of the phone dashboard: one component per widget id of the Companion's catalog (`xpeed-sim/src/panel/catalog.rs`), each reading its
// slice of the frame's `model` (`DashModel`, see `@/lib/sim/live-frame`). Every field may be missing; a widget that has nothing to say draws nothing.
// The look follows the panel on the PC: 2.5 px corners everywhere, square-block bars, big mono figures, the yellow accent for the player.
import { memo, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  colorref,
  type Cell, type DashModel, type Elem, type Role, type Show,
} from '@/lib/sim/live-frame';

const R = 'rounded-[2.5px]';

const TEXT: Record<Role, string> = {
  text: 'text-foreground', muted: 'text-muted-foreground', primary: 'text-primary', good: 'text-success', danger: 'text-destructive',
  warn: 'text-warn', best: 'text-brand-3', info: 'text-info', cold: 'text-brand-2',
};
const FILL: Record<Role, string> = {
  text: 'bg-foreground', muted: 'bg-muted-foreground', primary: 'bg-primary', good: 'bg-success', danger: 'bg-destructive',
  warn: 'bg-warn', best: 'bg-brand-3', info: 'bg-info', cold: 'bg-brand-2',
};
/** The text colour of a role; a role this page does not know (a newer Companion) reads as plain text. */
const roleText = (role?: Role | string) => TEXT[(role ?? 'text') as Role] ?? TEXT.text;
const roleFill = (role?: Role | string) => FILL[(role ?? 'text') as Role] ?? FILL.text;

const clamp01 = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const dimmed = (show?: Show) => show === 'dimmed';
const visible = (e?: Elem | null): e is Elem => !!e && e.show !== 'hidden' && !!e.text;

function Card({ id, title, right, show, className, children }: { id: string; title?: string; right?: ReactNode; show?: Show; className?: string; children: ReactNode }) {
  return (
    <section data-widget={id} className={cn(R, 'min-w-0 border border-border bg-surface p-3', dimmed(show) && 'opacity-50', className)}>
      {(title || right) && (
        <header className="mb-2 flex items-baseline justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="truncate">{title}</span>
          {right ? <span className="truncate normal-case tracking-normal">{right}</span> : null}
        </header>
      )}
      {children}
    </section>
  );
}

/** A bar of square blocks, filled from the left. */
function Blocks({ frac, role = 'good', n = 20, className }: { frac?: number | null; role?: Role | string; n?: number; className?: string }) {
  const on = Math.round(clamp01(frac) * n);
  return (
    <div className={cn('flex gap-[2px]', className)} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => <span key={i} className={cn(R, 'h-2.5 flex-1', i < on ? roleFill(role) : 'bg-muted/50')} />)}
    </div>
  );
}

function Stat({ label, value, role, show, big }: { label?: string; value?: string; role?: Role | string; show?: Show; big?: boolean }) {
  if (!value) return null;
  return (
    <div className={cn('min-w-0', dimmed(show) && 'opacity-50')}>
      {label ? <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div> : null}
      <div className={cn('truncate font-mono font-semibold tabular-nums', big ? 'text-3xl leading-tight' : 'text-lg leading-tight', roleText(role))}>{value}</div>
    </div>
  );
}
const ElemStat = ({ e, big }: { e?: Elem; big?: boolean }) =>
  visible(e) ? <Stat label={e.label} value={e.unit ? `${e.text} ${e.unit}` : e.text} role={e.role} show={e.show} big={big} /> : null;
const CellStat = ({ c }: { c: Cell }) => <Stat label={c.label} value={c.value} role={c.role} show={c.show} />;

// ---- the widgets of the first catalog ----

function Times({ m }: { m: DashModel }) {
  const delta = visible(m.delta) ? m.delta : null;
  if (!visible(m.lapTime) && !delta && !visible(m.lastLap) && !visible(m.bestLap)) return null;
  return (
    <Card id="times">
      <div className="flex items-end justify-between gap-3">
        <ElemStat e={m.lapTime} big />
        {delta ? (
          <div className={cn('text-right font-mono tabular-nums', dimmed(delta.show) && 'opacity-50')}>
            <div className={cn('text-2xl font-semibold leading-tight', roleText(delta.role))}>{delta.text}</div>
            {m.deltaVs ? <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.deltaVs}</div> : null}
          </div>
        ) : null}
      </div>
      {m.deltaNote ? <p className="mt-1 text-xs text-muted-foreground">{m.deltaNote}</p> : null}
      <div className="mt-2 grid grid-cols-2 gap-3">
        <ElemStat e={m.lastLap} />
        <ElemStat e={m.bestLap} />
      </div>
    </Card>
  );
}

function Pedal({ e }: { e?: Elem }) {
  if (!visible(e)) return null;
  return (
    <div className={cn('flex items-center gap-2', dimmed(e.show) && 'opacity-50')}>
      <span className="w-7 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{e.short || e.label}</span>
      <Blocks frac={e.frac} role={e.role ?? 'good'} n={16} className="flex-1" />
      <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums">{e.text}</span>
    </div>
  );
}

function Centre({ m }: { m: DashModel }) {
  if (!visible(m.gear) && !visible(m.speed) && !visible(m.throttle) && !visible(m.brake)) return null;
  const gear = visible(m.gear) ? m.gear : null;
  return (
    <Card id="centre">
      <div className="flex items-center justify-between gap-3">
        <div className={cn('flex items-baseline gap-2 font-mono tabular-nums', dimmed(gear?.show) && 'opacity-50')}>
          {visible(m.gearBelow) ? <span className="text-lg text-muted-foreground">{m.gearBelow.text}</span> : null}
          {gear ? <span className={cn('text-7xl font-bold leading-none', roleText(gear.role === 'text' ? 'primary' : gear.role))}>{gear.text}</span> : null}
          {visible(m.gearAbove) ? <span className="text-lg text-muted-foreground">{m.gearAbove.text}</span> : null}
        </div>
        {visible(m.speed) ? (
          <div className={cn('text-right font-mono tabular-nums', dimmed(m.speed.show) && 'opacity-50')}>
            <div className="text-4xl font-semibold leading-none">{m.speed.text}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.speed.unit}</div>
          </div>
        ) : null}
      </div>
      {visible(m.rev) || m.rev?.frac ? <Blocks frac={m.rev?.frac} role={m.rev?.role === 'danger' ? 'danger' : 'primary'} n={24} className="mt-3" /> : null}
      <div className="mt-3 space-y-1.5">
        <Pedal e={m.throttle} />
        <Pedal e={m.brake} />
        <Pedal e={m.clutch} />
      </div>
    </Card>
  );
}

function Fuel({ m }: { m: DashModel }) {
  const engine = (m.engine ?? []).filter((c) => c.show !== 'hidden' && c.value);
  if (!visible(m.fuel) && !visible(m.fuelLaps) && engine.length === 0) return null;
  return (
    <Card id="fuel" title={m.fuelTitle} show={m.fuel?.show}>
      <div className="flex items-end justify-between gap-3">
        <ElemStat e={m.fuel} big />
        {visible(m.fuelLaps) ? (
          <div className="text-right font-mono tabular-nums">
            <span className={cn('text-2xl font-semibold', roleText(m.fuelLaps.role))}>{m.fuelLaps.text}</span>
            {m.fuelLaps.label ? <span className="ml-1 text-xs text-muted-foreground">{m.fuelLaps.label}</span> : null}
          </div>
        ) : null}
      </div>
      {typeof m.fuelShare === 'number' ? <Blocks frac={m.fuelShare} role={m.fuelLow ? 'danger' : 'good'} className="mt-2" /> : null}
      <div className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{m.fuelTank?.text}</span>
        <span className="truncate text-right">{m.fuelPerLap?.text}</span>
      </div>
      {engine.length > 0 ? <div className="mt-2 grid grid-cols-2 gap-3">{engine.map((c, i) => <CellStat key={i} c={c} />)}</div> : null}
    </Card>
  );
}

function Tyres({ m }: { m: DashModel }) {
  const t = m.tyres;
  if (!t || t.show === 'hidden' || !t.tiles?.length) return null;
  return (
    <Card id="tyres" title={t.title} right={t.compound} show={t.show}>
      <div className="grid grid-cols-2 gap-2">
        {t.tiles.map((tile, i) => {
          const bands = tile.shape?.bands;
          const solid = colorref(tile.shape?.solid);
          return (
            <div key={i} className={cn(R, 'border border-border bg-surface-raised p-2')} data-tyre={tile.corner}>
              <div className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-wider">
                <span className="text-muted-foreground">{tile.corner}</span>
                <span className={roleText(tile.role)}>{tile.word}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className={cn(R, 'flex h-8 w-6 shrink-0 overflow-hidden')} style={solid ? { backgroundColor: solid } : undefined}>
                  {bands?.map((c, k) => <span key={k} className="flex-1" style={{ backgroundColor: colorref(c) }} />)}
                </div>
                <div className="min-w-0 font-mono tabular-nums">
                  <div className={cn('truncate text-xl font-semibold leading-tight', roleText(tile.role))} style={colorref(tile.heat) ? { color: colorref(tile.heat) } : undefined}>{tile.temp}</div>
                  {tile.pressure ? <div className="truncate text-xs text-muted-foreground">{tile.pressure[0]} {tile.pressure[1]}</div> : null}
                </div>
              </div>
              {tile.brake ? <div className="mt-1 truncate text-[10px] text-muted-foreground">{t.brakeLabel} {tile.brake}</div> : null}
              {typeof tile.wear === 'number' ? <Blocks frac={tile.wear} role={tile.wear < 0.25 ? 'danger' : 'good'} n={10} className="mt-1" /> : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Laps({ m }: { m: DashModel }) {
  const l = m.laps;
  if (!l || l.show === 'hidden') return null;
  const rows = l.rows ?? [];
  const sectors = Boolean(l.sectors);
  return (
    <Card id="laps" title={l.title} show={l.show}>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{l.empty}</p> : (
        <table className="w-full table-fixed font-mono text-sm tabular-nums">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-9 font-semibold">{l.heads?.[0]}</th>
              <th className="font-semibold">{l.heads?.[1]}</th>
              <th className="w-16 text-right font-semibold">{l.heads?.[2]}</th>
              {sectors ? ['S1', 'S2', 'S3'].map((s) => <th key={s} className="hidden w-14 text-right font-semibold sm:table-cell">{s}</th>) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={cn(dimmed(row.show) && 'opacity-50', row.kind === 'live' && 'bg-surface-raised')}>
                <td className="py-0.5 text-muted-foreground">{row.number}</td>
                <td className={cn('truncate', roleText(row.timeRole))}>{row.time}</td>
                <td className={cn('text-right', roleText(row.gapRole))}>{row.gap}</td>
                {sectors ? [0, 1, 2].map((k) => (
                  <td key={k} className={cn('hidden text-right sm:table-cell', roleText(row.sectors?.[k]?.[1]))}>{row.sectors?.[k]?.[0]}</td>
                )) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Track({ m }: { m: DashModel }) {
  if (m.map === 'hidden' && !visible(m.progress)) return null;
  if (!visible(m.progress) && !visible(m.distance)) return null;
  return (
    <Card id="track" title={m.mapTitle} show={m.progress?.show ?? m.map}>
      <div className="flex items-end justify-between gap-3">
        <ElemStat e={m.progress} big />
        <ElemStat e={m.distance} />
      </div>
      <Blocks frac={m.progress?.frac} role="primary" className="mt-2" />
    </Card>
  );
}

const CHIP: Record<string, Role> = { pit: 'info', abs: 'warn', tc: 'warn', drs: 'good', headlights: 'text', fuel: 'danger', engine: 'danger', handbrake: 'danger', flag: 'warn' };

function Alerts({ m }: { m: DashModel }) {
  const lights = (m.alerts ?? []).filter((a) => a.show !== 'hidden' && a.word);
  const damage = visible(m.damage) ? m.damage : null;
  const electronics = (m.electronics ?? []).filter((c) => c.show !== 'hidden' && c.value);
  if (!m.alertsTitle && lights.length === 0 && !damage && electronics.length === 0) return null;
  return (
    <Card id="alerts" title={m.alertsTitle}>
      {lights.length === 0 ? <p className="text-sm text-muted-foreground">{m.noAlerts}</p> : (
        <ul className="flex flex-wrap gap-1.5">
          {lights.map((a, i) => {
            const role = CHIP[a.kind ?? ''] ?? 'text';
            return (
              <li key={i} className={cn(R, 'border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide', dimmed(a.show) && 'opacity-50',
                a.glow === 'ready' ? cn('border-current bg-transparent', roleText(role)) : cn('border-transparent text-background', roleFill(role)))}>
                {a.word}
              </li>
            );
          })}
        </ul>
      )}
      {electronics.length > 0 ? <div className="mt-2 grid grid-cols-4 gap-2">{electronics.map((c, i) => <CellStat key={i} c={c} />)}</div> : null}
      {damage ? <p className={cn('mt-2 text-xs', roleText(damage.role))}>{damage.label ? `${damage.label}: ` : ''}{damage.text}</p> : null}
    </Card>
  );
}

// ---- the widgets of the later catalog (each has a model of its own) ----

// Black and white squares: a conic gradient repeated every quarter turn.
const CHEQUERED = '[background-image:repeating-conic-gradient(#fff_0%_25%,#000_0%_50%)] [background-size:40px_40px]';
const FLAG_LOOK: Record<string, string> = {
  green: 'bg-success text-success-foreground', yellow: 'bg-warn text-warn-foreground', blue: 'bg-info text-info-foreground',
  white: 'bg-white text-black', black: 'border-white bg-black text-white',
};

function Flag({ m }: { m: DashModel }) {
  const f = m.flag;
  if (!f || f.show === 'hidden') return null;
  const chequered = f.kind === 'chequered';
  return (
    <Card id="flag" title={f.title} show={f.show} className="p-2">
      <div
        data-flag={f.kind ?? 'none'}
        className={cn(R, 'flex h-24 items-center justify-center border border-border text-center text-2xl font-bold tracking-widest', chequered ? CHEQUERED : f.kind ? FLAG_LOOK[f.kind] : 'bg-surface-raised text-muted-foreground')}
        style={chequered ? CHEQUERED : undefined}
      >
        {chequered ? <span className={cn(R, 'bg-black px-3 py-1 text-white')}>{f.word}</span> : f.word}
      </div>
    </Card>
  );
}

function FuelCalc({ m }: { m: DashModel }) {
  const f = m.fuelCalc;
  if (!f || f.show === 'hidden') return null;
  const stats = (f.stats ?? []).filter((c) => c.value);
  return (
    <Card id="fuel_calc" title={f.title} show={f.show}>
      {stats.length > 0 ? <div className="grid grid-cols-3 gap-2">{stats.map((c, i) => <CellStat key={i} c={c} />)}</div> : null}
      {(f.rows?.length ?? 0) > 0 ? (
        <table className="mt-2 w-full font-mono text-sm tabular-nums">
          <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-semibold">{f.heads?.[0]}</th><th className="text-right font-semibold">{f.heads?.[1]}</th><th className="text-right font-semibold">{f.heads?.[2]}</th>
          </tr></thead>
          <tbody>{f.rows!.map((row, i) => (
            <tr key={i}><td className="py-0.5 text-muted-foreground">{row.laps}</td><td className="text-right">{row.needed}</td><td className={cn('text-right', roleText(row.role))}>{row.toAdd}</td></tr>
          ))}</tbody>
        </table>
      ) : null}
      {f.toEnd ? (
        <p className={cn('mt-2 text-sm', roleText(f.toEnd.role))}>
          <span className="text-muted-foreground">{f.toEnd.label} </span><span className="font-mono font-semibold">{f.toEnd.needed}</span>
          {f.toEnd.toAdd ? <span> · {f.toEnd.addLabel} <span className="font-mono font-semibold">{f.toEnd.toAdd}</span></span> : null}
        </p>
      ) : null}
      {f.note ? <p className="mt-2 text-xs text-muted-foreground">{f.note}</p> : null}
    </Card>
  );
}

function TyreTrend({ m }: { m: DashModel }) {
  const t = m.tyreTrend;
  if (!t || t.show === 'hidden') return null;
  return (
    <Card id="tyre_trend" title={t.title} show={t.show}>
      <div className="grid grid-cols-[2.5rem_1fr_3.5rem_3.5rem] items-center gap-x-2 gap-y-1 font-mono text-sm tabular-nums">
        <span /><span /><span className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">{t.heads?.[0]}</span>
        <span className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">{t.heads?.[1]}</span>
        {(t.rows ?? []).map((row, i) => (
          <div key={i} className="contents" data-worst={row.worst ? 'true' : undefined}>
            <span className={cn('text-xs', row.worst ? 'font-bold text-primary' : 'text-muted-foreground')}>{row.corner}</span>
            <Blocks frac={row.tread} role={row.role ?? 'good'} n={12} />
            <span className="text-right">{row.wear}</span>
            <span className={cn('text-right', roleText(row.role))}>{row.lapsLeft}</span>
          </div>
        ))}
      </div>
      {t.note ? <p className="mt-2 text-xs text-muted-foreground">{t.note}</p> : null}
    </Card>
  );
}

const TONE: Record<string, Role> = { plain: 'text', best: 'best', faster: 'good', slower: 'warn' };

function Sectors({ m }: { m: DashModel }) {
  const s = m.sectors;
  if (!s || s.show === 'hidden') return null;
  return (
    <Card id="sectors" title={s.title} show={s.show}>
      <table className="w-full font-mono text-base tabular-nums">
        <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground"><th /><th /><th className="text-right font-semibold">{s.bestHead}</th></tr></thead>
        <tbody>{(s.rows ?? []).map((row, i) => (
          <tr key={i}>
            <td className="py-0.5 text-sm text-muted-foreground">{row.label}</td>
            <td className={cn('text-right font-semibold', roleText(TONE[row.tone ?? 'plain']), row.fromLastLap && 'opacity-80')}>{row.time}</td>
            <td className="text-right text-sm text-muted-foreground">{row.best}</td>
          </tr>
        ))}</tbody>
      </table>
      {s.theoretical ? (
        <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-2 text-sm">
          <span className="truncate text-muted-foreground">{s.theoreticalLabel}</span>
          <span className="font-mono font-semibold tabular-nums">{s.theoretical}{s.gap ? <span className="ml-2 text-xs text-muted-foreground">{s.gap} {s.gapLabel}</span> : null}</span>
        </div>
      ) : null}
    </Card>
  );
}

const DELTA_BLOCKS = 10;

function DeltaBar({ m }: { m: DashModel }) {
  const d = m.deltaBar;
  if (!d || d.show === 'hidden') return null;
  // `frac` is 0..1 with the middle at zero (the bar spans +-2 s): blocks fill from the middle towards the delta.
  const step = Math.round((clamp01(d.frac ?? 0.5) - 0.5) * 2 * DELTA_BLOCKS);
  return (
    <Card id="delta_bar" title={d.title} right={d.caption} show={d.show}>
      <div className={cn('text-center font-mono text-5xl font-bold leading-none tabular-nums', roleText(d.role))}>{d.value}</div>
      <div className="mt-3 flex gap-[2px]" aria-hidden="true">
        {Array.from({ length: DELTA_BLOCKS * 2 + 1 }, (_, i) => {
          const at = i - DELTA_BLOCKS;
          const on = at === 0 || (step > 0 ? at > 0 && at <= step : at < 0 && at >= step);
          return <span key={i} className={cn(R, 'h-3 flex-1', on ? (at === 0 ? 'bg-foreground' : roleFill(d.role)) : 'bg-muted/50')} />;
        })}
      </div>
    </Card>
  );
}

function SessionCard({ m }: { m: DashModel }) {
  const s = m.sessionCard;
  if (!s || s.show === 'hidden') return null;
  if (!s.position && !s.remaining) return null;
  return (
    <Card id="session" title={s.title} show={s.show}>
      <div className="flex items-end justify-between gap-3 font-mono tabular-nums">
        <div>
          <span className="text-5xl font-bold leading-none text-primary">{s.position}</span>
          {s.ofCars ? <span className="ml-1 text-lg text-muted-foreground">{s.ofCars}</span> : null}
          {s.classLine ? <div className="mt-1 text-xs text-muted-foreground">{s.classLine}</div> : null}
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold leading-tight">{s.remaining}</div>
          {s.remainingNote ? <div className="text-xs text-muted-foreground">{s.remainingNote}</div> : null}
        </div>
      </div>
    </Card>
  );
}

function Relative({ m }: { m: DashModel }) {
  const r = m.relative;
  if (!r || r.show === 'hidden') return null;
  return (
    <Card id="relative" title={r.title} show={r.show}>
      {(r.rows?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{r.note}</p> : (
        <ul className="font-mono text-sm tabular-nums">
          {r.rows!.map((row, i) => (
            <li key={i} className={cn(R, 'flex items-center gap-2 px-1.5 py-0.5', row.isPlayer && 'bg-primary/15 font-semibold text-primary')} data-player={row.isPlayer ? 'true' : undefined}>
              <span className="w-8 shrink-0 text-muted-foreground">{row.position}</span>
              <span className={cn('min-w-0 flex-1 truncate', !row.isPlayer && (row.relation === 'level' || !row.relation ? '' : roleText(row.role)))}>{row.name}</span>
              <span className={cn('w-16 shrink-0 text-right', !row.isPlayer && roleText(row.role))}>{row.gap}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Standings({ m }: { m: DashModel }) {
  const s = m.standings;
  if (!s || s.show === 'hidden') return null;
  return (
    <Card id="standings" title={s.title} right={s.className} show={s.show}>
      {(s.rows?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{s.note}</p> : (
        <table className="w-full table-fixed font-mono text-sm tabular-nums">
          <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="w-9" /><th /><th className="w-16 text-right font-semibold">{s.heads?.[0]}</th><th className="w-20 text-right font-semibold">{s.heads?.[1]}</th>
          </tr></thead>
          <tbody>{s.rows!.map((row, i) => (
            <tr key={i} className={cn(row.isPlayer && 'bg-primary/15 font-semibold text-primary', row.skippedBefore && 'border-t border-dashed border-border')} data-player={row.isPlayer ? 'true' : undefined}>
              <td className="py-0.5 pl-1 text-muted-foreground">{row.position}</td>
              <td className="truncate">{row.name}</td>
              <td className="text-right">{row.gap}</td>
              <td className="pr-1 text-right">{row.last}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function GapSide({ side }: { side?: { label?: string; car?: { position?: string; name?: string; gap?: string; trend?: { text?: string; role?: Role } | null } | null } }) {
  if (!side) return null;
  const car = side.car;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{side.label}</div>
      {car ? (
        <>
          <div className="truncate font-mono text-sm"><span className="text-muted-foreground">{car.position}</span> {car.name}</div>
          <div className="font-mono text-2xl font-semibold leading-tight tabular-nums">{car.gap}</div>
          {car.trend?.text ? <div className={cn('truncate text-xs', roleText(car.trend.role))}>{car.trend.text}</div> : null}
        </>
      ) : <div className="font-mono text-2xl text-muted-foreground">–</div>}
    </div>
  );
}

function Gaps({ m }: { m: DashModel }) {
  const g = m.gaps;
  if (!g || g.show === 'hidden') return null;
  return (
    <Card id="gaps" title={g.title} show={g.show}>
      <div className="grid grid-cols-2 gap-3"><GapSide side={g.ahead} /><GapSide side={g.behind} /></div>
      {g.note ? <p className="mt-2 text-xs text-muted-foreground">{g.note}</p> : null}
    </Card>
  );
}

// The radar is drawn in metres, as the panel's: the player at the origin pointing up (+y is down in SVG, so ahead is -y).
const RADAR_VIEW = '-12 -30 24 50';
const CAR_W = 1.9;
const CAR_L = 4.6;
const THREAT: Record<string, string> = { clear: 'hsl(var(--muted-foreground))', near: 'hsl(var(--warn))', alongside: 'hsl(var(--destructive))' };

function Radar({ m }: { m: DashModel }) {
  const r = m.radar;
  if (!r || r.show === 'hidden') return null;
  const mode = r.mode ?? 'waiting';
  return (
    <Card id="radar" title={r.title} show={r.show}>
      {mode === 'waiting' ? <p className="text-sm text-muted-foreground">{r.note}</p> : (
        <svg viewBox={RADAR_VIEW} className="mx-auto h-56 w-auto max-w-full" role="img" aria-label={r.title ?? 'Radar'} data-mode={mode}>
          <rect x={-12} y={-30} width={24} height={50} rx={0.8} fill="hsl(var(--surface-raised))" />
          {mode === 'map' ? [...(r.cars ?? [])].map((c, i) => (
            <rect key={i} x={(c.rightM ?? 0) - CAR_W / 2} y={-(c.aheadM ?? 0) - CAR_L / 2} width={CAR_W} height={CAR_L} rx={0.4}
              fill={THREAT[c.threat ?? 'clear'] ?? THREAT.clear} data-threat={c.threat ?? 'clear'} />
          )) : null}
          {mode === 'spotter' ? (
            <>
              {Array.from({ length: Math.min(2, Math.max(0, r.leftBars ?? 0)) }, (_, i) => (
                <rect key={`l${i}`} x={-(2.4 + i * 1.8) - 0.5} y={-4.5} width={1} height={9} rx={0.4} fill={THREAT.alongside} data-bar="left" />
              ))}
              {Array.from({ length: Math.min(2, Math.max(0, r.rightBars ?? 0)) }, (_, i) => (
                <rect key={`r${i}`} x={2.4 + i * 1.8 - 0.5} y={-4.5} width={1} height={9} rx={0.4} fill={THREAT.alongside} data-bar="right" />
              ))}
            </>
          ) : null}
          <rect x={-CAR_W / 2} y={-CAR_L / 2} width={CAR_W} height={CAR_L} rx={0.4} fill="hsl(var(--primary))" data-player="true" />
        </svg>
      )}
    </Card>
  );
}

function DeltaRef({ m }: { m: DashModel }) {
  const d = m.deltaRef;
  if (!d || d.show === 'hidden') return null;
  return (
    <Card id="delta_ref" title={d.title} show={d.show}>
      <div className={cn('font-mono text-4xl font-bold leading-none tabular-nums', roleText(d.role))}>{d.value}</div>
      {d.line ? <p className="mt-2 truncate text-xs text-muted-foreground">{d.line}</p> : null}
      {d.personalLine ? <p className="truncate text-xs text-muted-foreground">{d.personalLine}</p> : null}
      {d.note ? <p className="mt-2 text-xs text-muted-foreground">{d.note}</p> : null}
    </Card>
  );
}

// ---- the registry ----

interface Entry {
  /** The part of the model the widget reads: a change anywhere else does not draw it again. */
  pick: (m: DashModel) => unknown;
  View: (props: { m: DashModel }) => ReactElement | null;
}

const own = <K extends keyof DashModel>(...keys: K[]) => (m: DashModel) => keys.map((k) => m[k]);

/** Every widget id of the catalog. An id that is not here is skipped (a newer Companion may know more). */
const WIDGETS: Record<string, Entry> = {
  times: { pick: own('lapTime', 'lastLap', 'bestLap', 'delta', 'deltaVs', 'deltaNote'), View: Times },
  centre: { pick: own('gear', 'gearBelow', 'gearAbove', 'speed', 'rev', 'throttle', 'brake', 'clutch'), View: Centre },
  fuel: { pick: own('fuelTitle', 'fuel', 'fuelShare', 'fuelLaps', 'fuelTank', 'fuelPerLap', 'fuelLow', 'engine'), View: Fuel },
  tyres: { pick: own('tyres'), View: Tyres },
  laps: { pick: own('laps'), View: Laps },
  track: { pick: own('map', 'mapTitle', 'progress', 'distance'), View: Track },
  alerts: { pick: own('alertsTitle', 'alerts', 'noAlerts', 'electronics', 'damage'), View: Alerts },
  flag: { pick: own('flag'), View: Flag },
  fuel_calc: { pick: own('fuelCalc'), View: FuelCalc },
  tyre_trend: { pick: own('tyreTrend'), View: TyreTrend },
  sectors: { pick: own('sectors'), View: Sectors },
  delta_bar: { pick: own('deltaBar'), View: DeltaBar },
  session: { pick: own('sessionCard'), View: SessionCard },
  relative: { pick: own('relative'), View: Relative },
  standings: { pick: own('standings'), View: Standings },
  gaps: { pick: own('gaps'), View: Gaps },
  radar: { pick: own('radar'), View: Radar },
  delta_ref: { pick: own('deltaRef'), View: DeltaRef },
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * One widget in its row. The key is the widget id (stable, so nothing is mounted again per frame), and the widget is drawn again only when its own
 * part of the model changed: frames arrive up to 15 times a second and most cards hold still.
 */
export const WidgetSlot = memo(function WidgetSlot({ id, model }: { id: string; model: DashModel }) {
  const entry = WIDGETS[id];
  if (!entry) return null;
  return <entry.View m={model} />;
}, (before, after) => {
  if (before.id !== after.id) return false;
  const entry = WIDGETS[after.id];
  return entry ? same(entry.pick(before.model), entry.pick(after.model)) : true;
});
