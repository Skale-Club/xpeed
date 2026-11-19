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
            units: view.units,
            laps: view.recent_laps,
        },
    );
    let slots = slots(live.caps);
    let d = Dash {
        live,
        view,
        m: &m,
        slots: &slots,
    };
    let layout = pick_layout_sticky(
        (body.right - body.left) as f32,
        (body.bottom - body.top) as f32,
        &slots,
        view.layout.get(),
    );
    view.layout.set(Some(layout));
    let plan = layout.plan_for(&slots, m.laps.rows.len());
    let (s, ox, oy) = canvas_fit_wh(body, plan.w, plan.h);
    g.place(s, ox, oy);
    header(g, &d, plan.w);
    for &(card, area) in &plan.cards {
        card_frame(g, area);
        match card {
            Pane::Times => times_card(g, &d, area),
            Pane::Centre => centre_card(g, &d, area),
            Pane::Fuel => fuel_card(g, &d, area),
            Pane::Tyres => tyres_card(g, &d, area),
            Pane::Laps => laps_card(g, &d, area),
            Pane::Track => track_card(g, &d, area),
            Pane::Alerts => alerts_card(g, &d, area),
        }
    }
    if let Some(target) = banner_target(&plan) {
        banner(g, &d, target);
    }
}

/// The box over the centre card (else the times card) while the game is paused or silent: a card-coloured box with the title
/// in the caution colour and a line under it. It covers only a card whose values are dimmed anyway, so every slow reading
/// (fuel, tyres, laps, track, alerts) stays readable, and it moves nothing.
pub(super) fn banner(g: &mut Painter, d: &Dash, target: Area) {
    let Some(b) = &d.m.banner else {
        return;
    };
    let semi = FW_SEMIBOLD as i32;
    let room = (target.2 - 2.0 * (S3 + S4)).max(60.0);
    let size = g.fitted(&b.title, room, T_NUMERAL, T_LEAD, semi, Face::Num);
    let title_w = g.tabular_width(&b.title, size, semi).min(room);
    let note_w = room.min(g.width_of(&b.note, T_BODY, FW_NORMAL as i32, Face::Ui));
    let lines = g
        .wrap_lines(&b.note, note_w.max(title_w), T_BODY, FW_NORMAL as i32, Face::Ui)
        .len()
        .max(1);
    let title_h = size * 1.2;
    let note_h = lines as f32 * 20.0;
    let content_w = title_w.max(note_w);
    let (x, y, w, h) = banner_box(target, content_w, title_h + S2 + note_h);
    g.round(g.r(x, y, w, h), CARD, Some(BORDER));
    let r = g.r(x, y + S4, w, title_h);
    g.text(&b.title, r, size, semi, Face::Num, WARN, DT_CENTER);
    g.wrapped(
        &b.note,
        x + S4,
        y + S4 + title_h + S2,
        w - 2.0 * S4,
        T_BODY,
        FW_NORMAL as i32,
        Face::Ui,
        MUTED_TEXT,
        DT_CENTER,
        20.0,
    );
}

/// A card: a rounded `CARD` with its border.
pub(super) fn card_frame(g: &mut Painter, (x, y, w, h): Area) {
    g.round(g.r(x, y, w, h), CARD, Some(BORDER));
}

/// A card's caption: a small upper-case label.
pub(super) fn caption(g: &mut Painter, s: &str, (x, y, w, _): Area, align: u32) {
    let r = g.r(x, y, w, CAPTION_H);
    g.caps(s, r, T_CAPTION, MUTED_TEXT, align);
}

