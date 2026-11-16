use super::*;

pub(super) fn dashboard(g: &mut Painter, body: RECT, view: &View) {
    let Some(live) = view.live.filter(|l| view.now_ms - l.at_ms <= STALE_MS) else {
        return waiting(g, body, view);
    };
    let side = has_side(live);
    let main_h = main_height(live);
    let layout = pick_layout((body.right - body.left) as f32, (body.bottom - body.top) as f32, side, main_h);
    let (w, h) = layout.size(side, main_h);
    let (s, ox, oy) = canvas_fit_wh(body, w, h);
    g.place(s, ox, oy);
    match layout {
        Layout::Portrait => portrait_block(g, live, view),
        Layout::Classic => main_block(g, live, view, w),
        Layout::Ultrawide => {
            main_block(g, live, view, w);
            side_column(g, live, view, CANVAS_H);
        }
        Layout::Wide => {
            main_block(g, live, view, w);
            side_column(g, live, view, h);
            laps_band(g, view, live, main_h + 22.0, CANVAS_W, h);
        }
        Layout::Square => {
            main_block(g, live, view, w);
            if side {
                let (top, half) = (main_h + 22.0, (CANVAS_W - 20.0) / 2.0);
                side_pair(g, live, view, (0.0, top, CANVAS_W, h - top), half, 20.0);
            }
        }
    }
}

/// The track and the tyres side by side in a box, the track `track_w` wide; whichever has nothing to show gives its
/// room to the other.
pub(super) fn side_pair(g: &mut Painter, live: &Live, view: &View, (x, y, w, h): Area, track_w: f32, gap: f32) {
    match (has_map(live), live.tyres.is_some()) {
        (true, true) => {
            track_panel(g, live, view, x, y, track_w, h);
            tyres_panel(g, live, view, x + track_w + gap, y, w - track_w - gap, h);
        }
        (true, false) => track_panel(g, live, view, x, y, w, h),
        (false, true) => tyres_panel(g, live, view, x, y, w, h),
        (false, false) => {}
    }
}

