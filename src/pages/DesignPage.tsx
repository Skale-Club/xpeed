import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, Loader2, Palette, Plus, Trash2 } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { PageLoader } from '@/components/PageLoader';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { FilterBar, FILTER_CELL, FILTER_WIDE_CELL } from '@/components/ui/filter-bar';
import { FilterSelect, SearchField } from '@/components/ui/filter-fields';
import { FilterSheet } from '@/components/ui/filter-sheet';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { OptionSelect } from '@/components/ui/option-select';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { Panel } from '@/components/ui/panel';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { StatGrid, StatTile } from '@/components/ui/stat-tile';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** Token names are read by hand from the :root block of src/index.css; keep both in step. `alpha` marks derived tints (no CSS variable of their own). */
interface Token { name: string; cls: string; alpha?: number }
const COLOUR_GROUPS: Array<{ title: string; tokens: Token[] }> = [
  { title: 'Surfaces & lines', tokens: [
    { name: 'background', cls: 'bg-background' }, { name: 'card', cls: 'bg-card' }, { name: 'popover', cls: 'bg-popover' },
    { name: 'surface', cls: 'bg-surface' }, { name: 'surface-raised', cls: 'bg-surface-raised' }, { name: 'surface-overlay', cls: 'bg-surface-overlay' },
    { name: 'secondary', cls: 'bg-secondary' }, { name: 'muted', cls: 'bg-muted' }, { name: 'accent', cls: 'bg-accent' },
    { name: 'border', cls: 'border-border' }, { name: 'border-subtle', cls: 'border-border-subtle' }, { name: 'border-strong', cls: 'border-border-strong' },
    { name: 'input', cls: 'border-input' }, { name: 'ring', cls: 'ring-ring' },
  ] },
  { title: 'Text', tokens: [
    { name: 'foreground', cls: 'text-foreground' }, { name: 'card-foreground', cls: 'text-card-foreground' }, { name: 'popover-foreground', cls: 'text-popover-foreground' },
    { name: 'secondary-foreground', cls: 'text-secondary-foreground' }, { name: 'muted-foreground', cls: 'text-muted-foreground' }, { name: 'accent-foreground', cls: 'text-accent-foreground' },
    { name: 'primary', cls: 'bg-primary' }, { name: 'primary-foreground', cls: 'text-primary-foreground' },
  ] },
  { title: 'Brand', tokens: [
    { name: 'brand', cls: 'bg-brand' }, { name: 'brand-foreground', cls: 'text-brand-foreground' },
    { name: 'brand-2', cls: 'bg-brand-2' }, { name: 'brand-2-foreground', cls: 'text-brand-2-foreground' },
    { name: 'brand-3', cls: 'bg-brand-3' }, { name: 'brand-3-foreground', cls: 'text-brand-3-foreground' },
  ] },
  { title: 'Status', tokens: ['success', 'warn', 'destructive', 'critical', 'info'].flatMap((n): Token[] => [
    { name: n, cls: `bg-${n}` }, { name: n, cls: `bg-${n}-soft`, alpha: 0.1 }, { name: n, cls: `border-${n}-line`, alpha: 0.3 }, { name: `${n}-foreground`, cls: `text-${n}-foreground` },
  ]) },
  { title: 'Charts', tokens: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ name: `chart-${i}`, cls: `bg-chart-${i}` })) },
  { title: 'Sidebar', tokens: [
    { name: 'sidebar-background', cls: 'bg-sidebar-background' }, { name: 'sidebar-foreground', cls: 'text-sidebar-foreground' },
    { name: 'sidebar-primary', cls: 'bg-sidebar-primary' }, { name: 'sidebar-primary-foreground', cls: 'text-sidebar-primary-foreground' },
    { name: 'sidebar-accent', cls: 'bg-sidebar-accent' }, { name: 'sidebar-accent-foreground', cls: 'text-sidebar-accent-foreground' },
    { name: 'sidebar-border', cls: 'border-sidebar-border' }, { name: 'sidebar-ring', cls: 'ring-sidebar-ring' },
  ] },
];