/// A tile on a card: `fill` and a border, with a thin accent along its top edge.
pub(super) fn tile_with_edge(g: &mut Painter, (x, y, w, h): Area, fill: COLORREF, edge: COLORREF) {
    let r = g.r(x, y, w, h);
    g.round(r, fill, Some(BORDER));
    let band = g.r(x, y, w, STROKE_ACCENT);
    g.clip(band);
    g.round(r, edge, None);
    g.unclip();
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
pub(super) fn brand_car_line(g: &mut Painter, live: &Live, view: &View, y: f32, width: f32) -> RECT {
    let catalog: Vec<_> = view.brands.iter().map(|b| b.brand.clone()).collect();
    let Some(brand) = crate::brands::match_brand(&live.car, &catalog) else {
        return g.r(0.0, y, width, 20.0);
    };
    if let Some(art) = view.brands.iter().find(|b| b.brand.key == brand.key) {
        let tile = g.r(0.0, y, 34.0, 20.0);
        g.round(tile, BRAND_TILE, None);
        g.image(g.r(2.0, y + 1.0, 30.0, 18.0), art.image);
        g.r(40.0, y, width - 40.0, 20.0)
    } else {
        g.r(0.0, y, width, 20.0)
    }
}

/// The line over the cards: the rev bar across the top; the track with the session chip, and the car and game under it,
/// on the left; the lap (with the mark of a lap that will not count) and the state line under it on the right.
pub(super) fn header(g: &mut Painter, d: &Dash, width: f32) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (m, view) = (d.m, d.view);
    if d.slots.rev {
        let share = if m.rev.show == Show::Shown { m.rev.frac } else { f32::NAN };
        let flash = lights_lit(share).1;
        let blink_on = view.now_ms / 120 % 2 == 0;
        g.rev_bar(0.0, 0.0, width, REV_H, share, flash && blink_on);
    }
    g.round(g.r(0.0, REV_H + 1.0, width, STROKE_BAR), CYAN, None);

    // A narrow canvas (the single column) gives the lap less room, and leaves the session chip out so the track keeps its name.
    let narrow = width < 500.0;
    let right_w = if narrow { 150.0 } else { 230.0 };
    let left_w = (width - right_w - S4).max(120.0);
    // The track and, after it, the session chip.
    let chip = m
        .session
        .as_ref()
        .filter(|_| !narrow)
        .map(|s| (s.clone(), g.caps_width(s, T_CAPTION) + S4));
    let chip_w = chip.as_ref().map_or(0.0, |(_, w)| w + S3);
    let track = g.clipped(&m.track, left_w - chip_w, T_VALUE, semi, Face::Num);
    let r = g.r(0.0, TITLE_Y, left_w, 30.0);
    g.text(&track, r, T_VALUE, semi, Face::Num, FOREGROUND, DT_LEFT);
    if let Some((word, w)) = chip {
        let x = g.tabular_width(&track, T_VALUE, semi) + S3;
        let (cx, cy, ch) = (x.min(left_w - w), TITLE_Y + 4.0, 22.0);
        g.round(g.r(cx, cy, w, ch), SURFACE, None);
        let r = g.r(cx, cy, w, ch);
        g.caps(&word, r, T_CAPTION, FOREGROUND_2, DT_CENTER);
    }
    let r = brand_car_line(g, d.live, view, TITLE_Y + 31.0, left_w);
    g.text(&m.car, r, T_BODY, normal, Face::Ui, MUTED_TEXT, DT_LEFT);

    // Out of the car (menu, garage) the lap is dim; where there is no lap to number only the state line shows.
    shown(g, m.lap.show, |g| {
        let r = g.r(width - right_w, TITLE_Y, right_w, 32.0);
        g.text(&m.lap.text, r, T_VALUE_L, semi, Face::Num, PRIMARY, DT_RIGHT);
        if m.invalid {
            let at = width - g.tabular_width(&m.lap.text, T_VALUE_L, semi) - S3;
            invalid_flag(g, view, at, TITLE_Y + 5.0, width >= 900.0);
        }
    });
    if let Some((_, line)) = m.status.as_ref().filter(|_| m.banner.is_none()) {
        let r = g.r(width - right_w - S4, TITLE_Y + 36.0, right_w + S4, 18.0);
        g.caps(line, r, T_CAPTION, WARN, DT_RIGHT);
    }
    g.fill(g.r(0.0, CARDS_TOP - S2, width, STROKE_HAIR), BORDER);
}

