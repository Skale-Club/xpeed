use super::*;

/// What one frame of the dashboard draws from: the reading (for the map and the make mark), the window's view, the model
/// (what to show) and the slots (where, from what the game can give).
pub(super) struct Dash<'a> {
    pub(super) live: &'a Live,
    pub(super) view: &'a View<'a>,
    pub(super) m: &'a DashModel,
    pub(super) slots: &'a Slots,
}

/// Draws `draw` for an element unless it is hidden, quiet when it is dimmed.
pub(super) fn shown(g: &mut Painter, show: Show, draw: impl FnOnce(&mut Painter)) {
    if show == Show::Hidden {
        return;
    }
    let before = g.set_dim(show == Show::Dimmed);
    draw(g);
    g.set_dim(before);
}

/// The dashboard tab: the waiting screen when there is no game to show, else the layout the window's shape asks for,
/// filled from the model. The layout comes from what the game can give and the window's size, never from which value
/// happens to be there.
pub(super) fn dashboard_screen(g: &mut Painter, body: RECT, view: &View) {
    let Some(live) = view.live.filter(|l| dashboard_shown(Some(l), &view.snapshot.game, view.now_ms)) else {
        return waiting(g, body, view);
    };
    let m = dashboard(
        live,
        &ModelCtx {
            lang: view.lang,
            now_ms: view.now_ms,
        },
    );
    let slots = slots(live.caps);
    let d = Dash {
        live,
        view,
        m: &m,
        slots: &slots,
    };
    let (side, main_h) = (slots.side(), main_height(&slots));
    let layout = pick_layout_sticky(
        (body.right - body.left) as f32,
        (body.bottom - body.top) as f32,
        side,
        main_h,
        view.layout.get(),
    );
    view.layout.set(Some(layout));
    let (w, h) = layout.size(side, main_h);
    let (s, ox, oy) = canvas_fit_wh(body, w, h);
    g.place(s, ox, oy);
    match layout {
        Layout::Portrait => portrait_block(g, &d),
        Layout::Classic => main_block(g, &d, w),
        Layout::Ultrawide => {
            main_block(g, &d, w);
            side_column(g, &d, CANVAS_H);
        }
        Layout::Wide => {
            main_block(g, &d, w);
            side_column(g, &d, h);
            laps_band(g, &d, main_h + 22.0, CANVAS_W, h);
        }
        Layout::Square => {
            main_block(g, &d, w);
            if side {
                let (top, half) = (main_h + 22.0, (CANVAS_W - 20.0) / 2.0);
                side_pair(g, &d, (0.0, top, CANVAS_W, h - top), half, 20.0);
            }
        }
    }
}

/// The track and the tyres side by side in a box, the track `track_w` wide; whichever the game cannot give leaves its
/// room to the other.
pub(super) fn side_pair(g: &mut Painter, d: &Dash, (x, y, w, h): Area, track_w: f32, gap: f32) {
    match (d.slots.map, d.slots.tyres) {
        (true, true) => {
            track_panel(g, d, x, y, track_w, h);
            tyres_panel(g, d, x + track_w + gap, y, w - track_w - gap, h);
        }
        (true, false) => track_panel(g, d, x, y, w, h),
        (false, true) => tyres_panel(g, d, x, y, w, h),
        (false, false) => {}
    }
}

/// A card: a rounded `CARD` with a thin accent along its top edge.
pub(super) fn card_with_edge(g: &mut Painter, (x, y, w, h): Area, edge: COLORREF) {
    let r = g.r(x, y, w, h);
    g.round(r, R_CARD, CARD, None);
    let band = g.r(x, y, w, STROKE_BAR);
    g.clip(band);
    g.round(r, R_CARD, edge, None);
    g.unclip();
}

