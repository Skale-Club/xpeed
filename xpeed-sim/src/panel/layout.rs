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

/// Width of the sidebar down the window's left edge (design pixels), the site's collapsed menu (`--sidebar-width-icon`, 3rem):
/// the panel's screens and the site's places as small icon buttons (`nav`), each named by a tooltip while the mouse is on it.
pub(super) const SIDEBAR_W: f32 = 48.0;

/// The side of a sidebar button (design pixels).
pub(super) const SIDEBAR_BUTTON: f32 = 32.0;

/// Where the header and the screens start (pixels): right of the sidebar.
pub(super) fn content_left(scale: f32) -> i32 {
    (SIDEBAR_W * scale).round() as i32
}

/// The places of the window's frame that can be clicked: the two screens (icon buttons down the sidebar, `sidebar_layout`), then
/// "full screen" and "always on top" (square icon buttons at the header's right). The language and the version live on the
/// Settings screen.
pub(super) fn header_hits(width: i32, scale: f32) -> [RECT; 4] {
    let p = |v: f32| (v * scale).round() as i32;
    let (top, bottom) = (p(13.0), p(51.0));
    let right = width - p(16.0);
    let (side, gap) = (p(38.0), p(8.0));
    let nth = |n: i32| rect(right - side - n * (side + gap), top, right - n * (side + gap), bottom);
    [screen_hit(Tab::Dash, scale), screen_hit(Tab::Monitor, scale), nth(1), nth(0)]
}

/// The sidebar button of one of the panel's screens (pixels).
pub(super) fn screen_hit(tab: Tab, scale: f32) -> RECT {
    sidebar_layout(scale)
        .buttons
        .into_iter()
        .find(|(item, _)| *item == SideItem::Screen(tab))
        .map_or(rect(0, 0, 0, 0), |(_, r)| r)
}

/// Where the header's "Edit layout" button sits (pixels): a square button left of the full screen button, when the window is
/// wide enough to have it beside the dashboard's name.
pub(super) fn edit_button_hit(width: i32, scale: f32) -> Option<RECT> {
    let p = |v: f32| (v * scale).round() as i32;
    let [_, _, full, _] = header_hits(width, scale);
    let (side, gap) = (p(38.0), p(8.0));
    (width as f32 / scale >= EDIT_BUTTON_MIN_W).then(|| rect(full.left - gap - side, full.top, full.left - gap, full.bottom))
}

/// The left edge of the header's right-hand buttons (pixels): what the pills keep clear of.
fn header_edge(width: i32, scale: f32) -> i32 {
    let [_, _, full, _] = header_hits(width, scale);
    edit_button_hit(width, scale).map_or(full.left, |edit| edit.left)
}

/// Where the dashboard's name sits in the header (pixels): at its left, after the sidebar, when the window leaves room before
/// the header's buttons.
pub(super) fn dashboard_hit(width: i32, scale: f32) -> Option<RECT> {
    let p = |v: f32| (v * scale).round() as i32;
    let left = content_left(scale) + p(S4);
    (header_limit(width, scale) - left >= p(150.0)).then(|| rect(left, p(17.0), left + p(150.0), p(47.0)))
}

/// How far right the header's pills may reach (pixels): a little before the header's buttons.
fn header_limit(width: i32, scale: f32) -> i32 {
    header_edge(width, scale) - (14.0 * scale).round() as i32
}

/// Where the "Phone" mark sits in the header (pixels): after the dashboard's name, when the window leaves room for both.
pub(super) fn phone_hit(width: i32, scale: f32) -> Option<RECT> {
    let p = |v: f32| (v * scale).round() as i32;
    let name = dashboard_hit(width, scale)?;
    let left = name.right + p(8.0);
    (header_limit(width, scale) - left >= p(84.0)).then(|| rect(left, name.top, left + p(84.0), name.bottom))
}

