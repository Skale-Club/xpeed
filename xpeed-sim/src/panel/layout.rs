use super::*;

/// Height of the header, in design pixels.
pub(super) const HEADER_H: f32 = 66.0;

/// The waiting screen is laid out on this canvas (design units), scaled whole to fit the window, so it keeps its
/// proportions at any size.
pub(super) const CANVAS_W: f32 = 1000.0;

pub(super) const CANVAS_H: f32 = 520.0;

/// The waiting screen's narrower canvas, for a tall window (a phone held upright).
pub(super) const PORTRAIT_W: f32 = 600.0;

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

/// A box in design units: `(x, y, width, height)`.
pub(super) type Area = (f32, f32, f32, f32);

/// The cards of the dashboard, each a rounded box of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Pane {
    /// The lap time, the delta to the best lap, the last and the best lap.
    Times,
    /// The gear, the speed, the pedals and the wheel.
    Centre,
    /// The fuel (and the water and oil temperatures).
    Fuel,
    Tyres,
    /// The laps table.
    Laps,
    /// The track map and how far along the lap is.
    Track,
    /// The alerts that are lit, the electronics' settings and the damage.
    Alerts,
}

impl Pane {
    /// The widest a card is drawn: a row of few cards is centred instead of stretching them.
    pub(super) fn max_w(self) -> f32 {
        match self {
            Pane::Times | Pane::Fuel => 480.0,
            Pane::Centre => 580.0,
            Pane::Tyres | Pane::Alerts => 560.0,
            Pane::Track => 700.0,
            Pane::Laps => 1500.0,
        }
    }
}

/// The dashboard's layouts, one per shape of window. Each is a canvas in design units made of rows of cards, scaled whole
/// to fit, so the panel works on an ultrawide screen, a 16:9 or 16:10 one, a 4:3 one and a phone held upright alike. The
/// same cards are in every one; a card the game cannot fill is not there and the others take its room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// A small window: the times, the centre and the fuel on top, the tyres, the track and the alerts under them.
    Classic,
    /// Ultrawide (21:9): five cards in a row, the laps and the track under them.
    Ultrawide,
    /// 16:9 and 16:10: four cards in a row, the laps, the track and the alerts under them.
    Wide,
    /// 4:3 and 5:4: three rows of three cards, the laps across the bottom.
    Square,
    /// A tall window (a phone held upright): everything in one column, a pair of cards where two fit side by side.
    Portrait,
}

/// A row of cards: its height and the cards in it with the share of the row each takes.
pub(super) struct Row {
    pub(super) h: f32,
    pub(super) cards: &'static [(Pane, f32)],
}

const WIDE_ROWS: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.3), (Pane::Fuel, 0.95), (Pane::Tyres, 1.05)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.25), (Pane::Track, 1.0), (Pane::Alerts, 1.05)],
    },
];

const ULTRAWIDE_ROWS: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.2),
            (Pane::Fuel, 1.0),
            (Pane::Tyres, 1.1),
            (Pane::Alerts, 1.0),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.6), (Pane::Track, 1.0)],
    },
];

const SQUARE_ROWS: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Fuel, 1.0)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::Track, 1.0), (Pane::Alerts, 1.0)],
    },
    Row {
        h: 206.0,
        cards: &[(Pane::Laps, 1.0)],
    },
];

const PORTRAIT_ROWS: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 250.0,
        cards: &[(Pane::Fuel, 0.9), (Pane::Tyres, 1.1)],
    },
    Row {
        h: 200.0,
        cards: &[(Pane::Laps, 1.0)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Track, 1.0), (Pane::Alerts, 1.0)],
    },
];

const CLASSIC_ROWS: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Fuel, 1.0)],
    },
    Row {
        h: 230.0,
        cards: &[(Pane::Tyres, 1.3), (Pane::Track, 0.8), (Pane::Alerts, 1.0)],
    },
];

/// The rev bar's height, and the line under it.
pub(super) const REV_H: f32 = 36.0;

/// Where the title (track, car, lap) starts and where the cards do.
pub(super) const TITLE_Y: f32 = 46.0;

pub(super) const CARDS_TOP: f32 = 110.0;

/// The space between two cards.
pub(super) const GAP: f32 = S3;

/// Where the cards of a layout are, in design units, and how big the canvas is.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Plan {
    pub(super) w: f32,
    pub(super) h: f32,
    pub(super) cards: Vec<(Pane, Area)>,
}