/// The times card: the lap time as the hero, the delta to the best lap under it (a number and a thin bar centred on
/// zero), then the last and the best lap side by side. The three are one stack under the caption (`times_plan`): grouped
/// with an even gap and centred, a tall card gets the big step of the type scale. On the first lap, where the delta is, a
/// short sentence says when it comes; nothing moves when it does.
pub(super) fn times_card(g: &mut Painter, d: &Dash, card: Area) {
    let semi = FW_SEMIBOLD as i32;
    let (m, slots) = (d.m, d.slots);
    let plan = times_plan(card, slots);
    let (x, y, w, _) = inner(card);
    let (hero, value_size, delta_size) = if plan.big {
        (T_DISPLAY, T_NUMERAL, T_NUMERAL)
    } else {
        (T_HERO, T_VALUE_L, T_VALUE_L)
    };
    if let Some(rule) = plan.rule {
        g.fill(g.r(rule.0, rule.1, rule.2, rule.3), BORDER);
        let col = (w - S3) / 2.0;
        let records = [(slots.last, &m.last_lap), (slots.best, &m.best_lap)];
        for (i, (_, elem)) in records.iter().filter(|(on, _)| *on).enumerate() {
            let cx = x + i as f32 * (col + S3);
            shown(g, elem.show, |g| {
                let (_, ry, _, rh) = plan.records;
                caption(g, &elem.label, (cx, ry, col, CAPTION_H), DT_LEFT);
                let size = g.fitted(&elem.text, col, value_size, T_BODY, semi, Face::Num);
                let r = g.r(cx - 1.0, ry + CAPTION_H + S1, col + 2.0, rh - CAPTION_H - S1);
                g.text(&elem.text, r, size, semi, Face::Num, elem.role.colour(), DT_LEFT);
            });
        }
    }
    let lap = &m.lap_time;
    if slots.lap_time {
        shown(g, lap.show, |g| {
            caption(g, &lap.label, (x, y, w, CAPTION_H), DT_LEFT);
            let (_, ly, _, lh) = plan.lap;
            let size = g.fitted(&lap.text, w, hero, T_VALUE_L, semi, Face::Num);
            let r = g.r(x - 2.0, ly, w + 4.0, lh);
            g.text(&lap.text, r, size, semi, Face::Num, lap.role.colour(), DT_LEFT);
        });
    }
    if slots.delta {
        let delta = &m.delta;
        let (_, gy, _, gh) = plan.delta;
        if delta.visible() {
            shown(g, delta.show, |g| {
                let r = g.r(x - 1.0, gy, w, gh);
                g.text(&delta.text, r, delta_size, semi, Face::Num, delta.role.colour(), DT_LEFT);
                let nw = g.tabular_width(&delta.text, delta_size, semi);
                let r = g.r(x + nw + S2, gy + gh - 26.0, (w - nw - S2).max(1.0), 20.0);
                g.text(&m.delta_vs, r, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_LEFT);
                g.centred_bar(plan.bar, delta.frac, delta.role.colour(), FOREGROUND);
            });
        } else if let Some(note) = &m.delta_note {
            shown(g, Show::Dimmed, |g| {
                g.wrapped(note, x, gy, w, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_LEFT, 20.0);
            });
        }
    }
}

/// The centre card: the gear big with the gears either side of it quiet, the speed under it with its unit, the pedals as
/// three solid bars with their names and percentages over them, and the wheel under them.
pub(super) fn centre_card(g: &mut Painter, d: &Dash, card: Area) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (m, slots) = (d.m, d.slots);
    let plan = centre_plan(card, slots);
    shown(g, m.gear.show, |g| {
        let (gx, gy, gw, gh) = plan.gear;
        let r = g.r(gx, gy, gw, gh);
        g.text(&m.gear.text, r, gh * GEAR_FILL, semi, Face::Num, PRIMARY, DT_CENTER);
        for (gear, (x, y, w, h)) in [(&m.gear_below, plan.below), (&m.gear_above, plan.above)] {
            if gear.visible() {
                let r = g.r(x, y, w, h);
                g.text(&gear.text, r, T_VALUE_L, semi, Face::Num, GREY, DT_CENTER);
            }
        }
    });
    shown(g, m.speed.show, |g| {
        let (sx, sy, sw, sh) = plan.speed;
        let r = g.r(sx, sy, sw, sh);
        g.text(&m.speed.text, r, T_NUMERAL_L, semi, Face::Num, FOREGROUND, DT_CENTER);
        let (ux, uy, uw, uh) = plan.unit;
        let r = g.r(ux, uy, uw, uh);
        g.caps(m.speed.unit, r, T_CAPTION, MUTED_TEXT, DT_CENTER);
    });
    for (elem, place) in [&m.throttle, &m.brake, &m.clutch].into_iter().zip(plan.pedals) {
        let Some(((lx, ly, lw, lh), bar)) = place else {
            continue;
        };
        shown(g, elem.show, |g| {
            // The name left and the percentage right; a name that does not fit with it gives way to its short one.
            let pct = g.tabular_width(&elem.text, T_CAPTION, normal);
            let name = if g.caps_width(&elem.label, T_CAPTION) + pct + S2 <= lw {
                &elem.label
            } else {
                &elem.short
            };
            let r = g.r(lx, ly, lw, lh);
            g.caps(name, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            let r = g.r(lx, ly, lw, lh);
            g.text(&elem.text, r, T_CAPTION, normal, Face::Num, FOREGROUND_2, DT_RIGHT);
            g.solid_bar(bar, elem.frac, elem.role.colour());
        });
    }
    shown(g, m.steer.show, |g| g.steer_bar(plan.steer, m.steer.frac));
}