/// Where the example's pill sits in the header (pixels): after the dashboard's name (in the phone mark's place, which the
/// example never shows), `want` design units wide or as much of it as the header leaves, and never narrower than 110.
pub(super) fn preview_hit(width: i32, scale: f32, want: f32) -> Option<RECT> {
    let p = |v: f32| (v * scale).round() as i32;
    let left = dashboard_hit(width, scale).map_or(content_left(scale) + p(S4), |name| name.right + p(8.0));
    let w = p(want).min(header_limit(width, scale) - left);
    (w >= p(110.0)).then(|| rect(left, p(17.0), left + w, p(47.0)))
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
    /// The gear, the speed and the wheel, with this lap's top and lowest speed.
    Centre,
    /// The pedals and the last seconds of them (owner-approved 2026-11-19): the old centre card's place is shared by the
    /// two, the centre the wider.
    Inputs,
    /// The fuel (and the water and oil temperatures).
    Fuel,
    Tyres,
    /// The laps table.
    Laps,
    /// The track map and how far along the lap is.
    Track,
    /// The alerts that are lit, the electronics' settings and the damage.
    Alerts,
    /// The digiflag: the flag the game shows as a block of its colour.
    Flag,
    /// The fuel strategy: the use per lap, the laps left and what a number of laps needs.
    FuelCalc,
    /// The tyre wear per lap and the laps left on each tyre.
    TyreTrend,
    /// The sector times against the best ones, and the theoretical best lap.
    Sectors,
    /// The delta to the best lap as a wide bar.
    DeltaBar,
    /// The place in the race and the class, and what is left of the session (time, or laps).
    Session,
    /// The cars ahead of and behind the player on the track, with the time to each.
    Relative,
    /// The player's class: the leader and the cars around the player, with the gap to the leader and the last lap.
    Standings,
    /// The car one place ahead and the one behind, with the gap to each and whether it is closing or opening.
    Gaps,
    /// The cars alongside and close, seen from above (the other cars' positions), or the game's own left and right signal.
    Radar,
    /// The delta to the reference lap from the Xpeed server (the board's best, and the person's own when it differs).
    DeltaRef,
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
    /// A narrow tall window with few cards (a phone held upright, a game that gives little): one column at the size text
    /// is read at, never the two columns of `Portrait` scaled down.
    Stack,
}

/// A row of cards: its height and the cards in it with the share of the row each takes.
pub(super) struct Row {
    pub(super) h: f32,
    pub(super) cards: &'static [(Pane, f32)],
}

const WIDE_ROWS: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 0.74),
            (Pane::Inputs, 0.56),
            (Pane::Fuel, 0.8),
            (Pane::Tyres, 1.2),
        ],
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
            (Pane::Centre, 0.68),
            (Pane::Inputs, 0.52),
            (Pane::Fuel, 0.85),
            (Pane::Tyres, 1.25),
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
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 0.68), (Pane::Inputs, 0.52), (Pane::Fuel, 1.0)],
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
        cards: &[(Pane::Centre, 0.57), (Pane::Inputs, 0.43)],
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

/// One column for a phone held upright: with the few cards a game gives (times, centre, inputs, laps) it stays under about
/// 915 design units, so a 390 x 844 phone shows it at a scale where the smallest text is still 10 px. The inputs card is
/// short here (no trace, `INPUTS_TRACE_MIN_H`) and the laps table keeps two rows; the gear's card keeps its height.
const STACK_ROWS: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 142.0,
        cards: &[(Pane::Inputs, 1.0)],
    },
    Row {
        h: 190.0,
        cards: &[(Pane::Fuel, 1.0)],
    },
    Row {
        h: 270.0,
        cards: &[(Pane::Tyres, 1.0)],
    },
    Row {
        h: 124.0,
        cards: &[(Pane::Laps, 1.0)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Track, 1.0)],
    },
    Row {
        h: 240.0,
        cards: &[(Pane::Alerts, 1.0)],
    },
];

const CLASSIC_ROWS: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 0.68), (Pane::Inputs, 0.52), (Pane::Fuel, 1.0)],
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

impl Plan {
    pub(super) fn area(&self, card: Pane) -> Option<Area> {
        self.cards.iter().find(|(c, _)| *c == card).map(|(_, a)| *a)
    }
}

/// The places of a row of cards `total` wide: the cards always share the whole width, each in proportion to its share
/// (a row with few cards makes them bigger, it never leaves empty margins at the sides). `(x, width)` for each, from `x0`.
pub(super) fn row_places(x0: f32, total: f32, gap: f32, cards: &[(Pane, f32)]) -> Vec<(f32, f32)> {
    let room = (total - gap * (cards.len() as f32 - 1.0)).max(0.0);
    let shares: f32 = cards.iter().map(|c| c.1).sum::<f32>().max(0.001);
    let mut at = x0;
    cards
        .iter()
        .map(|(_, share)| {
            let w = room * share / shares;
            let place = (at, w);
            at += w + gap;
            place
        })
        .collect()
}

