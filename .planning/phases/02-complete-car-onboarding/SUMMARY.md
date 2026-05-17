# Phase 02 — Complete Car Onboarding — SUMMARY

**Completed:** 2026-05-17
**Status:** Code complete (migration pending application to remote Supabase)

## Plan 02-01 — Data Layer

**Files modified:**
- `supabase/migrations/20260517_car_profile_extended_fields.sql` (pre-existed, ready to apply)
- `src/lib/db.ts` — extended `CarProfile` + new `CarProfileInput`; refactored `createCarProfile` with backward-compat overload + auto-name; widened `updateCarProfile` to `Partial<CarProfileInput>`
- `src/hooks/use-cars.ts` — `createCar` accepts `string | CarProfileInput`; `updateCar` accepts `Partial<CarProfileInput>`
- `src/contexts/CarsContext.tsx` — updated `CarsContextType` to mirror new hook signatures
- `src/integrations/supabase/types.ts` — added `make/model/year/trim/vin` to `car_profiles` Row/Insert/Update

**Backward compatibility:** legacy `createCarProfile('My Car', 'notes')` call site continues to work via the string-or-input overload.

**Auto-naming:** when `name` is omitted and `year + make + model` are all provided, the display name becomes `${year} ${make} ${model}`.

## Plan 02-02 — Onboarding Wizard

**Files created:**
- `src/components/OnboardingWizard.tsx` — 4-step self-contained wizard
  - Step 1: Welcome screen + "Get Started"
  - Step 2: Structured form (year, make, model, trim, VIN, notes) with validation
  - Step 3: Inline `<UploadCard>` with new car id + "Skip for now" link
  - Step 4: Done screen + "Go to Dashboard"
  - Progress dots + step counter ("Step N of 4")
  - Fade-in transitions via `key={currentStep}` remount
- `src/pages/OnboardingPage.tsx` — thin wrapper that sets `localStorage.onboarding_completed = 'true'` and navigates to `/`

**Files modified:**
- `src/App.tsx` — added lazy import + `/onboarding` route under `AuthenticatedLayout`
- `src/pages/Index.tsx` — added redirect `useEffect` that fires when `carsLoading === false && cars.length === 0 && !localStorage.getItem('onboarding_completed')`

**localStorage flag:** `onboarding_completed = 'true'`

## Plan 02-03 — CarsPage Rich Cards

**File rewritten:**
- `src/pages/CarsPage.tsx` — full rewrite of state, forms, and card rendering

**Form structure (Add dialog + inline Edit):**
- Year (number, 1900–2100)
- Make * (required)
- Model * (required)
- Trim (optional)
- VIN (optional, 17 chars enforced)
- Notes (optional)

**Card display:**
- Headline: `${year} ${make} ${model}` via `buildHeadline()`
- Fallback for legacy cars without structured fields: `car.name`
- Subtitle: `${trim} Trim` if trim present
- Muted line: `VIN ${vin}` if VIN present
- Notes shown as line-clamp-1 if present

**Visibility fix carried forward:** `group` class on `<Card>` so `group-hover:opacity-100` on edit/delete buttons works correctly.

## Verification

- ✅ `npx tsc --noEmit` — 0 errors
- ✅ `npx eslint src --ext .ts,.tsx` — 0 errors (12 unrelated warnings)
- ✅ `npm run build` — succeeds in 6.49s
- ✅ `npm test` — passes

## Pending

- Migration `supabase/migrations/20260517_car_profile_extended_fields.sql` must be applied to the remote Supabase project (user opted to skip Supabase CLI auth during this session). Until applied, attempts to write the new fields to the DB will fail with `column does not exist` errors. The Supabase types.ts file has been updated optimistically so the code compiles.

**To apply manually:** Supabase Dashboard → SQL Editor → paste the migration file contents → Run.
