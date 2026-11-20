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

/// Where one step of the open-game checklist stands (owner-approved module 9, 2026-11-19).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StepState {
    /// Done: a green tick.
    Done,
    /// What happens, or is to be done, now: a yellow number and edge.
    Now,
    /// Not reached yet: a grey number.
    Later,
    /// Cannot be done with this build: a red number and edge.
    Blocked,
}

/// One step of the checklist: its title, the line under it, the word on its right (none for a step not reached) and
/// where it stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Step {
    pub(super) title: String,
    pub(super) detail: String,
    pub(super) tag: String,
    pub(super) state: StepState,
}

fn step(lang: Lang, title: Msg, detail: Msg, tag: Option<Msg>, state: StepState) -> Step {
    Step {
        title: text(lang, &title),
        detail: text(lang, &detail),
        tag: tag.map_or_else(String::new, |tag| text(lang, &tag)),
        state,
    }
}

/// The open-game checklist (owner-approved module 9, 2026-11-19): the game open, its data on, the driver in the car.
/// Each step turns green by itself as the reading gets there; the step to act on says how, in the game's own menus.
pub(super) fn focus_steps(lang: Lang, (id, name, game): (&'static str, &'static str, Game)) -> [Step; 3] {
    use StepState::{Blocked, Done, Later, Now};
    let open = step(lang, Msg::StepGameOpen, Msg::StepGameFound(name.into()), Some(Msg::StepDone), Done);
    let data_done = step(lang, Msg::StepDataOn, Msg::StepDataArriving, Some(Msg::StepDone), Done);
    let car_later = step(lang, Msg::StepInCar, Msg::StepInCarDetail, None, Later);
    let (data, car) = match game {
        Game::Silent => (step(lang, Msg::StepDataOn, Msg::Setup(id), Some(Msg::StepToDo), Now), car_later),
        Game::Loading => {
            let data = step(lang, Msg::StepDataOn, Msg::FocusLoading, Some(Msg::StepLoading), Now);
            (data, car_later)
        }
        Game::Unsupported => {
            let data = step(lang, Msg::StepDataOn, Msg::FocusUnsupported, Some(Msg::StepUnsupported), Blocked);
            (data, car_later)
        }
        Game::Paused => (data_done, step(lang, Msg::StepInCar, Msg::FocusPaused, Some(Msg::StepPaused), Now)),
        Game::Recording(_) => {
            let car = step(lang, Msg::StepInCar, Msg::StepInCarDetail, Some(Msg::StepDone), Done);
            (data_done, car)
        }
        Game::Connected | Game::Waiting => {
            let car = step(lang, Msg::StepInCar, Msg::StepInCarDetail, Some(Msg::StepWaiting), Now);
            (data_done, car)
        }
    };
    [open, data, car]
}

/// The open-game screen's cover size (the carousel's middle one), and on a narrow canvas the share of it drawn.
pub(super) const FOCUS_COVER: (f32, f32) = (170.0, 255.0);
const NARROW_COVER: f32 = 0.6;

/// Whether the cover and the checklist sit side by side on a canvas `cw` wide (else the cover is over the checklist).
fn focus_wide(cw: f32) -> bool {
    cw >= FOCUS_COVER.0 + S6 + STEPS_W + 40.0
}

/// The checklist's width on a canvas `cw` wide.
fn steps_width(cw: f32) -> f32 {
    if focus_wide(cw) {
        STEPS_W
    } else {
        cw - 40.0
    }
}

/// The width of a step's word on the right (none for a step not reached).
fn tag_width(g: &mut Painter, step: &Step) -> f32 {
    if step.tag.is_empty() {
        0.0
    } else {
        g.caps_width(&step.tag, T_CAPTION)
    }
}

/// The lines of a step's detail, and the step's height, for a step `w` wide.
fn step_lines(g: &mut Painter, step: &Step, w: f32) -> (Vec<String>, f32) {
    let tag_w = tag_width(g, step) + if step.tag.is_empty() { 0.0 } else { S3 };
    let text_w = w - 2.0 * STEP_PAD - STEP_ICON - S3 - tag_w;
    let lines = g.wrap_lines(&step.detail, text_w, T_BODY, FW_NORMAL as i32, Face::Ui);
    let h = (20.0 + lines.len() as f32 * 19.0).max(STEP_ICON) + 2.0 * STEP_PAD;
    (lines, h)
}