/// The fuel card: the laps of fuel left as the hero (green, amber under five laps, red under two, while driving), the
/// litres and the tank's size beside it, a tank bar with a tick for each lap's worth of fuel and what a lap takes under
/// it; the water and oil temperatures at the bottom when the game gives them.
pub(super) fn fuel_card(g: &mut Painter, d: &Dash, card: Area) {
    let semi = FW_SEMIBOLD as i32;
    let m = d.m;
    let (x, y, w, h) = inner(card);
    caption(g, &m.fuel_title, (x, y, w, CAPTION_H), DT_LEFT);
    let cells = &m.engine;
    let hero_h = 52.0;
    let bar_h = if m.fuel_share.is_some() { S2 + 14.0 } else { 0.0 };
    let line_h = if m.fuel_per_lap.visible() { S2 + 16.0 } else { 0.0 };
    // The fuel group and the temperatures are one stack under the caption, grouped and centred (`fuel_plan`).
    let plan = fuel_plan(card, hero_h + bar_h + line_h, !cells.is_empty());
    let gy = plan.group.1;
    if m.fuel.visible() {
        shown(g, m.fuel.show, |g| {
            let half = w / 2.0;
            if m.fuel_laps.visible() {
                // The laps left on the left, the litres on the right.
                let size = g.fitted(&m.fuel_laps.text, half - S2, T_NUMERAL_L, T_VALUE, semi, Face::Num);
                let r = g.r(x - 1.0, gy, half, hero_h);
                g.text(&m.fuel_laps.text, r, size, semi, Face::Num, m.fuel_laps.role.colour(), DT_LEFT);
                let used = g.tabular_width(&m.fuel_laps.text, size, semi);
                let r = g.r(x + used + S2, gy + 22.0, (half - used - S2).max(1.0), 22.0);
                g.text(&m.fuel_laps.label, r, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_LEFT);
                let litres = format!("{} {}", m.fuel.text, m.fuel.unit);
                let size = g.fitted(&litres, half, T_VALUE_L, T_BODY, semi, Face::Num);
                let r = g.r(x + half, gy + 2.0, half + 1.0, 30.0);
                g.text(&litres, r, size, semi, Face::Num, FOREGROUND, DT_RIGHT);
                if m.fuel_tank.visible() {
                    let r = g.r(x + half, gy + 32.0, half + 1.0, 18.0);
                    g.text(&m.fuel_tank.text, r, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_RIGHT);
                }
            } else {
                // No laps (the use per lap is not known yet): the litres are the hero.
                let litres = format!("{} {}", m.fuel.text, m.fuel.unit);
                let size = g.fitted(&litres, w * 0.6, T_NUMERAL_L, T_VALUE, semi, Face::Num);
                let r = g.r(x - 1.0, gy, w * 0.6, hero_h);
                g.text(&litres, r, size, semi, Face::Num, FOREGROUND, DT_LEFT);
                if m.fuel_tank.visible() {
                    let r = g.r(x + w * 0.6, gy + 17.0, w * 0.4 + 1.0, 18.0);
                    g.text(&m.fuel_tank.text, r, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_RIGHT);
                }
            }
            let mut at = gy + hero_h;
            if let Some(share) = m.fuel_share {
                let colour = if m.fuel_laps.visible() {
                    m.fuel_laps.role.colour()
                } else {
                    SUCCESS
                };
                g.tank_bar((x, at + S2, w, 14.0), share, m.fuel_tick, colour);
                at += bar_h;
            }
            if m.fuel_per_lap.visible() {
                let r = g.r(x, at + S2, w, 16.0);
                g.text(&m.fuel_per_lap.text, r, T_CAPTION, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_LEFT);
            }
        });
    }
    let col = w / cells.len().max(1) as f32;
    let temps_y = plan.temps.map_or(y + h, |t| t.1);
    for (i, cell) in cells.iter().enumerate() {
        let cx = x + i as f32 * col;
        shown(g, cell.show, |g| {
            caption(g, &cell.label, (cx, temps_y, col, CAPTION_H), DT_LEFT);
            let r = g.r(cx - 1.0, temps_y + CAPTION_H + S1, col, 28.0);
            g.text(&cell.value, r, T_VALUE, semi, Face::Num, cell.role.colour(), DT_LEFT);
        });
    }
}

