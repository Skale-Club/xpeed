use super::*;

/// The colours, as `0x00BBGGRR`. The accent is the app's `--primary` (#F5E663); purple marks the best lap, as timing
/// screens do.
pub(super) const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    r as u32 | (g as u32) << 8 | (b as u32) << 16
}

pub(super) const BG: COLORREF = rgb(0x0c, 0x0d, 0x0f);

/// The window's background runs from this at the top to that at the bottom.
pub(super) const BG_TOP: COLORREF = rgb(0x14, 0x16, 0x1a);

pub(super) const BG_BOTTOM: COLORREF = rgb(0x08, 0x09, 0x0b);

pub(super) const CARD: COLORREF = rgb(0x16, 0x18, 0x1c);

pub(super) const EDGE: COLORREF = rgb(0x25, 0x28, 0x2e);

pub(super) const TRACK: COLORREF = rgb(0x27, 0x2a, 0x31);

pub(super) const WHITE: COLORREF = rgb(0xff, 0xff, 0xff);

pub(super) const TEXT: COLORREF = rgb(0xf2, 0xf2, 0xf3);

pub(super) const MUTED: COLORREF = rgb(0x7c, 0x82, 0x8c);

pub(super) const ACCENT: COLORREF = rgb(0xf5, 0xe6, 0x63);

pub(super) const GREEN: COLORREF = rgb(0x2f, 0xd6, 0x7b);

pub(super) const RED: COLORREF = rgb(0xff, 0x4d, 0x4d);

pub(super) const BLUE: COLORREF = rgb(0x3d, 0x9b, 0xff);

/// A calm steel blue for a cold tyre or a cold brake (the loud BLUE is for the clutch and the shift flash).
pub(super) const STEEL: COLORREF = rgb(0x6b, 0x95, 0xc2);

pub(super) const AMBER: COLORREF = rgb(0xff, 0xb0, 0x3b);

pub(super) const PURPLE: COLORREF = rgb(0xb5, 0x7c, 0xff);

pub(super) const GREY: COLORREF = rgb(0x5c, 0x61, 0x6b);

/// The rev bar's base line, and its gradient from low revs to the limit.
pub(super) const CYAN: COLORREF = rgb(0x26, 0xc6, 0xff);

pub(super) const REV_STOPS: [(f32, COLORREF); 4] = [
    (0.0, rgb(0x57, 0xe3, 0x3a)),
    (0.55, rgb(0xe9, 0xef, 0x3c)),
    (0.8, rgb(0xff, 0x9f, 0x1c)),
    (1.0, rgb(0xff, 0x30, 0x30)),
];

pub(super) const REV_DIVISIONS: usize = 10;

/// `a` with `t` (0..1) of `b` mixed in.
pub(super) fn mix(a: COLORREF, b: COLORREF, t: f32) -> COLORREF {
    let channel = |shift: u32| {
        let (x, y) = ((a >> shift & 0xff) as f32, (b >> shift & 0xff) as f32);
        ((x + (y - x) * t).round() as u32) << shift
    };
    channel(0) | channel(8) | channel(16)
}

/// The corner radius of buttons, pills and cards (design pixels): nearly square, as racing screens are.
pub(super) const CORNER: f32 = 2.5;