/// The recent laps as cards, oldest to newest, then the lap being driven (marked yellow, its time running): the
/// fastest in purple, each with its gap to the fastest.
pub(super) fn laps_band(g: &mut Painter, view: &View, live: &Live, top: f32, w: f32, bottom: f32) {
    let r = g.r(0.0, top, w, 16.0);
    g.caps(&text(view.lang, &Msg::PanelRecentLaps), r, 10.5, MUTED, DT_LEFT);
    let (y, h) = (top + 24.0, bottom - top - 24.0);
    let laps: Vec<LapLabel> = view.recent_laps.iter().map(|label| lap_parts(label)).collect();
    let fastest = fastest_valid(&laps).unwrap_or(f64::INFINITY);
    // Cards of a fixed width (six fit the row): the last completed laps (up to five), then the lap being driven.
    // Only laps that exist get a card; with fewer the row simply ends sooner.
    let (n, gap) = (6_usize, 12.0);
    let card_w = (w - gap * (n as f32 - 1.0)) / n as f32;
    let shown = &laps[laps.len().saturating_sub(n - 1)..];
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
        g.fill(g.r(x, y, card_w, h), CARD);
        g.fill(g.r(x, y, card_w, 3.0), edge);
        let r = g.r(x + 14.0, y + 14.0, card_w - 28.0, 16.0);
        g.caps(name, r, 10.5, name_color, DT_LEFT);
        if invalid {
            g.invalid_mark(x + card_w - 14.0 - 16.0, y + 13.0, 16.0);
        }
        // The time never leaves its card: smaller when it is long.
        let room = card_w - 24.0;
        let size = g.fitted(time, room, 30.0, 14.0, semi, Face::Num);
        let r = g.r(x + 12.0, y + 40.0, room + 4.0, 40.0);
        g.text(time, r, size, semi, Face::Num, time_color, DT_LEFT);
        let r = g.r(x + 14.0, y + h - 36.0, card_w - 28.0, 20.0);
        g.text(note, r, 14.0, semi, Face::Num, note_color, DT_LEFT);
    };
    for (i, lap) in shown.iter().enumerate() {
        let secs = clock_seconds(lap.time);
        let is_fastest = !lap.invalid && secs.is_some_and(|s| (s - fastest).abs() < 0.0005);
        let note = match secs {
            _ if lap.invalid => text(view.lang, &Msg::PanelInvalid),
            _ if is_fastest => text(view.lang, &Msg::PanelFastest),
            Some(s) if fastest.is_finite() => format!("+{:.3}", s - fastest),
            _ => String::new(),
        };
        let (edge, color) = match (lap.invalid, is_fastest) {
            (true, _) => (RED, MUTED),
            (_, true) => (PURPLE, PURPLE),
            _ => (EDGE, TEXT),
        };
        let note_color = match (lap.invalid, is_fastest) {
            (true, _) => RED,
            (_, true) => PURPLE,
            _ => MUTED,
        };
        card(g, i, edge, lap.name, MUTED, lap.time, color, &note, note_color, lap.invalid);
    }
    // The lap being driven, its time running and its delta to the best lap.
    let now = shown.len();
    let delta_color = match live.delta_s {
        Some(d) if d < 0.0 => GREEN,
        Some(_) => RED,
        None => MUTED,
    };
    let name = text(view.lang, &Msg::PanelLap(live.lap.max(1)));
    card(
        g,
        now,
        ACCENT,
        &name,
        ACCENT,
        &lap_clock(live.lap_time_s).unwrap_or_default(),
        TEXT,
        &delta_text(live.delta_s).unwrap_or_default(),
        delta_color,
        live.driving && live.lap_valid == Some(false),
    );
    if laps.is_empty() {
        let x = (now + 1) as f32 * (card_w + gap);
        let note = text(view.lang, &Msg::PanelNoLapsYet);
        g.wrapped(
            &note,
            x + 20.0,
            y + h / 2.0 - 11.0,
            w - x - 40.0,
            14.0,
            FW_NORMAL as i32,
            Face::Ui,
            MUTED,
            DT_CENTER,
            22.0,
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
        let fit = g.fitted(&word, room, 15.0, 11.0, FW_SEMIBOLD as i32, Face::Ui);
        let used = g.width_of(&word, fit, FW_SEMIBOLD as i32, Face::Ui);
        let r = g.r(right - size - 8.0 - used, y, used + 2.0, size);
        g.text(&word, r, fit, FW_SEMIBOLD as i32, Face::Ui, RED, DT_LEFT);
    }
}

/// The tall layout (a phone held upright), on a 600 x 1210 canvas: the rev bar, the lap, the delta, the gear with the
/// pedals either side and the wheel under the speed, the times and the fuel in two columns, the car strip (lights,
/// engine and fuel, electronics and damage), then the track and the tyres side by side.
pub(super) fn brand_car_line(g: &mut Painter, car: &str, live: &Live, view: &View, width: f32) -> RECT {
    let catalog: Vec<_> = view.brands.iter().map(|b| b.brand.clone()).collect();
    let Some(brand) = crate::brands::match_brand(&live.car, &catalog) else {
        return g.r(0.0, 72.0, width, 18.0);
    };
    if let Some(art) = view.brands.iter().find(|b| b.brand.key == brand.key) {
        let tile = g.r(0.0, 70.0, 34.0, 20.0);
        g.round(tile, 3.0, rgb(0xf5, 0xf5, 0xf5), None);
        g.image(g.r(2.0, 71.0, 30.0, 18.0), art.image);
        g.r(40.0, 72.0, width - 40.0, 18.0)
    } else {
        let _ = car;
        g.r(0.0, 72.0, width, 18.0)
    }
}