/// The tyres card: the compound in its header, and a tile for each tyre in a grid of two by two.
pub(super) fn tyres_card(g: &mut Painter, d: &Dash, card: Area) {
    let Some(tyres) = &d.m.tyres else {
        return;
    };
    let (x, y, w, _) = inner(card);
    shown(g, tyres.show, |g| {
        caption(g, &tyres.title, (x, y, w, CAPTION_H), DT_LEFT);
        if let Some(compound) = &tyres.compound {
            caption(g, compound, (x, y, w, CAPTION_H), DT_RIGHT);
        }
        for (i, (tile, area)) in tyres.tiles.iter().zip(tyre_tiles(card)).enumerate() {
            tyre_tile_view(g, tile, &tyres.brake_label, area, i.is_multiple_of(2));
        }
    });
}

/// One tyre's tile: the tyre drawn from above on its outer side (`Painter::tyre_shape`: three bands across the tread
/// when the game gives them, one block otherwise, in the colours of the temperatures), and beside it its corner and state
/// word, the temperature, the three readings across the tread, the pressure and the brake in a small row, and a thin
/// wear bar when the game gives the wear. What does not fit the tile's height is left out, the wear first, then the
/// readings across the tread.
pub(super) fn tyre_tile_view(g: &mut Painter, t: &TyreTile, brake_label: &str, area: Area, left_side: bool) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    tile_with_edge(g, area, BACKGROUND, t.role.colour());
    let (x, y, w, h) = area;
    // The rows, by what they need; the padding shrinks before a row goes.
    let (head_h, temp_h, tread_h, row_h, wear_h) = (16.0, 30.0, 16.0, 18.0, 7.0);
    let base = head_h + temp_h + if t.pressure.is_some() || t.brake.is_some() { row_h } else { 0.0 };
    let pad = if h >= base + tread_h + wear_h + 2.0 * S2 { S2 } else { S1 };
    let room = h - 2.0 * pad;
    let tread = t.tread_text.as_ref().filter(|_| room >= base + tread_h);
    let wear = t
        .wear
        .filter(|_| room >= base + if tread.is_some() { tread_h } else { 0.0 } + wear_h);
    let mut at = y + pad + STROKE_ACCENT * 0.5;
    // The tyre on the tile's outer side (left for a left tyre), the words beside it. It spans exactly the words: its top
    // on the top of the corner's letters (FL), its bottom on the last row drawn, never the empty rest of the tile.
    let small_row = t.pressure.is_some() || t.brake.is_some();
    let words_h = head_h
        + temp_h
        + if tread.is_some() { tread_h } else { 0.0 }
        + if small_row { row_h } else { 0.0 }
        + if wear.is_some() { wear_h } else { 0.0 };
    let cap_inset = (head_h - T_CAPTION * TYRE_CAP_HEIGHT) / 2.0;
    let shape_h = (words_h - 2.0 * cap_inset).max(1.0);
    let shape_w = (shape_h * TYRE_ASPECT).clamp(14.0, (w * 0.28).max(14.0));
    let shape_x = if left_side { x + S2 } else { x + w - S2 - shape_w };
    g.tyre_shape((shape_x, at + cap_inset, shape_w, shape_h), t.shape);
    let iw = (w - 3.0 * S2 - shape_w).max(1.0);
    let ix = if left_side { x + 2.0 * S2 + shape_w } else { x + S2 };
    let r = g.r(ix, at, iw, head_h);
    g.caps(&t.corner, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
    if !t.word.is_empty() {
        let r = g.r(ix, at, iw, head_h);
        g.caps(&t.word, r, T_CAPTION, t.role.colour(), DT_RIGHT);
    }
    at += head_h;
    let size = g.fitted(&t.temp, iw, T_VALUE_L, T_BODY, semi, Face::Num);
    let r = g.r(ix - 1.0, at, iw + 2.0, temp_h);
    g.text(&t.temp, r, size, semi, Face::Num, t.heat, DT_LEFT);
    at += temp_h;
    if let Some(points) = tread {
        // The three readings as the tyre draws them, each in its colour, a quiet dot between.
        let mut cx = ix;
        for (k, (number, colour)) in points.iter().enumerate() {
            if k > 0 {
                let dot_w = g.width_of("·", T_CAPTION, normal, Face::Ui) + S1;
                let r = g.r(cx, at, dot_w, tread_h);
                g.text("·", r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_CENTER);
                cx += dot_w;
            }
            let nw = g.tabular_width(number, T_CAPTION, semi);
            let r = g.r(cx, at, nw + 2.0, tread_h);
            g.text(number, r, T_CAPTION, semi, Face::Num, *colour, DT_LEFT);
            cx += nw;
        }
        at += tread_h;
    }
    if t.pressure.is_some() || t.brake.is_some() {
        let r = g.r(ix, at, iw, row_h);
        // The pressure on the left and the brake on the right; the brake's word goes when they would meet.
        let mut left_w = 0.0;
        if let Some((num, unit)) = &t.pressure {
            let nw = g.tabular_width(num, T_BODY, semi);
            g.text(num, g.r(ix, at, nw + 2.0, row_h), T_BODY, semi, Face::Num, FOREGROUND, DT_LEFT);
            g.text(
                unit,
                g.r(ix + nw + S1, at, iw, row_h),
                T_CAPTION,
                normal,
                Face::Ui,
                MUTED_TEXT,
                DT_LEFT,
            );
            left_w = nw + S1 + g.width_of(unit, T_CAPTION, normal, Face::Ui);
        }
        if let Some(brake) = &t.brake {
            let bw = g.tabular_width(brake, T_BODY, semi);
            let lw = g.width_of(brake_label, T_CAPTION, normal, Face::Ui);
            let with_word = left_w + S2 + lw + S1 + bw <= iw;
            g.text(brake, r, T_BODY, semi, Face::Num, FOREGROUND_2, DT_RIGHT);
            if with_word {
                let r = g.r(ix, at, iw - bw - S1, row_h);
                g.text(brake_label, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_RIGHT);
            }
        }
        at += row_h;
    }
    if let Some(wear) = wear {
        g.solid_bar((ix, at + 2.0, iw, 3.0), wear, FOREGROUND_2);
    }
}