const SECTIONS = [
  { id: 'colours', label: 'Colours' }, { id: 'type', label: 'Type' }, { id: 'radius', label: 'Radius & elevation' }, { id: 'buttons', label: 'Buttons' },
  { id: 'badges', label: 'Badges & chips' }, { id: 'stats', label: 'Stats' }, { id: 'navigation', label: 'Navigation' }, { id: 'filters', label: 'Filters' },
  { id: 'states', label: 'States' }, { id: 'forms', label: 'Form controls' },
] as const;

function readToken(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function Demo({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <Note>{note}</Note>
      {children}
    </div>
  );
}

function Swatch({ token }: { token: Token }) {
  const [value, setValue] = useState('');
  useEffect(() => { setValue(readToken(token.name)); }, [token.name]);
  const colour = token.alpha ? `hsl(var(--${token.name}) / ${token.alpha})` : `hsl(var(--${token.name}))`;
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg border border-border bg-card p-2" data-testid="swatch">
      <div className="h-10 rounded-md border border-border-strong" style={{ background: colour }} />
      <p className="truncate font-mono text-2xs font-semibold">--{token.name}{token.alpha ? ` @ ${token.alpha}` : ''}</p>
      <p className="truncate font-mono text-2xs text-muted-foreground">{token.cls}</p>
      <p className="truncate font-mono text-2xs text-muted-foreground">{value ? `hsl(${value})` : '-'}</p>
    </div>
  );
}

const PERIODS = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] as const;
type Period = (typeof PERIODS)[number]['value'];
const CARS = [{ value: 'prius', label: 'Prius' }, { value: 'civic', label: 'Civic' }, { value: 'golf', label: 'Golf' }];

