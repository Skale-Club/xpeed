use super::*;

pub(super) fn state_text(lang: Lang, game: &Game) -> String {
    text(
        lang,
        &match game {
            Game::Waiting => Msg::StateWaiting,
            Game::Connected => Msg::StateConnected,
            Game::Recording(lap) => Msg::StateRecording(*lap),
            Game::Paused => Msg::StatePaused,
            Game::Unsupported => Msg::StateUnsupported,
            Game::Silent => Msg::StateSilent,
            Game::Loading => Msg::StateLoading,
        },
    )
}

pub(super) fn state_color(game: &Game) -> COLORREF {
    match game {
        Game::Recording(_) => SUCCESS,
        Game::Connected => INFO,
        Game::Waiting => GREY,
        Game::Paused => WARN,
        Game::Unsupported => DESTRUCTIVE,
        Game::Silent => WARN,
        Game::Loading => MUTED_TEXT,
    }
}

/// The game the waiting screen is about: the most interesting one that is open (recording, connected, unsupported,
/// paused, open without data), if any.
pub(super) fn focus_of(games: &[(&'static str, &'static str, Game)]) -> Option<(&'static str, &'static str, Game)> {
    let rank = |g: &Game| match g {
        Game::Recording(_) => 5,
        Game::Connected => 4,
        Game::Unsupported => 3,
        Game::Paused => 2,
        Game::Silent | Game::Loading => 1,
        Game::Waiting => 0,
    };
    games
        .iter()
        .filter(|(_, _, g)| *g != Game::Waiting)
        .max_by_key(|(_, _, g)| rank(g))
        .cloned()
}

/// The waiting screen about one open game: its cover, its name, and what happens next (or what to switch on). `cw` is
/// the canvas width (narrower in a tall window), its text wrapped to fit.
/// What the open-game screen says: its title, its line (in yellow when the person has something to do) and a note.
pub(super) fn focus_words(view: &View, (id, name, game): (&'static str, &'static str, Game)) -> (String, String, Option<String>, bool) {
    let (title, line, note) = match game {
        Game::Silent => (Msg::FocusOpen(name.into()), Msg::Setup(id), Some(Msg::FocusAutoConnect)),
        Game::Loading => (Msg::FocusOpen(name.into()), Msg::FocusLoading, None),
        Game::Unsupported => (Msg::FocusOpen(name.into()), Msg::FocusUnsupported, None),
        Game::Paused => (Msg::FocusConnected(name.into()), Msg::FocusPaused, None),
        _ => (Msg::FocusConnected(name.into()), Msg::FocusGetInCar, None),
    };
    let act = game == Game::Silent || game == Game::Unsupported;
    (
        text(view.lang, &title),
        text(view.lang, &line),
        note.map(|n| text(view.lang, &n)),
        act,
    )
}

/// The open-game screen's cover size, and the height of the whole block for a canvas `cw` wide.
pub(super) const FOCUS_COVER: (f32, f32) = (170.0, 255.0);

pub(super) fn focus_height(g: &mut Painter, view: &View, focus: (&'static str, &'static str, Game), cw: f32) -> f32 {
    let (title, line, note, _) = focus_words(view, focus);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let mut h = g.wrap_lines(&title, cw - 40.0, T_NUMERAL, semi, Face::Num).len() as f32 * 46.0 + 6.0;
    h += g.wrap_lines(&line, cw - 60.0, T_BODY, semi, Face::Ui).len() as f32 * 22.0;
    if let Some(note) = note {
        h += S1 + g.wrap_lines(&note, cw - 60.0, T_BODY, normal, Face::Ui).len() as f32 * 20.0;
    }
    h + S6 + FOCUS_COVER.1 + 9.0
}