/// The laps table, newest first: the lap being driven in the accent colour with its sectors so far, then each lap done
/// with its time, its gap to the best and (when the game gives them) its sectors. The best lap and the best sectors are in
/// the best colour; a lap that did not count is quiet with its time struck through.
pub(super) fn laps_card(g: &mut Painter, d: &Dash, card: Area) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let laps = &d.m.laps;
    let (x, y, w, _) = inner(card);
    shown(g, laps.show, |g| {
        caption(g, &laps.title, (x, y, w, CAPTION_H), DT_LEFT);
        let cols = lap_columns(w, laps.sectors);
        let head_y = y + CAPTION_H + S2;
        let heads: Vec<String> = laps
            .heads
            .iter()
            .cloned()
            .chain(["S1", "S2", "S3"].into_iter().map(str::to_owned))
            .take(cols.len())
            .collect();
        for (i, (head, (cx, cw))) in heads.iter().zip(&cols).enumerate() {
            let r = g.r(x + cx, head_y, *cw - if i == 0 { 0.0 } else { S2 }, LAP_HEAD_H);
            g.caps(head, r, T_CAPTION, MUTED_TEXT, if i == 0 { DT_LEFT } else { DT_RIGHT });
        }
        g.fill(g.r(x, head_y + LAP_HEAD_H - 1.0, w, STROKE_HAIR), BORDER);
        let fit = lap_rows_fit(card.3);
        let top = head_y + LAP_HEAD_H;
        if laps.rows.is_empty() {
            let r = g.r(x, top + S3, w, 20.0);
            g.text(&laps.empty, r, T_BODY, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        }
        for (i, row) in laps.rows.iter().take(fit).enumerate() {
            let ry = top + i as f32 * LAP_ROW_H;
            shown(g, row.show, |g| {
                let line = |g: &mut Painter, col: usize, s: &str, colour: COLORREF, struck: bool| {
                    let (cx, cw) = cols[col];
                    let (align, left, width) = if col == 0 {
                        (DT_LEFT, x + cx, cw)
                    } else {
                        (DT_RIGHT, x + cx, cw - S2)
                    };
                    let r = g.r(left, ry, width, LAP_ROW_H);
                    if struck {
                        g.text_struck(s, r, T_BODY, semi, colour, align, DESTRUCTIVE);
                    } else {
                        g.text(s, r, T_BODY, semi, Face::Num, colour, align);
                    }
                };
                let number_colour = if row.kind == LapKind::Live { PRIMARY } else { MUTED_TEXT };
                line(g, 0, &row.number, number_colour, false);
                line(g, 1, &row.time, row.time_role.colour(), row.kind == LapKind::Invalid);
                line(g, 2, &row.gap, row.gap_role.colour(), false);
                for (s, sector) in row.sectors.iter().enumerate() {
                    if cols.len() > 3 + s {
                        match sector {
                            Some((text, role)) => line(g, 3 + s, text, role.colour(), false),
                            None if row.kind == LapKind::Live => line(g, 3 + s, "–", MUTED_TEXT, false),
                            None => line(g, 3 + s, "–", MUTED_TEXT, false),
                        }
                    }
                }
                g.fill(g.r(x, ry + LAP_ROW_H - 1.0, w, STROKE_HAIR), BORDER);
            });
        }
    });
}