pub(super) fn portrait_block(g: &mut Painter, live: &Live, view: &View) {
    let w = PORTRAIT_W;
    let share = if live.rpm_top > 0.0 { live.rpm / live.rpm_top } else { f32::NAN };
    let (lit, flash) = lights_lit(share);
    let blink_on = view.now_ms / 120 % 2 == 0;
    g.rev_bar(0.0, 0.0, w, 36.0, share, flash && blink_on);
    g.round(g.r(0.0, 37.0, w, 3.0), 1.5, CYAN, None);
    title_line(g, live, view, w, 420.0, false);
    g.fill(g.r(0.0, 95.0, w, 1.0), EDGE);

    let bottom = centre_block(g, live, view, w / 2.0, 100.0, 190.0, (lit, flash, blink_on));
    g.fill(g.r(0.0, bottom + 14.0, w, 1.0), EDGE);

    // The times on the left, fuel and lap progress on the right.
    let top = bottom + 22.0;
    side_stats(g, live, view, (0.0, w, top), 76.0, [34.0, 34.0, 34.0], 290.0);
    let strip = top + 76.0 * 3.0 + 6.0;
    g.fill(g.r(0.0, strip - 4.0, w, 1.0), EDGE);

    // The car strip, stacked: the lights across, the engine and the electronics side by side under them. A card with
    // nothing to show is left out and the others take its room.
    let present = present_cards(live);
    let has = |c: CarCard| present.contains(&c);
    let (lights_h, row_h, gap) = (80.0, 108.0, 10.0);
    let mut y = strip + 6.0;
    if has(CarCard::Lights) {
        car_card(g, live, view, CarCard::Lights, (0.0, y, w, lights_h));
        y += lights_h + gap;
    }
    let pair: Vec<CarCard> = [CarCard::Engine, CarCard::Electronics].into_iter().filter(|c| has(*c)).collect();
    let each = (w - gap * (pair.len() as f32 - 1.0)) / pair.len().max(1) as f32;
    for (i, card) in pair.iter().enumerate() {
        car_card(g, live, view, *card, (i as f32 * (each + gap), y, each, row_h));
    }
    if !pair.is_empty() {
        y += row_h + gap;
    }

    // The track and the tyres side by side, a square each.
    let low = y + 4.0;
    side_pair(g, live, view, (0.0, low, w, PORTRAIT_H - low), 250.0, 14.0);
}

/// The line over the dashboard: track and car on the left, the lap on the right (with the mark of a lap that will
/// not count, and whether the car is in the pits). `left_w` is the room the left side has.
pub(super) fn title_line(g: &mut Painter, live: &Live, view: &View, width: f32, left_w: f32, labelled: bool) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let r = g.r(0.0, 48.0, left_w, 24.0);
    g.text(&live.track.to_uppercase(), r, 17.0, semi, Face::Num, TEXT, DT_LEFT);
    let car = [live.car.as_str(), live.game]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("  ·  ");
    let r = brand_car_line(g, &car, live, view, left_w);
    g.text(&car, r, 12.5, normal, Face::Ui, MUTED, DT_LEFT);
    let r = g.r(width - 200.0, 46.0, 200.0, 28.0);
    let title = text(view.lang, &Msg::PanelLap(live.lap)).to_uppercase();
    // Out of the car (menu, garage) there is no lap to number or to call invalid: only the state line shows.
    if live.driving {
        g.text(&title, r, 26.0, semi, Face::Num, ACCENT, DT_RIGHT);
    }
    if live.driving && live.lap_valid == Some(false) {
        let at = width - g.width_of(&title, 26.0, semi, Face::Num) - 12.0;
        invalid_flag(g, view, at, 49.0, labelled);
    }
    let status = if live.in_pits {
        text(view.lang, &Msg::PanelPits)
    } else if !live.driving {
        text(view.lang, &Msg::PanelNotDriving)
    } else {
        String::new()
    };
    let r = g.r(width - 240.0, 72.0, 240.0, 18.0);
    g.caps(&status, r, 11.0, AMBER, DT_RIGHT);
}

