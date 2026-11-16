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

    // The account card always gets the height its content needs, and the games list takes what is left: its rows
    // get lower and, when even that is not enough, the last line says how many more games there are. Nothing is
    // ever drawn outside its card, whatever the window's size.
    let wanted: Vec<(Action, String, bool)> = match &view.card {
        Card::Connected { .. } => vec![(Action::OpenXpeed, text(view.lang, &Msg::PanelOpenXpeed), false)],
        Card::Waiting { .. } => vec![
            (Action::OpenConnectPage, text(view.lang, &Msg::ConnectOpenAgain), true),
            (Action::CancelConnect, text(view.lang, &Msg::ConnectCancel), false),
        ],
        Card::NotConnected { .. } => vec![(Action::Connect, text(view.lang, &Msg::MenuConnect), true)],
    };
    let buttons: Vec<(Action, String, bool, f32)> = wanted
        .into_iter()
        .map(|(action, label, primary)| {
            let w = (g.width_of(&label, T_BODY, semi, Face::Ui) + 36.0).min(col - 40.0);
            (action, label, primary, w)
        })
        .collect();
    let lines = button_lines(&buttons.iter().map(|b| b.3).collect::<Vec<_>>(), col - 40.0);
    let line_count = lines.iter().map(|&(line, _)| line).max().map_or(0, |l| l + 1) as f32;
    let (button_h, button_gap) = (36.0, 10.0);
    // The code to compare with the connection page takes a line of its own, big, under the headline.
    let code = match &view.card {
        Card::Waiting { code } => code.as_deref(),
        _ => None,
    };
    let code_h = if code.is_some() { 40.0 } else { 0.0 };
    let account_need = 104.0 + code_h + line_count * button_h + (line_count - 1.0).max(0.0) * button_gap + 20.0;
    // A new version waiting gets a card of its own between the games and the account.
    let update = present::update_line(view.lang, view.update);
    let update_h = 82.0;
    let update_need = if update.is_some() { update_h + gap } else { 0.0 };
    let games = view.games.len().max(1);
    let (games_h, row_h, max_scroll) = games_layout(games, area_h - gap - account_need - update_need);
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
        let state = state_text(view.lang, &row.state);
        let pill_w = g.width_of(&state, T_CAPTION, semi, Face::Ui) + 22.0;
        let text_x = 20.0 + tw + 14.0;
        let r = g.r(text_x, y, col - text_x - 40.0 - bar - pill_w, row_h);
        g.text(&row.title, r, T_BODY, normal, Face::Ui, FOREGROUND, DT_LEFT);
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

    // A new version: what it is and, when it can be, the button that installs it. Red when it is required.
    if let Some(line) = &update {
        let uy = games_h + gap;
        g.tile(0.0, uy, col, update_h, CARD);
        g.label(&text(view.lang, &Msg::PanelUpdate), 20.0, uy + S4, col - 40.0);
        let button_text = text(view.lang, &Msg::UpdateNow);
        let button_w = if line.button {
            (g.width_of(&button_text, T_BODY, semi, Face::Ui) + 36.0).min(col - 40.0)
        } else {
            0.0
        };
        g.fill(g.r(20.0, uy + 54.0, 10.0, 10.0), if line.required { DESTRUCTIVE } else { PRIMARY });
        let room = (col - 60.0 - if line.button { button_w + 14.0 } else { 0.0 }).max(40.0);
        let r = g.r(40.0, uy + 44.0, room, 30.0);
        g.text(
            &line.headline,
            r,
            T_BODY,
            semi,
            Face::Ui,
            if line.required { DESTRUCTIVE } else { FOREGROUND },
            DT_LEFT,
        );
        if line.button {
            let r = g.r(col - 20.0 - button_w, uy + 34.0, button_w, 36.0);
            g.round(r, R_TILE, PRIMARY, None);
            g.text(&button_text, r, T_BODY, semi, Face::Ui, ON_PRIMARY, DT_CENTER);
            view.buttons.borrow_mut().push((Action::UpdateNow, r));
        }
    }

    // Account: the state in words, where it connects, and what can be done about it.
    let account_y = games_h + gap + update_need;
    let account_h = area_h - account_y;
    g.tile(0.0, account_y, col, account_h, CARD);
    g.label(&text(view.lang, &Msg::PanelAccount), 20.0, account_y + S4, col - 40.0);
    let cloud_color = match view.snapshot.cloud {
        Cloud::Idle => SUCCESS,
        Cloud::Waiting(_) => WARN,
        Cloud::NotPaired => GREY,
        Cloud::Refused => DESTRUCTIVE,
    };
    let host = connect::host_of(view.server);
    // The headline, its colour and the muted line under it, by what the card says.
    let (dot, headline, muted) = match &view.card {
        Card::Waiting { code } => (
            WARN,
            text(view.lang, &Msg::ConnectWaiting),
            match code {
                Some(code) => text(view.lang, &Msg::ConnectCodeHint(code.clone())),
                None => text(view.lang, &Msg::ConnectWaitingHint),
            },
        ),
        Card::Connected { who } => (
            cloud_color,
            // Laps waiting to be sent matter more than who it is: say that when it is so.
            match view.snapshot.cloud {
                Cloud::Waiting(_) => present::cloud_line(view.lang, &view.snapshot.cloud, view.device),
                _ => connected_line(view.lang, who.as_deref()),
            },
            host.to_owned(),
        ),
        Card::NotConnected { note } => (
            cloud_color,
            present::cloud_line(view.lang, &view.snapshot.cloud, view.device),
            match note {
                Some(Note::Cancelled) => text(view.lang, &Msg::ConnectNoteCancelled),
                Some(Note::Expired) => text(view.lang, &Msg::ConnectNoteExpired),
                Some(Note::Failed(why)) => why.clone(),
                Some(Note::Reconnect) => text(view.lang, &Msg::ConnectNoteReconnect),
                None => host.to_owned(),
            },
        ),
    };
    g.fill(g.r(20.0, account_y + 52.0, 10.0, 10.0), dot);
    let r = g.r(40.0, account_y + 42.0, col - 60.0, 30.0);
    g.text(&headline, r, T_LEAD, semi, Face::Ui, FOREGROUND, DT_LEFT);
    if let Some(code) = code {
        let r = g.r(40.0, account_y + 68.0, col - 60.0, code_h);
        g.text(code, r, T_VALUE_L, semi, Face::Num, FOREGROUND, DT_LEFT);
    }
    let r = g.r(40.0, account_y + 70.0 + code_h, col - 60.0, 20.0);
    g.text(&muted, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
    // The buttons, in as many lines as the card's width needs: connecting comes first while there is no account (or
    // it refused this computer).
    for ((action, label, primary, w), &(line, x)) in buttons.iter().zip(&lines) {
        let by = account_y + 104.0 + code_h + line as f32 * (button_h + button_gap);
        if by + button_h > area_h - S3 {
            break;
        }
        let r = g.r(20.0 + x, by, *w, button_h);
        let (fill, edge, ink) = if *primary {
            (PRIMARY, None, ON_PRIMARY)
        } else {
            (CARD, Some(BORDER), FOREGROUND)
        };
        g.round(r, R_TILE, fill, edge);
        g.text(label, r, T_BODY, semi, Face::Ui, ink, DT_CENTER);
        view.buttons.borrow_mut().push((*action, r));
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
        let count = text(view.lang, &Msg::PanelLapsCount(view.snapshot.laps_saved));
        let title = text(view.lang, &Msg::PanelLaps).to_uppercase();
        let need = g.width_of(&count, T_CAPTION, normal, Face::Ui) + g.width_of(&title, T_CAPTION, semi, Face::Label) * 1.3 + S6;
        if need <= col - 40.0 {
            let r = g.r(right + 20.0, 14.0, col - 40.0, 22.0);
            g.text(&count, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_RIGHT);
        }
        let lap_row = 34.0;
        let room = ((laps_h - 52.0) / lap_row).floor().max(0.0) as usize;
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
    for (i, (time, line)) in view.activity.iter().take(room).enumerate() {
        let y = log_y + 42.0 + line_h * i as f32;
        if i > 0 {
            g.fill(g.r(right + 20.0, y, col - 40.0, 1.0), BORDER);
        }
        let r = g.r(right + 20.0, y, 52.0, line_h);
        g.text(time, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        let r = g.r(right + 76.0, y, col - 96.0, line_h);
        g.text(line, r, T_BODY, normal, Face::Ui, FOREGROUND, DT_LEFT);
    }

    // The footer: the button that copies the support text, then what is worth a word (copied, or a part that stopped), and
    // the shortcuts at the right while there is room for them.
    g.place(s, body.left, body.top);
    let copy = text(view.lang, &Msg::DiagnosticsCopy);
    let copy_w = g.width_of(&copy, T_CAPTION, semi, Face::Ui) + S6;
    let r = g.r(0.0, h - S6, copy_w, S6);
    g.round(r, R_TILE, CARD, Some(BORDER));
    g.text(&copy, r, T_CAPTION, semi, Face::Ui, FOREGROUND, DT_CENTER);
    view.buttons.borrow_mut().push((Action::CopyDiagnostics, r));
    let note_x = copy_w + 14.0;
    let note = if !view.failed.is_empty() {
        Some((text(view.lang, &Msg::WorkersFailed(view.failed.to_owned())), DESTRUCTIVE))
    } else if view.copied {
        Some((text(view.lang, &Msg::DiagnosticsCopied), MUTED_TEXT))
    } else {
        None
    };
    let hint = text(view.lang, &Msg::PanelHint);
    let hint_w = g.width_of(&hint, T_CAPTION, normal, Face::Ui);
    let note_w = note.as_ref().map_or(0.0, |(t, _)| g.width_of(t, T_CAPTION, normal, Face::Ui));
    if let Some((line, color)) = &note {
        let r = g.r(note_x, h - 22.0, (w - note_x).max(0.0), 20.0);
        g.text(line, r, T_CAPTION, normal, Face::Ui, *color, DT_LEFT);
    }
    if note_x + note_w + hint_w + S6 <= w {
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
    g.round(g.r(x, y, w, S6), R_TILE, tint(CARD, color, 0.18), None);
    let r = g.r(x, y, w, S6);
    g.text(word, r, T_CAPTION, FW_SEMIBOLD as i32, Face::Ui, color, DT_CENTER);
}