/// The recent laps as cards, oldest to newest, then the lap being driven (marked yellow, its time running): the
/// fastest in purple, each with its gap to the fastest.
pub(super) fn laps_band(g: &mut Painter, d: &Dash, top: f32, w: f32, bottom: f32) {
    let (view, m) = (d.view, d.m);
    let r = g.r(0.0, top, w, S4);
    g.caps(&text(view.lang, &Msg::PanelRecentLaps), r, T_CAPTION, MUTED_TEXT, DT_LEFT);
    let (y, h) = (top + S6, bottom - top - S6);
    let laps = view.recent_laps;
    let fastest = fastest_valid(laps);
    // Cards of a fixed width (six fit the row): the last completed laps (up to five), then the lap being driven.
    // Only laps that exist get a card; with fewer the row simply ends sooner.
    let (n, gap) = (6_usize, S3);
    let card_w = (w - gap * (n as f32 - 1.0)) / n as f32;
    let shown_laps = &laps[laps.len().saturating_sub(n - 1)..];
    let semi = FW_SEMIBOLD as i32;
    let card = |g: &mut Painter,
                i: usize,
                edge: COLORREF,
                name: &str,
                name_color: COLORREF,
                time: &str,
                time_color: COLORREF,
                note: &str,
                note_color: COLORREF,
                invalid: bool| {
        let x = i as f32 * (card_w + gap);
        card_with_edge(g, (x, y, card_w, h), edge);
        let r = g.r(x + S4, y + S4, card_w - 2.0 * S4, S4);
        g.caps(name, r, T_CAPTION, name_color, DT_LEFT);
        if invalid {
            g.invalid_mark(x + card_w - S4 - S4, y + S3, S4);
        }
        // The time never leaves its card: smaller when it is long.
        let room = card_w - S6;
        let size = g.fitted(time, room, T_VALUE_L, T_BODY, semi, Face::Num);
        let r = g.r(x + S3, y + 40.0, room + S1, 40.0);
        g.text(time, r, size, semi, Face::Num, time_color, DT_LEFT);
        let r = g.r(x + S4, y + h - 36.0, card_w - 2.0 * S4, 20.0);
        g.text(note, r, T_BODY, semi, Face::Num, note_color, DT_LEFT);
    };
    for (i, lap) in shown_laps.iter().enumerate() {
        let invalid = !lap.valid;
        let is_fastest = !invalid && fastest == Some(lap.time_ms);
        let note = match fastest {
            _ if invalid => text(view.lang, &Msg::PanelInvalid),
            _ if is_fastest => text(view.lang, &Msg::PanelFastest),
            Some(best) => format!("+{:.3}", f64::from(lap.time_ms.saturating_sub(best)) / 1000.0),
            None => String::new(),
        };
        let (edge, color) = match (invalid, is_fastest) {
            (true, _) => (DESTRUCTIVE, MUTED_TEXT),
            (_, true) => (BEST, BEST),
            _ => (BORDER, FOREGROUND),
        };
        let note_color = match (invalid, is_fastest) {
            (true, _) => DESTRUCTIVE,
            (_, true) => BEST,
            _ => MUTED_TEXT,
        };
        let name = text(view.lang, &Msg::PanelLap(lap.number as i32));
        card(
            g,
            i,
            edge,
            &name,
            MUTED_TEXT,
            &clock(lap.time_ms),
            color,
            &note,
            note_color,
            invalid,
        );
    }
    // The lap being driven, its time running and its delta to the best lap: drawn when the game gives a lap clock.
    let now = shown_laps.len();
    if d.slots.lap_time {
        shown(g, m.lap_time.show, |g| {
            let name = text(view.lang, &Msg::PanelLap(d.live.lap.max(1)));
            let time = if d.live.lap_time_s.is_some() {
                m.lap_time.text.clone()
            } else {
                String::new()
            };
            card(
                g,
                now,
                PRIMARY,
                &name,
                PRIMARY,
                &time,
                FOREGROUND,
                &m.delta.text,
                m.delta.role.colour(),
                m.invalid,
            );
        });
    }
    if laps.is_empty() {
        let x = (now + 1) as f32 * (card_w + gap);
        let note = text(view.lang, &Msg::PanelNoLapsYet);
        g.wrapped(
            &note,
            x + S6,
            y + h / 2.0 - S3,
            w - x - 2.0 * S6,
            T_BODY,
            FW_NORMAL as i32,
            Face::Ui,
            MUTED_TEXT,
            DT_CENTER,
            S6,
        );
    }
}

/// The mark of a lap that will not count, ending at `right` (design units), with its word before it when `label`.
pub(super) fn invalid_flag(g: &mut Painter, view: &View, right: f32, y: f32, label: bool) {
    let size = 22.0;
    g.invalid_mark(right - size, y, size);
    if label {
        let word = text(view.lang, &Msg::PanelInvalid);
        let room = 120.0;
        let fit = g.fitted(&word, room, T_BODY, T_CAPTION, FW_SEMIBOLD as i32, Face::Ui);
        let used = g.width_of(&word, fit, FW_SEMIBOLD as i32, Face::Ui);
        let r = g.r(right - size - S2 - used, y, used + 2.0, size);
        g.text(&word, r, fit, FW_SEMIBOLD as i32, Face::Ui, DESTRUCTIVE, DT_LEFT);
    }
}