/// The lap's times in a column on the left (lap time, last, best) and fuel and lap progress on the right. `columns`
/// is `(left edge, right edge, top)`; `row_h` the height of a row; `sizes` the size of each time's figure; `room` the
/// width a column has. Every part the game gives nothing for is left out and the rest take its room.
pub(super) fn side_stats(g: &mut Painter, live: &Live, view: &View, columns: (f32, f32, f32), row_h: f32, sizes: [f32; 3], room: f32) {
    let (left, right, top) = columns;
    let semi = FW_SEMIBOLD as i32;
    let lang = view.lang;
    let times: Vec<(String, String, COLORREF, f32)> = [
        (Msg::PanelLapTime, lap_clock(live.lap_time_s), TEXT, sizes[0]),
        (Msg::PanelLastLap, lap_clock(live.last_lap_s), TEXT, sizes[1]),
        (Msg::PanelBestLap, lap_clock(live.best_lap_s), PURPLE, sizes[2]),
    ]
    .into_iter()
    .filter_map(|(label, value, color, size)| Some((text(lang, &label), value?, color, size)))
    .collect();
    let step = left_row_h(times.len(), row_h);
    for (i, (label, value, color, size)) in times.iter().enumerate() {
        let y = top + step * i as f32;
        if i > 0 {
            g.fill(g.r(left, y, room, 1.0), EDGE);
        }
        let r = g.r(left, y + 10.0, room, 18.0);
        g.caps(label, r, 11.0, MUTED, DT_LEFT);
        let r = g.r(left - 2.0, y + 28.0, room + 20.0, row_h - 34.0);
        g.text(value, r, *size, semi, Face::Num, *color, DT_LEFT);
    }
    let progress = match (live.dist_m, live.track_length_m) {
        (Some(d), Some(l)) if l > 0.0 => Some((d / l).clamp(0.0, 1.0) as f32),
        _ => None,
    };
    let fuel = fuel_reading(live);
    let (fuel_at, lap_at) = right_plan(row_h, fuel.is_some(), progress.is_some());
    let rx = right - room;
    if let (Some(fuel), Some((dy, h))) = (fuel, fuel_at) {
        fuel_block(g, live, view, fuel, (rx, top + dy, room, h), sizes[0].min(42.0));
    }
    // The lap: the share, the bar and the distance.
    if let (Some(p), Some((dy, _))) = (progress, lap_at) {
        let y = top + dy;
        if dy > 0.0 {
            g.fill(g.r(rx, y, room, 1.0), EDGE);
        }
        let r = g.r(rx, y + 10.0, room, 18.0);
        g.caps(&text(lang, &Msg::PanelLapProgress), r, 11.0, MUTED, DT_RIGHT);
        let r = g.r(rx - 22.0, y + 28.0, room + 24.0, row_h - 30.0);
        g.text(&format!("{:.0}%", p * 100.0), r, sizes[1] + 12.0, semi, Face::Num, TEXT, DT_RIGHT);
        let bar_w = room.min(240.0);
        g.blocks(right - bar_w, y + row_h + 2.0, bar_w, 9.0, 20, 0.0, p, ACCENT);
        if let (Some(d), Some(l)) = (live.dist_m, live.track_length_m) {
            let line = format!("{:.0} / {:.0} m", d.clamp(0.0, l), l);
            let r = g.r(rx, y + row_h + 18.0, room, 16.0);
            g.text(&line, r, 12.5, FW_NORMAL as i32, Face::Ui, MUTED, DT_RIGHT);
        }
    }
}

