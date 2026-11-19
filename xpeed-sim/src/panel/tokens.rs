//! The design tokens of the panel: the one place for every colour, type size, radius, spacing and stroke. Nothing else
//! in `panel/` writes a colour, a font size, a corner radius or a gap as a literal; a view that needs a new one adds it
//! here, with its reason.
//!
//! The surfaces, text and status colours are the site's (`src/index.css`, `tailwind.config.ts`), so the Companion and the
//! website read as one product. What only a HUD needs (the rev bar, the cyan base line, the steel of a cold tyre) is
//! marked as such. The typeface stays Chakra Petch (`paint.rs`, owner decision).

use super::*;

/// A colour as `0x00BBGGRR` (what GDI takes) from its red, green and blue.
pub(super) const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    r as u32 | (g as u32) << 8 | (b as u32) << 16
}

/// `a` with `t` (0..1) of `b` mixed in. Only tokens and gradients use it: a view asks for a named colour instead.
pub(super) const fn mix(a: COLORREF, b: COLORREF, t: f32) -> COLORREF {
    const fn channel(a: COLORREF, b: COLORREF, t: f32, shift: u32) -> COLORREF {
        let (x, y) = ((a >> shift & 0xff) as f32, (b >> shift & 0xff) as f32);
        ((x + (y - x) * t + 0.5) as u32) << shift
    }
    channel(a, b, t, 0) | channel(a, b, t, 8) | channel(a, b, t, 16)
}

// Surfaces.

/// The window's background (`--background`, #101113).
pub(super) const BACKGROUND: COLORREF = rgb(0x10, 0x11, 0x13);
/// A card (`--card`, #18191b).
pub(super) const CARD: COLORREF = rgb(0x18, 0x19, 0x1b);
/// A menu or list that floats over a card (`--popover`, #1a1b1e).
pub(super) const POPOVER: COLORREF = rgb(0x1a, 0x1b, 0x1e);
/// A quiet surface inside a card (`--muted`, #1f2023).
pub(super) const SURFACE: COLORREF = rgb(0x1f, 0x20, 0x23);
/// The empty part of a bar or a gauge, and a pressed or hovered surface (`--secondary`, #242529).
pub(super) const SECONDARY: COLORREF = rgb(0x24, 0x25, 0x29);
/// A line and the outline of a card (`--border`, #292a2e).
pub(super) const BORDER: COLORREF = rgb(0x29, 0x2a, 0x2e);

// Text.

/// The main text (`--foreground`, #eeeff2).
pub(super) const FOREGROUND: COLORREF = rgb(0xee, 0xef, 0xf2);
/// Text a step quieter than the main one (#d8dadf).
pub(super) const FOREGROUND_2: COLORREF = rgb(0xd8, 0xda, 0xdf);
/// Captions and notes (#93979f: the site's muted text, lighter than before for contrast on a card).
pub(super) const MUTED_TEXT: COLORREF = rgb(0x93, 0x97, 0x9f);

// Brand and status.

/// The brand colour (`--primary`, #f5e663): the gear, the lap number, a button.
pub(super) const PRIMARY: COLORREF = rgb(0xf5, 0xe6, 0x63);
/// The ink on `PRIMARY` and on any lit status colour (#121316).
pub(super) const ON_PRIMARY: COLORREF = rgb(0x12, 0x13, 0x16);
/// Danger: a lap that does not count, a hot tyre, a low fuel (`--destructive`, #e64c4c).
pub(super) const DESTRUCTIVE: COLORREF = rgb(0xe6, 0x4c, 0x4c);
/// Caution (#f6ae31).
pub(super) const WARN: COLORREF = rgb(0xf6, 0xae, 0x31);
/// Good: faster than the best lap, the throttle, a tyre in its window (#31b97a).
pub(super) const SUCCESS: COLORREF = rgb(0x31, 0xb9, 0x7a);
/// Information: the clutch, ABS (#4c99f0).
pub(super) const INFO: COLORREF = rgb(0x4c, 0x99, 0xf0);
/// The best lap, as timing screens colour it (#a474e7).
pub(super) const BEST: COLORREF = rgb(0xa4, 0x74, 0xe7);

// HUD only: nothing of the site has these.