/// The car's line under the track, with the make's mark before it when the make is known; the box the text goes in.
pub(super) fn brand_car_line(g: &mut Painter, live: &Live, view: &View, width: f32) -> RECT {
    let catalog: Vec<_> = view.brands.iter().map(|b| b.brand.clone()).collect();
    let Some(brand) = crate::brands::match_brand(&live.car, &catalog) else {
        return g.r(0.0, 72.0, width, 18.0);
    };
    if let Some(art) = view.brands.iter().find(|b| b.brand.key == brand.key) {
        let tile = g.r(0.0, 70.0, 34.0, 20.0);
        g.round(tile, R_XS, BRAND_TILE, None);
        g.image(g.r(2.0, 71.0, 30.0, 18.0), art.image);
        g.r(40.0, 72.0, width - 40.0, 18.0)
    } else {
        g.r(0.0, 72.0, width, 18.0)
    }
}

/// The rev bar across the top: a dome in the revs' colours on a cyan base line, and the shift lights' state. Returns
/// `(lit, flashing, blink phase)` for the gear's frame.
pub(super) fn rev_header(g: &mut Painter, d: &Dash, width: f32) -> (usize, bool, bool) {
    let share = if d.m.rev.show == Show::Shown { d.m.rev.frac } else { f32::NAN };
    let (lit, flash) = lights_lit(share);
    let blink_on = d.view.now_ms / 120 % 2 == 0;
    g.rev_bar(0.0, 0.0, width, 36.0, share, flash && blink_on);
    g.round(g.r(0.0, 37.0, width, STROKE_BAR), 1.5, CYAN, None);
    (lit, flash, blink_on)
}

/// The tall layout (a phone held upright), on a 600 x 1210 canvas: the rev bar, the lap, the delta, the gear with the
/// pedals either side and the wheel under the speed, the times and the fuel in two columns, the car strip (lights,
/// engine and fuel, electronics and damage), then the track and the tyres side by side.
pub(super) fn portrait_block(g: &mut Painter, d: &Dash) {
    let w = PORTRAIT_W;
    let lights = rev_header(g, d, w);
    title_line(g, d, w, 420.0, false);
    g.fill(g.r(0.0, 95.0, w, STROKE_HAIR), BORDER);

    let bottom = centre_block(g, d, w / 2.0, 100.0, 190.0, lights);
    g.fill(g.r(0.0, bottom + 14.0, w, STROKE_HAIR), BORDER);

    // The times on the left, fuel and lap progress on the right.
    let top = bottom + 22.0;
    side_stats(g, d, (0.0, w, top), 76.0, [T_NUMERAL; 3], 290.0);
    let strip = top + 76.0 * 3.0 + 6.0;
    g.fill(g.r(0.0, strip - 4.0, w, STROKE_HAIR), BORDER);

    // The car strip, stacked: the lights across, the engine and the electronics side by side under them. A card the
    // game cannot fill is left out and the others take its room.
    let has = |c: CarCard| d.slots.cards.contains(&c);
    let (lights_h, row_h, gap) = (80.0, 108.0, S3);
    let mut y = strip + 6.0;
    if has(CarCard::Lights) {
        car_card(g, d, CarCard::Lights, (0.0, y, w, lights_h));
        y += lights_h + gap;
    }
    let pair: Vec<CarCard> = [CarCard::Engine, CarCard::Electronics].into_iter().filter(|c| has(*c)).collect();
    let each = (w - gap * (pair.len() as f32 - 1.0)) / pair.len().max(1) as f32;
    for (i, card) in pair.iter().enumerate() {
        car_card(g, d, *card, (i as f32 * (each + gap), y, each, row_h));
    }
    if !pair.is_empty() {
        y += row_h + gap;
    }

    // The track and the tyres side by side, a square each.
    let low = y + 4.0;
    side_pair(g, d, (0.0, low, w, PORTRAIT_H - low), 250.0, 14.0);
}

