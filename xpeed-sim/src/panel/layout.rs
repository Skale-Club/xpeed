use super::*;

/// Height of the header, in design pixels.
pub(super) const HEADER_H: f32 = 66.0;

/// The dashboard is laid out on this canvas (design units) and scaled whole to fit the window, so it keeps its
/// proportions at any size and fills a full screen instead of stretching empty cards.
pub(super) const CANVAS_W: f32 = 1000.0;

pub(super) const CANVAS_H: f32 = 520.0;

/// The column on the right for the track map and the tyres, shown when the game gives them and the window is big
/// enough for the wider canvas not to shrink the rest (full screen, a large window).
pub(super) const SIDE_W: f32 = 360.0;

/// The shift lights light from this share of the top RPM to `SHIFT_AT`, where they flash.
pub(super) const LIGHTS_FROM: f32 = 0.55;

pub(super) const SHIFT_AT: f32 = 0.97;

pub(super) const LIGHTS: usize = 20;

/// The places of the header that can be clicked: the two tabs, "full screen" and "always on top" (square icon
/// buttons at the right).
pub(super) fn header_hits(width: i32, scale: f32) -> [RECT; 5] {
    let p = |v: f32| (v * scale).round() as i32;
    let (top, bottom) = (p(13.0), p(51.0));
    let right = width - p(16.0);
    let (side, gap) = (p(38.0), p(8.0));
    let nth = |n: i32| rect(right - side - n * (side + gap), top, right - n * (side + gap), bottom);
    // Narrower tabs in a narrow window (a phone held upright), so they never run into the buttons.
    let tab = if (width as f32 / scale) < 560.0 { 80.0 } else { 116.0 };
    [
        rect(p(20.0), p(17.0), p(20.0 + tab), p(47.0)),
        rect(p(20.0 + tab), p(17.0), p(20.0 + 2.0 * tab), p(47.0)),
        nth(2),
        nth(1),
        nth(0),
    ]
}

/// Where the version text sits in the header (pixels), or `None` when the window is too narrow to show it.
pub(super) fn version_hit(width: i32, scale: f32) -> Option<RECT> {
    let p = |v: f32| (v * scale).round() as i32;
    let [_, mon, lang, _, _] = header_hits(width, scale);
    let right = lang.left - p(14.0);
    (right - p(60.0) > mon.right + p(12.0)).then(|| rect(right - p(120.0), lang.top, right, lang.bottom))
}

/// Fits a canvas of `width` x `height` design units in `body`, centred: its scale and where it starts (pixels).
pub(super) fn canvas_fit_wh(body: RECT, width: f32, height: f32) -> (f32, i32, i32) {
    let (bw, bh) = ((body.right - body.left) as f32, (body.bottom - body.top) as f32);
    let s = (bw / width).min(bh / height).max(0.1);
    let ox = body.left + ((bw - width * s) / 2.0).round() as i32;
    let oy = body.top + ((bh - height * s) / 2.0).round() as i32;
    (s, ox, oy)
}

/// The dashboard's layouts, one per shape of window. Each is a canvas in design units, scaled whole to fit, so the
/// panel works on an ultrawide screen, a 16:9 or 16:10 one, a 4:3 one and a phone held upright alike.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Layout {
    /// The main dashboard alone (a small window).
    Classic,
    /// Ultrawide (21:9): the main dashboard and the track and tyre column.
    Ultrawide,
    /// 16:9 and 16:10: the column, and the recent laps under the dashboard.
    Wide,
    /// 4:3 and 5:4: the track and the tyres side by side under the dashboard.
    Square,
    /// A tall window (a phone held upright): everything in one column.
    Portrait,
}

/// The recent laps under the dashboard (`Layout::Wide`).
pub(super) const BAND_H: f32 = 188.0;

/// The track and tyre row under the dashboard (`Layout::Square`).
pub(super) const SQUARE_ROW_H: f32 = 310.0;

/// The tall layout's canvas (about 9:16).
pub(super) const PORTRAIT_W: f32 = 600.0;

pub(super) const PORTRAIT_H: f32 = 1210.0;