/// The rev bar's base line and the headlights (#26c6ff).
pub(super) const CYAN: COLORREF = rgb(0x26, 0xc6, 0xff);
/// A calm blue for a cold tyre or a cold brake (the louder `INFO` is for the clutch and the shift flash).
pub(super) const STEEL: COLORREF = rgb(0x6b, 0x95, 0xc2);
/// A neighbouring gear (#7f848c, raised from #5c616b to read on a card).
pub(super) const GREY: COLORREF = rgb(0x7f, 0x84, 0x8c);
/// The rev bar's gradient from low revs to the limit.
pub(super) const REV_STOPS: [(f32, COLORREF); 4] = [
    (0.0, rgb(0x57, 0xe3, 0x3a)),
    (0.55, rgb(0xe9, 0xef, 0x3c)),
    (0.8, rgb(0xff, 0x9f, 0x1c)),
    (1.0, rgb(0xff, 0x30, 0x30)),
];
/// A tyre's colour by its temperature (°C): steel while cold, green in its window, amber hot, red over, blending between
/// them (the thresholds of `TyreState`: 65 / 95 / 105). Owner-approved mockup, 2026-11-19.
pub(super) const TYRE_HEAT_STOPS: [(f32, COLORREF); 8] = [
    (40.0, STEEL),
    (65.0, STEEL),
    (72.0, SUCCESS),
    (92.0, SUCCESS),
    (98.0, WARN),
    (104.0, WARN),
    (110.0, DESTRUCTIVE),
    (140.0, DESTRUCTIVE),
];
/// The rubber around a tyre's tread when it is drawn from above (its sidewalls).
pub(super) const TYRE_SIDEWALL: COLORREF = rgb(0x0b, 0x0b, 0x0c);
/// The lights card (owner decision 2026-11-19): every light the game can give keeps its place in a grid of at most
/// `LIGHT_COLUMNS` columns, off dark with its name, on filled in its colour, ready outlined. A light that lights never
/// moves another. Tiles are `LIGHT_TILE_H` tall, never under `LIGHT_TILE_MIN_H` (with less room, only the lit ones show).
pub(super) const LIGHT_COLUMNS: usize = 4;
pub(super) const LIGHT_TILE_H: f32 = 40.0;
pub(super) const LIGHT_TILE_MIN_H: f32 = 20.0;
/// A drawn tyre is this wide for its height (seen from above).
pub(super) const TYRE_ASPECT: f32 = 0.5;
/// The times card's projected lap line and the delta graph under it (owner-approved module 5, 2026-11-19).
pub(super) const PROJECTED_H: f32 = 18.0;
pub(super) const DELTA_TRACE_H: f32 = 40.0;
/// The delta graph's scale: at least this many seconds either side of zero, never more than `DELTA_TRACE_MAX_S`.
pub(super) const DELTA_TRACE_MIN_S: f32 = 0.5;
pub(super) const DELTA_TRACE_MAX_S: f32 = 2.0;
/// How much of its colour the area between the delta line and zero takes.
pub(super) const DELTA_TRACE_FILL: f32 = 0.28;
/// The laps table's gap bar (owner-approved module 4, 2026-11-19): a lap this many seconds or more behind the best
/// fills it; it is this tall.
pub(super) const LAP_GAP_FULL_S: f32 = 2.0;
pub(super) const LAP_GAP_BAR_H: f32 = 5.0;
/// The inputs card (owner-approved 2026-11-19): the share of its height the trace takes, the width of a pedal bar
/// in its column, the height of the lap line at the bottom, and a block's least height in a pedal bar.
pub(super) const INPUT_TRACE_SHARE: f32 = 0.34;
pub(super) const INPUT_BAR_WIDTH: f32 = 0.7;
pub(super) const INPUT_LAP_H: f32 = 18.0;
pub(super) const INPUT_BLOCK_H: f32 = 5.0;
/// The input trace's grid (owner, 2026-11-19): a hairline every 10% of the pedal travel, barely lighter than the strip,
/// so the trace reads like a chart without the lines competing with it.
pub(super) const INPUT_GRID_INK: COLORREF = rgb(0x1c, 0x1d, 0x21);
/// The gear takes at least this share of the centre card's inside height (owner, 2026-11-19: it is read from afar;
/// nothing else may shrink it).
pub(super) const GEAR_MIN_SHARE: f32 = 0.5;
/// The fuel card's stint planner: the runs it counts (owner-approved module 6, 2026-11-19).
pub(super) const FUEL_PLAN_LAPS: [u32; 2] = [10, 20];
/// The fuel card's rows: the use tiles, a planner row, and a temperature's bar.
pub(super) const FUEL_STAT_H: f32 = 46.0;
pub(super) const FUEL_PLAN_ROW_H: f32 = 20.0;
pub(super) const FUEL_TEMP_BAR_H: f32 = 6.0;
/// The track card's lap progress bar: how tall it is.
pub(super) const LAP_BAR_H: f32 = 8.0;
/// A tyre tile's wear bar: how far under the row above it starts, and how tall it is.
pub(super) const WEAR_BAR_TOP: f32 = 2.0;
pub(super) const WEAR_BAR_H: f32 = 3.0;
/// The distance between two grooves across a drawn tread.
pub(super) const TYRE_GROOVE_PITCH: f32 = 10.0;