/// The live track card: an upward-facing car and the next corners in a local perspective.
/// Recorded movement drives the camera directly; the site keeps the top-down lap-study map.
pub(super) fn track_card(g: &mut Painter, d: &Dash, card: Area) {
    let (normal, semi) = (FW_NORMAL as i32, FW_SEMIBOLD as i32);
    let m = d.m;
    let (x, y, w, h) = inner(card);
    shown(g, m.map, |g| {
        caption(g, &m.map_title, (x, y, w, CAPTION_H), DT_LEFT);
    });
    let line_h = if m.progress.visible() { 20.0 } else { 0.0 };
    let map_box = (x, y + CAPTION_H + S1, w, (h - CAPTION_H - S1 - line_h - S1).max(1.0));
    shown(g, m.map, |g| {
        let rendered = d
            .live
            .map
            .as_ref()
            .filter(|_| has_map(d.live))
            .zip(d.live.pos)
            .zip(d.live.heading)
            .is_some_and(|((map, car), heading)| {
                g.track_perspective(
                    map_box,
                    map,
                    d.live.map_complete,
                    d.live.road.as_deref(),
                    &d.live.trail,
                    d.live.reference.as_ref(),
                    car,
                    heading,
                    crate::perspective::mirrored_ground(d.live.game),
                )
            });
        let msg = if !has_map(d.live) {
            Msg::PanelTrackLearning
        } else if d.live.pos.is_none() {
            Msg::PanelTrackPosition
        } else if !rendered {
            Msg::PanelTrackDirection
        } else if let Some(road) = &d.live.road {
            match road.kind {
                crate::perspective::RoadKind::AiEnvelope => Msg::PanelTrackRoad,
                crate::perspective::RoadKind::Asphalt => Msg::PanelTrackAsphalt,
                crate::perspective::RoadKind::WhiteLine => Msg::PanelTrackLimits,
                crate::perspective::RoadKind::Estimated => Msg::PanelTrackEstimated,
            }
        } else {
            Msg::PanelTrackPaths
        };
        let note = text(d.view.lang, &msg);
        let (mx, my, mw, mh) = map_box;
        let r = if rendered {
            g.r(mx + S1, my + S1, mw - 2.0 * S1, 16.0)
        } else {
            g.r(mx + S2, my + mh / 2.0 - 12.0, mw - 2.0 * S2, 24.0)
        };
        let size = g.fitted(&note, mw - 2.0 * S2, T_CAPTION, 9.0, normal, Face::Ui);
        g.text(
            &note,
            r,
            size,
            normal,
            Face::Ui,
            MUTED_TEXT,
            if rendered { DT_LEFT } else { DT_CENTER },
        );
        if rendered && d.live.reference.is_some() {
            let r = g.r(mx + S1, my + S1 + 17.0, mw - 2.0 * S1, 16.0);
            g.text(
                &text(d.view.lang, &Msg::PanelTrackSessionBest),
                r,
                T_CAPTION,
                normal,
                Face::Ui,
                INFO,
                DT_LEFT,
            );
        }
    });
    if m.progress.visible() {
        shown(g, m.progress.show, |g| {
            let r = g.r(x, y + h - line_h, w, line_h);
            g.text(&m.progress.text, r, T_BODY, semi, Face::Ui, FOREGROUND, DT_LEFT);
            let used = g.width_of(&m.progress.text, T_BODY, semi, Face::Ui);
            if m.distance.visible() && used + g.tabular_width(&m.distance.text, T_BODY, normal) + S4 <= w {
                let r = g.r(x, y + h - line_h, w, line_h);
                g.text(&m.distance.text, r, T_BODY, normal, Face::Num, MUTED_TEXT, DT_RIGHT);
            }
        });
    }
}

