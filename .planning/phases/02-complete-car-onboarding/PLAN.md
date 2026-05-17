---
phase: 02-complete-car-onboarding
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supabase/migrations/20260517_car_profile_extended_fields.sql
  - src/lib/db.ts
  - src/contexts/CarsContext.tsx
  - src/hooks/use-cars.ts
autonomous: true
requirements:
  - ONBOARD-01
  - ONBOARD-02
  - ONBOARD-03
  - ONBOARD-04
  - ONBOARD-05

must_haves:
  truths:
    - "New users see an onboarding wizard immediately after signup (no empty dashboard confusion)"
    - "Users can register a car with year, make, model, trim, VIN, and notes — not just a free-text name"
    - "The car display name is auto-generated as 'YEAR MAKE MODEL' when not explicitly overridden"
    - "Existing car CRUD and sessions are unaffected by the schema migration"
    - "db.ts functions accept and persist all new car fields without TypeScript errors"
  artifacts:
    - path: "supabase/migrations/20260517_car_profile_extended_fields.sql"
      provides: "Schema migration adding make, model, year, trim, vin columns to car_profiles"
      contains: "ALTER TABLE car_profiles ADD COLUMN"
    - path: "src/lib/db.ts"
      provides: "Updated CarProfile type + createCarProfile/updateCarProfile signatures"
      exports: ["CarProfile", "createCarProfile", "updateCarProfile"]
  key_links:
    - from: "src/lib/db.ts CarProfile interface"
      to: "src/hooks/use-cars.ts createCar / updateCar"
      via: "Partial<CarProfile> type propagation"
      pattern: "createCar\\(name.*make.*model.*year"
    - from: "src/hooks/use-cars.ts"
      to: "src/contexts/CarsContext.tsx"
      via: "useCars() return type re-exported through CarsContextType"
      pattern: "createCar.*CarExtendedFields"
---

<objective>
Extend the car_profiles database schema and all TypeScript data-access layers to support structured vehicle identity fields (year, make, model, trim, VIN), laying the foundation for the onboarding wizard and richer car cards in subsequent tasks.

Purpose: The wizard (Task 02-02) and updated CarsPage (Task 02-03) both depend on the new fields existing in the DB and being typesafe end-to-end before UI work begins. Doing data-layer first prevents interface drift.

Output:
- `supabase/migrations/20260517_car_profile_extended_fields.sql` — applied migration
- Updated `CarProfile` interface, `createCarProfile`, `updateCarProfile` in `src/lib/db.ts`
- Updated `CarsContextType`, `createCar`, `updateCar` signatures propagated through `src/contexts/CarsContext.tsx` and `src/hooks/use-cars.ts`
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/codebase/CONVENTIONS.md
@.planning/codebase/ARCHITECTURE.md
</context>

<interfaces>
<!-- Current CarProfile interface in src/lib/db.ts (lines 375-383) -->
```typescript
export interface CarProfile {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
  user_id?: string;
  is_admin?: boolean;
}
```

<!-- Current createCarProfile signature (line 398) -->
```typescript
export async function createCarProfile(name: string, notes?: string): Promise<CarProfile>
```

<!-- Current updateCarProfile signature (line 412) -->
```typescript
export async function updateCarProfile(
  id: string,
  updates: Partial<Pick<CarProfile, 'name' | 'notes'>>
): Promise<void>
```

<!-- Current CarsContextType in src/contexts/CarsContext.tsx -->
```typescript
interface CarsContextType {
  cars: CarProfile[];
  selectedCar: CarProfile | null;
  selectedCarId: string | null;
  loading: boolean;
  error: string | null;
  createCar: (name: string, notes?: string) => Promise<CarProfile>;
  updateCar: (id: string, updates: Partial<Pick<CarProfile, 'name' | 'notes'>>) => Promise<void>;
  deleteCar: (id: string) => Promise<void>;
  selectCar: (id: string | null) => void;
  refresh: () => Promise<void>;
}
```

<!-- use-cars.ts createCar (line 57) -->
```typescript
const createCar = useCallback(async (name: string, notes?: string) => {
  const newCar = await createCarProfile(name, notes);
  ...
}, []);

const updateCar = useCallback(async (id: string, updates: Partial<Pick<CarProfile, 'name' | 'notes'>>) => {
  await updateCarProfile(id, updates);
  ...
}, []);
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Write and apply DB migration for extended car fields</name>
  <files>supabase/migrations/20260517_car_profile_extended_fields.sql</files>
  <action>
Create the migration file with the following SQL. Do NOT use `IF NOT EXISTS` on the column adds — this migration is new; use plain `ADD COLUMN` to fail fast if something is wrong.

```sql
-- Migration: Extended car profile fields for structured vehicle identity
-- Phase 02 — Complete Car Onboarding Wizard
-- 2026-05-17