/// The waiting screen about one open game, from the top of its own canvas: its name, what happens next (or what to
/// switch on), then its cover. `cw` is the canvas width (narrower in a tall window), the words wrapped to fit.
pub(super) fn focus_screen(g: &mut Painter, view: &View, focus: (&'static str, &'static str, Game), cw: f32) {
    let (id, name, game) = focus.clone();
    let (title, line, note, act) = focus_words(view, focus);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let mut y = 0.0;
    y += g.wrapped(&title, 20.0, y, cw - 40.0, T_NUMERAL, semi, Face::Num, FOREGROUND, DT_CENTER, 46.0);
    y += 6.0;
    y += g.wrapped(
        &line,
        30.0,
        y,
        cw - 60.0,
        T_BODY,
        semi,
        Face::Ui,
        if act { PRIMARY } else { MUTED_TEXT },
        DT_CENTER,
        22.0,
    );
    if let Some(note) = note {
        y += S1;
        y += g.wrapped(&note, 30.0, y, cw - 60.0, T_BODY, normal, Face::Ui, MUTED_TEXT, DT_CENTER, 20.0);
    }
    // The game's cover, as big as the carousel's middle one; a name card when there is no cover.
    let (w, h) = FOCUS_COVER;
    let (x, y) = ((cw - w) / 2.0, y + S6);
    let exact = g.exact(x, y, w, h);
    match view.covers.iter().find(|c| c.key == id).map(|c| c.image).filter(|i| !i.is_null()) {
        Some(image) => g.image_exact(exact, image),
        None => g.cover_card(exact, name, 1.1),
    }
    // A line under it: yellow while the game is the one being watched, amber while it shares no data.
    g.fill(g.r(x, y + h + 6.0, w, 3.0), if game == Game::Silent { WARN } else { PRIMARY });
}

pub(super) fn waiting(g: &mut Painter, body: RECT, view: &View) {
    // A tall window (a phone held upright) gets a narrower canvas, so the words stay big enough to read.
    let tall = ((body.right - body.left) as f32) < ((body.bottom - body.top) as f32) * 0.9;
    let cw = if tall { PORTRAIT_W } else { CANVAS_W };
    let (s, ox, oy) = canvas_fit_wh(body, cw, CANVAS_H);
    g.place(s, ox, oy);
    if let Some(focus) = view.focus.clone() {
        // Measured first, then fitted by its own height: the block sits in the middle whatever the window's shape.
        // On a phone the block is drawn narrower, so it comes out bigger (the title wraps).
        let fcw = if tall { 440.0 } else { cw };
        let margin = 40.0;
        let h = focus_height(g, view, focus.clone(), fcw) + 2.0 * margin;
        let (s, ox, oy) = canvas_fit_wh(body, fcw, h);
        g.place(s, ox, oy + (margin * s).round() as i32);
        return focus_screen(g, view, focus, fcw);
    }
    let title = text(view.lang, &Msg::PanelWaitingTitle);
    let r = g.r(0.0, 66.0, cw, 50.0);
    g.text(&title, r, T_NUMERAL, FW_SEMIBOLD as i32, Face::Num, FOREGROUND, DT_CENTER);
    g.wrapped(
        &text(view.lang, &Msg::PanelWaiting),
        20.0,
        116.0,
        cw - 40.0,
        T_BODY,
        FW_NORMAL as i32,
        Face::Ui,
        MUTED_TEXT,
        DT_CENTER,
        22.0,
    );
    if !view.covers.is_empty() {
        view.carousel_step.set(120.0 * g.s);
        return cover_carousel(g, view.covers, view.carousel, &view.buttons, cw);
    }
    // The games it reads, as chips, centred in rows.
    let chips: Vec<(String, f32)> = view
        .games
        .iter()
        .map(|row| {
            (
                row.title.clone(),
                g.width_of(&row.title, T_BODY, FW_SEMIBOLD as i32, Face::Ui) + 28.0,
            )
        })
        .collect();
    let mut rows: Vec<Vec<(String, f32)>> = vec![Vec::new()];
    let mut used = 0.0;
    for chip in chips {
        if used + chip.1 > cw - 240.0 && !rows.last().unwrap().is_empty() {
            rows.push(Vec::new());
            used = 0.0;
        }
        used += chip.1 + 10.0;
        rows.last_mut().unwrap().push(chip);
    }
    for (i, row) in rows.iter().enumerate() {
        let total: f32 = row.iter().map(|(_, w)| w + 10.0).sum::<f32>() - 10.0;
        let mut x = (cw - total) / 2.0;
        let y = 262.0 + i as f32 * 40.0;
        for (name, w) in row {
            g.round(g.r(x, y, *w, S8), S4, CARD, Some(BORDER));
            let r = g.r(x, y, *w, 30.0);
            g.text(name, r, T_BODY, FW_SEMIBOLD as i32, Face::Ui, MUTED_TEXT, DT_CENTER);
            x += w + 10.0;
        }
    }
}