/// What a card at least needs of its row's height (design units): the laps table takes the rows it has (its caption, its
/// head and `lap_rows` rows), the track map and the alerts a floor of their own; the other cards hold the row's height.
pub(super) fn need_h(card: Pane, lap_rows: usize, row_h: f32) -> f32 {
    match card {
        Pane::Laps => laps_card_h(lap_rows.min(lap_rows_fit(row_h)).max(1)).min(row_h),
        Pane::Track => TRACK_NEED_H.min(row_h),
        Pane::Alerts => ALERTS_NEED_H.min(row_h),
        Pane::Flag => FLAG_NEED_H.min(row_h),
        Pane::FuelCalc => FUEL_CALC_NEED_H.min(row_h),
        Pane::TyreTrend => TYRE_TREND_NEED_H.min(row_h),
        Pane::Sectors => SECTORS_NEED_H.min(row_h),
        Pane::DeltaBar => DELTA_NEED_H.min(row_h),
        Pane::Session => SESSION_NEED_H.min(row_h),
        Pane::Relative => RELATIVE_NEED_H.min(row_h),
        Pane::Standings => STANDINGS_NEED_H.min(row_h),
        Pane::Gaps => GAPS_NEED_H.min(row_h),
        Pane::Radar => RADAR_NEED_H.min(row_h),
        Pane::DeltaRef => DELTA_REF_NEED_H.min(row_h),
        _ => row_h,
    }
}

/// The least height of the track card (the caption, a map and the line under it) and of the alerts card (the caption, two
/// lines of alerts, the electronics' row and the damage line).
pub(super) const TRACK_NEED_H: f32 = 210.0;
pub(super) const ALERTS_NEED_H: f32 = 232.0;

/// The least height of the cards of the catalog's later widgets: the flag (a block with its word), the fuel strategy (the
/// caption, three figures, a table of four rows and a note), the tyre wear (the caption, the heads and four rows), the
/// sectors (three rows and the theoretical best) and the delta (the number and its bar).
pub(super) const FLAG_NEED_H: f32 = 110.0;
pub(super) const FUEL_CALC_NEED_H: f32 = 256.0;
pub(super) const TYRE_TREND_NEED_H: f32 = 212.0;
pub(super) const SECTORS_NEED_H: f32 = 228.0;
pub(super) const DELTA_NEED_H: f32 = 130.0;
/// The session card: the caption, the place (big), the class line and the time (or laps) left.
pub(super) const SESSION_NEED_H: f32 = 168.0;
/// The rivals cards: the caption and seven rows of the relative card (three cars either side of the player), the caption,
/// the heads and six rows of the standings, and the caption and the two sides of the gaps card.
pub(super) const RELATIVE_NEED_H: f32 = 244.0;
pub(super) const STANDINGS_NEED_H: f32 = 242.0;
pub(super) const GAPS_NEED_H: f32 = 200.0;
/// The radar card: the caption and a box tall enough for the car and the cars close to it.
pub(super) const RADAR_NEED_H: f32 = 200.0;
/// The reference card: the caption, the delta in big figures and two lines under it.
pub(super) const DELTA_REF_NEED_H: f32 = 150.0;

/// The height of a laps card with `rows` rows: its padding, caption, head and the rows.
pub(super) fn laps_card_h(rows: usize) -> f32 {
    2.0 * S3 + CAPTION_H + S2 + LAP_HEAD_H + rows as f32 * LAP_ROW_H + S1
}

/// The heights of the rows (those the game can fill, in order) from what each needs: a row never grows past its own
/// height by itself; the height a row does not need goes to the nearest row above it that needs all of its own (else the
/// nearest below), so the canvas keeps its height and the cards that stay get bigger.
pub(super) fn row_heights(rows: &[(f32, Vec<Pane>)], lap_rows: usize) -> Vec<f32> {
    let full: Vec<f32> = rows.iter().map(|r| r.0).collect();
    let need: Vec<f32> = rows
        .iter()
        .map(|(h, cards)| cards.iter().map(|c| need_h(*c, lap_rows, *h)).fold(0.0_f32, f32::max).min(*h))
        .collect();
    let mut out = full.clone();
    let holds = |i: usize| need[i] >= full[i] - 0.01;
    for i in 0..rows.len() {
        let spare = full[i] - need[i];
        if holds(i) || spare <= 0.0 {
            continue;
        }
        let target = (0..i).rev().find(|j| holds(*j)).or_else(|| (i + 1..rows.len()).find(|j| holds(*j)));
        if let Some(j) = target {
            out[i] -= spare;
            out[j] += spare;
        }
    }
    out
}