ALTER TABLE public.car_profiles
  ADD COLUMN make  TEXT,
  ADD COLUMN model TEXT,
  ADD COLUMN year  INTEGER CHECK (year >= 1900 AND year <= 2100),
  ADD COLUMN trim  TEXT,
  ADD COLUMN vin   TEXT CHECK (vin IS NULL OR length(vin) = 17);

-- Index to support filtering/searching by make+model
CREATE INDEX idx_car_profiles_make_model
  ON public.car_profiles (make, model)
  WHERE make IS NOT NULL;
```

After writing the file, apply it via the Supabase CLI:
```
npx supabase db push
```

If the CLI is not authenticated or the project is paused, note that in the SUMMARY and leave the migration file ready — the SQL itself is the artifact, application can be deferred.
  </action>
  <verify>
    <automated>npx supabase db diff --schema public 2>&1 | grep -E "make|model|year|trim|vin|No schema changes" || echo "Migration file exists at supabase/migrations/20260517_car_profile_extended_fields.sql"</automated>
  </verify>
  <done>
    - Migration SQL file exists at the correct path.
    - Columns make (TEXT), model (TEXT), year (INTEGER with range check), trim (TEXT), vin (TEXT with 17-char check) exist on car_profiles in the remote DB (or migration file is ready to apply).
    - Existing rows are unaffected (all new columns are nullable).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Extend CarProfile types and db.ts functions</name>
  <files>src/lib/db.ts, src/hooks/use-cars.ts, src/contexts/CarsContext.tsx</files>
  <behavior>
    - CarProfile interface includes: make?: string | null, model?: string | null, year?: number | null, trim?: string | null, vin?: string | null
    - createCarProfile(name, options?) accepts all new fields in an options object; name is auto-generated if make+model+year are provided and name is omitted/empty
    - updateCarProfile accepts Partial of all CarProfile fields (not just name/notes)
    - useCars.createCar and useCars.updateCar propagate the new signatures
    - CarsContextType reflects the new signatures — no TypeScript errors on build
    - Auto-name logic: if name is empty/undefined and year+make+model are all provided, set name = `${year} ${make} ${model}` (trimmed)
  </behavior>
  <action>
**src/lib/db.ts — changes:**

1. Extend `CarProfile` interface:
```typescript
export interface CarProfile {
  id: string;
  name: string;
  notes: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  trim: string | null;
  vin: string | null;
  created_at: string;
  user_id?: string;
  is_admin?: boolean;
}
```

2. Add a `CarProfileInput` type for create/update payloads (avoids exposing id/created_at):
```typescript
export interface CarProfileInput {
  name?: string;
  notes?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  trim?: string | null;
  vin?: string | null;
}
```

3. Replace `createCarProfile`:
```typescript
export async function createCarProfile(
  nameOrInput: string | CarProfileInput,
  notes?: string,
): Promise<CarProfile> {
  // Handle legacy positional call: createCarProfile('My Car', 'notes')
  let input: CarProfileInput;
  if (typeof nameOrInput === 'string') {
    input = { name: nameOrInput, notes };
  } else {
    input = nameOrInput;
  }

  // Auto-generate name from year+make+model if name is blank
  if (!input.name?.trim() && input.year && input.make && input.model) {
    input = { ...input, name: `${input.year} ${input.make} ${input.model}`.trim() };
  }

  if (!input.name?.trim()) {
    throw new Error('Vehicle name is required (or provide year + make + model)');
  }

  const { data, error } = await supabase
    .from('car_profiles')
    .insert({
      name: input.name,
      notes: input.notes ?? null,
      make: input.make ?? null,
      model: input.model ?? null,
      year: input.year ?? null,
      trim: input.trim ?? null,
      vin: input.vin ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create car profile: ${error.message}`);
  return data;
}
```

4. Replace `updateCarProfile`:
```typescript
export async function updateCarProfile(
  id: string,
  updates: Partial<CarProfileInput>,
): Promise<void> {
  const { error } = await supabase
    .from('car_profiles')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error(`Failed to update car profile: ${error.message}`);
}
```

**src/hooks/use-cars.ts — changes:**

Update `createCar` to accept `CarProfileInput | string` matching the new `createCarProfile` signature:
```typescript
const createCar = useCallback(async (
  nameOrInput: string | CarProfileInput,
  notes?: string,
) => {
  const newCar = await createCarProfile(nameOrInput, notes);
  setCars(prev => [newCar, ...prev]);
  setSelectedCarId(newCar.id);
  return newCar;
}, []);
```

Update `updateCar`:
```typescript
const updateCar = useCallback(async (
  id: string,
  updates: Partial<CarProfileInput>,
) => {
  await updateCarProfile(id, updates);
  setCars(prev => prev.map(car => car.id === id ? { ...car, ...updates } : car));
}, []);
```

Import `CarProfileInput` at the top: `import { getUserCars, createCarProfile, updateCarProfile, deleteCarProfile, type CarProfile, type CarProfileInput } from '@/lib/db';`

**src/contexts/CarsContext.tsx — changes:**

Update `CarsContextType`:
```typescript
import type { CarProfile, CarProfileInput } from '@/lib/db';

interface CarsContextType {
  cars: CarProfile[];
  selectedCar: CarProfile | null;
  selectedCarId: string | null;
  loading: boolean;
  error: string | null;
  createCar: (nameOrInput: string | CarProfileInput, notes?: string) => Promise<CarProfile>;
  updateCar: (id: string, updates: Partial<CarProfileInput>) => Promise<void>;
  deleteCar: (id: string) => Promise<void>;
  selectCar: (id: string | null) => void;
  refresh: () => Promise<void>;
}
```

The Provider body does not need changes — it delegates to `useCars()`.

Run `npm run build` (or `npx tsc --noEmit`) to confirm zero TypeScript errors before marking done.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | tail -20</automated>
  </verify>
  <done>
    - `npm run build` (or `npx tsc --noEmit`) exits with 0 errors.
    - `CarProfile` interface includes all 5 new nullable fields.
    - `CarProfileInput` is exported from db.ts.
    - `createCarProfile('My Car', 'notes')` legacy call still compiles (backward-compat overload).
    - `createCarProfile({ year: 2023, make: 'Toyota', model: 'Camry' })` compiles and auto-names the car.
    - CarsPage.tsx compiles without changes (existing `updateCar(id, { name, notes })` call is still valid via Partial<CarProfileInput>).
  </done>
</task>

</tasks>

<verification>
```
npx tsc --noEmit
npm run build
```
Both must exit 0. The migration file must exist at `supabase/migrations/20260517_car_profile_extended_fields.sql`.
</verification>

<success_criteria>
- [ ] Migration SQL file exists and is syntactically valid
- [ ] `car_profiles` table has columns: make, model, year, trim, vin (nullable)
- [ ] `CarProfile` TypeScript interface reflects all new fields
- [ ] `CarProfileInput` exported from db.ts
- [ ] `createCarProfile` auto-generates name when year+make+model provided and name omitted
- [ ] `updateCarProfile` accepts updates to any CarProfileInput field
- [ ] `use-cars.ts` and `CarsContext.tsx` updated signatures compile cleanly
- [ ] Existing CarsPage.tsx requires NO changes (backward compatibility maintained)
- [ ] `npm run build` exits 0
</success_criteria>

<output>
After completion, create `.planning/phases/02-complete-car-onboarding/02-01-SUMMARY.md` documenting:
- Migration filename and columns added
- CarProfileInput interface shape
- Any backward-compat decisions made
- Whether migration was applied to remote DB or left pending
</output>

---
phase: 02-complete-car-onboarding
plan: 02
type: execute
wave: 2
depends_on: ["02-01"]
files_modified:
  - src/components/OnboardingWizard.tsx
  - src/pages/OnboardingPage.tsx
  - src/App.tsx
autonomous: false
requirements:
  - ONBOARD-01
  - ONBOARD-02
  - ONBOARD-03

must_haves:
  truths:
    - "A user with 0 cars is automatically redirected to /onboarding on first login"
    - "The wizard has 4 steps with a visible progress indicator (Step N of 4)"
    - "Step 2 collects year, make, model (required) plus trim, VIN, notes (optional)"
    - "Step 3 offers CSV upload inline via UploadCard with a working Skip option"
    - "Completing or skipping the wizard sets an onboarding_completed flag and redirects to /"
    - "Returning users with cars are never shown the wizard"
  artifacts:
    - path: "src/components/OnboardingWizard.tsx"
      provides: "Multi-step wizard component"
      exports: ["OnboardingWizard"]
    - path: "src/pages/OnboardingPage.tsx"
      provides: "Route page wrapping the wizard"
      exports: ["default"]
    - path: "src/App.tsx"
      provides: "/onboarding route wired into AuthenticatedLayout"
      contains: "/onboarding"
  key_links:
    - from: "src/pages/Index.tsx"
      to: "/onboarding"
      via: "useEffect checks cars.length === 0 && !onboarding_completed → navigate('/onboarding')"
      pattern: "navigate.*onboarding"
    - from: "src/components/OnboardingWizard.tsx"
      to: "src/contexts/CarsContext.tsx createCar"
      via: "Step 2 form submit calls createCar({ year, make, model, trim, vin, notes })"
      pattern: "createCar.*CarProfileInput"
    - from: "src/components/OnboardingWizard.tsx Step 3"
      to: "src/components/UploadCard.tsx"
      via: "Renders <UploadCard carProfileId={newCarId} onComplete={handleUploadDone} />"
      pattern: "UploadCard.*carProfileId"
---

<objective>
Build the OnboardingWizard component and wire it into a protected /onboarding route. New users (0 cars) are redirected here from the dashboard; completing or skipping the wizard sets a localStorage flag and returns them to the dashboard.

Purpose: Eliminates the blank-dashboard first-run experience. Users arrive knowing exactly what to do.

Output:
- `src/components/OnboardingWizard.tsx` — 4-step wizard component
- `src/pages/OnboardingPage.tsx` — thin route wrapper
- `src/App.tsx` — /onboarding route added
- `src/pages/Index.tsx` — redirect logic added (cars.length === 0 check)
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/codebase/CONVENTIONS.md
@.planning/phases/02-complete-car-onboarding/02-01-SUMMARY.md
</context>

<interfaces>
<!-- From Plan 02-01: CarProfileInput (src/lib/db.ts) -->
```typescript
export interface CarProfileInput {
  name?: string;
  notes?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  trim?: string | null;
  vin?: string | null;
}
```

<!-- CarsContextType createCar (updated in Plan 02-01) -->
```typescript
createCar: (nameOrInput: string | CarProfileInput, notes?: string) => Promise<CarProfile>;
```

<!-- UploadCard props (src/components/UploadCard.tsx) -->
```typescript
interface UploadCardProps {
  onComplete: (sessionId: string) => void;
  carProfileId?: string;
  variant?: 'default' | 'compact';
}
```

<!-- App.tsx route pattern -->
```typescript
// AuthenticatedLayout wraps PrivateRoute + CarsProvider + Suspense
<Route path="/cars" element={<AuthenticatedLayout><CarsPage /></AuthenticatedLayout>} />
// Add /onboarding the same way
```

<!-- Index.tsx relevant hooks already available -->
```typescript
const { cars, loading: carsLoading } = useCarsContext();
const navigate = useNavigate();
```

<!-- localStorage onboarding flag -->
const ONBOARDING_KEY = 'onboarding_completed'; // store 'true' string
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Build OnboardingWizard component and OnboardingPage</name>
  <files>src/components/OnboardingWizard.tsx, src/pages/OnboardingPage.tsx</files>
  <action>
**src/components/OnboardingWizard.tsx**

Create a self-contained 4-step wizard. State: `currentStep` (1-4), `newCarId` (string | null set after Step 2 completes).

**Step layout:**
```
Step 1 — Welcome
  Heading: "Welcome to Car Insights"
  Body: "Let's get you set up. We'll register your first vehicle and optionally upload your first OBD2 session."
  CTA Button: "Get Started →"

Step 2 — Add Your Car  (the form)
  Fields:
    - Year* (number input, min=1900, max=2100, placeholder "2023")
    - Make* (text input, placeholder "Toyota")
    - Model* (text input, placeholder "Camry")
    - Trim (text input, optional, placeholder "LX")
    - VIN (text input, optional, placeholder "1HGBH41JXMN109186", maxLength=17)
    - Notes (text input, optional, placeholder "Purchased Aug 2023, 42k miles")
  Validation: year, make, model required — show inline error if empty on submit
  On submit: call createCar({ year, make, model, trim, vin, notes })
             → store returned car.id in `newCarId` state → advance to Step 3

Step 3 — Upload First Session
  Subheading: "Upload your first OBD2 CSV session"
  Body: "Drop your CSV export from Torque Pro, OBD Fusion, or similar."
  Render: <UploadCard carProfileId={newCarId!} onComplete={handleUploadDone} variant="default" />
  Skip link: "Skip for now — I'll upload later" → handleSkip()
  handleUploadDone(sessionId): advance to Step 4
  handleSkip(): advance to Step 4

Step 4 — Done!
  Heading: "You're all set!"
  Body: "Your vehicle is registered. Head to the dashboard to see your data."
  CTA Button: "Go to Dashboard" → calls onComplete()
```

**Progress indicator** (shown on all steps):
```tsx
<div className="text-xs text-muted-foreground font-mono text-center mb-6">
  Step {currentStep} of 4
</div>
```

Use a simple `<div className="space-y-1 flex gap-1 justify-center mb-6">` with 4 dots, the current step dot highlighted with `bg-primary` and others `bg-primary/20`, sized `w-2 h-2 rounded-full`.

**Animated transitions:** Use Tailwind `transition-opacity duration-300` on a wrapper `<div key={currentStep}>` — when step changes, React remounts by key triggering a CSS opacity animation. No external animation library needed.

**Props:**
```typescript
interface OnboardingWizardProps {
  onComplete: () => void; // called when wizard finishes (Done! button)
}
```

**Imports to use:**
- `useCarsContext` from `@/contexts/CarsContext`
- `UploadCard` from `@/components/UploadCard`
- `Button` from `@/components/ui/button`
- `Input` from `@/components/ui/input`
- `Label` from `@/components/ui/label`
- `Card, CardContent` from `@/components/ui/card`
- Lucide icons: `Car, Upload, CheckCircle, ArrowRight`

**Outer layout:** Centered full-screen div:
```tsx
<div className="min-h-screen bg-background flex items-center justify-center p-4">
  <Card className="w-full max-w-lg">
    <CardContent className="pt-8 pb-8 px-8">
      {/* progress dots */}
      {/* step content */}
    </CardContent>
  </Card>
</div>
```

---

**src/pages/OnboardingPage.tsx**

Thin wrapper that uses `useNavigate` to handle `onComplete`:

```typescript
import { useNavigate } from 'react-router-dom';
import OnboardingWizard from '@/components/OnboardingWizard';

const ONBOARDING_KEY = 'onboarding_completed';

export default function OnboardingPage() {
  const navigate = useNavigate();

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
    navigate('/', { replace: true });
  };

  return <OnboardingWizard onComplete={handleComplete} />;
}
```
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | tail -10</automated>
  </verify>
  <done>
    - Both files exist and compile cleanly.
    - OnboardingWizard exports a default component accepting `onComplete: () => void`.
    - All 4 steps are implemented with the specified content.
    - Step 2 form validates year/make/model before calling createCar.
    - Step 3 renders UploadCard with the car id from Step 2.
    - Skip link bypasses upload and goes to Step 4.
    - Step 4 has a "Go to Dashboard" button that calls onComplete().
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire /onboarding route and add redirect from dashboard</name>
  <files>src/App.tsx, src/pages/Index.tsx</files>
  <action>
**src/App.tsx:**

1. Add lazy import:
```typescript
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));
```

2. Add route inside `<Routes>` after the `/cars` route:
```tsx
<Route path="/onboarding" element={<AuthenticatedLayout><OnboardingPage /></AuthenticatedLayout>} />
```

---

**src/pages/Index.tsx:**

Add redirect logic. The onboarding check must run AFTER cars have loaded (not while `carsLoading` is true) to avoid a race condition.

Add this constant near the top of the file (outside the component):
```typescript
const ONBOARDING_KEY = 'onboarding_completed';
```

Inside the `Index` component, after the existing `useCarsContext` and `useNavigate` destructuring, add:

```typescript
// Redirect new users (no cars, onboarding not completed) to wizard
useEffect(() => {
  if (carsLoading) return;
  const alreadyOnboarded = localStorage.getItem(ONBOARDING_KEY) === 'true';
  if (!alreadyOnboarded && cars.length === 0) {
    navigate('/onboarding', { replace: true });
  }
}, [carsLoading, cars.length, navigate]);
```

Place this `useEffect` AFTER the existing state declarations but BEFORE the data-fetching effects that depend on `selectedCarId`. This ensures the redirect fires early without waiting for session queries.

Do NOT remove the existing empty-state JSX in Index.tsx — it still handles the case where a user has completed onboarding but later deletes all their cars.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | tail -10</automated>
  </verify>
  <done>
    - `src/App.tsx` has `/onboarding` route using `AuthenticatedLayout`.
    - `src/pages/Index.tsx` has a `useEffect` that redirects to `/onboarding` when `carsLoading === false && cars.length === 0 && !localStorage.getItem('onboarding_completed')`.
    - `npm run build` exits 0.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
    Complete onboarding wizard wired into the app:
    - /onboarding route serving the 4-step wizard
    - Dashboard auto-redirects new users (0 cars) to the wizard
    - Step 2 creates a car via structured fields
    - Step 3 offers CSV upload or skip
    - Step 4 redirects to dashboard and sets localStorage flag
  </what-built>
  <how-to-verify>
    1. Run `npm run dev` and open the app in a browser.
    2. Open DevTools → Application → Local Storage → delete `onboarding_completed` and `selected_car_id` keys if present.
    3. If you have cars in your account, temporarily test with a fresh account or use DevTools to check the redirect logic.
    4. Navigate to `/` — confirm redirect to `/onboarding`.
    5. On Step 1, click "Get Started" — confirm Step 2 appears with year/make/model/trim/VIN/notes fields and a "Step 2 of 4" indicator.
    6. Submit Step 2 with year=2023, make=Toyota, model=Camry — confirm car is created and Step 3 appears.
    7. On Step 3, click "Skip for now" — confirm Step 4 appears.
    8. On Step 4, click "Go to Dashboard" — confirm redirect to `/` with the dashboard loaded.
    9. Navigate to `/onboarding` again — confirm you are NOT redirected back (onboarding_completed is set).
    10. Go to /cars — confirm the new "2023 Toyota Camry" car appears in the list.
  </how-to-verify>
  <resume-signal>Type "approved" if the full wizard flow works end-to-end, or describe any issues found.</resume-signal>
</task>

</tasks>

<verification>
```
npm run build
```
Must exit 0. All TypeScript errors resolved. /onboarding route accessible when authenticated.
</verification>

<success_criteria>
- [ ] `npm run build` exits 0
- [ ] /onboarding route is accessible when authenticated
- [ ] New user (0 cars) is redirected from / to /onboarding
- [ ] Step 2 form validates year, make, model as required
- [ ] Step 2 creates car with structured fields via createCar(CarProfileInput)
- [ ] Step 3 renders UploadCard with the new car's ID
- [ ] Skip link bypasses upload and reaches Step 4
- [ ] Done button sets localStorage('onboarding_completed', 'true') and navigates to /
- [ ] Returning user with cars is never redirected to /onboarding
- [ ] Wizard checkpoint approved by user
</success_criteria>

<output>
After completion, create `.planning/phases/02-complete-car-onboarding/02-02-SUMMARY.md` documenting:
- OnboardingWizard component structure and props
- Step 2 → createCar(CarProfileInput) call pattern
- Step 3 UploadCard integration
- localStorage flag name: 'onboarding_completed'
- Redirect logic location in Index.tsx
</output>

---
phase: 02-complete-car-onboarding
plan: 03
type: execute
wave: 2
depends_on: ["02-01"]
files_modified:
  - src/pages/CarsPage.tsx
autonomous: true
requirements:
  - ONBOARD-04
  - ONBOARD-05

must_haves:
  truths:
    - "Car cards on /cars display year, make, model (e.g. '2023 Toyota Camry') as the primary identity"
    - "Trim is shown as a subtitle when present (e.g. 'LX Trim')"
    - "VIN is shown in a muted line when present"
    - "The Add Vehicle dialog has structured fields (year, make, model, trim, VIN, notes)"
    - "The Edit form also exposes all structured fields"
    - "Existing cars with only name/notes (no make/model/year) still render gracefully, showing name as-is"
  artifacts:
    - path: "src/pages/CarsPage.tsx"
      provides: "Updated car cards and Add/Edit forms with structured fields"
      contains: "make, model, year, trim, vin"
  key_links:
    - from: "CarsPage Add Vehicle dialog form"
      to: "useCarsContext createCar"
      via: "handleCreateCar calls createCar({ year, make, model, trim, vin, notes })"
      pattern: "createCar.*year.*make.*model"
    - from: "CarsPage Edit inline form"
      to: "useCarsContext updateCar"
      via: "handleUpdateCar calls updateCar(id, { year, make, model, trim, vin, notes })"
      pattern: "updateCar.*year.*make.*model"
---

<objective>
Update CarsPage.tsx to display and edit the new structured car identity fields. Car cards now show "YEAR MAKE MODEL" as the headline identity. Add and Edit forms collect all structured fields.

Purpose: Richer car cards give users confidence that their vehicle is properly identified, and the edit form allows correcting data after onboarding.

Output: Updated `src/pages/CarsPage.tsx` — no new files needed.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/codebase/CONVENTIONS.md
@.planning/phases/02-complete-car-onboarding/02-01-SUMMARY.md
</context>

<interfaces>
<!-- Updated CarProfile from Plan 02-01 -->
```typescript
export interface CarProfile {
  id: string;
  name: string;           // auto-generated or user-provided
  notes: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  trim: string | null;
  vin: string | null;
  created_at: string;
  user_id?: string;
  is_admin?: boolean;
}

export interface CarProfileInput {
  name?: string;
  notes?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  trim?: string | null;
  vin?: string | null;
}
```

<!-- Updated CarsContextType from Plan 02-01 -->
```typescript
createCar: (nameOrInput: string | CarProfileInput, notes?: string) => Promise<CarProfile>;
updateCar: (id: string, updates: Partial<CarProfileInput>) => Promise<void>;
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Update CarsPage with structured add/edit forms and rich car cards</name>
  <files>src/pages/CarsPage.tsx</files>
  <action>
Rewrite the relevant sections of `src/pages/CarsPage.tsx`. Preserve all existing logic for selection, delete, toast notifications, and loading states. Only change: state variables, form fields, card display, and the handleCreateCar / handleUpdateCar / startEditing functions.

**New state variables** (replace `newCarName`, `newCarNotes`, `editName`, `editNotes`):
```typescript
// Add form state
const [newYear, setNewYear] = useState('');
const [newMake, setNewMake] = useState('');
const [newModel, setNewModel] = useState('');
const [newTrim, setNewTrim] = useState('');
const [newVin, setNewVin] = useState('');
const [newNotes, setNewNotes] = useState('');

// Edit form state
const [editYear, setEditYear] = useState('');
const [editMake, setEditMake] = useState('');
const [editModel, setEditModel] = useState('');
const [editTrim, setEditTrim] = useState('');
const [editVin, setEditVin] = useState('');
const [editNotes, setEditNotes] = useState('');
```

**handleCreateCar** — validate year/make/model, pass CarProfileInput:
```typescript
const handleCreateCar = async () => {
  if (!newMake.trim() || !newModel.trim()) {
    toast({ title: 'Error', description: 'Make and model are required', variant: 'destructive' });
    return;
  }
  const yearNum = newYear ? parseInt(newYear, 10) : undefined;
  if (newYear && (isNaN(yearNum!) || yearNum! < 1900 || yearNum! > 2100)) {
    toast({ title: 'Error', description: 'Enter a valid year (1900–2100)', variant: 'destructive' });
    return;
  }
  setIsCreating(true);
  try {
    await createCar({
      year: yearNum ?? null,
      make: newMake.trim(),
      model: newModel.trim(),
      trim: newTrim.trim() || null,
      vin: newVin.trim() || null,
      notes: newNotes.trim() || null,
    });
    toast({ title: 'Success', description: 'Vehicle added successfully' });
    setNewYear(''); setNewMake(''); setNewModel(''); setNewTrim(''); setNewVin(''); setNewNotes('');
    setIsAddDialogOpen(false);
  } catch (error) {
    toast({ title: 'Error', description: String(error), variant: 'destructive' });
  } finally {
    setIsCreating(false);
  }
};
```

**handleUpdateCar**:
```typescript
const handleUpdateCar = async (id: string) => {
  if (!editMake.trim() || !editModel.trim()) {
    toast({ title: 'Error', description: 'Make and model are required', variant: 'destructive' });
    return;
  }
  const yearNum = editYear ? parseInt(editYear, 10) : undefined;
  setIsUpdating(true);
  try {
    // Regenerate display name
    const name = yearNum && editMake && editModel
      ? `${yearNum} ${editMake.trim()} ${editModel.trim()}`
      : `${editMake.trim()} ${editModel.trim()}`;
    await updateCar(id, {
      name,
      year: yearNum ?? null,
      make: editMake.trim(),
      model: editModel.trim(),
      trim: editTrim.trim() || null,
      vin: editVin.trim() || null,
      notes: editNotes.trim() || null,
    });
    toast({ title: 'Success', description: 'Vehicle updated successfully' });
    setEditingCar(null);
  } catch (error) {
    toast({ title: 'Error', description: String(error), variant: 'destructive' });
  } finally {
    setIsUpdating(false);
  }
};
```

**startEditing** — populate all edit state from car:
```typescript
const startEditing = (car: CarProfile) => {
  setEditingCar(car.id);
  setEditYear(car.year?.toString() ?? '');
  setEditMake(car.make ?? '');
  setEditModel(car.model ?? '');
  setEditTrim(car.trim ?? '');
  setEditVin(car.vin ?? '');
  setEditNotes(car.notes ?? '');
};
```

**Add Vehicle Dialog form fields** (replace the existing two inputs):
```tsx
<div className="grid grid-cols-2 gap-3">
  <div className="space-y-1.5">
    <Label htmlFor="new-year">Year</Label>
    <Input id="new-year" placeholder="2023" maxLength={4}
      value={newYear} onChange={e => setNewYear(e.target.value)} />
  </div>
  <div className="space-y-1.5">
    <Label htmlFor="new-make">Make *</Label>
    <Input id="new-make" placeholder="Toyota"
      value={newMake} onChange={e => setNewMake(e.target.value)} />
  </div>
  <div className="space-y-1.5">
    <Label htmlFor="new-model">Model *</Label>
    <Input id="new-model" placeholder="Camry"
      value={newModel} onChange={e => setNewModel(e.target.value)} />
  </div>
  <div className="space-y-1.5">
    <Label htmlFor="new-trim">Trim</Label>
    <Input id="new-trim" placeholder="LX (optional)"
      value={newTrim} onChange={e => setNewTrim(e.target.value)} />
  </div>
</div>
<div className="space-y-1.5">
  <Label htmlFor="new-vin">VIN</Label>
  <Input id="new-vin" placeholder="17-character VIN (optional)" maxLength={17}
    value={newVin} onChange={e => setNewVin(e.target.value)} />
</div>
<div className="space-y-1.5">
  <Label htmlFor="new-notes">Notes</Label>
  <Input id="new-notes" placeholder="e.g. 42k miles, purchased Aug 2023"
    value={newNotes} onChange={e => setNewNotes(e.target.value)} />
</div>
```

**Car card display** — replace the CardTitle / notes paragraph section in the non-editing branch:
```tsx
<>
  {/* Primary identity line */}
  <CardTitle className="text-sm font-mono leading-tight">
    {car.year && car.make && car.model
      ? `${car.year} ${car.make} ${car.model}`
      : car.name}
  </CardTitle>
  {/* Trim subtitle */}
  {car.trim && (
    <p className="text-xs text-muted-foreground">{car.trim} Trim</p>
  )}
  {/* VIN */}
  {car.vin && (
    <p className="text-xs text-muted-foreground font-mono tracking-wide">
      VIN: {car.vin}
    </p>
  )}
  {/* Notes — show if no structured fields AND notes exist (legacy support) */}
  {!car.make && car.notes && (
    <p className="text-xs text-muted-foreground line-clamp-1">{car.notes}</p>
  )}
</>
```

**Inline edit form** in the editing branch (inside the card, replace the two Input fields):
```tsx
<div className="space-y-1.5">
  <div className="flex gap-2">
    <Input value={editYear} onChange={e => setEditYear(e.target.value)}
      className="h-7 text-xs w-20" placeholder="Year" maxLength={4}
      onClick={e => e.stopPropagation()} />
    <Input value={editMake} onChange={e => setEditMake(e.target.value)}
      className="h-7 text-xs flex-1" placeholder="Make *"
      onClick={e => e.stopPropagation()} />
    <Input value={editModel} onChange={e => setEditModel(e.target.value)}
      className="h-7 text-xs flex-1" placeholder="Model *"
      onClick={e => e.stopPropagation()} />
  </div>
  <div className="flex gap-2">
    <Input value={editTrim} onChange={e => setEditTrim(e.target.value)}
      className="h-6 text-xs flex-1" placeholder="Trim"
      onClick={e => e.stopPropagation()} />
    <Input value={editVin} onChange={e => setEditVin(e.target.value)}
      className="h-6 text-xs flex-1" placeholder="VIN" maxLength={17}
      onClick={e => e.stopPropagation()} />
  </div>
  <Input value={editNotes} onChange={e => setEditNotes(e.target.value)}
    className="h-6 text-xs" placeholder="Notes"
    onClick={e => e.stopPropagation()} />
</div>
```

Import `CarProfile` as a type in CarsPage (it's already imported via `useCarsContext` — if not directly, add: `import type { CarProfile } from '@/lib/db';`).
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | tail -10</automated>
  </verify>
  <done>
    - CarsPage.tsx compiles with 0 TypeScript errors.
    - Add Vehicle dialog has year, make, model, trim, VIN, notes fields.
    - Make and model are validated as required before submit.
    - Car cards display "YEAR MAKE MODEL" when structured fields exist.
    - Trim and VIN appear as subtitle lines when present.
    - Cars with only legacy `name` field (no make/model) still render their name without crashing.
    - Inline edit form exposes all structured fields.
    - `npm run build` exits 0.
  </done>
</task>

</tasks>

<verification>
```
npm run build
```
Must exit 0. CarsPage renders correct card layout for structured and legacy cars.
</verification>

<success_criteria>
- [ ] `npm run build` exits 0
- [ ] Add Vehicle dialog has year/make/model (required), trim/VIN/notes (optional)
- [ ] Card headline shows "2023 Toyota Camry" format when fields are populated
- [ ] Trim shown as "LX Trim" subtitle when present
- [ ] VIN shown in muted monospace line when present
- [ ] Legacy cars (name only, no make/model) render their name without errors
- [ ] Edit form pre-populates all fields from existing car data
- [ ] Update saves all structured fields including regenerated name
</success_criteria>

<output>
After completion, create `.planning/phases/02-complete-car-onboarding/02-03-SUMMARY.md` documenting:
- Card display logic (structured vs. legacy fallback)
- Edit form field layout decisions
- handleCreateCar and handleUpdateCar patterns
</output>
