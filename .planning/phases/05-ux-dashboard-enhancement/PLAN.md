---
phase: 05-ux-dashboard-enhancement
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/pages/CarsPage.tsx
  - src/components/AppLayout.tsx
  - src/lib/db.ts
autonomous: true
requirements:
  - UX-01
  - UX-02
  - UX-03
  - UX-04
  - UX-05
  - UX-06
  - UX-07

must_haves:
  truths:
    - "Edit buttons on car cards are visible on hover (group bug fixed)"
    - "Car cards show session count and last upload date"
    - "Dashboard empty state includes a step-by-step Quick Start guide"
    - "History page empty state includes an Upload CTA button"
    - "Dashboard skeleton replaces the full-screen spinner during load"
    - "FlagsPanel groups flags by severity with Critical shown before Attention"
    - "Problems dialog shows counts per severity and a Resolve All button for active flags"
  artifacts:
    - path: "src/components/DashboardSkeleton.tsx"
      provides: "Skeleton layout for dashboard KPI + chart area"
      exports: ["DashboardSkeleton"]
    - path: "src/components/CarCardSkeleton.tsx"
      provides: "Skeleton placeholder for a single car card"
      exports: ["CarCardSkeleton"]
    - path: "src/pages/CarsPage.tsx"
      provides: "Car management page with fixed group bug, session count, last upload"
      contains: "group class on card wrapper"
    - path: "src/components/FlagsPanel.tsx"
      provides: "Severity-grouped flags with Resolve All"
  key_links:
    - from: "src/pages/CarsPage.tsx"
      to: "src/lib/db.ts"
      via: "getSessionCountByCarId / getLastUploadDateByCarId helpers"
      pattern: "supabase.*car_profile_id"
    - from: "src/pages/Index.tsx"
      to: "src/components/DashboardSkeleton.tsx"
      via: "replaces PageLoader when loading || statsLoading"
      pattern: "DashboardSkeleton"
---

<objective>
Fix the most impactful, lowest-risk UX bugs and visual improvements across the dashboard, car cards, flags panel, and empty states. Every task in this plan is a targeted surgical edit — no architecture changes, no new data models beyond two lightweight DB helpers.

Purpose: Eliminate invisible buttons, replace jarring full-screen spinners with content-aware skeletons, and give every empty state clear next-step guidance. These changes directly affect first-run experience and day-to-day usability.

Output:
- CarsPage.tsx with working hover-reveal edit buttons, session count, and last upload date per card
- DashboardSkeleton.tsx + CarCardSkeleton.tsx components
- Dashboard loading path uses skeleton instead of PageLoader
- FlagsPanel with severity grouping + Resolve All
- Improved empty states on Dashboard and HistoryPage
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/pages/Index.tsx
@src/pages/CarsPage.tsx
@src/pages/HistoryPage.tsx
@src/components/FlagsPanel.tsx
@src/components/AppLayout.tsx
@src/components/PageLoader.tsx
@src/lib/db.ts

<interfaces>
<!-- Key contracts the executor needs. Do not explore the codebase beyond these. -->

From src/components/ui/skeleton.tsx:
```typescript
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
export { Skeleton };
```

From src/lib/db.ts (existing patterns to follow):
```typescript
// All DB helpers follow this pattern:
export async function getSessions(carProfileId?: string) {
  let query = supabase
    .from('sessions')
    .select('id, car_profile_id, uploaded_at, ...')
    .order('uploaded_at', { ascending: false });
  if (carProfileId) query = query.eq('car_profile_id', carProfileId);
  const { data } = await query;
  return data || [];
}
```

From src/contexts/CarsContext.tsx:
```typescript
interface CarsContextType {
  cars: CarProfile[];
  selectedCar: CarProfile | null;
  selectedCarId: string | null;
  loading: boolean;
  error: string | null;
  createCar, updateCar, deleteCar, selectCar, refresh
}
```

From src/components/FlagsPanel.tsx (existing Flag interface):
```typescript
interface Flag {
  id?: string;
  severity: string;         // 'critical' | 'attention'
  canonical_key: string;
  parameter_key: string;
  message: string;
  evidence?: Record<string, unknown> | null;
  resolved?: boolean;
}
interface FlagsPanelProps {
  flags: Flag[];
  limit?: number;
}
```