/// The fuel block: the litres big on the right, the laps they last prominent beside them, a tank gauge under them (a
/// bar of small squares, fuel in the tank against the tank's size) and the use per lap small under the gauge. Only
/// what is known is drawn; the laps and the gauge turn red when the car is driving and the fuel lasts under two laps.
pub(super) fn fuel_block(g: &mut Painter, live: &Live, view: &View, fuel: f32, (x, y, w, _h): Area, size: f32) {
    let (semi, lang) = (FW_SEMIBOLD as i32, view.lang);
    let low = fuel_low(live);
    let r = g.r(x, y + 10.0, w, 18.0);
    g.caps(&text(lang, &Msg::PanelFuel), r, 11.0, MUTED, DT_RIGHT);
    let (line_y, line_h) = (y + 28.0, size * 1.2);
    let litres = format!("{fuel:.1} L");
    let r = g.r(x - 22.0, line_y, w + 24.0, line_h);
    g.text(&litres, r, size, semi, Face::Num, TEXT, DT_RIGHT);
    if let Some(laps) = fuel_laps_text(live, lang) {
        let room = (w - g.width_of(&litres, size, semi, Face::Num) - 14.0).max(40.0);
        let laps_size = g.fitted(&laps, room, 22.0, 12.0, semi, Face::Num);
        let r = g.r(x, line_y, room + 6.0, line_h);
        g.text(&laps, r, laps_size, semi, Face::Num, if low { RED } else { ACCENT }, DT_LEFT);
    }
    let mut at = line_y + line_h + 4.0;
    if let Some(share) = fuel_share(fuel, live.fuel_tank_l) {
        g.blocks(x, at, w, 9.0, 20, 0.0, share, if low { RED } else { ACCENT });
        at += 14.0;
    }
    if let Some(per) = fuel_per_lap_text(live, lang) {
        let r = g.r(x, at, w, 16.0);
        g.text(&per, r, 12.5, FW_NORMAL as i32, Face::Ui, MUTED, DT_LEFT);
    }
}

/// The main dashboard on its 1000 x 520 canvas: rev bar (as wide as the whole layout, `width`), track and car, the
/// lap's times and the fuel on the sides, the delta, the gear between its pedals and the speed over the wheel in the
/// middle, and the car strip along the bottom.
pub(super) fn main_block(g: &mut Painter, live: &Live, view: &View, width: f32) {
    // The rev bar: a dome across the top, green to red as the revs climb, on a cyan line; it flashes blue at the
    // shift point.
    let share = if live.rpm_top > 0.0 { live.rpm / live.rpm_top } else { f32::NAN };
    let (lit, flash) = lights_lit(share);
    let blink_on = view.now_ms / 120 % 2 == 0;
    g.rev_bar(0.0, 0.0, width, 36.0, share, flash && blink_on);
    g.round(g.r(0.0, 37.0, width, 3.0), 1.5, CYAN, None);
    title_line(g, live, view, width, 640.0, true);
    g.fill(g.r(0.0, 95.0, width, 1.0), EDGE);

    side_stats(g, live, view, (0.0, CANVAS_W, 100.0), 98.0, [52.0, 42.0, 42.0], MAIN_SIDE_W);
    centre_block(g, live, view, CANVAS_W / 2.0, 100.0, 140.0, (lit, flash, blink_on));

    // The car strip along the bottom: only the cards that have something to show.
    let strip = STRIP_TOP;
    let plan = strip_plan(0.0, strip, CANVAS_W, CANVAS_H - strip - 8.0, &present_cards(live));
    if !plan.is_empty() {
        g.fill(g.r(0.0, strip - 5.0, CANVAS_W, 1.0), EDGE);
    }
    for (card, area) in plan {
        car_card(g, live, view, card, area);
    }
}