/// Where cover `i` of `count` sits from the middle of a carousel at `at`: a signed distance in covers, wrapped so the
/// covers go round (the nearest way).
pub(super) fn carousel_offset(i: usize, count: usize, at: f32) -> f32 {
    let n = count as f32;
    let d = (i as f32 - at).rem_euclid(n);
    if d > n / 2.0 {
        d - n
    } else {
        d
    }
}

/// How many steps (the nearest way round, negative to the left) take a carousel of `count` covers whose middle is
/// heading to `target` to cover `to`.
pub(super) fn carousel_steps(target: i64, to: usize, count: usize) -> i64 {
    if count == 0 {
        return 0;
    }
    let n = count as i64;
    let by = (to as i64 - target).rem_euclid(n);
    if by > n / 2 {
        by - n
    } else {
        by
    }
}

/// The games as a carousel: the cover in the middle big, the others smaller and darker the further they are, going
/// round; the middle game's name under it and a row of small squares saying which one it is. Steam's art where it
/// has some, the name on a card where not. A click on a side cover or on one of the squares brings that game to the
/// middle.
pub(super) fn cover_carousel(g: &mut Painter, covers: &[CoverArt], at: f32, buttons: &std::cell::RefCell<Vec<(Action, RECT)>>, cw: f32) {
    let count = covers.len();
    let (big_w, mid_x, top) = (150.0, cw / 2.0, 168.0);
    let big_h = big_w * 1.5;
    // Far covers first, so the nearer ones are drawn over them.
    let mut order: Vec<(usize, f32)> = (0..count).map(|i| (i, carousel_offset(i, count, at))).collect();
    order.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
    for (i, d) in order {
        let far = d.abs();
        if far > 3.2 {
            continue;
        }
        let scale = (1.0 - 0.17 * far).max(0.4);
        let (w, h) = (big_w * scale, big_h * scale);
        // Closer together further out, as on a curved shelf.
        let x = mid_x + d.signum() * (far * 128.0 - far * far * 9.0) - w / 2.0;
        let y = top + (big_h - h) / 2.0;
        let exact = g.exact(x, y, w, h);
        let cover = &covers[i];
        if cover.image.is_null() {
            g.cover_card(exact, cover.name, scale);
        } else {
            g.image_exact(exact, cover.image);
        }
        // Darker the further from the middle.
        let shade = (far * 0.32).min(0.8);
        if shade > 0.01 {
            g.veil_exact(exact, BACKGROUND, shade);
        }
        // A side cover is a button; nearer covers are drawn later and go first, as they are on top.
        if far > 0.5 {
            buttons.borrow_mut().insert(0, (Action::Cover(i), g.r(x, y, w, h)));
        }
    }
    // The game in the middle, and where it is in the list.
    let middle = (at.round() as i64).rem_euclid(count as i64) as usize;
    let r = g.r(0.0, top + big_h + 14.0, cw, 26.0);
    g.text(
        &covers[middle].name.to_uppercase(),
        r,
        T_LEAD,
        FW_SEMIBOLD as i32,
        Face::Num,
        FOREGROUND,
        DT_CENTER,
    );
    let (dot, gap) = (7.0, 6.0);
    let total = count as f32 * dot + (count as f32 - 1.0) * gap;
    for i in 0..count {
        let x = mid_x - total / 2.0 + i as f32 * (dot + gap);
        g.fill(g.r(x, top + big_h + 48.0, dot, dot), if i == middle { PRIMARY } else { SECONDARY });
        // A square is small: its button reaches halfway to its neighbours and a little above and below.
        let hit = g.r(x - gap / 2.0, top + big_h + 40.0, dot + gap, dot + S4);
        buttons.borrow_mut().push((Action::Cover(i), hit));
    }
}