impl Layout {
    /// The canvas size. `side` is whether there is anything for the track and tyre column (or row) to show: without
    /// it the layouts that exist for it are as small as the main dashboard, which then fills the window. `main_h` is
    /// the height of the main dashboard (see `main_height`).
    pub(super) fn size(self, side: bool, main_h: f32) -> (f32, f32) {
        match self {
            Layout::Classic => (CANVAS_W, main_h),
            Layout::Ultrawide if !side => (CANVAS_W, main_h),
            // The column keeps its full height: the track and the tyres need it.
            Layout::Ultrawide => (CANVAS_W + SIDE_W, CANVAS_H),
            Layout::Wide if !side => (CANVAS_W, main_h + BAND_H),
            Layout::Wide => (CANVAS_W + SIDE_W, main_h + BAND_H),
            Layout::Square if !side => (CANVAS_W, main_h),
            Layout::Square => (CANVAS_W, main_h + SQUARE_ROW_H),
            Layout::Portrait => (PORTRAIT_W, PORTRAIT_H),
        }
    }

    /// The smallest scale at which the layout still reads well (the tall one is drawn bigger to begin with).
    pub(super) fn min_scale(self, side: bool) -> f32 {
        match self {
            Layout::Classic => 0.0,
            Layout::Ultrawide | Layout::Square if !side => 0.0,
            Layout::Portrait => 0.5,
            _ => 0.75,
        }
    }
}

/// The layout that fills a body of `bw` x `bh` pixels best while staying readable; between two that fill it about as
/// well, the one that shows more. `side`: there is a track or tyres to show.
pub(super) fn pick_layout(bw: f32, bh: f32, side: bool, main_h: f32) -> Layout {
    let order = [Layout::Wide, Layout::Ultrawide, Layout::Square, Layout::Portrait, Layout::Classic];
    let fill = |l: Layout| {
        let (w, h) = l.size(side, main_h);
        let s = (bw / w).min(bh / h);
        (s >= l.min_scale(side)).then(|| s * s * w * h / (bw * bh).max(1.0))
    };
    let best = order.iter().filter_map(|&l| fill(l)).fold(0.0_f32, f32::max);
    order
        .into_iter()
        .find(|&l| fill(l).is_some_and(|f| f >= best - 0.03))
        .unwrap_or(Layout::Classic)
}

/// The height of the main dashboard: with no car card to show (no lights, engine or electronics) the strip along the
/// bottom is not there and the canvas ends under the middle, so nothing below it is left floating.
pub(super) fn main_height(live: &Live) -> f32 {
    if present_cards(live).is_empty() {
        STRIP_TOP + 16.0
    } else {
        CANVAS_H
    }
}

/// The height of each of the `n` rows of the times column: three rows share the column's height, so with fewer the
/// rows are taller (not past half again) and leave no hole.
pub(super) fn left_row_h(n: usize, row_h: f32) -> f32 {
    if n == 0 {
        return row_h;
    }
    (3.0 * row_h / n as f32).min(row_h * 1.5)
}

/// A block's place in a column: `(offset from the column's top, height)`.
pub(super) type Span = Option<(f32, f32)>;

/// Where the fuel and the lap progress go in the right column; only what is shown has a place. The fuel block (its
/// gauge needs the room) is taller than a plain row.
pub(super) fn right_plan(row_h: f32, fuel: bool, lap: bool) -> (Span, Span) {
    let (fuel_h, lap_h) = (row_h * 1.4, row_h * 1.6);
    match (fuel, lap) {
        (true, true) => (Some((0.0, fuel_h)), Some((fuel_h, lap_h))),
        (true, false) => (Some((0.0, fuel_h)), None),
        (false, true) => (None, Some((0.0, lap_h))),
        (false, false) => (None, None),
    }
}

/// The width of the left and right columns of the main block, and where its car strip starts.
pub(super) const MAIN_SIDE_W: f32 = 300.0;

pub(super) const STRIP_TOP: f32 = 400.0;

/// The blocks of a pedal bar: each `PEDAL_SEG` tall with a `PEDAL_GAP` between, as many as fit in `h`.
pub(super) const PEDAL_SEG: f32 = 6.0;

pub(super) const PEDAL_GAP: f32 = 2.0;

/// Where the middle of the dashboard puts its parts, from the centre line `cx` and the top of the delta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Centre {
    /// The gear's frame (the corner brackets).
    pub(super) frame: Area,
    pub(super) brake: Area,
    pub(super) throttle: Area,
    pub(super) clutch: Area,
    /// The steering bar, under the speed.
    pub(super) steer: Area,
    /// Where the speed and its unit go.
    pub(super) speed: Area,
    pub(super) unit: Area,
    /// The first line under everything.
    pub(super) bottom: f32,
}

pub(super) const FRAME_W: f32 = 280.0;