#[cfg(test)]
impl Plan {
    pub(super) fn area(&self, card: Pane) -> Option<Area> {
        self.cards.iter().find(|(c, _)| *c == card).map(|(_, a)| *a)
    }
}

/// The places of a row of cards `total` wide: each takes its share, none past its widest; what a card cannot take goes
/// to the others, and when every card is at its widest the row is centred. `(x, width)` for each, from `x0`.
pub(super) fn row_places(x0: f32, total: f32, gap: f32, cards: &[(Pane, f32)], clamp: bool) -> Vec<(f32, f32)> {
    let room = total - gap * (cards.len() as f32 - 1.0);
    let mut width = vec![0.0_f32; cards.len()];
    let mut fixed = vec![false; cards.len()];
    // A card that would be wider than it can be is held at its widest, and the rest shared again.
    for _ in 0..cards.len() {
        let free: f32 = (0..cards.len()).filter(|i| !fixed[*i]).map(|i| cards[i].1).sum();
        let left = room - (0..cards.len()).filter(|i| fixed[*i]).map(|i| width[i]).sum::<f32>();
        if free <= 0.0 {
            break;
        }
        let mut changed = false;
        for i in 0..cards.len() {
            if fixed[i] {
                continue;
            }
            width[i] = left * cards[i].1 / free;
            if clamp && width[i] > cards[i].0.max_w() {
                width[i] = cards[i].0.max_w();
                fixed[i] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let used: f32 = width.iter().sum::<f32>() + gap * (cards.len() as f32 - 1.0);
    let mut at = x0 + ((total - used) / 2.0).max(0.0);
    width
        .into_iter()
        .map(|w| {
            let place = (at, w);
            at += w + gap;
            place
        })
        .collect()
}

impl Layout {
    fn spec(self) -> (f32, &'static [Row]) {
        match self {
            Layout::Classic => (1000.0, CLASSIC_ROWS),
            Layout::Ultrawide => (1900.0, ULTRAWIDE_ROWS),
            Layout::Wide => (1440.0, WIDE_ROWS),
            Layout::Square => (1000.0, SQUARE_ROWS),
            Layout::Portrait => (600.0, PORTRAIT_ROWS),
        }
    }

    /// The cards of this layout that the game can fill, with their places; the canvas is as tall as its rows need.
    pub(super) fn plan(self, slots: &Slots) -> Plan {
        let (w, rows) = self.spec();
        let mut cards = Vec::new();
        let mut y = CARDS_TOP;
        for row in rows {
            let present: Vec<(Pane, f32)> = row.cards.iter().copied().filter(|(c, _)| slots.cards.contains(c)).collect();
            if present.is_empty() {
                continue;
            }
            for ((card, _), (x, cw)) in present.iter().zip(row_places(0.0, w, GAP, &present, w > 1100.0)) {
                cards.push((*card, (x, y, cw, row.h)));
            }
            y += row.h + GAP;
        }
        Plan {
            w,
            h: if cards.is_empty() { y } else { y - GAP },
            cards,
        }
    }

    /// The canvas size.
    pub(super) fn size(self, slots: &Slots) -> (f32, f32) {
        let plan = self.plan(slots);
        (plan.w, plan.h)
    }

    /// The smallest scale at which the layout still reads well.
    pub(super) fn min_scale(self) -> f32 {
        match self {
            Layout::Classic => 0.0,
            Layout::Portrait => 0.5,
            Layout::Square => 0.7,
            Layout::Wide | Layout::Ultrawide => 0.75,
        }
    }
}

/// The scale a canvas of `size` gets in a body of `bw` x `bh`, and how much of the body it fills.
fn fit_of(bw: f32, bh: f32, (w, h): (f32, f32)) -> (f32, f32) {
    let s = (bw / w).min(bh / h);
    (s, s * s * w * h / (bw * bh).max(1.0))
}

/// The layout that fills a body of `bw` x `bh` pixels best while staying readable; between two that fill it about as
/// well, the one that shows more. Classic, the smallest, is for when none of the others reads well.
pub(super) fn pick_layout(bw: f32, bh: f32, slots: &Slots) -> Layout {
    let order = [Layout::Wide, Layout::Ultrawide, Layout::Square, Layout::Portrait];
    let fill = |l: Layout| {
        let (s, f) = fit_of(bw, bh, l.size(slots));
        (s >= l.min_scale()).then_some(f)
    };
    let best = order.iter().filter_map(|&l| fill(l)).fold(f32::NEG_INFINITY, f32::max);
    order
        .into_iter()
        .find(|&l| fill(l).is_some_and(|f| f >= best - 0.03))
        .unwrap_or(Layout::Classic)
}

/// The inside of the window as it opens (pixels), for a screen whose work area is `work_w` x `work_h`: 16:9, about
/// 80% of the work area (1536 x 864 on a 1920 x 1080 screen), never smaller than the smallest window.
pub(super) fn opening_size(work_w: i32, work_h: i32, scale: f32) -> (i32, i32) {
    let (min_w, min_h) = (MIN_WIDTH as f32 * scale, MIN_HEIGHT as f32 * scale);
    let w = (work_w as f32 * 0.8).min(work_h as f32 * 0.85 * 16.0 / 9.0).max(min_w);
    let h = (w * 9.0 / 16.0).max(min_h);
    (w.round() as i32, h.round() as i32)
}

/// How much better another layout must fill the window than the one in use before the dashboard changes to it: a
/// window dragged through a threshold does not flip back and forth.
const LAYOUT_STICKY: f32 = 0.12;
/// The layout in use also keeps its place a little below its usual smallest scale.
const SCALE_SLACK: f32 = 0.06;

/// `pick_layout`, but the layout already in use stays unless another one fills the window clearly better, or the one in
/// use no longer reads at all. Classic is only a fallback: it is left as soon as another layout reads.
pub(super) fn pick_layout_sticky(bw: f32, bh: f32, slots: &Slots, current: Option<Layout>) -> Layout {
    let best = pick_layout(bw, bh, slots);
    let Some(current) = current.filter(|c| *c != best && *c != Layout::Classic) else {
        return best;
    };
    let fill = |l: Layout, slack: f32| {
        let (s, f) = fit_of(bw, bh, l.size(slots));
        (s >= l.min_scale() - slack).then_some(f)
    };
    match (fill(current, SCALE_SLACK), fill(best, 0.0)) {
        (Some(keep), Some(change)) if change < keep + LAYOUT_STICKY => current,
        (Some(_), None) => current,
        _ => best,
    }
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

// The insides of the cards. Each function is the geometry of one card, from the card's box: the views draw at these
// places, and the tests check that nothing of a card leaves it or lies over another part.

/// A card's inner box: its padding taken off all round.
pub(super) fn inner((x, y, w, h): Area) -> Area {
    (x + S3, y + S3, (w - 2.0 * S3).max(1.0), (h - 2.0 * S3).max(1.0))
}

/// The height of a card's caption line, and the space under it.
pub(super) const CAPTION_H: f32 = 16.0;

/// Where the parts of the centre card go: the gear (and the gears either side of it), the speed with its unit, the
/// pedals, and the wheel, from the top down; a part the game cannot fill gives its height to the gear.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Centre {
    pub(super) gear: Area,
    /// Where the gear below and the gear above are drawn (the gear's own height, a narrow box each).
    pub(super) below: Area,
    pub(super) above: Area,
    pub(super) speed: Area,
    pub(super) unit: Area,
    /// A pedal: the line over its bar (its name and its percentage) and the bar.
    pub(super) pedals: [Option<(Area, Area)>; 3],
    pub(super) steer: Area,
}

pub(super) const PEDAL_LINE_H: f32 = 16.0;
pub(super) const PEDAL_BAR_H: f32 = 8.0;
pub(super) const STEER_BAR_H: f32 = 6.0;

pub(super) fn centre_plan(card: Area, slots: &Slots) -> Centre {
    let (x, y, w, h) = inner(card);
    let pedal_count = [slots.brake, slots.throttle, slots.clutch].iter().filter(|p| **p).count();
    // The heights of what is under the gear, from the bottom up.
    let steer_h = if slots.steer { STEER_BAR_H + S3 } else { 0.0 };
    let pedals_h = if pedal_count > 0 {
        PEDAL_LINE_H + S1 + PEDAL_BAR_H + S3
    } else {
        0.0
    };
    let speed_h = if slots.speed { 44.0 + 4.0 + 14.0 + S2 } else { 0.0 };
    let gear_h = if slots.gear {
        (h - steer_h - pedals_h - speed_h).clamp(40.0, 170.0)
    } else {
        0.0
    };
    // Anything the gear cannot use is left over; the block under it is pushed to the bottom so the card has no hole.
    let used = gear_h + speed_h + pedals_h + steer_h;
    let top = y + ((h - used) / 2.0).max(0.0);
    let gear = (x, top, w, gear_h);
    let side = (w * 0.3).min(120.0);
    let nb = (40.0_f32, 36.0_f32);
    let cx = x + w / 2.0;
    let mid = top + gear_h / 2.0 - nb.1 / 2.0;
    let below = (cx - side - nb.0 / 2.0, mid, nb.0, nb.1);
    let above = (cx + side - nb.0 / 2.0, mid, nb.0, nb.1);
    let speed_y = top + gear_h + S1;
    let speed = (x, speed_y, w, 44.0);
    let unit = (x, speed_y + 44.0, w, 14.0);
    let pedals_y = top + gear_h + speed_h;
    let mut pedals = [None; 3];
    if pedal_count > 0 {
        let gap = S3;
        let col = (w - gap * (pedal_count as f32 - 1.0)) / pedal_count as f32;
        let mut at = x;
        for (i, on) in [slots.brake, slots.throttle, slots.clutch].into_iter().enumerate() {
            if on {
                pedals[i] = Some((
                    (at, pedals_y, col, PEDAL_LINE_H),
                    (at, pedals_y + PEDAL_LINE_H + S1, col, PEDAL_BAR_H),
                ));
                at += col + gap;
            }
        }
    }
    let steer = (x, pedals_y + pedals_h, w, STEER_BAR_H);
    Centre {
        gear,
        below,
        above,
        speed,
        unit,
        pedals,
        steer,
    }
}

/// The four tyre tiles of a tyres card: two by two (front left, front right, rear left, rear right), under the caption.
/// A card much wider than it is tall puts them in one row.
pub(super) fn tyre_tiles(card: Area) -> [Area; 4] {
    let (x, y, w, h) = inner(card);
    let (top, h) = (y + CAPTION_H + S2, (h - CAPTION_H - S2).max(1.0));
    if w > h * 2.6 {
        let tile = (w - 3.0 * S2) / 4.0;
        std::array::from_fn(|i| (x + i as f32 * (tile + S2), top, tile, h))
    } else {
        let (tw, th) = ((w - S2) / 2.0, (h - S2) / 2.0);
        std::array::from_fn(|i| (x + (i % 2) as f32 * (tw + S2), top + (i / 2) as f32 * (th + S2), tw, th))
    }
}

/// The row of a laps table's column: where each column's text goes. The lap number, the time and the gap come first, then
/// the three sectors when the game gives them; the times take what the numbers do not.
pub(super) fn lap_columns(width: f32, sectors: bool) -> Vec<(f32, f32)> {
    let weights: &[f32] = if sectors {
        &[0.7, 1.35, 1.15, 1.0, 1.0, 1.0]
    } else {
        &[0.7, 1.35, 1.15]
    };
    let total: f32 = weights.iter().sum();
    let mut at = 0.0;
    weights
        .iter()
        .map(|w| {
            let cw = width * w / total;
            let col = (at, cw);
            at += cw;
            col
        })
        .collect()
}

/// The height of a laps table's head row and of each row.
pub(super) const LAP_HEAD_H: f32 = 22.0;
pub(super) const LAP_ROW_H: f32 = 26.0;

/// How many rows of the laps table fit in a card of height `h`.
pub(super) fn lap_rows_fit(h: f32) -> usize {
    let (_, _, _, ih) = inner((0.0, 0.0, 100.0, h));
    (((ih - CAPTION_H - S2 - LAP_HEAD_H) / LAP_ROW_H).floor().max(0.0)) as usize
}

/// The places of tiles flowing left to right in lines inside `area`: each of the `widths` is `h` tall with `gap` between;
/// a tile that does not fit on the line goes to the next, and a tile wider than the area is cut to it. Tiles that do not
/// fit in the height are left out (`None`).
pub(super) fn flow(area: Area, widths: &[f32], h: f32, gap: f32) -> Vec<Option<Area>> {
    let (x, y, w, ah) = area;
    let (mut at, mut line) = (0.0_f32, 0_usize);
    widths
        .iter()
        .map(|tw| {
            let tw = tw.min(w);
            if at > 0.0 && at + tw > w {
                line += 1;
                at = 0.0;
            }
            let top = y + line as f32 * (h + gap);
            let place = (top + h <= y + ah + 0.01).then_some((x + at, top, tw, h));
            at += tw + gap;
            place
        })
        .collect()
}

/// Which places the dashboard has, from what the game can give (`Live::caps`): the layout is chosen from these and the
/// window's size, so a value that appears or goes away never moves anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Slots {
    pub(super) rev: bool,
    pub(super) gear: bool,
    pub(super) speed: bool,
    pub(super) brake: bool,
    pub(super) throttle: bool,
    pub(super) clutch: bool,
    pub(super) steer: bool,
    pub(super) lap_time: bool,
    pub(super) last: bool,
    pub(super) best: bool,
    pub(super) delta: bool,
    pub(super) fuel: bool,
    pub(super) progress: bool,
    pub(super) map: bool,
    pub(super) tyres: bool,
    pub(super) water: bool,
    pub(super) oil: bool,
    /// The game gives the sector times: the laps table has S1, S2 and S3.
    pub(super) sectors: bool,
    /// The cards the game can fill, in the order the layouts place them.
    pub(super) cards: Vec<Pane>,
}

pub(super) fn slots(caps: crate::game::Caps) -> Slots {
    use crate::game::Caps;
    let all = |set: &[Caps]| set.iter().all(|c| caps.has(*c));
    let any = |set: &[Caps]| set.iter().any(|c| caps.has(*c));
    // The distance into the lap is the game's own, else the speed added up: a record by lap needs one of them.
    let along = any(&[Caps::DIST, Caps::SPEED]);
    let s = Slots {
        rev: caps.has(Caps::RPM),
        gear: caps.has(Caps::GEAR),
        speed: caps.has(Caps::SPEED),
        brake: caps.has(Caps::BRAKE),
        throttle: caps.has(Caps::THROTTLE),
        clutch: caps.has(Caps::CLUTCH),
        steer: caps.has(Caps::STEER),
        lap_time: caps.has(Caps::LAP_TIME),
        last: caps.has(Caps::LAST_LAP),
        best: caps.has(Caps::LAST_LAP) && along,
        delta: all(&[Caps::LAP_TIME]) && along,
        fuel: caps.has(Caps::FUEL),
        progress: caps.has(Caps::TRACK_LENGTH) && along,
        map: caps.has(Caps::POSITION),
        tyres: any(&[
            Caps::TYRE_TEMP,
            Caps::TYRE_PRESSURE,
            Caps::TYRE_WEAR,
            Caps::BRAKE_TEMP,
            Caps::TYRE_TREAD,
        ]),
        water: caps.has(Caps::WATER_TEMP),
        oil: caps.has(Caps::OIL_TEMP),
        sectors: caps.has(Caps::SECTORS),
        cards: Vec::new(),
    };
    let alerts = any(&[
        Caps::PIT_LIMITER,
        Caps::ABS_ACTIVE,
        Caps::TC_ACTIVE,
        Caps::DRS,
        Caps::HEADLIGHTS,
        Caps::ENGINE_WARNING,
        Caps::HANDBRAKE,
        Caps::FLAG,
        Caps::FUEL,
        Caps::TC_LEVEL,
        Caps::ABS_LEVEL,
        Caps::ENGINE_MAP,
        Caps::BRAKE_BIAS,
        Caps::DAMAGE_BODY,
        Caps::DAMAGE_ENGINE,
        Caps::DAMAGE_GEARBOX,
        Caps::DAMAGE_SUSPENSION,
    ]);
    let cards: Vec<Pane> = [
        (Pane::Times, s.lap_time || s.last || s.best),
        (Pane::Centre, s.gear || s.speed || s.brake || s.throttle || s.clutch || s.steer),
        (Pane::Fuel, s.fuel || s.water || s.oil),
        (Pane::Tyres, s.tyres),
        (Pane::Laps, s.lap_time || s.last),
        (Pane::Track, s.map || s.progress),
        (Pane::Alerts, alerts),
    ]
    .into_iter()
    .filter(|(_, on)| *on)
    .map(|(card, _)| card)
    .collect();
    Slots { cards, ..s }
}
