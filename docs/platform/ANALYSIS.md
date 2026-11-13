# Lap analysis library

Pure functions over lap files (`src/lib/sim/`), no UI, no network, no stored state. They return data (codes and
numbers); a screen turns it into sentences and translations. Same laps in, same results out.

| Module | What it does |
|---|---|
| `lap-series.ts` | Shared plumbing: a lap's channels on an even grid of distances, gap filling, smoothing, statistics |
| `corners.ts` | `detectCorners`, `matchCorners`, `trackCorners` |
| `corner-compare.ts` | `compareCorners`: corner by corner delta with the differences that explain it |
| `sectors.ts` | Best sectors, theoretical best lap, per-lap sector status, time left on the table |
| `insights.ts` | `lapInsights` (a lap against a reference) and `sessionInsights` (a set of laps) |
| `synthetic-lap.ts` | Made-up laps with known corners, used by the tests (not by the app) |

Units are those of the lap file: meters, seconds, speed in **m/s**, pedals 0..1. Options named `...Kmh` are in km/h
because that is how people think about them; the comparison and the insights report speed differences in km/h
(`...Kmh`, `kmh`), the corner list keeps m/s.

## Corner detection: `detectCorners(lap, options?)`

1. **Grid.** `speed` (the only required channel) is laid on a grid of distances every 2 m (the step grows on a very long
   lap, at most 12,000 points), gaps (NaN) filled by a straight line. This is why a 500,000-sample lap takes about 10 ms.
2. **Smooth.** A moving average over `smoothingM` (20 m) is used to find minima; a lighter one (`measureSmoothM`,
   10 m) gives the speeds that are reported, so a sharp apex is not rounded off.
3. **Dips.** Wiggles smaller than `noiseKmh` (3 km/h) are removed (a zigzag filter), leaving real peaks and valleys.
4. **Corner test.** A valley is a corner when the highest speed within `windowM` (400 m) before it and the highest within
   `windowM` after it are both at least `minDropKmh` (15 km/h) above it. A gentle dip is therefore not a corner.
5. **Merging.** Consecutive valleys are one corner when they are closer than `minSeparationM` (60 m), or when they are
   at most `chicaneMaxM` (200 m) apart and the speed between them never rises more than `chicaneRecoveryKmh`
   (10 km/h) above the higher of the two. That is a chicane or a double apex: it is one corner (`chicane: true`), its
   apex is the deeper minimum, and it starts at the first and ends at the last.
6. **Extent.** `startDist` is where the speed has fallen by `startDropFraction` (10%, at least 1.5 km/h) of the drop
   from the speed before the corner; `endDist` is where it has climbed back `endRecoveryFraction` (60%) of the way
   to the lower of the speeds before and after. Neighbors never overlap. Corner "exit" is therefore where most of the
   speed is back, not where the car is at full speed.
7. **Driver inputs**, each only if its channel exists:
   - `brakePointDist`: the last run of `brake` above `brakeOn` (0.1) that ends at the corner (gaps up to 10 m stay in
     the run), linearly interpolated to the crossing; `brakePeak` is the highest brake in the run. With no `brake`
     channel but a `g_long`, deceleration beyond `gLongBrake` (0.3 g) is used (`brakeSource: 'g_long'`, `brakePeak` null).
     With neither, both are null: speed alone cannot tell braking from lifting, so it is not guessed.
   - `trailBrakeLength`: meters of the braking run with `|steer| >= steerOn` (0.04); needs `brake` and `steer`.
   - `throttlePickupDist`: the first point after the apex where `throttle` passes `throttlePickup` (0.5) and stays above
     for 10 m; the apex itself if it is already above (after the last minimum for a chicane).
   - `direction`: sign of `steer` around the apex (positive: right), else the turn of the path (`x`,`z`; x east,
     z north), else null.
   - `gear`: the raw gear sample nearest the apex. `timeInCorner`: `t` at `endDist` minus `t` at `startDist`.

Each corner also carries `lapLengthM` and `apexFraction` (apex as a share of the lap), which matching uses, and
`available` (which channels existed).

### `matchCorners(reference, other, options?)`

