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

/// Every bar (fuel, delta, throttle, brake, clutch, wheel, tread wear, progress) is a row of square blocks a hair
/// apart, never one continuous rounded fill. Owner decision: the segmented bars of 2026-11-12 (ac5c6b5) were the right
/// ones; the stage-2 rebuild of 2026-11-16 (37cc6fc) swapped them for solid rounded bars, restored 2026-11-19.
/// `Painter::blocks` draws them; `tests::bars_are_square_blocks` pins it.
pub(super) const BAR_BLOCKS: usize = 20;
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
