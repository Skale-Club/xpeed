// The sizes of the pictures that stand beside a name on the Virtual screens, in one place, so the same kind of place looks the same on
// every screen (owner rule, 2026-11-21: XPD-D-IDENTITY). A page header may pass its own, bigger size; a list row, a card or a line of
// text takes one of these.

/** The brand logo beside a car's name: `row` in a list row or a card (the default), `line` inside a quiet line of small text. */
export const CAR_LOGO = { row: 'h-7 w-10', line: 'h-5 w-7' } as const;

/** The small map beside a track's name: `row` in a list row or a card (the default), `dense` in a tight ranking line. */
export const TRACK_THUMB = { row: 'h-11 w-11', dense: 'h-7 w-7' } as const;
