// The strip under the two laps of a comparison (owner, 2026-11-22: "messy" as three loose rows): every row is a short label in the same
// column and, beside it, its controls. These classes are the row and the label, so "Compare with" and "Recent" line up.

/** One row of the strip: stacked on a phone, the label beside its controls from `sm`. */
export const BAR_ROW = 'flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3';
/** The label of a row: one width for every row, so the controls start on one line. */
export const BAR_LABEL = 'shrink-0 text-xs font-medium text-muted-foreground sm:w-28';
/** The controls of a row: a plain wrapping row of small controls. */
export const BAR_CONTROLS = 'flex min-w-0 flex-1 flex-wrap items-center gap-2';