/// A groove across a drawn tread: its colour, a little darker.
pub(super) const fn groove_of(c: COLORREF) -> COLORREF {
    mix(c, TYRE_SIDEWALL, 0.3)
}

/// The colour of a tyre at `temp_c` along `TYRE_HEAT_STOPS`; a quiet grey without a temperature.
pub(super) fn heat_colour(temp_c: f32) -> COLORREF {
    if !temp_c.is_finite() {
        return SECONDARY;
    }
    let stops = TYRE_HEAT_STOPS;
    if temp_c <= stops[0].0 {
        return stops[0].1;
    }
    for pair in stops.windows(2) {
        let ((t0, c0), (t1, c1)) = (pair[0], pair[1]);
        if temp_c <= t1 {
            return mix(c0, c1, (temp_c - t0) / (t1 - t0));
        }
    }
    stops[stops.len() - 1].1
}
/// How many divisions the rev bar has.
pub(super) const REV_DIVISIONS: usize = 10;
/// The window's backdrop runs from this at the top to that at the bottom (a gradient around `BACKGROUND`).
pub(super) const BACKDROP_TOP: COLORREF = mix(BACKGROUND, rgb(0x1c, 0x1e, 0x23), 0.8);
pub(super) const BACKDROP_BOTTOM: COLORREF = mix(BACKGROUND, rgb(0, 0, 0), 0.35);

// Derived colours: each is a named mix of tokens, written once here.

/// The road's centre line on the track map.
pub(super) const ROAD_LINE: COLORREF = mix(SECONDARY, FOREGROUND, 0.5);
/// The cover of a game that has not arrived yet.
pub(super) const COVER_PLACEHOLDER: COLORREF = mix(BACKGROUND, CARD, 0.8);
/// The name of a light that is off: present but quiet, well under the muted text.
pub(super) const LIGHT_OFF_INK: COLORREF = mix(CARD, MUTED_TEXT, 0.45);
/// The row under the mouse in the language list.
pub(super) const ROW_HOVER: COLORREF = mix(CARD, FOREGROUND, 0.07);
/// What the make marks stand on (the logos are drawn for a light ground).
pub(super) const BRAND_TILE: COLORREF = rgb(0xf5, 0xf5, 0xf5);
/// The flags of the alerts card.
pub(super) const FLAG_WHITE: COLORREF = rgb(0xff, 0xff, 0xff);
pub(super) const FLAG_BLACK: COLORREF = rgb(0x05, 0x05, 0x06);

/// How much of its colour an element that is not live keeps over the card (paused, a menu, a silent game): it reads as
/// "last known", never as a live value.
pub(super) const DIM: f32 = 0.34;

/// `c` as an element that is not live shows it, over a card.
pub(super) const fn dim(c: COLORREF) -> COLORREF {
    mix(CARD, c, DIM)
}

/// `colour` over `base` by `amount`, for a colour that depends on a reading (a tyre's temperature, a light's colour):
/// not a token, the one place a view derives a colour at run time.
pub(super) fn tint(base: COLORREF, colour: COLORREF, amount: f32) -> COLORREF {
    mix(base, colour, amount)
}

// Type: the sizes, in design pixels (a window at 96 DPI). Labels are never below `T_CAPTION`.