/// The line over the dashboard: track and car on the left, the lap on the right (with the mark of a lap that will
/// not count, and the state line under it). `left_w` is the room the left side has.
pub(super) fn title_line(g: &mut Painter, d: &Dash, width: f32, left_w: f32, labelled: bool) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (m, view) = (d.m, d.view);
    let r = g.r(0.0, 48.0, left_w, 24.0);
    g.text(&m.track, r, T_LEAD, semi, Face::Num, FOREGROUND, DT_LEFT);
    let r = brand_car_line(g, d.live, view, left_w);
    g.text(&m.car, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
    // Out of the car (menu, garage) the lap is dim; where there is no lap to number only the state line shows.
    shown(g, m.lap.show, |g| {
        let r = g.r(width - 200.0, 46.0, 200.0, 28.0);
        g.text(&m.lap.text, r, T_VALUE_L, semi, Face::Num, PRIMARY, DT_RIGHT);
        if m.invalid {
            let at = width - g.width_of(&m.lap.text, T_VALUE_L, semi, Face::Num) - S3;
            invalid_flag(g, view, at, 49.0, labelled);
        }
    });
    if let Some((_, line)) = &m.status {
        let r = g.r(width - 240.0, 72.0, 240.0, 18.0);
        g.caps(line, r, T_CAPTION, WARN, DT_RIGHT);
    }
}