Pairs the corners of two laps of the same track by `apexFraction` (so laps a little different in length still line up).
It is an order-preserving best pairing: most pairs first, then least total offset, and a pair must be within
`toleranceM` (40 m, or 1% of the lap if more) on the reference lap. A corner that has no such partner (extra on one lap,
missing on the other) is left unmatched instead of being paired with a wrong one. Laps whose lengths differ by more than
`lengthTolerance` (3%) are not matched at all. Returns `{ pairs, unmatchedReference, unmatchedOther }`.

### `trackCorners(laps, options?)`

Detects on every lap (laps not within 3% of the median length are ignored), groups corners that are within the tolerance
of each other along the lap, keeps one per lap, and reports each group at the **median** position and values, numbered
1.. in driving order. A corner found on fewer than `minSupport` (0.5) of the laps is dropped. Each result has `support`
and `lapsUsed`. Use it to number corners consistently across a set.

## Comparing two laps: `compareCorners(study, reference, options?)`

* The reference is stretched to the length of the studied lap (laps within 3%), so the finish lines meet. A lap without
  `t` or `speed`, or more than 3% different in length, is `comparable: false` with a `reason`.
* **Gap.** `t` of both laps is read at the same distances; the gap is `t(study) - t(reference)`; positive means the
  studied lap is behind.
* **Corners.** Detected on both laps and matched. The stretch measured is the corner of both laps side by side
  (earliest start to latest end, trimmed so neighbors never overlap). `deltaTime` is the gap at its end minus the gap at
  its start. The corner is numbered as on the reference lap.
* **Straights.** Everything outside those stretches. Because both kinds are differences of the same gap series, corner
  deltas plus straight deltas equal the whole-lap delta (`totals.residualS` is 0 up to rounding), and it matches the
  lap times in the headers (`headerDelta`) when those agree with the channels.
* **Differences that explain the time** (study minus reference): `entrySpeedKmh` and `exitSpeedKmh` at the two ends of
  the common stretch, `minSpeedKmh` (the minimum of each lap), `brakePointM` (+ later, - earlier), `brakePeak`,
  `trailBrakeM`, `throttlePickupM` (+ later), `gear`, and `lineOffsetM` (sideways distance of the paths at the apex,
  + the studied lap is to the left; needs `x`,`z` on both).
* **`dominantCause`** (only for a corner that lost at least `minDeltaS`, 0.02 s). Each possible cause gets a score,
  the difference divided by its threshold (1 = at the threshold); thresholds are in `CAUSE_THRESHOLDS`:

  | Cause | When | Default threshold |
  |---|---|---|
  | `brakesEarly` | brake point earlier | 8 m |
  | `brakesLate` | brake point later **and** it was paid for (slower in the corner, slower out, or later on the throttle); replaces `lowMinSpeed` | 8 m |
  | `lowMinSpeed` | minimum speed lower | 3 km/h |
  | `line` | paths apart sideways at the apex | 1.5 m |
  | `latePickup` | throttle comes on later | 10 m |
  | `wrongGear` | different gear at the apex | fixed score 1.2 |
  | `slowExit` | slower at the end of the corner; only when none of the above applies, because it is a symptom of them | 3 km/h |
  | `none` | nothing measured explains it, or the corner was not lost | |

  The strongest score at or above 1 wins; scores within 0.15 of the top are a tie, which goes to the one earlier in
  the corner (brake, apex speed, line, throttle, gear). `confidence` (0 to 1) rises with the score and falls when another
  cause is close or when data was missing. `causes` lists everything that passed. `missing` lists the channels
  (`brake`, `throttle`, `position`) that were not there on one of the laps.

## Sectors (`sectors.ts`)

`summarizeSectors(laps)` takes `SectorLap` objects (`sectorLapFrom(lapFile)` makes one) and returns the best valid time of
each sector with its lap, the **theoretical best** (the best sectors added up), the best lap and `potentialGainMs`, and
per-sector averages. Left out, with a reason: invalid laps (`invalid`), pit laps (`pit_lap`: in or out laps have partial
sectors), no list (`no_sectors`), fewer than 2 or more than 9 or non-positive sectors (`bad_sectors`), sectors that
differ from the lap time by more than 250 ms (`sum_mismatch`), and laps whose sector count differs from the majority
(`count_mismatch`; on a tie the larger count wins). `sectorStandings(lap, summary, personalBestSectorsMs?)` gives every
sector `best-of-set`, `personal-best` or `slower`, its gap to the best and the time left on the table; it is null for an
invalid lap, a pit lap, no sectors or a different count. `timeLeftOnTable(lap, summary)` totals it.

