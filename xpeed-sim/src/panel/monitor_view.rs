use super::*;

pub(super) fn monitor(g: &mut Painter, body: RECT, view: &View) {
    let s = view.scale;
    g.place(s, body.left, body.top);
    let (w, h) = ((body.right - body.left) as f32 / s, (body.bottom - body.top) as f32 / s);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let gap = S4;
    let footer = 26.0;
    // Two columns side by side; in a narrow window (a phone held upright) one under the other.
    let stacked = w < 640.0;
    let col = if stacked { w } else { (w - gap) / 2.0 };
    let right = if stacked { 0.0 } else { col + gap };
    let left_h = if stacked { ((h - footer - gap) * 0.55).round() } else { h - footer };
    let area_h = left_h;

    // The games list takes the whole left column (the account and updates are on the Settings screen): its rows get lower
    // and, when even that is not enough, the list scrolls. Nothing is ever drawn outside its card, whatever the window's size.
    let games = view.games.len().max(1);
    let (games_h, row_h, max_scroll) = games_layout(games, area_h);
    // The card fills the column even when the list is short.
    let games_h = games_h.max(area_h);
    let offset = view.games_scroll.clamp(0.0, max_scroll);
    let scrolling = max_scroll > 0.0;

    // Games: each reader with its cover, its name and a status pill; the list scrolls inside its card when it is
    // longer than the room (mouse wheel, or the thin bar at the right).
    g.tile(0.0, 0.0, col, games_h, CARD);
    g.label(&text(view.lang, &Msg::PanelGames), 20.0, S4, col - 40.0);
    let (list_top, list_bottom) = (42.0, games_h - S2);
    let bar = if scrolling { 14.0 } else { 0.0 };
    g.clip(g.r(0.0, list_top, col, list_bottom - list_top));
    for (i, row) in view.games.iter().enumerate() {
        let y = list_top + row_h * i as f32 - offset;
        if y + row_h < list_top || y > list_bottom {
            continue;
        }
        if i > 0 {
            g.fill(g.r(20.0, y, col - 40.0 - bar, 1.0), BORDER);
        }
        // The cover, small; the game's initial on a card when there is none.
        let th = (row_h - 10.0).min(42.0);
        let tw = th * 2.0 / 3.0;
        let thumb = g.r(20.0, y + (row_h - th) / 2.0, tw, th);
        match cover_for(row.key, view.covers) {
            Some(image) => g.image(thumb, image),
            None => {
                g.fill(thumb, SECONDARY);
                let initial: String = row.title.chars().take(1).collect();
                g.text(&initial, thumb, T_BODY, semi, Face::Num, MUTED_TEXT, DT_CENTER);
            }
        }
        // The name with a line of context under it (the lap and track while recording), and the status word.
        let state = text(view.lang, &Msg::MonitorWord(row.state.clone()));
        let pill_w = g.width_of(&state, T_CAPTION, semi, Face::Ui) + 22.0;
        let text_x = 20.0 + tw + 14.0;
        let text_w = col - text_x - 40.0 - bar - pill_w;
        let track = match row.state {
            Game::Recording(_) => view.live.map(|live| live.track.clone()).filter(|track| !track.is_empty()),
            _ => None,
        };
        let context = text(view.lang, &Msg::MonitorContext(row.state.clone(), track));
        let r = g.r(text_x, y + row_h / 2.0 - 19.0, text_w, 20.0);
        g.text(&row.title, r, T_BODY, normal, Face::Ui, FOREGROUND, DT_LEFT);
        let r = g.r(text_x, y + row_h / 2.0 + 1.0, text_w, 17.0);
        g.text(&context, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        pill(
            g,
            col - 20.0 - bar - pill_w,
            y + (row_h - S6) / 2.0,
            pill_w,
            &state,
            state_color(&row.state),
        );
    }
    g.unclip();
    if scrolling {
        // A thin square bar: the track in the edge colour, the thumb lit when the mouse is on it.
        let track_h = list_bottom - list_top;
        let content = row_h * games as f32;
        let thumb_h = (track_h * track_h / content).clamp(S6, track_h);
        let thumb_y = list_top + (track_h - thumb_h) * offset / max_scroll;
        let x = col - 17.0;
        g.fill(g.r(x, list_top, 3.0, track_h), BORDER);
        let thumb_hit = g.r(x - 6.0, thumb_y, 15.0, thumb_h);
        let lit = view.mouse.is_some_and(|(mx, my)| inside(&thumb_hit, mx, my));
        g.fill(g.r(x - 1.0, thumb_y, 5.0, thumb_h), if lit { PRIMARY } else { MUTED_TEXT });
        view.scroll.set(Some(ScrollBar {
            area: g.r(0.0, 0.0, col, games_h),
            track: g.r(x - 6.0, list_top, 15.0, track_h),
            thumb: thumb_hit,
            max: max_scroll,
            per_px: max_scroll / ((track_h - thumb_h).max(1.0) * s),
        }));
    }

    // The right column (laps and activity), under the left one when stacked.
    let area_h = if stacked { h - footer - left_h - gap } else { h - footer };
    if stacked {
        g.place(s, body.left, body.top + ((left_h + gap) * s).round() as i32);
    }
    // Laps saved, newest first.
    let laps_h = if stacked {
        (area_h * 0.4).max(110.0)
    } else {
        (area_h * 0.44).max(150.0)
    };
    g.tile(right, 0.0, col, laps_h, CARD);
    g.label(&text(view.lang, &Msg::PanelLaps), right + 20.0, S4, col - 40.0);
    if view.recent_laps.is_empty() {
        let r = g.r(right + 20.0, 44.0, col - 40.0, S6);
        g.text(
            &text(view.lang, &Msg::PanelNoLaps),
            r,
            T_BODY,
            normal,
            Face::Ui,
            MUTED_TEXT,
            DT_LEFT,
        );
    } else {
        // The count beside the title only when both fit on the line (in a small window they would run into each other).
        // How many, and the newest lap's track and car when the game gave them.
        let newest = view.recent_laps.last().filter(|l| !l.track.is_empty() && !l.car.is_empty());
        let count = match newest {
            Some(lap) => Msg::PanelLapsWhere(view.snapshot.laps_saved, lap.track.clone(), lap.car.clone()),
            None => Msg::PanelLapsCount(view.snapshot.laps_saved),
        };
        let count = text(view.lang, &count);
        let title = text(view.lang, &Msg::PanelLaps).to_uppercase();
        let need = g.width_of(&count, T_CAPTION, normal, Face::Ui) + g.width_of(&title, T_CAPTION, semi, Face::Label) * 1.3 + S6;
        if need <= col - 40.0 {
            let r = g.r(right + 20.0, 14.0, col - 40.0, 22.0);
            g.text(&count, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_RIGHT);
        }
        let lap_row = 34.0;
        let room = ((laps_h - 52.0) / lap_row).floor().max(0.0) as usize;
        // One speed scale for the laps shown, so their mini graphs compare.
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for lap in view.recent_laps.iter().rev().take(room) {
            for &v in &lap.speed_kmh {
                (lo, hi) = (lo.min(f32::from(v)), hi.max(f32::from(v)));
            }
        }
        for (i, saved) in view.recent_laps.iter().rev().take(room).enumerate() {
            let y = 44.0 + lap_row * i as f32;
            if i > 0 {
                g.fill(g.r(right + 20.0, y, col - 40.0, 1.0), BORDER);
            }
            let name = text(view.lang, &Msg::PanelLap(saved.number as i32));
            let time = clock(saved.time_ms);
            let invalid = !saved.valid;
            let r = g.r(right + 20.0, y, col / 2.0, lap_row);
            g.text(&name, r, T_BODY, normal, Face::Ui, FOREGROUND_2, DT_LEFT);
            // The time stays in its half of the row (smaller when it is long), the mark of an invalid lap before it.
            let room = col / 2.0 - 20.0 - if invalid { S6 } else { 0.0 };
            let size = g.fitted(&time, room, T_LEAD, T_CAPTION, semi, Face::Num);
            let color = match (invalid, i) {
                (true, _) => MUTED_TEXT,
                (_, 0) => PRIMARY,
                _ => FOREGROUND,
            };
            let r = g.r(right + col / 2.0, y, col / 2.0 - 20.0, lap_row);
            g.text(&time, r, size, semi, Face::Num, color, DT_RIGHT);
            // The lap's speed between its name and its time: yellow the newest, quiet the others.
            let (spark_x, spark_w) = (right + 96.0, col / 2.0 - 96.0);
            if spark_w >= 40.0 {
                let ink = if i == 0 && !invalid { PRIMARY } else { MUTED_TEXT };
                g.sparkline((spark_x, y + 9.0, spark_w, lap_row - 18.0), &saved.speed_kmh, (lo, hi), ink);
            }
            if invalid {
                // The digits are set a little wider than the plain measure: leave room.
                let used = g.width_of(&time, size, semi, Face::Num) * 1.18 + S2;
                g.invalid_mark(right + col - 20.0 - used - 22.0, y + (lap_row - S4) / 2.0, S4);
            }
        }
    }

    // Activity: what happened, newest first, in plain words (the technical log stays in the log file).
    let log_y = laps_h + gap;
    g.tile(right, log_y, col, area_h - log_y, CARD);
    g.label(&text(view.lang, &Msg::PanelActivity), right + 20.0, log_y + S4, col - 40.0);
    if view.activity.is_empty() {
        let r = g.r(right + 20.0, log_y + 44.0, col - 40.0, S6);
        g.text(
            &text(view.lang, &Msg::PanelNoActivity),
            r,
            T_BODY,
            normal,
            Face::Ui,
            MUTED_TEXT,
            DT_LEFT,
        );
    }
    let line_h = S8;
    let room = ((area_h - log_y - 52.0) / line_h).floor().max(0.0) as usize;
    for (i, (time, line, tone)) in view.activity.iter().take(room).enumerate() {
        let y = log_y + 42.0 + line_h * i as f32;
        if i > 0 {
            g.fill(g.r(right + 20.0, y, col - 40.0, 1.0), BORDER);
        }
        let r = g.r(right + 20.0, y, 52.0, line_h);
        g.text(time, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        // A square dot in the colour of what it was (owner-approved module 10, 2026-11-19).
        g.fill(g.r(right + 72.0, y + (line_h - S2) / 2.0, S2, S2), tone.colour());
        let r = g.r(right + 90.0, y, col - 110.0, line_h);
        g.text(line, r, T_BODY, normal, Face::Ui, FOREGROUND, DT_LEFT);
    }

    // The footer: a part that stopped, in red (the support button is on the Settings screen), and the shortcuts at the right
    // while there is room for them.
    g.place(s, body.left, body.top);
    let note = (!view.failed.is_empty()).then(|| text(view.lang, &Msg::WorkersFailed(view.failed.to_owned())));
    let hint = text(view.lang, &Msg::PanelHint);
    let hint_w = g.width_of(&hint, T_CAPTION, normal, Face::Ui);
    let note_w = note.as_ref().map_or(0.0, |t| g.width_of(t, T_CAPTION, normal, Face::Ui));
    if let Some(line) = &note {
        let r = g.r(0.0, h - 22.0, w, 20.0);
        g.text(line, r, T_CAPTION, normal, Face::Ui, DESTRUCTIVE, DT_LEFT);
    }
    if note_w + hint_w + S6 <= w {
        let r = g.r(0.0, h - 20.0, w, 20.0);
        g.text(&hint, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_RIGHT);
    }
}

/// The cover of a game, when it is loaded.
pub(super) fn cover_for(key: &str, covers: &[CoverArt]) -> Option<*mut GpImage> {
    covers
        .iter()
        .find(|c| c.key == key)
        .map(|c| c.image)
        .filter(|image| !image.is_null())
}

/// A small rounded label with a tinted background.
pub(super) fn pill(g: &mut Painter, x: f32, y: f32, w: f32, word: &str, color: COLORREF) {
    g.round(g.r(x, y, w, S6), tint(CARD, color, 0.18), None);
    let r = g.r(x, y, w, S6);
    g.text(word, r, T_CAPTION, FW_SEMIBOLD as i32, Face::Ui, color, DT_CENTER);
}