/// The alerts card: only the alerts that are lit, as solid tiles with their words; then one row of the electronics'
/// settings and a short damage line. An alert that is off is not drawn at all.
pub(super) fn alerts_card(g: &mut Painter, d: &Dash, card: Area) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let m = d.m;
    let (x, y, w, h) = inner(card);
    caption(g, &m.alerts_title, (x, y, w, CAPTION_H), DT_LEFT);
    // From the bottom: the damage line, the electronics row, and the alerts take what is above them.
    let damage_h = if m.damage.visible() { 18.0 } else { 0.0 };
    let elec_h = if m.electronics.is_empty() { 0.0 } else { 50.0 };
    let mut bottom = y + h;
    if m.damage.visible() {
        shown(g, m.damage.show, |g| {
            let r = g.r(x, bottom - damage_h, w, damage_h);
            let colour = if m.damage.role == Role::Warn { WARN } else { MUTED_TEXT };
            g.text(&m.damage.text, r, T_BODY, normal, Face::Ui, colour, DT_LEFT);
        });
        bottom -= damage_h + S2;
    }
    if !m.electronics.is_empty() {
        let n = m.electronics.len() as f32;
        let cw = (w - S2 * (n - 1.0)) / n;
        for (i, cell) in m.electronics.iter().enumerate() {
            let cx = x + i as f32 * (cw + S2);
            shown(g, cell.show, |g| {
                g.round(g.r(cx, bottom - elec_h, cw, elec_h), BACKGROUND, Some(BORDER));
                let r = g.r(cx + S2, bottom - elec_h + 6.0, cw - S3, 14.0);
                g.caps(&cell.label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
                let size = g.fitted(&cell.value, cw - S3, T_VALUE, T_BODY, semi, Face::Num);
                let r = g.r(cx + S2 - 1.0, bottom - elec_h + 22.0, cw - S3 + 2.0, 24.0);
                g.text(&cell.value, r, size, semi, Face::Num, cell.role.colour(), DT_LEFT);
            });
        }
        bottom -= elec_h + S2;
    }
    let top = y + CAPTION_H + S2;
    let region = (x, top, w, (bottom - top).max(0.0));
    if m.alerts.is_empty() {
        let r = g.r(x, top, w, 20.0);
        g.text(&m.no_alerts, r, T_BODY, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        return;
    }
    let tile_h = 28.0;
    let widths: Vec<f32> = m.alerts.iter().map(|a| g.caps_width(&a.word, T_CAPTION) + S4 + S2).collect();
    for (alert, place) in m.alerts.iter().zip(flow(region, &widths, tile_h, S2)) {
        if let Some(area) = place {
            shown(g, alert.show, |g| g.alert_tile(alert, area));
        }
    }
}