/// The checklist's height (the steps and the gaps between them), `w` wide.
fn steps_height(g: &mut Painter, steps: &[Step], w: f32) -> f32 {
    let gaps = S2 * steps.len().saturating_sub(1) as f32;
    steps.iter().map(|s| step_lines(g, s, w).1).sum::<f32>() + gaps
}

/// The open-game screen's words: its title and, under the checklist, its note.
fn focus_title_note(view: &View, focus: (&'static str, &'static str, Game)) -> (String, Option<String>) {
    let (title, _, note, _) = focus_words(view, focus);
    (title, note)
}

/// The height of the open-game screen for a canvas `cw` wide.
pub(super) fn focus_height(g: &mut Painter, view: &View, focus: (&'static str, &'static str, Game), cw: f32) -> f32 {
    let (title, note) = focus_title_note(view, focus.clone());
    let steps = focus_steps(view.lang, focus);
    let w = steps_width(cw);
    let title_h = g.wrap_lines(&title, cw - 40.0, T_NUMERAL, FW_SEMIBOLD as i32, Face::Num).len() as f32 * 46.0;
    let mut note_h = 0.0;
    if let Some(note) = note {
        note_h = S3 + g.wrap_lines(&note, w, T_BODY, FW_NORMAL as i32, Face::Ui).len() as f32 * 20.0;
    }
    let list_h = steps_height(g, &steps, w) + note_h;
    let body_h = if focus_wide(cw) {
        list_h.max(FOCUS_COVER.1 + 9.0)
    } else {
        FOCUS_COVER.1 * NARROW_COVER + 9.0 + S4 + list_h
    };
    title_h + S6 + body_h
}