/// The middle of the dashboard: the delta over the gear (its corner brackets turning red near the limit and flashing
/// blue at the shift), the brake and the throttle as columns of small squares outside the brackets (the clutch beside
/// the brake, when the game gives it), the speed under the gear and the wheel as a bar under the speed. Whatever the
/// game gives no value for is not drawn. Returns the line under all of it. `lights` is `(shift lights lit, flashing,
/// blink phase)`.
pub(super) fn centre_block(g: &mut Painter, live: &Live, view: &View, cx: f32, top: f32, frame_h: f32, lights: (usize, bool, bool)) -> f32 {
    let (lit, flash, blink_on) = lights;
    let semi = FW_SEMIBOLD as i32;
    let delta = delta_text(live.delta_s);
    let plan = centre_plan(cx, top, frame_h, delta.is_some());
    if let Some(delta) = delta {
        let delta_color = match live.delta_s {
            Some(d) if d < 0.0 => GREEN,
            _ => RED,
        };
        let r = g.r(cx - 170.0, top, 340.0, 16.0);
        g.caps(&text(view.lang, &Msg::PanelDelta), r, 10.5, MUTED, DT_CENTER);
        let r = g.r(cx - 170.0, top + 14.0, 340.0, 40.0);
        g.text(&delta, r, 38.0, semi, Face::Num, delta_color, DT_CENTER);
        // Each block is a tenth of a second, faster to the left.
        let at = 0.5 + (live.delta_s.unwrap_or(0.0).clamp(-1.0, 1.0) as f32) / 2.0;
        g.blocks(cx - 150.0, top + 56.0, 300.0, 9.0, 20, at.min(0.5), at.max(0.5), delta_color);
        g.fill(g.r(cx - 1.0, top + 52.0, 2.0, 17.0), TEXT);
    }

    if live.gear.is_finite() {
        let frame = match (flash, lit) {
            (true, _) if blink_on => BLUE,
            (true, _) => RED,
            (false, n) if n >= LIGHTS - 2 => RED,
            _ => MUTED,
        };
        let (fx, fy, fw, fh) = plan.frame;
        let (arm, thick) = (26.0, 3.0);
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
        g.text(&gear_text(live.gear), r, fh * 0.93, semi, Face::Num, ACCENT, DT_CENTER);
        let (below, above) = neighbour_gears(live.gear, live.gears);
        for (gear, x) in [(below, fx + 24.0), (above, fx + fw - 64.0)] {
            if let Some(gear) = gear {
                let (w, h) = (40.0, 52.0);
                let y = fy + fh / 2.0 - h / 2.0;
                g.fill(g.r(x, y, w, h), CARD);
                let r = g.r(x, y, w, h);
                g.text(&gear, r, 26.0, semi, Face::Num, MUTED, DT_CENTER);
            }
        }
    }

    // The pedals: columns of small squares (brake red, throttle green, clutch blue), a letter under each. A pedal the
    // game gives no value for is left out.
    let bars: Vec<_> = [
        (Msg::PanelBrake, live.brake, RED, plan.brake),
        (Msg::PanelThrottle, live.throttle, GREEN, plan.throttle),
        (Msg::PanelClutch, live.clutch, BLUE, plan.clutch),
    ]
    .into_iter()
    .filter(|(_, value, _, _)| value.is_finite())
    .collect();
    for (name, value, color, area) in &bars {
        g.pedal_blocks(*area, *value, *color);
        let (bx, by, bw, bh) = *area;
        let r = g.r(bx - 8.0, by + bh + 3.0, bw + 16.0, 14.0);
        g.caps(&pedal_tag(&text(view.lang, name)), r, 9.0, MUTED, DT_CENTER);
    }

    if live.speed_ms.is_finite() {
        let (sx, sy, sw, sh) = plan.speed;
        let r = g.r(sx, sy, sw, sh);
        g.text(&format!("{:.0}", live.speed_ms * 3.6), r, 42.0, semi, Face::Num, TEXT, DT_CENTER);
        let (ux, uy, uw, uh) = plan.unit;
        let r = g.r(ux, uy, uw, uh);
        g.caps("km/h", r, 10.5, MUTED, DT_CENTER);
    }
    if live.steer.is_finite() {
        g.steer_bar(plan.steer, live.steer);
    }
    plan.bottom
}