/// Captions, labels, notes and units.
pub(super) const T_CAPTION: f32 = 12.0;
/// The one exception to `T_CAPTION`: a label in a tile of fixed width (a light, a setting) shrinks to fit it, down to
/// this, rather than run out of the tile (owner, 2026-11-19). `Painter::caps_fit`.
pub(super) const T_LABEL_MIN: f32 = 9.0;
/// Body text and buttons.
pub(super) const T_BODY: f32 = 14.0;
/// A heading or a small figure.
pub(super) const T_LEAD: f32 = 18.0;
/// A figure in a card.
pub(super) const T_VALUE: f32 = 22.0;
/// A bigger figure: the lap number, a neighbouring gear.
pub(super) const T_VALUE_L: f32 = 28.0;
/// The delta, the fuel in litres, a lap card's time.
pub(super) const T_NUMERAL: f32 = 36.0;
/// The speed, the lap times.
pub(super) const T_NUMERAL_L: f32 = 44.0;
/// The biggest figures of a row of times.
pub(super) const T_HERO: f32 = 52.0;
/// The lap time of a tall times card.
pub(super) const T_DISPLAY: f32 = 72.0;
/// The type scale, smallest first.
pub(super) const SCALE: [f32; 9] = [
    T_CAPTION,
    T_BODY,
    T_LEAD,
    T_VALUE,
    T_VALUE_L,
    T_NUMERAL,
    T_NUMERAL_L,
    T_HERO,
    T_DISPLAY,
];

/// At most nine sizes, and a label is never below 12 design pixels: checked when the program is built.
const _: () = assert!(SCALE.len() <= 9 && SCALE[0] >= 12.0);

/// The largest size of the type scale that is not above `size` (the smallest when `size` is below it all): a text that
/// shrinks to fit steps down the scale, it never makes a size of its own.
pub(super) fn type_step(size: f32) -> f32 {
    SCALE.iter().rev().copied().find(|s| *s <= size + 0.001).unwrap_or(T_CAPTION)
}

/// The gear fills this share of its frame's height.
pub(super) const GEAR_FILL: f32 = 0.93;

// Shape.

/// The panel's one corner: near-square, as racing screens are (the "square pill"). Owner decision 2026-11-12
/// (fec259a), restored 2026-11-19 after the token pass of 2026-11-16 (539eb8a) copied the site's 4/6/8/10 radii and
/// rounded everything again.
///
/// Every rounded shape of the panel and of the Coach window uses it: card, tile, button, tab, pill, chip, popover,
/// tooltip, input, switch (bars are square blocks: `BAR_BLOCKS`). There is no second radius and none may be added:
/// `Painter::round` takes no radius, and a shape thinner than twice the corner takes half its short side
/// (`rounded_path`). The site's scale
/// (`rounded-md` and friends) and the spacing tokens are never a corner here. `tests::one_near_square_corner` pins
/// it; changing it is an owner decision, recorded in the journal before the code.
pub(super) const R_CORNER: f32 = 2.5;

/// Every bar (fuel, delta, throttle, brake, clutch, tread wear, progress) is a row of square blocks a hair apart, never
/// one continuous rounded fill; the one exception is the wheel, a thin white line (`STEER_LINE_H`, owner 2026-11-19).
/// Owner decision: the segmented bars of 2026-11-12 (ac5c6b5) were the right ones; the stage-2 rebuild of 2026-11-16
/// (37cc6fc) swapped them for solid rounded bars, restored 2026-11-19.
/// `Painter::blocks` draws them; `tests::bars_are_square_blocks` pins it.
pub(super) const BAR_BLOCKS: usize = 20;
/// The wheel's line: how thick (owner, 2026-11-19: "just a line, subtle, minimalist").
pub(super) const STEER_LINE_H: f32 = 2.0;
/// The hair between two blocks.
pub(super) const BAR_BLOCK_GAP: f32 = 1.5;
/// The narrowest block: a short bar has fewer blocks rather than slivers.
pub(super) const BAR_BLOCK_MIN_W: f32 = 6.0;

/// Spacing, on a 4 px grid.
pub(super) const S1: f32 = 4.0;
pub(super) const S2: f32 = 8.0;
pub(super) const S3: f32 = 12.0;
pub(super) const S4: f32 = 16.0;
pub(super) const S6: f32 = 24.0;
pub(super) const S8: f32 = 32.0;

/// Strokes: a hairline, a bar's thickness, the accent edge of a tile.
pub(super) const STROKE_HAIR: f32 = 1.0;
pub(super) const STROKE_BAR: f32 = 3.0;
pub(super) const STROKE_ACCENT: f32 = 2.0;