/// `delta`: the delta is shown over the gear. Without it the gear frame moves up into its room and grows by it, so
/// the block keeps its height and leaves no hole.
pub(super) fn centre_plan(cx: f32, top: f32, frame_h: f32, delta: bool) -> Centre {
    let (rise, frame_h) = if delta { (72.0, frame_h) } else { (8.0, frame_h + 64.0) };
    let (fx, fy) = (cx - FRAME_W / 2.0, top + rise);
    let (bar_w, clutch_w, gap) = (18.0, 10.0, 10.0);
    let brake_x = fx - gap - bar_w;
    let speed_y = fy + frame_h + 6.0;
    Centre {
        frame: (fx, fy, FRAME_W, frame_h),
        brake: (brake_x, fy, bar_w, frame_h),
        throttle: (fx + FRAME_W + gap, fy, bar_w, frame_h),
        clutch: (brake_x - 7.0 - clutch_w, fy, clutch_w, frame_h),
        steer: (fx, speed_y + 60.0, FRAME_W, 8.0),
        speed: (cx - 120.0, speed_y, 240.0, 40.0),
        unit: (cx - 120.0, speed_y + 38.0, 240.0, 14.0),
        bottom: speed_y + 72.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CarCard {
    Lights,
    Engine,
    Electronics,
}

impl CarCard {
    /// The narrowest a card reads well at, and the share of a row it takes.
    pub(super) fn min_w(self) -> f32 {
        match self {
            CarCard::Lights => 230.0,
            CarCard::Engine => 190.0,
            CarCard::Electronics => 290.0,
        }
    }

    pub(super) fn weight(self) -> f32 {
        match self {
            CarCard::Lights => 1.0,
            CarCard::Engine => 0.85,
            CarCard::Electronics => 1.15,
        }
    }
}

/// The cards of `present` that fit a row of `w` x `h` at (`x`, `y`), left to right, taking all the room between
/// them. When there is not room for all of them, the engine goes first, then the electronics, then the lights.
pub(super) fn strip_plan(x: f32, y: f32, w: f32, h: f32, present: &[CarCard]) -> Vec<(CarCard, Area)> {
    let gap = 12.0;
    let want: Vec<CarCard> = [CarCard::Lights, CarCard::Engine, CarCard::Electronics]
        .into_iter()
        .filter(|c| present.contains(c))
        .collect();
    let mut sets = vec![want];
    for drop in [CarCard::Engine, CarCard::Electronics, CarCard::Lights] {
        let mut next = sets.last().cloned().unwrap_or_default();
        next.retain(|c| *c != drop);
        if !next.is_empty() && Some(&next) != sets.last() {
            sets.push(next);
        }
    }
    for set in sets {
        if set.is_empty() {
            continue;
        }
        let room = w - gap * (set.len() as f32 - 1.0);
        let total: f32 = set.iter().map(|c| c.weight()).sum();
        let fits = set.iter().all(|c| room * c.weight() / total >= c.min_w());
        if fits || set.len() == 1 {
            let mut at = x;
            return set
                .iter()
                .map(|&c| {
                    let cw = room * c.weight() / total;
                    let area = (at, y, cw, h);
                    at += cw + gap;
                    (c, area)
                })
                .collect();
        }
    }
    Vec::new()
}

/// Where `n` light tiles go in a box: a grid of equal tiles (same width, same height, left aligned) with the number
/// of columns chosen from the count so that no row is left with a lone tile: the layout with the fewest empty places
/// wins, then the one with the biggest tiles. Tiles never leave the box.
pub(super) fn light_cells((x, y, w, h): Area, n: usize) -> Vec<Area> {
    let (min_w, max_w, min_h, max_h, gap) = (40.0, 96.0, 24.0, 40.0, 6.0);
    if n == 0 {
        return Vec::new();
    }
    let size = |cols: usize| {
        let rows = n.div_ceil(cols);
        let tw = ((w - gap * (cols as f32 - 1.0)) / cols as f32).min(max_w).max(1.0);
        let th = ((h - gap * (rows as f32 - 1.0)) / rows as f32).min(max_h).max(1.0);
        (rows, tw, th)
    };
    let mut best: Option<(usize, usize, f32, f32)> = None;
    for cols in 1..=n {
        let (rows, tw, th) = size(cols);
        if tw < min_w || th < min_h {
            continue;
        }
        let better = best.is_none_or(|(c, r, bw, bh)| {
            let (empty, best_empty) = (cols * rows - n, c * r - n);
            empty < best_empty || (empty == best_empty && tw * th > bw * bh)
        });
        if better {
            best = Some((cols, rows, tw, th));
        }
    }
    // No layout is roomy enough: as many columns as the width allows, the tiles as big as the box leaves them.
    let (cols, tw, th) = best.map_or_else(
        || {
            // The most columns the width allows; of those, the count that leaves the fewest empty places.
            let most = (((w + gap) / (min_w + gap)).floor() as usize).clamp(1, n);
            let cols = (1..=most).min_by_key(|c| (c * n.div_ceil(*c) - n, most - c)).unwrap_or(1);
            let (_, tw, th) = size(cols);
            (cols, tw, th)
        },
        |(cols, _, tw, th)| (cols, tw, th),
    );
    (0..n)
        .map(|i| (x + (i % cols) as f32 * (tw + gap), y + (i / cols) as f32 * (th + gap), tw, th))
        .collect()
}

/// Where `n` cells go in a box with `cols` columns: `(x, y, w, h)` each.
pub(super) fn cell_grid((x, y, w, h): Area, n: usize, cols: usize) -> Vec<Area> {
    if n == 0 {
        return Vec::new();
    }
    let cols = cols.clamp(1, n);
    let rows = n.div_ceil(cols);
    let (cw, rh) = (w / cols as f32, (h / rows as f32).min(44.0));
    (0..n)
        .map(|i| (x + (i % cols) as f32 * cw, y + (i / cols) as f32 * rh, cw, rh))
        .collect()
}

/// Where the two halves of the electronics card go: the figures on the left, the damage bars on the right; a half
/// with nothing to show gives its room to the other.
pub(super) fn electronics_split((x, y, w, h): Area, stats: bool, bars: bool) -> (Area, Area) {
    match (stats, bars) {
        (true, true) => {
            let left = (w * 0.46).floor();
            ((x, y, left, h), (x + left + 14.0, y, w - left - 14.0, h))
        }
        (true, false) => ((x, y, w, h), (x + w, y, 0.0, h)),
        (false, true) => ((x, y, 0.0, h), (x, y, w, h)),
        (false, false) => ((x, y, 0.0, h), (x, y, 0.0, h)),
    }
}

/// A box in design units: `(x, y, width, height)`.
pub(super) type Area = (f32, f32, f32, f32);

/// Where everything of the tyre schematic goes. Tyre order everywhere: front left, front right, rear left, rear right.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Schematic {
    pub(super) tyres: [Area; 4],
    /// Beside each tyre, on its outer side: the temperature and the pressure. Left tyres' text is right-aligned (it
    /// hugs the tyre), right tyres' text left-aligned.
    pub(super) readout: [Area; 4],
    /// The brake temperature: above the front tyres, below the rear ones. Zero height when no brake is shown.
    pub(super) brake: [Area; 4],
    /// The car's silhouette between the tyres.
    pub(super) body: Area,
    /// The size of the big temperature.
    pub(super) temp_size: f32,
}

/// The brake row's height.
pub(super) const BRAKE_ROW: f32 = 18.0;

/// The schematic for a box: the car in the middle, as large as the height allows, the readouts on its two sides.
/// `brakes`: keep a row above and below for the brake temperatures.
pub(super) fn schematic(x: f32, y: f32, w: f32, h: f32, brakes: bool) -> Schematic {
    let brake_h = if brakes { BRAKE_ROW } else { 0.0 };
    let inner_h = (h - 2.0 * brake_h).max(1.0);
    // A tyre is about twice as long as it is wide. Long enough to hold the temperature and the pressure.
    let th = (inner_h * 0.32).clamp(33.0, 80.0).min(inner_h / 2.0 - 4.0).max(8.0);
    let tw = (th * 0.55).clamp(8.0, 42.0);
    // The distance between the two tyres of an axle: wide, but never so wide that the readouts lose their room.
    let (readout_min, pad) = (80.0, 10.0);
    let gap = (th * 1.15)
        .clamp(30.0, 70.0)
        .min((w - 2.0 * tw - 2.0 * (readout_min + pad)).max(14.0));
    let cx = x + w / 2.0;
    let (left_x, right_x) = (cx - gap / 2.0 - tw, cx + gap / 2.0);
    let (front_y, rear_y) = (y + brake_h, y + h - brake_h - th);
    // The temperature and the pressure take about 50 units of height at the biggest; the size follows the tyre.
    let temp_size = ((th - 18.0) / 1.15).clamp(14.0, 30.0);
    let block = temp_size * 1.15 + 16.0;
    // The body reaches a little past the tyres at both ends and as far out as the middle of each tyre.
    let half = gap / 2.0 + tw * 0.5;
    let (body_top, body_bottom) = ((front_y - th * 0.15).max(y), (rear_y + th * 1.15).min(y + h));
    let mut plan = Schematic {
        tyres: [
            (left_x, front_y, tw, th),
            (right_x, front_y, tw, th),
            (left_x, rear_y, tw, th),
            (right_x, rear_y, tw, th),
        ],
        readout: [(0.0, 0.0, 0.0, 0.0); 4],
        brake: [(0.0, 0.0, 0.0, 0.0); 4],
        body: (cx - half, body_top, half * 2.0, body_bottom - body_top),
        temp_size,
    };
    for i in 0..4 {
        let (tx, ty, tw, th) = plan.tyres[i];
        let rh = block;
        let ry = (ty + th / 2.0 - rh / 2.0).max(y);
        plan.readout[i] = if i.is_multiple_of(2) {
            (x, ry, (tx - pad - x).max(0.0), rh)
        } else {
            (tx + tw + pad, ry, (x + w - tx - tw - pad).max(0.0), rh)
        };
        if brakes {
            let by = if i < 2 { y } else { y + h - brake_h };
            plan.brake[i] = (tx + tw / 2.0 - 40.0, by, 80.0, brake_h);
        }
    }
    plan
}

/// The car's outline seen from above, in a box: the half width at each distance from the nose, as a share of the
/// box's half width. Control points `(distance 0..1, half width)`, joined smoothly.
pub(super) const BODY_PROFILE: [(f32, f32); 13] = [
    (0.00, 0.10),
    (0.03, 0.24),
    (0.09, 0.38),
    (0.17, 0.52),
    (0.26, 0.74),
    (0.36, 0.88),
    (0.48, 0.84),
    (0.60, 0.82),
    (0.72, 0.90),
    (0.85, 0.98),
    (0.94, 0.96),
    (0.98, 0.86),
    (1.00, 0.55),
];

/// The silhouette's outline, going down the right side and back up the left, all inside the box.
pub(super) fn body_outline((x, y, w, h): Area) -> Vec<(f32, f32)> {
    let half = w / 2.0;
    let cx = x + half;
    let steps = 48;
    let side: Vec<(f32, f32)> = (0..=steps)
        .map(|k| {
            let t = k as f32 / steps as f32;
            let at = BODY_PROFILE
                .windows(2)
                .find(|p| t <= p[1].0)
                .unwrap_or(&BODY_PROFILE[BODY_PROFILE.len() - 2..]);
            let (a, b) = (at[0], at[1]);
            let u = ((t - a.0) / (b.0 - a.0)).clamp(0.0, 1.0);
            // Eased between the two control points, so the outline has no corners.
            let ease = (1.0 - (u * std::f32::consts::PI).cos()) / 2.0;
            (y + t * h, (a.1 + (b.1 - a.1) * ease) * half)
        })
        .collect();
    side.iter()
        .map(|&(py, hw)| (cx + hw, py))
        .chain(side.iter().rev().map(|&(py, hw)| (cx - hw, py)))
        .collect()
}

/// Buttons of these widths in lines no wider than `room`, 10 apart: each one's line and its left edge in the line.
pub(super) fn button_lines(widths: &[f32], room: f32) -> Vec<(usize, f32)> {
    let mut placed = Vec::with_capacity(widths.len());
    let (mut line, mut x) = (0, 0.0);
    for &w in widths {
        if x > 0.0 && x + w > room {
            line += 1;
            x = 0.0;
        }
        placed.push((line, x));
        x += w + 10.0;
    }
    placed
}

/// The games card in `room` design units of height, for `games` lines: its height, the height of a line (from 52
/// down to 44) and how far the list scrolls (0 when every line fits).
pub(super) fn games_layout(games: usize, room: f32) -> (f32, f32, f32) {
    let games = games.max(1) as f32;
    let (head, foot) = (42.0, 8.0);
    let list = (room - head - foot).max(44.0);
    let row_h = (list / games).clamp(44.0, 52.0);
    let content = row_h * games;
    if content <= list {
        (head + foot + content, row_h, 0.0)
    } else {
        (head + foot + list, row_h, content - list)
    }
}

/// The inside of the window as it opens (pixels), for a screen whose work area is `work_w` x `work_h`: 16:9, about
/// 80% of the work area (1536 x 864 on a 1920 x 1080 screen), never smaller than the smallest window.
pub(super) fn opening_size(work_w: i32, work_h: i32, scale: f32) -> (i32, i32) {
    let (min_w, min_h) = (MIN_WIDTH as f32 * scale, MIN_HEIGHT as f32 * scale);
    let w = (work_w as f32 * 0.8).min(work_h as f32 * 0.85 * 16.0 / 9.0).max(min_w);
    let h = (w * 9.0 / 16.0).max(min_h);
    (w.round() as i32, h.round() as i32)
}