From src/pages/Index.tsx (problems dialog state — used in Task 3):
```typescript
// generalStats.problems contains Flag[] with resolved field
// handleToggleResolved(flagId, currentResolved) exists
// visibleProblems is already filtered
// isProblemsOpen / setIsProblemsOpen controls dialog
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix CarsPage group bug + add session count and last upload to car cards</name>
  <files>
    src/pages/CarsPage.tsx
    src/lib/db.ts
  </files>
  <action>
**Step A — Add two lightweight DB helpers to src/lib/db.ts:**

Add these two functions after `getSessions`:

```typescript
export async function getSessionCountForCar(carProfileId: string): Promise<number> {
  const { count } = await supabase
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('car_profile_id', carProfileId);
  return count || 0;
}

export async function getLastUploadForCar(carProfileId: string): Promise<Date | null> {
  const { data } = await supabase
    .from('sessions')
    .select('uploaded_at')
    .eq('car_profile_id', carProfileId)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? new Date(data.uploaded_at) : null;
}
```

**Step B — Update CarsPage.tsx:**

1. Import the two new helpers at the top.

2. Add state for card metadata (per-car):
```typescript
const [carMeta, setCarMeta] = useState<Record<string, { sessionCount: number; lastUpload: Date | null }>>({});
```

3. Add a `useEffect` that fires when `cars` changes and populates `carMeta`:
```typescript
useEffect(() => {
  if (cars.length === 0) return;
  const fetchMeta = async () => {
    const entries = await Promise.all(
      cars.map(async (car) => {
        const [sessionCount, lastUpload] = await Promise.all([
          getSessionCountForCar(car.id),
          getLastUploadForCar(car.id),
        ]);
        return [car.id, { sessionCount, lastUpload }] as const;
      })
    );
    setCarMeta(Object.fromEntries(entries));
  };
  fetchMeta();
}, [cars]);
```

4. Fix the group bug: On the `<Card>` element (line ~176), add the `group` class to the existing className string. The card's className currently has `bg-card border-border cursor-pointer transition-all ...` — append `group` to it.

5. In the `<CardContent>` at the bottom of each card (currently only shows "Currently Selected" text), expand it to show meta info:
```tsx
<CardContent className="pt-0">
  <div className="flex items-center justify-between text-xs text-muted-foreground font-mono mt-1">
    <span>{carMeta[car.id]?.sessionCount ?? '…'} sessions</span>
    {carMeta[car.id]?.lastUpload ? (
      <span>Last: {carMeta[car.id]!.lastUpload!.toLocaleDateString()}</span>
    ) : (
      <span className="italic">No uploads yet</span>
    )}
  </div>
  {selectedCarId === car.id && (
    <div className="flex items-center gap-2 text-xs text-primary font-medium mt-2">
      <Check className="w-3.5 h-3.5" />
      Currently Selected
    </div>
  )}