export default function DesignPage() {
  const { isAdmin, loading } = useAdminStatus();
  const [section, setSection] = useState<string>(SECTIONS[0].id);
  const [seg, setSeg] = useState<Period>('week');
  const [segSm, setSegSm] = useState<Period>('day');
  const [segFull, setSegFull] = useState<Period>('month');
  const [tab, setTab] = useState('one');
  const [page, setPage] = useState(2);
  const [more, setMore] = useState(1);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [car, setCar] = useState('');
  const [query, setQuery] = useState('');
  const [sheetCar, setSheetCar] = useState('');
  const [on, setOn] = useState(true);
  const [option, setOption] = useState('civic');
  const [picked, setPicked] = useState(true);
  const [chips, setChips] = useState(['Wet', 'Track day']);
  const [retrying, setRetrying] = useState(false);

  if (loading) return <PageLoader />;
  // Not an admin: say nothing about admins, e-mails or how to become one.
  if (!isAdmin) return (
    <AppLayout>
      <div className="max-w-md mx-auto pt-12 text-center space-y-2">
        <h2 className="text-lg font-bold text-foreground">Not available</h2>
        <p className="text-sm text-muted-foreground">There is nothing to see on this page.</p>
      </div>
    </AppLayout>
  );

  const goTo = (id: string) => {
    setSection(id);
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  const fakeLoadMore = () => { setFetchingMore(true); setTimeout(() => { setMore((m) => m + 1); setFetchingMore(false); }, 600); };
  const fakeRetry = () => { setRetrying(true); setTimeout(() => setRetrying(false), 800); };
  const sheetCount = sheetCar ? 1 : 0;

  return (
    <AppLayout>
      <div className="space-y-4 pb-12">
        <PageHeader
          icon={Palette}
          title="Design system"
          description="Every token and shared component, as the app uses them. Developer tooling: fake data, nothing is fetched."
          back={{ to: '/admin', label: 'Admin' }}
        />

        <nav aria-label="Sections" className="sticky top-0 z-10 -mx-1 bg-background/90 px-1 backdrop-blur">
          <Tabs value={section} onValueChange={goTo}>
            <TabsList variant="underline" aria-label="Design system sections">
              {SECTIONS.map((s) => <TabsTrigger key={s.id} value={s.id}>{s.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </nav>

        <section id="colours" className="scroll-mt-14">
          <Panel title="Colours" description="Every token of :root in src/index.css. Use the Tailwind class, never a raw hex or hsl().">
            <div className="space-y-5">
              {COLOUR_GROUPS.map((g) => (
                <div key={g.title} className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h4>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {g.tokens.map((t) => <Swatch key={t.cls} token={t} />)}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <section id="type" className="scroll-mt-14">
          <Panel title="Type" description="Inter for text, JetBrains Mono (font-mono) for codes and numbers that line up.">
            <div className="space-y-3">
              {[
                ['h1', 'text-2xl font-bold', 'Page title'], ['h2', 'text-xl font-bold', 'Screen title (PageHeader)'],
                ['h3', 'text-sm font-semibold', 'Panel title'], ['h4', 'text-xs font-semibold uppercase', 'Sub-block label'],
              ].map(([tag, cls, text]) => (
                <div key={tag} className="min-w-0"><p className={cls}>{text}</p><p className="font-mono text-2xs text-muted-foreground">{tag} · {cls}</p></div>
              ))}
              {(['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-xs', 'text-2xs'] as const).map((cls) => (
                <div key={cls} className="min-w-0"><p className={cls}>The quick brown fox jumps over the lazy dog</p><p className="font-mono text-2xs text-muted-foreground">{cls}</p></div>
              ))}
              <div className="space-y-1">
                <Note>Lap times and telemetry: font-mono with tabular-nums, so columns of digits stay aligned.</Note>
                <p className="font-mono text-lg tabular-nums">1:23.456<br />1:24.007<br />0:59.888</p>
                <p className="font-mono text-2xs text-muted-foreground">font-mono tabular-nums</p>
              </div>
            </div>
          </Panel>
        </section>

        <section id="radius" className="scroll-mt-14">
          <Panel title="Radius & elevation" description="One tight radius scale; shadows go with the surface step they sit on.">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-2xl', 'rounded-full'].map((cls) => (
                  <div key={cls} className="space-y-1.5"><div className={`h-14 border border-border-strong bg-secondary ${cls}`} /><p className="font-mono text-2xs text-muted-foreground">{cls}</p></div>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[['shadow-card', 'bg-surface'], ['shadow-raised', 'bg-surface-raised'], ['shadow-overlay', 'bg-surface-overlay']].map(([sh, bg]) => (
                  <div key={sh} className={`space-y-1 rounded-xl border border-border p-4 ${sh} ${bg}`}>
                    <p className="text-sm font-semibold">{sh}</p><p className="font-mono text-2xs text-muted-foreground">{bg}</p>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </section>

        <section id="buttons" className="scroll-mt-14">
          <Panel title="Buttons" description="One Button, six variants, four sizes. Disabled keeps the shape; loading is a disabled button with a spinner.">
            <div className="space-y-4">
              {(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const).map((v) => (
                <div key={v} className="space-y-1.5">
                  <p className="font-mono text-2xs text-muted-foreground">variant="{v}"</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant={v} size="sm">Small</Button>
                    <Button variant={v}>Default</Button>
                    <Button variant={v} size="lg">Large</Button>
                    <Button variant={v} size="icon" aria-label={`${v} icon button`}><Plus /></Button>
                    <Button variant={v} disabled>Disabled</Button>
                    <Button variant={v} disabled><Loader2 className="animate-spin" />Loading</Button>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <section id="badges" className="scroll-mt-14">
          <Panel title="Badges & chips" description="Badge labels a category; StatusBadge says what state something is in; Chip is a filter, a tag or a choice.">
            <div className="space-y-4">
              <Demo title="Badge" note="A small label or category that is not a state. Brand hues are for highlights, never for status.">
                <div className="flex flex-wrap gap-2">
                  {(['default', 'secondary', 'destructive', 'outline', 'success', 'warn', 'info', 'critical', 'brand', 'brand2', 'brand3', 'muted'] as const).map((v) => <Badge key={v} variant={v}>{v}</Badge>)}
                </div>
              </Demo>
              <Demo title="StatusBadge" note="Wherever a row or card says what state something is in (online, failed, pending).">
                <div className="flex flex-wrap gap-2">
                  {(['success', 'warn', 'critical', 'info', 'neutral'] as const).map((t) => <StatusBadge key={t} tone={t}>{t}</StatusBadge>)}
                  <StatusBadge tone="success" dot={false}>no dot</StatusBadge>
                </div>
              </Demo>
              <Demo title="Chip" note="Plain label, toggle (selected shows its state) or removable applied filter. md is the phone default, sm fits dense toolbars.">
                {(['md', 'sm'] as const).map((size) => (
                  <div key={size} className="flex flex-wrap items-center gap-2">
                    <span className="w-8 font-mono text-2xs text-muted-foreground">{size}</span>
                    <Chip size={size}>Plain</Chip>
                    <Chip size={size} onClick={() => setPicked((p) => !p)} selected={picked}>Toggle</Chip>
                    <Chip size={size} onClick={() => undefined}>Not selected</Chip>
                    {chips.map((c) => <Chip key={c} size={size} onRemove={() => setChips((l) => l.filter((x) => x !== c))} removeLabel={`Remove ${c}`}>{c}</Chip>)}
                  </div>
                ))}
              </Demo>
            </div>
          </Panel>
        </section>

        <section id="stats" className="scroll-mt-14">
          <Panel title="Stats" description="StatTile is one number of a screen; StatGrid lays a row of them out as a list.">
            <div className="space-y-4">
              <Demo title="Tones" note="Tone colours the value; keep default unless the number carries a meaning.">
                <StatGrid>
                  <StatTile label="Default" value="128" hint="sessions" />
                  <StatTile label="Brand" value="42.1" tone="brand" hint="km/h avg" />
                  <StatTile label="Success" value="98%" tone="success" hint="healthy" />
                  <StatTile label="Warn" value="3" tone="warn" hint="due soon" />
                  <StatTile label="Critical" value="1" tone="critical" hint="act now" />
                  <StatTile label="Info" value="7" tone="info" hint="notes" />
                </StatGrid>
              </Demo>
              <Demo title="Trend meaning" note="Direction is the arrow; meaning (good / bad / neutral) is the colour, because up is not always good.">
                <StatGrid>
                  <StatTile label="Lap time" value="1:23.4" icon={Inbox} trend={{ direction: 'down', label: '-0.4 s', meaning: 'good' }} />
                  <StatTile label="Fuel use" value="6.9 L" trend={{ direction: 'up', label: '+0.8 L', meaning: 'bad' }} />
                  <StatTile label="Distance" value="312 km" trend={{ direction: 'flat', label: 'same', meaning: 'neutral' }} footer="Last 30 days" />
                </StatGrid>
              </Demo>
            </div>
          </Panel>
        </section>

        <section id="navigation" className="scroll-mt-14">
          <Panel title="Navigation" description="Choices, sections and pages.">
            <div className="space-y-5">
              <Demo title="SegmentedControl" note="A short, mutually exclusive choice (a period, a mode). Use Tabs when the choice swaps a block of content.">
                <div className="space-y-2">
                  <SegmentedControl aria-label="Period md" options={PERIODS} value={seg} onChange={setSeg} />
                  <SegmentedControl aria-label="Period sm" size="sm" options={PERIODS} value={segSm} onChange={setSegSm} />
                  <SegmentedControl aria-label="Period full width" fullWidth options={PERIODS} value={segFull} onChange={setSegFull} />
                </div>
              </Demo>
              <Demo title="Tabs" note="Pill swaps a block of content; underline is a row of text tabs for a page's sections.">
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList><TabsTrigger value="one">Pill one</TabsTrigger><TabsTrigger value="two">Pill two</TabsTrigger></TabsList>
                  <TabsContent value="one"><Note>Content of pill tab one.</Note></TabsContent>
                  <TabsContent value="two"><Note>Content of pill tab two.</Note></TabsContent>
                </Tabs>
                <Tabs defaultValue="a">
                  <TabsList variant="underline"><TabsTrigger value="a">Overview</TabsTrigger><TabsTrigger value="b">Laps</TabsTrigger><TabsTrigger value="c">Setup</TabsTrigger></TabsList>
                  <TabsContent value="a"><Note>Content of the underline tab.</Note></TabsContent>
                  <TabsContent value="b"><Note>Laps.</Note></TabsContent>
                  <TabsContent value="c"><Note>Setup.</Note></TabsContent>
                </Tabs>
              </Demo>
              <Demo title="Pagination" note="Previous / Next with Page x of y, for a list split in pages the person moves through.">
                <Pagination page={page} pageCount={8} onPageChange={setPage} total={78} pageSize={10} showJump />
              </Demo>
              <Demo title="LoadMore" note="The Load more button of a list that grows page by page (fake: adds a page after a moment).">
                <div className="space-y-2">
                  <Note>{more} of 3 pages loaded</Note>
                  <LoadMore hasNextPage={more < 3} isFetchingNextPage={fetchingMore} onClick={fakeLoadMore} testId="design-load-more" />
                </div>
              </Demo>
            </div>
          </Panel>
        </section>

        <section id="filters" className="scroll-mt-14">
          <Panel title="Filters" description="One bar for every list: inline on a wide screen, a bottom sheet on a phone.">
            <div className="space-y-5">
              <Demo title="FilterBar" note="A wrapping row of small controls with no card of its own: FilterSelect, SearchField, toggles.">
                <FilterBar>
                  <div className={FILTER_CELL}><FilterSelect label="Car" value={car} onChange={setCar} options={CARS} allLabel="All" className="w-full sm:w-44" /></div>
                  <div className={FILTER_WIDE_CELL}><SearchField label="Search sessions" value={query} onChange={setQuery} placeholder="Search" className="w-full sm:w-56" /></div>
                </FilterBar>
              </Demo>
              <Demo title="FilterSheet" note="The phone pattern: one Filters button with a count, a sheet holding the controls, Clear all and Show results at the foot.">
                <FilterSheet count={sheetCount} onClear={() => setSheetCar('')}>
                  <FilterSelect label="Car" value={sheetCar} onChange={setSheetCar} options={CARS} allLabel="All" className="w-full" />
                </FilterSheet>
              </Demo>
            </div>
          </Panel>
        </section>

        <section id="states" className="scroll-mt-14">
          <Panel title="States" description="What a block shows when it has nothing, failed or is waiting.">
            <div className="space-y-5">
              <Demo title="EmptyState" note="Nothing here yet: say why and offer the next step. compact fits inside a small panel.">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <Card><CardContent className="p-0"><EmptyState icon={Inbox} title="No sessions yet" description="Drive with the scanner connected and trips appear here." action={<Button size="sm">Connect scanner</Button>} /></CardContent></Card>
                  <Card><CardContent className="p-0"><EmptyState compact icon={Inbox} title="Nothing to show" description="Compact variant." /></CardContent></Card>
                </div>
              </Demo>
              <Demo title="ErrorState" note="Something failed: a short title, what to do, and a retry that spins while it runs.">
                <Card><CardContent className="p-0"><ErrorState title="Could not load sessions" description="Check the connection and try again." onRetry={fakeRetry} retrying={retrying} /></CardContent></Card>
              </Demo>
              <Demo title="LoadingState" note="Waiting for data: a spinner for a block, list or cards placeholders that match what will appear.">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <LoadingState variant="spinner" label="Loading" />
                  <LoadingState variant="list" rows={3} />
                  <LoadingState variant="cards" rows={2} />
                </div>
                <div className="space-y-2"><Note>Skeleton, the raw building block:</Note><Skeleton className="h-4 w-1/2" /><Skeleton className="h-10 w-full" /></div>
              </Demo>
            </div>
          </Panel>
        </section>

        <section id="forms" className="scroll-mt-14">
          <Panel title="Form controls" description="Input, Switch and the app's drop-down.">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Demo title="Input" note="Text field; pair it with a Label.">
                <Input aria-label="Example input" placeholder="Type here" />
              </Demo>
              <Demo title="Switch" note="An on / off setting that applies at once.">
                <label className="flex items-center gap-3 text-sm"><Switch checked={on} onCheckedChange={setOn} aria-label="Example switch" />{on ? 'On' : 'Off'}</label>
              </Demo>
              <Demo title="OptionSelect" note="The app's drop-down behind a plain value / onChange / options API; emptyLabel adds the All entry.">
                <div className="space-y-2">
                  <OptionSelect aria-label="Car" value={option} onChange={setOption} options={CARS} emptyLabel="All cars" />
                  <OptionSelect label="Car" size="sm" value={option} onChange={setOption} options={CARS} emptyLabel="All" />
                </div>
              </Demo>
              <Demo title="Destructive action" note="Pair destructive buttons with a confirm step.">
                <Button variant="destructive" size="sm"><Trash2 />Delete</Button>
              </Demo>
            </div>
          </Panel>
        </section>

        <p className="text-center text-xs text-muted-foreground"><Link to="/admin" className="underline">Back to the admin panel</Link></p>
      </div>
    </AppLayout>
  );
}