## Insights (`insights.ts`)

`lapInsights(study, reference, options?)` returns at most 5 findings, most seconds first (ties: kind, corner, sector):

| `kind` | Means | Fields |
|---|---|---|
| `lostInCorner` | time lost in a corner | `corner`, `seconds`, `cause`, `confidence`, and `meters` or `kmh` for the cause |
| `brakeEarlier` | the cause is `brakesEarly` | `meters` earlier |
| `slowerExit` | the cause is `slowExit` | `kmh` slower at the end of the corner |
| `topSpeedLower` | a straight of at least 150 m whose top speed is 4 km/h lower | `seconds` lost there, `kmh`, `corner: null` |
| `sectorGap` | the sector that lost the most (at least 0.1 s), from the header sector times | `sector`, `seconds` |
| `inconsistent` | given `options.set` (3+ usable laps): the corner whose time varies most (std at least 0.08 s) | `seconds` (the spread), `meters` (brake point spread), `kmh` (minimum speed spread) |

Every finding has a `severity` (`high` from 0.3 s, `medium` from 0.12 s). `cause` is a comparison cause, or
`unknownCause` when time was lost, no cause fit and a channel needed to decide (brake, throttle, position) was missing
on one of the laps, or `none` when everything was there and nothing explains it. A cause is never named without its data.

`sessionInsights(laps)` counts only valid laps that are not pit laps, and leaves out those slower than 107% of the best
from the statistics. It returns `consistency` (best, average, median, standard deviation, spread, laps within 1% of the
best), the corners (`trackCorners`), `cornerSpreads` (per corner: std of time, of minimum speed, of brake point; most
variable first), `mostVariableCorner`, `bestVsAverage` (per corner, seconds the best lap gained against the average of
the others, with brake point and minimum speed differences; largest first), `biggestGain` and `bestLapIndex`.
Corner statistics need 3 or more laps.

## Limits

* **Sample rate.** Positions are found on a 2 m grid, so at 20 Hz and 60 m/s (3 m between samples) a brake point or a
  pickup is good to about 3 to 5 m, and speeds are smoothed over 10 m. Below about 10 Hz expect a coarser answer; the
  analysis does not fail but small differences (a few meters, 1 or 2 km/h) are inside the noise.
* **Missing channels** remove only what needs them (see above). With speed alone there are corners and times, but no
  brake point, trail braking, pickup, direction or gear, and no cause that depends on them.
* **Start and finish line.** A corner that straddles the line (the lap starts mid-corner) is not found whole; an
  in-lap or out-lap is analysed but is not representative, and the session functions leave those out.
* **Different tracks or layouts.** Matching needs the same track within 3% in length; it cannot tell two layouts of the
  same length apart, so the caller must pass laps of one track and layout.
* **Causes are rules, not proof.** They name the earliest measurable difference that is big enough. Confidence is a
  heuristic for ranking, not a probability. The `line` cause needs positions accurate to well under 1.5 m.
* **Speed units.** The detection assumes `speed` is in m/s as the lap format says.

## Using it in a screen

* Compute once per pair of laps: `compareCorners` returns everything (corners, straights, totals, the detected
  corners); `lapInsights` runs it again, so call it only for the short list and keep the comparison for the table.
* Show corners by their `index` (the numbering of the reference lap). For a set of laps use `trackCorners` so numbers agree.
* Turn `kind`, `cause` and `severity` into text with the own strings of the app; treat `unknownCause` as "we could not tell,
  this lap has no brake data" and offer nothing more specific. Do not present a cause with a low `confidence` as fact.
* Always show the totals (corners, straights, whole lap) next to the corner list so the numbers visibly add up.
* Convert speeds for the unit of the user with `speedIn` from `analysis.ts`; everything here is m/s or km/h as named.
* All of it runs in a few milliseconds per lap, so it is safe in the browser; use a worker only for very large sets.