impl Layout {
    /// The canvas width in design units.
    pub(super) fn width(self) -> f32 {
        match self {
            Layout::Classic | Layout::Square => 1000.0,
            Layout::Ultrawide => 1900.0,
            Layout::Wide => 1440.0,
            Layout::Portrait => 600.0,
            Layout::Stack => 400.0,
        }
    }

    /// The rows the built-in dashboards share for now.
    pub(super) fn default_rows(self) -> &'static [Row] {
        match self {
            Layout::Classic => CLASSIC_ROWS,
            Layout::Ultrawide => ULTRAWIDE_ROWS,
            Layout::Wide => WIDE_ROWS,
            Layout::Square => SQUARE_ROWS,
            Layout::Portrait => PORTRAIT_ROWS,
            Layout::Stack => STACK_ROWS,
        }
    }

    /// The cards of this layout that the game can fill, with their places, as they are when the laps table is full; the
    /// canvas is as tall as its rows need.
    #[cfg(test)]
    pub(super) fn plan(self, slots: &Slots) -> Plan {
        self.plan_for(slots, usize::MAX)
    }

    /// The same with `lap_rows` rows in the laps table: the table's row takes only the height it needs and the row above
    /// it takes the rest, so the canvas keeps its size and a few laps never leave a tall, empty card.
    #[cfg(test)]
    pub(super) fn plan_for(self, slots: &Slots, lap_rows: usize) -> Plan {
        self.plan_in(DashboardId::Practice, slots, lap_rows)
    }

    /// `plan_for` for a dashboard: its built-in rows, with the cards the game cannot fill left out.
    #[cfg(test)]
    pub(super) fn plan_in(self, dashboard: DashboardId, slots: &Slots, lap_rows: usize) -> Plan {
        self.plan_with(&Views::default(), dashboard, slots, lap_rows)
    }

    /// `plan_in` for the view the driver saved for the dashboard in this layout, else its built-in rows.
    pub(super) fn plan_with(self, views: &Views, dashboard: DashboardId, slots: &Slots, lap_rows: usize) -> Plan {
        self.plan_view(&views.rows_for(dashboard, self), slots, lap_rows)
    }

    /// The places of the cards of a view (saved or built in alike), with the cards the game cannot fill left out.
    pub(super) fn plan_view(self, view: &SavedView, slots: &Slots, lap_rows: usize) -> Plan {
        let w = self.width();
        let present: Vec<(f32, Vec<(Pane, f32)>)> = view
            .rows
            .iter()
            .map(|row| {
                (
                    row.h,
                    row.cards
                        .iter()
                        .copied()
                        .filter(|(c, _)| slots.cards.contains(c))
                        .collect::<Vec<_>>(),
                )
            })
            .filter(|(_, cards)| !cards.is_empty())
            .collect();
        let heights = row_heights(
            &present
                .iter()
                .map(|(h, c)| (*h, c.iter().map(|c| c.0).collect()))
                .collect::<Vec<_>>(),
            lap_rows,
        );
        let mut cards = Vec::new();
        let mut y = CARDS_TOP;
        for ((_, row_cards), h) in present.iter().zip(heights) {
            for ((card, _), (x, cw)) in row_cards.iter().zip(row_places(0.0, w, GAP, row_cards)) {
                cards.push((*card, (x, y, cw, h)));
            }
            y += h + GAP;
        }
        Plan {
            w,
            h: if cards.is_empty() { y } else { y - GAP },
            cards,
        }
    }

    /// The canvas size of the Practice dashboard.
    #[cfg(test)]
    pub(super) fn size(self, slots: &Slots) -> (f32, f32) {
        self.size_in(DashboardId::Practice, slots)
    }

    /// The canvas size of a dashboard (built-in rows).
    #[cfg(test)]
    pub(super) fn size_in(self, dashboard: DashboardId, slots: &Slots) -> (f32, f32) {
        self.size_with(&Views::default(), dashboard, slots)
    }

    /// The canvas size of a dashboard, with the driver's saved views.
    pub(super) fn size_with(self, views: &Views, dashboard: DashboardId, slots: &Slots) -> (f32, f32) {
        let plan = self.plan_with(views, dashboard, slots, usize::MAX);
        (plan.w, plan.h)
    }

    /// The smallest scale at which the layout still reads well.
    pub(super) fn min_scale(self) -> f32 {
        match self {
            Layout::Classic => 0.0,
            Layout::Portrait => 0.5,
            Layout::Stack => 0.83,
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
/// well, the one that shows more. Classic, the smallest, is for when none of the others reads well. `dashboard` is the
/// one on screen: each has its own rows, so its own canvas.
#[cfg(test)]
pub(super) fn pick_layout_in(dashboard: DashboardId, bw: f32, bh: f32, slots: &Slots) -> Layout {
    pick_layout_with(&Views::default(), dashboard, bw, bh, slots)
}

/// `pick_layout_in` with the driver's saved views (they change the canvas, so the shape that fits).
pub(super) fn pick_layout_with(views: &Views, dashboard: DashboardId, bw: f32, bh: f32, slots: &Slots) -> Layout {
    let order = [Layout::Wide, Layout::Ultrawide, Layout::Square, Layout::Portrait, Layout::Stack];
    let fill = |l: Layout| {
        let (s, f) = fit_of(bw, bh, l.size_with(views, dashboard, slots));
        (s >= l.min_scale()).then_some(f)
    };
    let best = order.iter().filter_map(|&l| fill(l)).fold(f32::NEG_INFINITY, f32::max);
    order
        .into_iter()
        .find(|&l| fill(l).is_some_and(|f| f >= best - 0.03))
        .unwrap_or(Layout::Classic)
}

/// The views that give Practice the base rows (`Layout::default_rows`) in every shape, as it had them before its wide shapes got
/// one more row: the tests of the layout's own rules (which shape fits which window) run on these.
#[cfg(test)]
pub(super) fn base_views() -> Views {
    let mut views = Views::default();
    for (layout, _) in LAYOUT_KEYS {
        views.set(DashboardId::Practice, layout, SavedView::from_rows(layout.default_rows()));
    }
    views
}

/// `pick_layout_in` for the Practice dashboard.
#[cfg(test)]
pub(super) fn pick_layout(bw: f32, bh: f32, slots: &Slots) -> Layout {
    pick_layout_in(DashboardId::Practice, bw, bh, slots)
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
#[cfg(test)]
pub(super) fn pick_layout_sticky(dashboard: DashboardId, bw: f32, bh: f32, slots: &Slots, current: Option<Layout>) -> Layout {
    pick_layout_sticky_with(&Views::default(), dashboard, bw, bh, slots, current)
}

/// `pick_layout_sticky` with the driver's saved views.
pub(super) fn pick_layout_sticky_with(
    views: &Views,
    dashboard: DashboardId,
    bw: f32,
    bh: f32,
    slots: &Slots,
    current: Option<Layout>,
) -> Layout {
    let best = pick_layout_with(views, dashboard, bw, bh, slots);
    let Some(current) = current.filter(|c| *c != best && *c != Layout::Classic) else {
        return best;
    };
    let fill = |l: Layout, slack: f32| {
        let (s, f) = fit_of(bw, bh, l.size_with(views, dashboard, slots));
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

/// Where the parts of the centre card go (owner-approved 2026-11-19): this lap's top and lowest speed as two small labels
/// in the top corners, the gear (the biggest thing on the dashboard: it takes all the height the rest leaves, up to
/// `GEAR_MAX_H`), the speed with its unit, and the wheel's line at the bottom. A part the game cannot fill gives its
/// height to the gear; the gears either side sit at the card's edges, clear of the gear.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Centre {
    pub(super) gear: Area,
    /// Where the gear below and the gear above are drawn (a narrow box each, at the card's left and right edges).
    pub(super) below: Area,
    pub(super) above: Area,
    pub(super) speed: Area,
    pub(super) unit: Area,
    pub(super) steer: Area,
    /// The line of TOP (left) and MIN (right), when the game gives the speed.
    pub(super) corners: Option<Area>,
}

/// The tallest the gear is drawn: a tall centre card gives its spare height to the gear until here.
pub(super) const GEAR_MAX_H: f32 = 230.0;

pub(super) const PEDAL_LINE_H: f32 = 16.0;
pub(super) const STEER_BAR_H: f32 = 6.0;

pub(super) fn centre_plan(card: Area, slots: &Slots) -> Centre {
    let (x, y, w, h) = inner(card);
    let corners_h = if slots.speed { CAPTION_H + S2 } else { 0.0 };
    let speed_h = if slots.speed { S1 + 44.0 + 4.0 + 14.0 } else { 0.0 };
    let steer_h = if slots.steer { S4 + STEER_BAR_H } else { 0.0 };
    let room = h - corners_h;
    let gear_h = if slots.gear {
        (room - speed_h - steer_h).clamp(40.0, GEAR_MAX_H)
    } else {
        0.0
    };
    // The corners stay at the top; the gear, the speed and the wheel are one group centred in the rest.
    let used = gear_h + speed_h + steer_h;
    let top = y + corners_h + ((room - used) / 2.0).max(0.0);
    let corners = (corners_h > 0.0).then_some((x, y, w, CAPTION_H));
    let gear = (x, top, w, gear_h);
    let nb = (40.0_f32, 36.0_f32);
    let mid = top + gear_h / 2.0 - nb.1 / 2.0;
    let below = (x, mid, nb.0, nb.1);
    let above = (x + w - nb.0, mid, nb.0, nb.1);
    let speed_y = top + gear_h + S1;
    let speed = (x, speed_y, w, 44.0);
    let unit = (x, speed_y + 44.0, w, 14.0);
    let steer = (x, top + gear_h + speed_h + S4, w, STEER_BAR_H);
    Centre {
        gear,
        below,
        above,
        speed,
        unit,
        steer,
        corners,
    }
}

/// Where the parts of the inputs card go (owner-approved 2026-11-19): its caption line (the aids it marks on the right),
/// the last seconds of throttle and brake, the pedals as vertical bars of blocks (each with its percentage over it and its
/// name under it), and one line of this lap's time flat out, braking and on neither pedal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct InputsPlan {
    pub(super) head: Area,
    pub(super) trace: Option<Area>,
    /// Throttle, brake, clutch: the percentage line, the bar, the name line.
    pub(super) pedals: [Option<(Area, Area, Area)>; 3],
    pub(super) lap: Area,
}

/// The least inside height at which the inputs card draws the trace of the last seconds: under it the pedals keep the room.
pub(super) const INPUTS_TRACE_MIN_H: f32 = 140.0;

pub(super) fn inputs_plan(card: Area, slots: &Slots) -> InputsPlan {
    let (x, y, w, h) = inner(card);
    let head = (x, y, w, CAPTION_H);
    let lap = (x, y + h - INPUT_LAP_H, w, INPUT_LAP_H);
    let top = y + CAPTION_H + S2;
    let trace_on = (slots.throttle || slots.brake) && h >= INPUTS_TRACE_MIN_H;
    let trace_h = if trace_on {
        ((h - CAPTION_H) * INPUT_TRACE_SHARE).clamp(28.0, 110.0)
    } else {
        0.0
    };
    let trace = trace_on.then_some((x, top, w, trace_h));
    let bars_top = top + if trace_on { trace_h + S3 } else { 0.0 };
    let bars_bottom = lap.1 - S3;
    let on = [slots.throttle, slots.brake, slots.clutch];
    let count = on.iter().filter(|p| **p).count();
    let mut pedals = [None; 3];
    if count > 0 {
        let col = (w - S3 * (count as f32 - 1.0)) / count as f32;
        let bar_h = (bars_bottom - bars_top - PEDAL_LINE_H - 14.0 - 2.0 * S1).max(8.0);
        let bar_w = (col * INPUT_BAR_WIDTH).min(64.0);
        let mut at = x;
        for (i, present) in on.into_iter().enumerate() {
            if present {
                let pct = (at, bars_top, col, PEDAL_LINE_H);
                let bar = (at + (col - bar_w) / 2.0, bars_top + PEDAL_LINE_H + S1, bar_w, bar_h);
                let name = (at, bar.1 + bar_h + S1, col, 14.0);
                pedals[i] = Some((pct, bar, name));
                at += col + S3;
            }
        }
    }
    InputsPlan { head, trace, pedals, lap }
}

/// Where blocks of `heights` go, top to bottom, in a room `room_h` tall from `room_y`: grouped with an even gap between them
/// (the room's spare height shared out, but never under `min_gap` or over `max_gap`) and the group centred, so a tall card
/// has an equal margin above and under its content and never a hole inside it. The top of each block.
pub(super) fn stack(room_y: f32, room_h: f32, heights: &[f32], min_gap: f32, max_gap: f32) -> Vec<f32> {
    let n = heights.len();
    let sum: f32 = heights.iter().sum();
    let gap = if n > 1 {
        ((room_h - sum) / (n as f32 + 1.0)).clamp(min_gap, max_gap)
    } else {
        0.0
    };
    let total = sum + gap * (n.max(1) as f32 - 1.0);
    let mut at = room_y + ((room_h - total) / 2.0).max(0.0);
    heights
        .iter()
        .map(|h| {
            let top = at;
            at += h + gap;
            top
        })
        .collect()
}

/// Where the parts of the times card go: the lap time, the delta with its bar, and the last and best lap with the line
/// over them. They are stacked (`stack`) under the caption; a tall card gets bigger figures instead of a gap.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct TimesPlan {
    /// The figures are the big step of the type scale.
    pub(super) big: bool,
    pub(super) lap: Area,
    pub(super) delta: Area,
    pub(super) bar: Area,
    /// The projected lap and, under it, the delta along the lap (owner-approved module 5): only with room for it.
    pub(super) trace: Option<Area>,
    /// The line over the last and the best lap, and where they are (caption and figure together).
    pub(super) rule: Option<Area>,
    pub(super) records: Area,
}

/// A times card whose inside is this tall (or taller) uses the big figures.
pub(super) const TIMES_BIG_H: f32 = 340.0;

pub(super) fn times_plan(card: Area, slots: &Slots) -> TimesPlan {
    let (x, y, w, h) = inner(card);
    let big = h >= TIMES_BIG_H;
    let hero_h = if big { 84.0 } else { 60.0 };
    let delta_h = if big { 44.0 } else { 34.0 };
    let value_h = if big { 44.0 } else { 32.0 };
    let has_delta = slots.delta;
    let has_records = slots.last || slots.best;
    let records_h = CAPTION_H + S1 + value_h;
    let top = y + CAPTION_H + S1;
    let mut heights = vec![hero_h];
    if has_delta {
        heights.push(delta_h + S2 + STEER_BAR_H);
    }
    // The delta along the lap goes under the delta only when the card has room for it with every gap at least `S3`.
    let trace_h = PROJECTED_H + S1 + DELTA_TRACE_H;
    let others: f32 = heights.iter().sum::<f32>() + if has_records { records_h } else { 0.0 };
    let gaps = (heights.len() + usize::from(has_records)) as f32 * S3;
    let has_trace = has_delta && y + h - top - others - gaps >= trace_h;
    if has_trace {
        heights.push(trace_h);
    }
    if has_records {
        heights.push(records_h);
    }
    let tops = stack(top, y + h - top, &heights, S3, S8);
    let mut next = tops.iter().skip(1);
    let delta_top = if has_delta { next.next().copied() } else { None };
    let trace_top = if has_trace { next.next().copied() } else { None };
    let records_top = if has_records { next.next().copied() } else { None };
    let rule = records_top.map(|t| {
        let above = match (trace_top, delta_top) {
            (Some(tt), _) => tt + trace_h,
            (None, Some(d)) => d + delta_h + S2 + STEER_BAR_H,
            (None, None) => tops[0] + hero_h,
        };
        (x, (above + t) / 2.0, w, STROKE_HAIR)
    });
    let dt = delta_top.unwrap_or(tops[0] + hero_h);
    TimesPlan {
        big,
        lap: (x, tops[0], w, hero_h),
        delta: (x, dt, w, delta_h),
        bar: (x, dt + delta_h + S2, w, STEER_BAR_H),
        trace: trace_top.map(|tt| (x, tt, w, trace_h)),
        rule,
        records: (x, records_top.unwrap_or(y + h), w, records_h),
    }
}

/// Where the rows of the fuel card go under its caption (owner-approved module 6, 2026-11-19): the fuel group (the
/// hero and the tank bar), the use tiles, the stint planner and the water and oil, stacked with an even gap and centred.
/// A row that does not fit with every gap at least `S3` is left out: the planner first, then the use tiles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct FuelRows {
    pub(super) group: Area,
    pub(super) stats: Option<Area>,
    pub(super) planner: Option<Area>,
    pub(super) temps: Option<Area>,
}

/// The height of the fuel card's stint planner with `rows` runs in it.
pub(super) fn fuel_planner_h(rows: usize) -> f32 {
    CAPTION_H + S1 + rows as f32 * FUEL_PLAN_ROW_H + 2.0 * S2
}

pub(super) fn fuel_rows(card: Area, group_h: f32, stats: bool, planner_rows: usize, temps: bool) -> FuelRows {
    let (x, y, w, h) = inner(card);
    let top = y + CAPTION_H + S2;
    let room = y + h - top;
    let temps_h = CAPTION_H + S1 + FUEL_TEMP_BAR_H;
    let planner_h = fuel_planner_h(planner_rows);
    let blocks = |stats: bool, planner: bool| -> Vec<f32> {
        let mut heights = vec![group_h];
        if stats {
            heights.push(FUEL_STAT_H);
        }
        if planner {
            heights.push(planner_h);
        }
        if temps {
            heights.push(temps_h);
        }
        heights
    };
    let fits = |heights: &[f32]| heights.iter().sum::<f32>() + S3 * (heights.len() as f32 - 1.0) <= room;
    let mut keep_planner = planner_rows > 0;
    let mut keep_stats = stats;
    if !fits(&blocks(keep_stats, keep_planner)) {
        keep_planner = false;
    }
    if !fits(&blocks(keep_stats, keep_planner)) {
        keep_stats = false;
    }
    let tops = stack(top, room, &blocks(keep_stats, keep_planner), S3, S8);
    let mut next = tops.into_iter();
    let group = (x, next.next().unwrap_or(top), w, group_h);
    let stats = keep_stats.then(|| (x, next.next().unwrap_or(top), w, FUEL_STAT_H));
    let planner = keep_planner.then(|| (x, next.next().unwrap_or(top), w, planner_h));
    let temps = temps.then(|| (x, next.next().unwrap_or(top), w, temps_h));
    FuelRows {
        group,
        stats,
        planner,
        temps,
    }
}

/// The card the banner goes over: the centre card (the live car values, dimmed while paused anyway), else the times card;
/// never one whose readings stay readable (fuel, tyres, laps, track, alerts).
pub(super) fn banner_target(plan: &Plan) -> Option<Area> {
    plan.area(Pane::Centre).or_else(|| plan.area(Pane::Times))
}

/// The banner's box: `content_w` x `content_h` of text with the token padding, centred in `target` and always inside it
/// (with the card's own padding left round it).
pub(super) fn banner_box(target: Area, content_w: f32, content_h: f32) -> Area {
    let (tx, ty, tw, th) = target;
    let w = (content_w + 2.0 * S4).min(tw - 2.0 * S3).max(1.0);
    let h = (content_h + 2.0 * S4).min(th - 2.0 * S3).max(1.0);
    (tx + (tw - w) / 2.0, ty + (th - h) / 2.0, w, h)
}

/// The cells of the lights card's grid for `n` lights in `region`: rows of at most `LIGHT_COLUMNS`, balanced (nine lights
/// are three rows of three, not two of four and one alone), tiles `LIGHT_TILE_H` tall or less to fit. `None` when even
/// `LIGHT_TILE_MIN_H` does not fit, or there is nothing to place.
pub(super) fn light_grid((x, y, w, h): Area, n: usize) -> Option<Vec<Area>> {
    if n == 0 {
        return None;
    }
    let rows = n.div_ceil(LIGHT_COLUMNS);
    let cols = n.div_ceil(rows);
    let tile_h = ((h - S2 * (rows as f32 - 1.0)) / rows as f32).min(LIGHT_TILE_H);
    if tile_h < LIGHT_TILE_MIN_H {
        return None;
    }
    let tile_w = (w - S2 * (cols as f32 - 1.0)) / cols as f32;
    let cell = |i: usize| {
        let (col, row) = ((i % cols) as f32, (i / cols) as f32);
        (x + col * (tile_w + S2), y + row * (tile_h + S2), tile_w, tile_h)
    };
    Some((0..n).map(cell).collect())
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
        (Pane::Centre, s.gear || s.speed || s.steer),
        (Pane::Inputs, s.brake || s.throttle || s.clutch),
        (Pane::Fuel, s.fuel || s.water || s.oil),
        (Pane::Tyres, s.tyres),
        (Pane::Laps, s.lap_time || s.last),
        (Pane::Track, s.map || s.progress),
        (Pane::Alerts, alerts),
        (Pane::Flag, caps.has(Caps::FLAG)),
        (Pane::FuelCalc, caps.has(Caps::FUEL)),
        (Pane::TyreTrend, caps.has(Caps::TYRE_WEAR)),
        (Pane::Sectors, caps.has(Caps::SECTORS)),
        (Pane::DeltaBar, s.delta),
        (
            Pane::Session,
            any(&[Caps::RACE_POSITION, Caps::SESSION_TIME_LEFT, Caps::SESSION_LAPS]),
        ),
        (Pane::Relative, caps.has(Caps::RIVALS)),
        (Pane::Standings, caps.has(Caps::RIVALS)),
        (Pane::Gaps, caps.has(Caps::RIVALS)),
        (Pane::Radar, any(&[Caps::RIVALS_WORLD, Caps::SPOTTER])),
        (Pane::DeltaRef, s.delta),
    ]
    .into_iter()
    .filter(|(_, on)| *on)
    .map(|(card, _)| card)
    .collect();
    Slots { cards, ..s }
}