/// One card: its fill and top edge like a lap card, its title, then what it holds.
pub(super) fn car_card(g: &mut Painter, live: &Live, view: &View, card: CarCard, area: Area) {
    let (x, y, w, h) = area;
    g.fill(g.r(x, y, w, h), CARD);
    g.fill(g.r(x, y, w, 3.0), EDGE);
    let title = match card {
        CarCard::Lights => Msg::PanelLights,
        CarCard::Engine => Msg::PanelEngineFuel,
        CarCard::Electronics => Msg::PanelElectronics,
    };
    let r = g.r(x + 14.0, y + 10.0, w - 28.0, 16.0);
    g.caps(&text(view.lang, &title), r, 10.5, MUTED, DT_LEFT);
    let inner = (x + 14.0, y + 32.0, w - 28.0, (h - 32.0 - 8.0).max(1.0));
    match card {
        CarCard::Lights => lights_card(g, live, view, inner),
        CarCard::Engine => engine_card(g, live, view, inner),
        CarCard::Electronics => electronics_card(g, live, view, inner),
    }
}

pub(super) fn lights_card(g: &mut Painter, live: &Live, view: &View, inner: Area) {
    let pills = light_pills(live);
    for (pill, cell) in pills.iter().zip(light_cells(inner, pills.len())) {
        g.light_tile(view.lang, *pill, cell);
    }
}

pub(super) fn draw_cells(g: &mut Painter, cells: &[Cell], area: Area, cols: usize) {
    let semi = FW_SEMIBOLD as i32;
    for (cell, (x, y, w, h)) in cells.iter().zip(cell_grid(area, cells.len(), cols)) {
        let r = g.r(x, y, w - 4.0, 12.0);
        g.caps(&cell.label, r, 9.0, MUTED, DT_LEFT);
        let size = (h - 12.0).clamp(14.0, 20.0);
        let r = g.r(x - 1.0, y + 12.0, w + 2.0, size + 4.0);
        g.text(&cell.value, r, size, semi, Face::Num, cell.color, DT_LEFT);
    }
}

pub(super) fn engine_card(g: &mut Painter, live: &Live, view: &View, inner: Area) {
    draw_cells(g, &engine_cells(live, view.lang), inner, 2);
}

pub(super) fn electronics_card(g: &mut Painter, live: &Live, view: &View, inner: Area) {
    let cells = electronics_cells(live, view.lang);
    let bars = damage_bars(live, view.lang);
    let (stats_area, bars_area) = electronics_split(inner, !cells.is_empty(), !bars.is_empty());
    draw_cells(g, &cells, stats_area, 2);
    let (bx, by, bw, bh) = bars_area;
    let row_h = (bh / 4.0).min(18.0);
    for (i, (name, share)) in bars.iter().enumerate() {
        let y = by + i as f32 * row_h;
        let r = g.r(bx, y, 44.0, row_h);
        g.caps(name, r, 8.0, MUTED, DT_LEFT);
        let track = (bx + 48.0, y + row_h / 2.0 - 3.0, (bw - 48.0).max(1.0), 6.0);
        g.round(g.r(track.0, track.1, track.2, track.3), 3.0, TRACK, None);
        let color = damage_color(*share);
        // Undamaged is an empty bar with a pip of green, so it still reads as healthy.
        let len = (track.2 * share).max(5.0);
        g.round(g.r(track.0, track.1, len, track.3), 3.0, color, None);
    }
}

/// The right-hand column, from under the header line to `bottom`: the track map, then the four tyres. Whichever has
/// nothing to show gives its room to the other; with neither the column is empty.
pub(super) fn side_column(g: &mut Painter, live: &Live, view: &View, bottom: f32) {
    let (x, w, top) = (CANVAS_W + 24.0, SIDE_W - 24.0, 106.0);
    match (has_map(live), live.tyres.is_some()) {
        (true, true) => {
            let tyres_h = ((bottom - top) * 0.46).clamp(214.0, 330.0);
            track_panel(g, live, view, x, top, w, bottom - top - tyres_h - 14.0);
            tyres_panel(g, live, view, x, bottom - tyres_h, w, tyres_h);
        }
        (true, false) => track_panel(g, live, view, x, top, w, bottom - top),
        (false, true) => tyres_panel(g, live, view, x, top, w, bottom - top),
        (false, false) => {}
    }
}