/// One step at (`x`, `y`), `w` wide: its card (a yellow edge when it is the one now, red when blocked), the square with
/// a tick or its number, its title and detail, and its word on the right. The height used.
fn draw_step(g: &mut Painter, step: &Step, number: usize, x: f32, y: f32, w: f32) -> f32 {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (lines, h) = step_lines(g, step, w);
    let (edge, fill, ink) = match step.state {
        StepState::Done => (BORDER, SUCCESS, ON_PRIMARY),
        StepState::Now => (PRIMARY, PRIMARY, ON_PRIMARY),
        StepState::Later => (BORDER, SECONDARY, MUTED_TEXT),
        StepState::Blocked => (DESTRUCTIVE, DESTRUCTIVE, ON_PRIMARY),
    };
    g.round(g.r(x, y, w, h), CARD, Some(edge));
    let (ix, iy) = (x + STEP_PAD, y + STEP_PAD);
    g.round(g.r(ix, iy, STEP_ICON, STEP_ICON), fill, None);
    if step.state == StepState::Done {
        g.tick((ix, iy, STEP_ICON, STEP_ICON), ink);
    } else {
        let r = g.r(ix, iy, STEP_ICON, STEP_ICON);
        g.text(&number.to_string(), r, T_BODY, semi, Face::Num, ink, DT_CENTER);
    }
    // The word on the right, in the colour of where the step stands.
    let tag_w = tag_width(g, step);
    if tag_w > 0.0 {
        let colour = match step.state {
            StepState::Done => SUCCESS,
            StepState::Now => PRIMARY,
            StepState::Later => MUTED_TEXT,
            StepState::Blocked => DESTRUCTIVE,
        };
        let r = g.r(x + w - STEP_PAD - tag_w, iy, tag_w + S1, STEP_ICON);
        g.caps(&step.tag, r, T_CAPTION, colour, DT_LEFT);
    }
    let tx = ix + STEP_ICON + S3;
    let text_w = x + w - STEP_PAD - tx - if tag_w > 0.0 { tag_w + S3 } else { 0.0 };
    let title_ink = if step.state == StepState::Later { MUTED_TEXT } else { FOREGROUND };
    let r = g.r(tx, iy, text_w, 20.0);
    g.text(&step.title, r, T_BODY, semi, Face::Ui, title_ink, DT_LEFT);
    for (i, line) in lines.iter().enumerate() {
        let r = g.r(tx, iy + 20.0 + i as f32 * 19.0, text_w, 19.0);
        g.text(line, r, T_BODY, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
    }
    h
}

/// The waiting screen about one open game, from the top of its own canvas (owner-approved module 9, 2026-11-19): its
/// title, then its cover beside the checklist (over it on a narrow canvas), and the note under the checklist. `cw` is
/// the canvas width (narrower in a tall window), the words wrapped to fit.
pub(super) fn focus_screen(g: &mut Painter, view: &View, focus: (&'static str, &'static str, Game), cw: f32) {
    let (id, name, game) = focus.clone();
    let (title, note) = focus_title_note(view, focus.clone());
    let steps = focus_steps(view.lang, focus);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let mut y = g.wrapped(
        &title,
        20.0,
        0.0,
        cw - 40.0,
        T_NUMERAL,
        semi,
        Face::Num,
        FOREGROUND,
        DT_CENTER,
        46.0,
    );
    y += S6;
    let w = steps_width(cw);
    let wide = focus_wide(cw);
    // The game's cover; a name card when there is none.
    let scale = if wide { 1.0 } else { NARROW_COVER };
    let (cover_w, cover_h) = (FOCUS_COVER.0 * scale, FOCUS_COVER.1 * scale);
    let block_w = if wide { cover_w + S6 + w } else { w };
    let left = (cw - block_w) / 2.0;
    let cover_x = if wide { left } else { (cw - cover_w) / 2.0 };
    let exact = g.exact(cover_x, y, cover_w, cover_h);
    match view.covers.iter().find(|c| c.key == id).map(|c| c.image).filter(|i| !i.is_null()) {
        Some(image) => g.image_exact(exact, image),
        None => g.cover_card(exact, name, 1.1 * scale),
    }
    // A line under it: yellow while the game is the one being watched, amber while it shares no data.
    let underline = if game == Game::Silent { WARN } else { PRIMARY };
    g.fill(g.r(cover_x, y + cover_h + 6.0, cover_w, 3.0), underline);
    // The checklist: beside the cover and centred on it, or under it.
    let list_h = steps_height(g, &steps, w);
    let (x, mut sy) = if wide {
        (left + cover_w + S6, y + ((cover_h - list_h) / 2.0).max(0.0))
    } else {
        (left, y + cover_h + 9.0 + S4)
    };
    for (i, step) in steps.iter().enumerate() {
        sy += draw_step(g, step, i + 1, x, sy, w) + S2;
    }
    if let Some(note) = note {
        g.wrapped(&note, x, sy - S2 + S3, w, T_BODY, normal, Face::Ui, MUTED_TEXT, DT_LEFT, 20.0);
    }
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
        return cover_carousel(g, view, cw);
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
            g.round(g.r(x, y, *w, S8), CARD, Some(BORDER));
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
pub(super) fn cover_carousel(g: &mut Painter, view: &View, cw: f32) {
    let (covers, at, buttons) = (view.covers, view.carousel, &view.buttons);
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
    // Under the name (owner-approved module 8, 2026-11-19): when the game was last driven, its laps and the best on
    // the track driven last; nothing for a game not driven since the history began.
    if let Some(played) = view.played.get(covers[middle].key) {
        let best = played.best_here().map(|(ms, track)| (crate::util::clock(ms), track.to_owned()));
        let msg = Msg::PanelLastPlayed {
            ago: crate::present::ago(view.lang, played.last_ms, view.now_ms),
            laps: played.laps,
            best,
        };
        let line = text(view.lang, &msg);
        let r = g.r(20.0, top + big_h + 42.0, cw - 40.0, 22.0);
        g.text(&line, r, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_CENTER);
    }
    let (dot, gap) = (7.0, 6.0);
    let total = count as f32 * dot + (count as f32 - 1.0) * gap;
    for i in 0..count {
        let x = mid_x - total / 2.0 + i as f32 * (dot + gap);
        g.fill(g.r(x, top + big_h + 76.0, dot, dot), if i == middle { PRIMARY } else { SECONDARY });
        // A square is small: its button reaches halfway to its neighbours and a little above and below.
        let hit = g.r(x - gap / 2.0, top + big_h + 68.0, dot + gap, dot + S4);
        buttons.borrow_mut().push((Action::Cover(i), hit));
    }
}