/// The lap's times in a column on the left (lap time, last, best) and fuel and lap progress on the right. `columns`
/// is `(left edge, right edge, top)`; `row_h` the height of a row; `sizes` the size of each time's figure; `room` the
/// width a column has. A row the game cannot fill is not there and the others take its room; a row whose value is not
/// known yet (no best lap on the first lap) keeps its place, empty.
pub(super) fn side_stats(g: &mut Painter, d: &Dash, columns: (f32, f32, f32), row_h: f32, sizes: [f32; 3], room: f32) {
    let (left, right, top) = columns;
    let semi = FW_SEMIBOLD as i32;
    let (m, slots) = (d.m, d.slots);
    let rows: Vec<(&Elem, f32)> = [
        (slots.lap_time, &m.lap_time, sizes[0]),
        (slots.last, &m.last_lap, sizes[1]),
        (slots.best, &m.best_lap, sizes[2]),
    ]
    .into_iter()
    .filter(|(on, _, _)| *on)
    .map(|(_, elem, size)| (elem, size))
    .collect();
    let step = left_row_h(slots.times(), row_h);
    for (i, (elem, size)) in rows.iter().enumerate() {
        let y = top + step * i as f32;
        if i > 0 {
            g.fill(g.r(left, y, room, STROKE_HAIR), BORDER);
        }
        shown(g, elem.show, |g| {
            let r = g.r(left, y + 10.0, room, 18.0);
            g.caps(&elem.label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            let r = g.r(left - 2.0, y + 28.0, room + 20.0, row_h - 34.0);
            g.text(&elem.text, r, *size, semi, Face::Num, elem.role.colour(), DT_LEFT);
        });
    }
    let (fuel_at, lap_at) = right_plan(row_h, slots.fuel, slots.progress);
    let rx = right - room;
    if let Some((dy, h)) = fuel_at {
        fuel_block(g, d, (rx, top + dy, room, h), sizes[0].min(T_NUMERAL_L));
    }
    // The lap: the share, the bar and the distance.
    if let Some((dy, _)) = lap_at {
        let y = top + dy;
        if dy > 0.0 {
            g.fill(g.r(rx, y, room, STROKE_HAIR), BORDER);
        }
        shown(g, m.progress.show, |g| {
            let r = g.r(rx, y + 10.0, room, 18.0);
            g.caps(&m.progress.label, r, T_CAPTION, MUTED_TEXT, DT_RIGHT);
            let r = g.r(rx - 22.0, y + 28.0, room + 24.0, row_h - 30.0);
            let big = if sizes[1] >= T_NUMERAL_L { T_HERO } else { T_NUMERAL_L };
            g.text(&m.progress.text, r, big, semi, Face::Num, FOREGROUND, DT_RIGHT);
            let bar_w = room.min(240.0);
            g.blocks(right - bar_w, y + row_h + 2.0, bar_w, 9.0, 20, 0.0, m.progress.frac, PRIMARY);
            let r = g.r(rx, y + row_h + 18.0, room, 16.0);
            g.text(&m.distance.text, r, T_CAPTION, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_RIGHT);
        });
    }
}

/// The fuel block: the litres big on the right, the laps they last prominent beside them, a tank gauge under them (a
/// bar of small squares, fuel in the tank against the tank's size) and the use per lap small under the gauge. Only
/// what is known is drawn; the laps and the gauge turn red when the car is driving and the fuel lasts under two laps.
pub(super) fn fuel_block(g: &mut Painter, d: &Dash, (x, y, w, _h): Area, size: f32) {
    let (semi, m) = (FW_SEMIBOLD as i32, d.m);
    let fuel = &m.fuel;
    shown(g, fuel.show, |g| {
        let r = g.r(x, y + 10.0, w, 18.0);
        g.caps(&fuel.label, r, T_CAPTION, MUTED_TEXT, DT_RIGHT);
        let (line_y, line_h) = (y + 28.0, size * 1.2);
        let litres = format!("{} {}", fuel.text, fuel.unit);
        let r = g.r(x - 22.0, line_y, w + 24.0, line_h);
        g.text(&litres, r, size, semi, Face::Num, FOREGROUND, DT_RIGHT);
        if m.fuel_laps.visible() {
            let room = (w - g.width_of(&litres, size, semi, Face::Num) - 14.0).max(40.0);
            let laps_size = g.fitted(&m.fuel_laps.text, room, T_VALUE, T_CAPTION, semi, Face::Num);
            let r = g.r(x, line_y, room + 6.0, line_h);
            g.text(&m.fuel_laps.text, r, laps_size, semi, Face::Num, m.fuel_laps.role.colour(), DT_LEFT);
        }
        let mut at = line_y + line_h + S1;
        if let Some(share) = m.fuel_share {
            g.blocks(x, at, w, 9.0, 20, 0.0, share, if m.fuel_low { DESTRUCTIVE } else { PRIMARY });
            at += 14.0;
        }
        if m.fuel_per_lap.visible() {
            let r = g.r(x, at, w, 16.0);
            g.text(&m.fuel_per_lap.text, r, T_CAPTION, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_LEFT);
        }
    });
}

/// The main dashboard on its 1000 x 520 canvas: rev bar (as wide as the whole layout, `width`), track and car, the
/// lap's times and the fuel on the sides, the delta, the gear between its pedals and the speed over the wheel in the
/// middle, and the car strip along the bottom.
pub(super) fn main_block(g: &mut Painter, d: &Dash, width: f32) {
    let lights = rev_header(g, d, width);
    title_line(g, d, width, 640.0, true);
    g.fill(g.r(0.0, 95.0, width, STROKE_HAIR), BORDER);

    side_stats(g, d, (0.0, CANVAS_W, 100.0), 98.0, [T_HERO, T_NUMERAL_L, T_NUMERAL_L], MAIN_SIDE_W);
    centre_block(g, d, CANVAS_W / 2.0, 100.0, 140.0, lights);

    // The car strip along the bottom: only the cards the game can fill.
    let strip = STRIP_TOP;
    let plan = strip_plan(0.0, strip, CANVAS_W, CANVAS_H - strip - S2, &d.slots.cards);
    if !plan.is_empty() {
        g.fill(g.r(0.0, strip - 5.0, CANVAS_W, STROKE_HAIR), BORDER);
    }
    for (card, area) in plan {
        car_card(g, d, card, area);
    }
}

/// The middle of the dashboard: the delta over the gear (its corner brackets turning red near the limit and flashing
/// blue at the shift), the brake and the throttle as columns of small squares outside the brackets (the clutch beside
/// the brake, when the game gives it), the speed under the gear and the wheel as a bar under the speed. Whatever the
/// game cannot give is not drawn; what it gives but not now is dimmed. Returns the line under all of it. `lights` is
/// `(shift lights lit, flashing, blink phase)`.
pub(super) fn centre_block(g: &mut Painter, d: &Dash, cx: f32, top: f32, frame_h: f32, lights: (usize, bool, bool)) -> f32 {
    let (lit, flash, blink_on) = lights;
    let (m, slots) = (d.m, d.slots);
    let semi = FW_SEMIBOLD as i32;
    let plan = centre_plan(cx, top, frame_h, slots.delta);
    // The delta: its place is there whenever the game gives a lap clock; it fills once there is a best lap.
    shown(g, m.delta.show, |g| {
        let color = m.delta.role.colour();
        let r = g.r(cx - 170.0, top, 340.0, 16.0);
        g.caps(&m.delta.label, r, T_CAPTION, MUTED_TEXT, DT_CENTER);
        let r = g.r(cx - 170.0, top + 14.0, 340.0, 40.0);
        g.text(&m.delta.text, r, T_NUMERAL, semi, Face::Num, color, DT_CENTER);
        // Each block is a tenth of a second, faster to the left.
        let at = m.delta.frac;
        g.blocks(cx - 150.0, top + 56.0, 300.0, 9.0, 20, at.min(0.5), at.max(0.5), color);
        g.fill(g.r(cx - 1.0, top + 52.0, 2.0, 17.0), FOREGROUND);
    });

    shown(g, m.gear.show, |g| {
        let frame = match (flash, lit) {
            (true, _) if blink_on => INFO,
            (true, _) => DESTRUCTIVE,
            (false, n) if n >= LIGHTS - 2 => DESTRUCTIVE,
            _ => MUTED_TEXT,
        };
        let (fx, fy, fw, fh) = plan.frame;
        let (arm, thick) = (26.0, STROKE_BAR);
        for (px, py, dx, dy) in [
            (fx, fy, 1.0, 1.0),
            (fx + fw, fy, -1.0, 1.0),
            (fx, fy + fh, 1.0, -1.0),
            (fx + fw, fy + fh, -1.0, -1.0),
        ] {
            let x0 = if dx > 0.0 { px } else { px - arm };
            let y0 = if dy > 0.0 { py } else { py - thick };
            g.fill(g.r(x0, y0, arm, thick), frame);
            let x1 = if dx > 0.0 { px } else { px - thick };
            let y1 = if dy > 0.0 { py } else { py - arm };
            g.fill(g.r(x1, y1, thick, arm), frame);
        }
        let r = g.r(fx - 4.0, fy - 4.0, fw + 8.0, fh + 8.0);
        g.text(&m.gear.text, r, fh * GEAR_FILL, semi, Face::Num, PRIMARY, DT_CENTER);
        for (gear, x) in [(&m.gear_below, fx + 24.0), (&m.gear_above, fx + fw - 64.0)] {
            if gear.visible() {
                let (w, h) = (40.0, 52.0);
                let y = fy + fh / 2.0 - h / 2.0;
                g.fill(g.r(x, y, w, h), SURFACE);
                let r = g.r(x, y, w, h);
                g.text(&gear.text, r, T_VALUE_L, semi, Face::Num, GREY, DT_CENTER);
            }
        }
    });

    // The pedals: columns of small squares (brake red, throttle green, clutch blue), a letter under each.
    for (elem, area) in [(&m.brake, plan.brake), (&m.throttle, plan.throttle), (&m.clutch, plan.clutch)] {
        shown(g, elem.show, |g| {
            g.pedal_blocks(area, elem.frac, elem.role.colour());
            let (bx, by, bw, bh) = area;
            let r = g.r(bx - 8.0, by + bh + 3.0, bw + 16.0, 14.0);
            g.caps(&elem.label, r, T_CAPTION, MUTED_TEXT, DT_CENTER);
        });
    }

    shown(g, m.speed.show, |g| {
        let (sx, sy, sw, sh) = plan.speed;
        let r = g.r(sx, sy, sw, sh);
        g.text(&m.speed.text, r, T_NUMERAL_L, semi, Face::Num, FOREGROUND, DT_CENTER);
        let (ux, uy, uw, uh) = plan.unit;
        let r = g.r(ux, uy, uw, uh);
        g.caps(m.speed.unit, r, T_CAPTION, MUTED_TEXT, DT_CENTER);
    });
    shown(g, m.steer.show, |g| g.steer_bar(plan.steer, m.steer.frac));
    plan.bottom
}

/// One card: its fill and top edge like a lap card, its title, then what it holds.
pub(super) fn car_card(g: &mut Painter, d: &Dash, card: CarCard, area: Area) {
    let (x, y, w, h) = area;
    card_with_edge(g, area, BORDER);
    let title = match card {
        CarCard::Lights => Msg::PanelLights,
        CarCard::Engine => Msg::PanelEngineFuel,
        CarCard::Electronics => Msg::PanelElectronics,
    };
    let r = g.r(x + S4, y + S3, w - 2.0 * S4, S4);
    g.caps(&text(d.view.lang, &title), r, T_CAPTION, MUTED_TEXT, DT_LEFT);
    let inner = (x + S4, y + S8, w - 2.0 * S4, (h - S8 - S2).max(1.0));
    match card {
        CarCard::Lights => lights_card(g, d, inner),
        CarCard::Engine => draw_cells(g, &d.m.engine, inner, 2),
        CarCard::Electronics => electronics_card(g, d, inner),
    }
}

pub(super) fn lights_card(g: &mut Painter, d: &Dash, inner: Area) {
    let lights = &d.m.lights;
    for (light, cell) in lights.iter().zip(light_cells(inner, lights.len())) {
        shown(g, light.show, |g| g.light_tile(d.view.lang, light, cell));
    }
}

pub(super) fn draw_cells(g: &mut Painter, cells: &[Cell], area: Area, cols: usize) {
    let semi = FW_SEMIBOLD as i32;
    for (cell, (x, y, w, h)) in cells.iter().zip(cell_grid(area, cells.len(), cols)) {
        shown(g, cell.show, |g| {
            let r = g.r(x, y, w - S1, S3);
            g.caps(&cell.label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            let size = (h - S3).clamp(T_BODY, T_VALUE);
            let r = g.r(x - 1.0, y + S3, w + 2.0, size + S1);
            g.text(&cell.value, r, size, semi, Face::Num, cell.role.colour(), DT_LEFT);
        });
    }
}

pub(super) fn electronics_card(g: &mut Painter, d: &Dash, inner: Area) {
    let (cells, bars) = (&d.m.electronics, &d.m.damage);
    let (stats_area, bars_area) = electronics_split(inner, !cells.is_empty(), !bars.is_empty());
    draw_cells(g, cells, stats_area, 2);
    let (bx, by, bw, bh) = bars_area;
    let row_h = (bh / 4.0).min(18.0);
    let label_w = 64.0;
    for (i, bar) in bars.iter().enumerate() {
        let y = by + i as f32 * row_h;
        shown(g, bar.show, |g| {
            let r = g.r(bx, y, label_w, row_h);
            g.caps(&bar.label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            let track = (bx + label_w + S1, y + row_h / 2.0 - 3.0, (bw - label_w - S1).max(1.0), 6.0);
            g.round(g.r(track.0, track.1, track.2, track.3), 3.0, SECONDARY, None);
            // Undamaged is an empty bar with a pip of green, so it still reads as healthy.
            let len = (track.2 * bar.share).max(5.0);
            g.round(g.r(track.0, track.1, len, track.3), 3.0, damage_color(bar.share), None);
        });
    }
}

/// The right-hand column, from under the header line to `bottom`: the track map, then the four tyres. Whichever the
/// game cannot give leaves its room to the other; with neither the column is empty.
pub(super) fn side_column(g: &mut Painter, d: &Dash, bottom: f32) {
    let (x, w, top) = (CANVAS_W + S6, SIDE_W - S6, 106.0);
    match (d.slots.map, d.slots.tyres) {
        (true, true) => {
            let tyres_h = ((bottom - top) * 0.46).clamp(214.0, 330.0);
            track_panel(g, d, x, top, w, bottom - top - tyres_h - 14.0);
            tyres_panel(g, d, x, bottom - tyres_h, w, tyres_h);
        }
        (true, false) => track_panel(g, d, x, top, w, bottom - top),
        (false, true) => tyres_panel(g, d, x, top, w, bottom - top),
        (false, false) => {}
    }
}

/// The track map (the car's own path, with where it is now) in a box; its title is there whenever the game gives a
/// position, the path once there is enough of one.
pub(super) fn track_panel(g: &mut Painter, d: &Dash, x: f32, y: f32, w: f32, h: f32) {
    let m = d.m;
    shown(g, m.map, |g| {
        let r = g.r(x, y, w, S4);
        g.caps(&m.map_title, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
        if let Some(map) = d.live.map.as_ref().filter(|_| has_map(d.live)) {
            g.track_map((x, y + 22.0, w, h - 22.0), map, d.live.map_complete, d.live.pos);
        }
    });
}

/// The four tyres around a quiet top view of the car: a rounded tyre at each corner, partly outside the body, its
/// border and glow in its temperature's colour and its tread left filling it from the bottom. On the outer side the
/// temperature and the pressure; above the front tyres and below the rear ones the brake's temperature with a disc
/// in its colour. When the game cannot give tyres, nothing is drawn (not even the title); when it can and has not yet,
/// the car is there dimmed with dashes.
pub(super) fn tyres_panel(g: &mut Painter, d: &Dash, x: f32, y: f32, w: f32, h: f32) {
    let Some(tyres) = &d.m.tyres else {
        return;
    };
    shown(g, tyres.show, |g| {
        let r = g.r(x, y, w, S4);
        g.caps(&tyres.title, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
        let plan = schematic(x, y + 22.0, w, h - 22.0, d.slots.brakes);
        // The car first, so the tyres sit on top of it.
        g.car_body(plan.body);
        for (i, tyre) in tyres.tyres.iter().enumerate() {
            tyre_box(g, &plan, i, tyre);
        }
    });
}

/// One tyre of the schematic: a dark tyre with its border and a soft glow in its temperature's colour and its tread
/// left as a muted fill from the bottom; the temperature big and the pressure under it on the outer side; the
/// brake's temperature with its disc in its row.
pub(super) fn tyre_box(g: &mut Painter, plan: &Schematic, i: usize, tyre: &crate::game::Tyre) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let known = tyre.temp_c.is_finite();
    let color = tyre_color(tyre.temp_c);
    let (x, y, w, h) = plan.tyres[i];
    let radius = (w * 0.3).min(9.0);
    let edge = if known { color } else { TYRE_UNKNOWN_EDGE };
    // The glow: a few rings getting fainter outward.
    if known {
        for (grow, amount) in [(5.0, 0.07), (3.5, 0.12), (2.0, 0.2)] {
            g.round(
                g.r(x - grow, y - grow, w + 2.0 * grow, h + 2.0 * grow),
                radius + grow,
                tint(BACKGROUND, color, amount),
                None,
            );
        }
    }
    g.round(g.r(x, y, w, h), radius, edge, None);
    let base = TYRE_FILL;
    let border = 1.6;
    g.round(
        g.r(x + border, y + border, w - 2.0 * border, h - 2.0 * border),
        radius - border,
        base,
        None,
    );
    // Tread left: the fill rises from the bottom, in the temperature's colour, muted.
    if tyre.left.is_finite() {
        let inset = 3.2;
        let (fx, fw, full) = (x + inset, w - 2.0 * inset, h - 2.0 * inset);
        let filled = full * tyre.left.clamp(0.0, 1.0);
        if filled >= 1.0 {
            let tint = if known {
                tint(base, color, 0.5)
            } else {
                tint(base, MUTED_TEXT, 0.3)
            };
            g.round(
                g.r(fx, y + inset + full - filled, fw, filled),
                (radius - inset).max(1.0).min(filled / 2.0),
                tint,
                None,
            );
        }
    }
    // The readout, centred on the tyre's height, on its outer side.
    let (rx, _, rw, _) = plan.readout[i];
    let right_aligned = i.is_multiple_of(2);
    let size = plan.temp_size;
    let block = size * 1.15 + 16.0;
    let top = y + h / 2.0 - block / 2.0;
    let temp = if known { format!("{:.0}°", tyre.temp_c) } else { "–".to_owned() };
    let r = g.r(rx, top, rw, size * 1.15);
    g.text(
        &temp,
        r,
        size,
        semi,
        Face::Num,
        color,
        if right_aligned { DT_RIGHT } else { DT_LEFT },
    );
    if tyre.pressure_kpa.is_finite() {
        let num = format!("{:.1}", tyre.pressure_kpa / 6.894_757);
        let (num_w, psi_w) = (
            g.width_of(&num, T_BODY, semi, Face::Num),
            g.width_of("psi", T_CAPTION, normal, Face::Ui),
        );
        let ly = top + size * 1.15 + 1.0;
        let (num_x, psi_x) = if right_aligned {
            (rx + rw - psi_w - 4.0 - num_w, rx + rw - psi_w)
        } else {
            (rx, rx + num_w + 4.0)
        };
        let r = g.r(num_x - 1.0, ly, num_w + 2.0, 18.0);
        g.text(&num, r, T_BODY, semi, Face::Num, FOREGROUND, DT_LEFT);
        let r = g.r(psi_x, ly + 4.0, psi_w + 2.0, 14.0);
        g.text("psi", r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
    }
    let (bx, by, bw, bh) = plan.brake[i];
    if tyre.brake_c.is_finite() && bh > 0.0 {
        let label = format!("{:.0} °C", tyre.brake_c);
        let (disc, gap) = (11.0, 5.0);
        let label_w = g.width_of(&label, T_CAPTION, normal, Face::Num);
        let left = bx + (bw - (disc + gap + label_w)) / 2.0;
        g.brake_disc(left + disc / 2.0, by + bh / 2.0, disc, brake_color(tyre.brake_c));
        let r = g.r(left + disc + gap, by, label_w + 4.0, bh);
        g.text(&label, r, T_CAPTION, normal, Face::Num, MUTED_TEXT, DT_LEFT);
    }
}