/// The track map (the car's own path, with where it is now) in a box; nothing until there is enough of a path.
pub(super) fn track_panel(g: &mut Painter, live: &Live, view: &View, x: f32, y: f32, w: f32, h: f32) {
    let Some(map) = live.map.as_ref().filter(|_| has_map(live)) else {
        return;
    };
    let r = g.r(x, y, w, 16.0);
    g.caps(&text(view.lang, &Msg::PanelTrack), r, 10.5, MUTED, DT_LEFT);
    g.track_map((x, y + 22.0, w, h - 22.0), map, live.map_complete, live.pos);
}

/// The four tyres around a quiet top view of the car: a rounded tyre at each corner, partly outside the body, its
/// border and glow in its temperature's colour and its tread left filling it from the bottom. On the outer side the
/// temperature and the pressure; above the front tyres and below the rear ones the brake's temperature with a disc
/// in its colour. When the game says nothing about tyres, nothing is drawn (not even the title).
pub(super) fn tyres_panel(g: &mut Painter, live: &Live, view: &View, x: f32, y: f32, w: f32, h: f32) {
    let Some(tyres) = live.tyres else {
        return;
    };
    let r = g.r(x, y, w, 16.0);
    g.caps(&text(view.lang, &Msg::PanelTyres), r, 10.5, MUTED, DT_LEFT);
    let brakes = tyres.iter().any(|t| t.brake_c.is_finite());
    let plan = schematic(x, y + 22.0, w, h - 22.0, brakes);
    // The car first, so the tyres sit on top of it.
    g.car_body(plan.body);
    for (i, tyre) in tyres.iter().enumerate() {
        tyre_box(g, &plan, i, tyre);
    }
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
    let edge = if known { color } else { mix(BG, MUTED, 0.35) };
    // The glow: a few rings getting fainter outward.
    if known {
        for (grow, amount) in [(5.0, 0.07), (3.5, 0.12), (2.0, 0.2)] {
            g.round(
                g.r(x - grow, y - grow, w + 2.0 * grow, h + 2.0 * grow),
                radius + grow,
                mix(BG, color, amount),
                None,
            );
        }
    }
    g.round(g.r(x, y, w, h), radius, edge, None);
    let base = mix(BG, CARD, 0.55);
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
            let tint = if known { mix(base, color, 0.5) } else { mix(base, MUTED, 0.3) };
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
        let (num_w, psi_w) = (g.width_of(&num, 14.0, semi, Face::Num), g.width_of("psi", 10.0, normal, Face::Ui));
        let ly = top + size * 1.15 + 1.0;
        let (num_x, psi_x) = if right_aligned {
            (rx + rw - psi_w - 4.0 - num_w, rx + rw - psi_w)
        } else {
            (rx, rx + num_w + 4.0)
        };
        let r = g.r(num_x - 1.0, ly, num_w + 2.0, 18.0);
        g.text(&num, r, 14.0, semi, Face::Num, TEXT, DT_LEFT);
        let r = g.r(psi_x, ly + 4.0, psi_w + 2.0, 14.0);
        g.text("psi", r, 10.0, normal, Face::Ui, MUTED, DT_LEFT);
    }
    let (bx, by, bw, bh) = plan.brake[i];
    if tyre.brake_c.is_finite() && bh > 0.0 {
        let label = format!("{:.0} °C", tyre.brake_c);
        let (disc, gap) = (11.0, 5.0);
        let label_w = g.width_of(&label, 12.0, normal, Face::Num);
        let left = bx + (bw - (disc + gap + label_w)) / 2.0;
        g.brake_disc(left + disc / 2.0, by + bh / 2.0, disc, brake_color(tyre.brake_c));
        let r = g.r(left + disc + gap, by, label_w + 4.0, bh);
        g.text(&label, r, 12.0, normal, Face::Num, MUTED, DT_LEFT);
    }
}