</CardContent>
```

Do NOT change any other logic — handlers, dialogs, and add/edit/delete flows remain identical.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&amp;&amp; echo "TYPE CHECK PASSED"</automated>
  </verify>
  <done>
    - Card wrapper has `group` class — edit button is visible on hover
    - Each car card shows "N sessions" and "Last: MM/DD/YYYY" (or "No uploads yet")
    - "Currently Selected" still shows for selected car
    - No TypeScript errors
  </done>
</task>

<task type="auto">
  <name>Task 2: Create DashboardSkeleton and CarCardSkeleton, wire DashboardSkeleton into Index.tsx</name>
  <files>
    src/components/DashboardSkeleton.tsx
    src/components/CarCardSkeleton.tsx
    src/pages/Index.tsx
  </files>
  <action>
**Step A — Create src/components/DashboardSkeleton.tsx:**

This component mirrors the layout of the populated dashboard (LatestTripCard + GeneralInfoCard grid, then a chart area below). Use `Skeleton` from `@/components/ui/skeleton`.

```tsx
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      {/* KPI cards row — matches the 2-col grid of LatestTripCard + GeneralInfoCard */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[0, 1].map((i) => (
          <Card key={i} className="bg-card border-border">
            <CardHeader className="pb-2">
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-24 w-full rounded-md" />
              <div className="grid grid-cols-2 gap-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Chart area */}
      <div className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    </div>
  );
}
```

**Step B — Create src/components/CarCardSkeleton.tsx:**

```tsx
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export function CarCardSkeleton() {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <Skeleton className="w-10 h-10 rounded-full" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step C — Wire DashboardSkeleton into src/pages/Index.tsx:**

Find the loading guard (currently lines 378-384 in Index.tsx):
```tsx
if (loading || statsLoading) {
  return (
    <AppLayout>
      <PageLoader fullScreen={false} />
    </AppLayout>
  );
}
```

Replace `<PageLoader fullScreen={false} />` with `<DashboardSkeleton />`.

Add the import at the top of Index.tsx:
```typescript
import { DashboardSkeleton } from '@/components/DashboardSkeleton';
```

The `PageLoader` import can remain (it may be used elsewhere or for the no-car-selected case — do NOT remove it from this file).
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&amp;&amp; echo "TYPE CHECK PASSED"</automated>
  </verify>
  <done>
    - DashboardSkeleton.tsx exists and exports `DashboardSkeleton`
    - CarCardSkeleton.tsx exists and exports `CarCardSkeleton`
    - Dashboard shows pulsing skeleton cards instead of spinner during data load
    - No TypeScript errors
  </done>
</task>

<task type="auto">
  <name>Task 3: Improve empty states (Dashboard + HistoryPage) and enhance FlagsPanel with severity grouping + Resolve All</name>
  <files>
    src/pages/Index.tsx
    src/pages/HistoryPage.tsx
    src/components/FlagsPanel.tsx
  </files>
  <action>
**Step A — Dashboard empty state (src/pages/Index.tsx):**

The current empty state (triggered when `stats.totalSessions === 0`) is a 2-col grid with `UploadCard` + a minimal Quick Start card. The Quick Start card already has a 3-step `ol` list — upgrade it visually:

Replace the Quick Start `<Card>` inside the empty state grid with:
```tsx
<Card className="bg-card border-border h-full flex flex-col">
  <CardContent className="p-5 flex flex-col justify-between h-full gap-4">
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-mono font-semibold text-foreground">Get Started in 3 Steps</h3>
      </div>
      <ol className="space-y-3">
        {[
          { step: '1', label: 'Connect OBD2 reader', detail: 'Use any ELM327 Bluetooth or WiFi adapter' },
          { step: '2', label: 'Export CSV from Car Scanner', detail: 'File → Export → CSV in the Car Scanner app' },
          { step: '3', label: 'Drop the file above', detail: 'Instant health analysis, no account needed' },
        ].map(({ step, label, detail }) => (
          <li key={step} className="flex gap-3">
            <span className="w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
              {step}
            </span>
            <div>
              <p className="text-xs font-medium text-foreground">{label}</p>
              <p className="text-[11px] text-muted-foreground">{detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
    <Button
      size="sm"
      variant="outline"
      className="w-full text-xs font-mono"
      onClick={() => navigate('/cars')}
    >
      <Car className="w-3.5 h-3.5 mr-2" />
      Manage Vehicles
    </Button>
  </CardContent>
</Card>
```

**Step B — HistoryPage empty state (src/pages/HistoryPage.tsx):**

Find the empty-sessions card (currently lines 330-336):
```tsx
{selectedCarId && !loading && sessions.length === 0 && (
  <Card className="bg-card border-border">
    <CardContent className="py-12 text-center">
      <p className="text-muted-foreground text-sm">No sessions for {selectedCar?.name} yet.</p>
    </CardContent>
  </Card>
)}
```

Replace with:
```tsx
{selectedCarId && !loading && sessions.length === 0 && (
  <Card className="bg-card border-border">
    <CardContent className="py-10 flex flex-col items-center text-center gap-4">
      <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
        <HistoryIcon className="w-6 h-6 text-primary/50" />
      </div>
      <div>
        <h3 className="text-sm font-mono font-semibold text-foreground mb-1">
          No sessions for {selectedCar?.name} yet
        </h3>
        <p className="text-xs text-muted-foreground max-w-xs">
          Upload your first OBD2 CSV file to start tracking vehicle health and fuel efficiency.
        </p>
      </div>
      <Button size="sm" onClick={() => navigate('/')} className="font-mono text-xs">
        <ArrowRight className="w-3.5 h-3.5 mr-2" />
        Go to Dashboard to Upload
      </Button>
    </CardContent>
  </Card>
)}
```

Make sure `ArrowRight` is in the existing import at the top of HistoryPage — it already is per the current source.

**Step C — FlagsPanel severity grouping + Resolve All (src/components/FlagsPanel.tsx):**

The FlagsPanel is used in two contexts:
1. HistoryPage / SessionDetail — flags come in without `resolved` — display-only, no resolve action needed
2. Index.tsx problems dialog — flags have `resolved`, needs Resolve All

Add an optional `onResolveAll` prop and group rendering by severity. Replace the entire component:

```tsx
import { AlertTriangle, AlertCircle, CheckCircle, CheckSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Flag {
  id?: string;
  severity: string;
  canonical_key: string;
  parameter_key: string;
  message: string;
  evidence?: Record<string, unknown> | null;
  resolved?: boolean;
}

interface FlagsPanelProps {
  flags: Flag[];
  limit?: number;
  onResolveAll?: () => void;
}

export default function FlagsPanel({ flags, limit, onResolveAll }: FlagsPanelProps) {
  const criticals = flags.filter(f => f.severity === 'critical' && !f.resolved);
  const attentions = flags.filter(f => f.severity === 'attention' && !f.resolved);
  const resolved = flags.filter(f => f.resolved);
  const activeCount = criticals.length + attentions.length;

  if (flags.length === 0) {
    return (
      <Card className="bg-card border-success/30">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-success" />
          <div>
            <p className="text-sm font-medium text-foreground">All parameters look normal</p>
            <p className="text-xs text-muted-foreground">No attention or critical flags detected.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const renderFlag = (flag: Flag, i: number) => {
    const isCritical = flag.severity === 'critical';
    const Icon = isCritical ? AlertCircle : AlertTriangle;
    const evidence = flag.evidence as Record<string, number> | null;

    return (
      <Card key={flag.id || i} className={isCritical ? 'severity-critical border' : 'severity-attention border'}>
        <CardContent className="p-3 flex gap-3">
          <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isCritical ? 'text-destructive' : 'text-warn'}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] uppercase font-mono font-bold tracking-wider ${isCritical ? 'text-destructive' : 'text-warn'}`}>
                {flag.severity}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">{flag.canonical_key}</span>
            </div>
            <p className="text-xs text-foreground leading-relaxed">{flag.message}</p>
            {evidence && (
              <div className="flex gap-3 mt-2 text-[10px] font-mono text-muted-foreground">
                {evidence.max !== undefined && <span>max: {Number(evidence.max).toFixed(1)}</span>}
                {evidence.avg !== undefined && <span>avg: {Number(evidence.avg).toFixed(1)}</span>}
                {evidence.pct_out_of_range !== undefined && <span>{Number(evidence.pct_out_of_range).toFixed(1)}% out</span>}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  // Apply limit after grouping (limit affects total displayed, not per group)
  const allActive = [...criticals, ...attentions];
  const displayed = limit ? allActive.slice(0, limit) : allActive;
  const displayedCriticals = displayed.filter(f => f.severity === 'critical');
  const displayedAttentions = displayed.filter(f => f.severity === 'attention');

  return (
    <div className="space-y-3">
      {/* Header with counts + Resolve All */}
      {(activeCount > 0 || onResolveAll) && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {criticals.length > 0 && (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                {criticals.length} Critical
              </Badge>
            )}
            {attentions.length > 0 && (
              <Badge className="text-[10px] px-1.5 py-0 bg-yellow-500/15 text-yellow-600 border-yellow-500/30 hover:bg-yellow-500/25">
                {attentions.length} Attention
              </Badge>
            )}
          </div>
          {onResolveAll && activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
              onClick={onResolveAll}
            >
              <CheckSquare className="w-3 h-3 mr-1" />
              Resolve All
            </Button>
          )}
        </div>
      )}

      {/* Critical group */}
      {displayedCriticals.length > 0 && (
        <div className="space-y-2">
          {displayedCriticals.map((f, i) => renderFlag(f, i))}
        </div>
      )}

      {/* Attention group */}
      {displayedAttentions.length > 0 && (
        <div className="space-y-2">
          {displayedAttentions.map((f, i) => renderFlag(f, i + displayedCriticals.length))}
        </div>
      )}

      {limit && allActive.length > limit && (
        <p className="text-xs text-muted-foreground text-center">+{allActive.length - limit} more flags</p>
      )}
    </div>
  );
}
```

**Step D — Wire Resolve All in Index.tsx:**

In the Problems Dialog in Index.tsx, the `<FlagsPanel>` is NOT directly used — the dialog renders its own flag list. However, the `FlagsPanel` IS used in HistoryPage (line 298: `<FlagsPanel flags={flags} limit={5} />`).

For the Problems dialog in Index.tsx, add the `onResolveAll` handler. Find inside the problems `<Dialog>` the section that currently renders `visibleProblems.map(...)`. Before that map, in the dialog header area, wire a "Resolve All" button using the same pattern as `handleToggleResolved`:

Add this handler to Index.tsx (after `handleToggleResolved`):
```typescript
const handleResolveAll = useCallback(async () => {
  const activeFlags = generalStats.problems.filter(p => !p.resolved);
  try {
    await Promise.all(activeFlags.map(f => toggleFlagResolved(f.id, true)));
    setGeneralStats(prev => ({
      ...prev,
      problems: prev.problems.map(p => ({ ...p, resolved: true })),
      problemCount: 0,
      healthScore: 100,
    }));
    toast.success(`${activeFlags.length} issues marked as resolved`);
  } catch {
    toast.error('Failed to resolve all issues');
  }
}, [generalStats.problems]);
```

Then in the Problems dialog header (inside `<DialogHeader className="flex flex-row ...">`, after the existing eye toggle button), add:
```tsx
{visibleProblems.some(p => !p.resolved) && (
  <Button
    variant="ghost"
    size="sm"
    className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
    onClick={handleResolveAll}
  >
    <CheckSquare className="w-3 h-3 mr-1" />
    Resolve All
  </Button>
)}
```

Add `CheckSquare` to the existing Lucide import in Index.tsx if not already present (it already is per the current source).

Import `useCallback` is already imported in Index.tsx.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&amp;&amp; echo "TYPE CHECK PASSED"</automated>
  </verify>
  <done>
    - Dashboard empty state shows numbered step cards with detail text + Manage Vehicles button
    - History empty state shows icon + descriptive text + "Go to Dashboard to Upload" button
    - FlagsPanel renders Critical flags before Attention flags with severity Badge counts
    - "Resolve All" button appears in Problems dialog when active flags exist
    - FlagsPanel `onResolveAll` prop is optional — existing usages in HistoryPage compile without changes
    - No TypeScript errors
  </done>
</task>

</tasks>

<verification>
After all three tasks complete, verify the full change set:

1. **CarsPage group bug**: Open /cars, hover a car card — Edit (pencil) icon must appear.
2. **Car card metadata**: Each card shows "N sessions" and a last upload date (or "No uploads yet").
3. **Dashboard skeleton**: Temporarily add `await new Promise(r => setTimeout(r, 2000))` inside `loadDashboard` to simulate slow load — pulsing skeleton cards should appear instead of spinner. Remove after testing.
4. **Dashboard empty state** (with no sessions): The step-by-step guide must show 3 numbered steps with detail text.
5. **HistoryPage empty state**: Switch to a car with no sessions — descriptive text + CTA button appears.
6. **FlagsPanel grouping**: On a session with both critical and attention flags, Critical section appears first.
7. **Resolve All button**: In the Problems dialog on Index, "Resolve All" button appears when active flags exist; clicking it resolves all and shows toast.

TypeScript gate (must pass before any manual check):
```
npx tsc --noEmit
```
</verification>

<success_criteria>
- `npx tsc --noEmit` exits 0 — no new type errors introduced
- CarsPage `<Card>` elements have `group` class — confirmed via code inspection
- `getSessionCountForCar` and `getLastUploadForCar` exported from src/lib/db.ts
- DashboardSkeleton.tsx and CarCardSkeleton.tsx both exist with named exports
- Index.tsx loading path renders `<DashboardSkeleton />` not `<PageLoader />`
- FlagsPanel renders severity badge counts and optional Resolve All — all usages remain compilable
- Empty states on Dashboard and History have actionable CTAs, not bare "no data" text
</success_criteria>

<output>
After completion, create `.planning/phases/05-ux-dashboard-enhancement/05-01-SUMMARY.md` with:
- What was changed (file-by-file)
- Any deviations from the plan
- Outstanding issues or follow-up items
</output>

---

## Goal

Transform the dashboard and key pages from functional-but-basic into a polished, delightful product that users would screenshot and share — targeting >= 85/100 on a visual audit.

This plan addresses the **highest-impact, lowest-risk improvements** that can be shipped in a single focused execution: a critical bug fix (invisible edit buttons), content-aware loading states, actionable empty states, and a flags panel that communicates severity at a glance.

## Tasks

### Task 1: Fix CarsPage Group Bug + Car Card Metadata
**Files:** `src/pages/CarsPage.tsx`, `src/lib/db.ts`

**What:** The `<Card>` wrapper in CarsPage is missing the `group` Tailwind class. The edit button uses `opacity-0 group-hover:opacity-100` but without `group` on the parent, it is permanently invisible. Fix this with a single class addition. Also surface per-card metadata (session count, last upload date) by adding two lightweight Supabase queries to db.ts.

**Exact change in CarsPage.tsx:** On line ~178 the `<Card className=...>` element — append `group` to the className string.

**New helpers in db.ts:**
- `getSessionCountForCar(carProfileId: string): Promise<number>` — uses `select('id', { count: 'exact', head: true })`
- `getLastUploadForCar(carProfileId: string): Promise<Date | null>` — selects `uploaded_at`, orders desc, limit 1

**New UI in CardContent:** Shows `N sessions` on the left and `Last: MM/DD/YYYY` on the right, below the existing "Currently Selected" indicator.

### Task 2: Dashboard Skeleton + Wire into Index.tsx
**Files:** `src/components/DashboardSkeleton.tsx` (new), `src/components/CarCardSkeleton.tsx` (new), `src/pages/Index.tsx`

**What:** Create two skeleton components using the existing `src/components/ui/skeleton.tsx`. Replace the `<PageLoader fullScreen={false} />` in Index.tsx's loading guard with `<DashboardSkeleton />`. The skeleton mirrors the populated dashboard layout: header row, 2-col KPI card grid, chart area.

**CarCardSkeleton** is created for future use in CarsPage (not wired in this plan — just created so it exists).

### Task 3: Empty States + FlagsPanel Severity Grouping + Resolve All
**Files:** `src/pages/Index.tsx`, `src/pages/HistoryPage.tsx`, `src/components/FlagsPanel.tsx`

**Dashboard empty state:** Replace the minimal Quick Start `<ol>` card with a richer 3-step numbered guide using icon badges, a label, and a detail line per step. Add a "Manage Vehicles" CTA button at the bottom.

**HistoryPage empty state:** Replace the single-line `"No sessions for X yet."` with an icon, a heading, a descriptive sentence, and a "Go to Dashboard to Upload" `<Button>`.

**FlagsPanel:** Rewrite to:
1. Separate `critical` and `attention` flags into visual groups (critical rendered first)
2. Show `Badge` counts in the header (`N Critical`, `N Attention`)
3. Accept optional `onResolveAll?: () => void` prop — renders a "Resolve All" ghost button in the header when active flags exist
4. Preserve all existing behavior for callers that don't pass `onResolveAll` (HistoryPage, SessionDetail)

**Index.tsx Problems Dialog:** Add `handleResolveAll` async callback that calls `toggleFlagResolved` for each active flag in parallel. Wire a "Resolve All" button into the dialog header.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|-----------|
| Supabase count query returns `null` instead of `0` | Low | Guard with `count || 0` in the helper |
| FlagsPanel callers pass `id`-less flags (evidence from code: `key={flag.id \|\| i}`) | Exists | Keep `flag.id || i` fallback key in the rewrite |
| `Promise.all` in `handleResolveAll` fails midway — partial resolve | Low | Wrap in try/catch, show error toast; state is re-derived from DB on next load anyway |
| `Badge` component variant — `bg-yellow-500/15` custom class may need CSS tweak | Low | Inline the className directly on the Badge element; shadcn Badge accepts className prop |
| Dashboard skeleton dimensions don't match real card sizes exactly | Expected | Skeleton is a loading hint, not a pixel-perfect replica; visual match within ~20px is acceptable |
| `npx tsc --noEmit` on Windows resolves paths differently | Rare | Run from project root; `tsconfig.app.json` is the relevant config but `tsc --noEmit` reads `tsconfig.json` which includes it |
