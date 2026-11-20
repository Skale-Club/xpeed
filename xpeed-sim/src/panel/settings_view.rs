//! The Settings screen (the sidebar's gear): the account, updates, the preferences the tray menu also has (language, units,
//! start with Windows, update automatically, the phone view) and the support button. The Monitor screen keeps only what the
//! program is doing.

use super::*;

/// The height of the update card (design units).
const UPDATE_H: f32 = 82.0;

/// The height of the support card (design units).
const SUPPORT_H: f32 = 96.0;

/// The preferences' rows: the language, the four units, then the three switches.
const PREF_ROWS: f32 = 8.0;

pub(super) fn settings(g: &mut Painter, body: RECT, view: &View) {
    let s = view.scale;
    g.place(s, body.left, body.top);
    let (w, h) = ((body.right - body.left) as f32 / s, (body.bottom - body.top) as f32 / s);
    let gap = S4;
    // Two columns side by side (the account, updates and support at the left, the preferences at the right); in a narrow window
    // one under the other, and a card that would start below the window is left out.
    let stacked = w < 640.0;
    let col = if stacked { w } else { (w - gap) / 2.0 };
    let account_h = account_need(g, view, col);
    account_card(g, view, 0.0, 0.0, col, account_h);
    let update_y = account_h + gap;
    update_card(g, view, 0.0, update_y, col);
    let support_y = update_y + UPDATE_H + gap;
    if stacked {
        let prefs_y = support_y;
        let prefs_h = prefs_need().min(h - prefs_y).max(0.0);
        if prefs_h >= 120.0 {
            prefs_card(g, view, 0.0, prefs_y, col, prefs_h);
        }
        let support_y = prefs_y + prefs_h + gap;
        if support_y + SUPPORT_H <= h {
            support_card(g, view, 0.0, support_y, col, SUPPORT_H);
        }
    } else {
        // Each card as tall as what it holds, so a big window has no empty cards.
        support_card(g, view, 0.0, support_y, col, SUPPORT_H);
        prefs_card(g, view, col + gap, 0.0, col, prefs_need().min(h));
    }
}

/// The height the preferences want at their roomiest.
fn prefs_need() -> f32 {
    52.0 + PREF_ROWS * 42.0 + S3
}

/// The account card's buttons, by what the card says: label, primary, width (design units).
fn account_buttons(g: &mut Painter, view: &View, col: f32) -> Vec<(Action, String, bool, f32)> {
    let semi = FW_SEMIBOLD as i32;
    let wanted: Vec<(Action, String, bool)> = match &view.card {
        Card::Connected { .. } => {
            let mut actions = vec![(Action::OpenXpeed, text(view.lang, &Msg::PanelOpenXpeed), false)];
            if view.coach_available {
                actions.push((Action::Coach, "Session Coach".into(), false));
            }
            actions
        }
        Card::Waiting { .. } => vec![
            (Action::OpenConnectPage, text(view.lang, &Msg::ConnectOpenAgain), true),
            (Action::CancelConnect, text(view.lang, &Msg::ConnectCancel), false),
        ],
        Card::NotConnected { .. } => vec![(Action::Connect, text(view.lang, &Msg::MenuConnect), true)],
    };
    wanted
        .into_iter()
        .map(|(action, label, primary)| {
            let w = (g.width_of(&label, T_BODY, semi, Face::Ui) + 36.0).min(col - 40.0);
            (action, label, primary, w)
        })
        .collect()
}

/// The code to compare with the connection page, while one is shown.
fn account_code<'a>(view: &'a View) -> Option<&'a str> {
    match &view.card {
        Card::Waiting { code } => code.as_deref(),
        _ => None,
    }
}

const BUTTON_H: f32 = 36.0;
const BUTTON_GAP: f32 = 10.0;

/// The height the account card needs for its words and its buttons at this width.
pub(super) fn account_need(g: &mut Painter, view: &View, col: f32) -> f32 {
    let buttons = account_buttons(g, view, col);
    let lines = button_lines(&buttons.iter().map(|b| b.3).collect::<Vec<_>>(), col - 40.0);
    let line_count = lines.iter().map(|&(line, _)| line).max().map_or(0, |l| l + 1) as f32;
    let code_h = if account_code(view).is_some() { 40.0 } else { 0.0 };
    104.0 + code_h + line_count * BUTTON_H + (line_count - 1.0).max(0.0) * BUTTON_GAP + 20.0
}

/// Account: the state in words, where it connects, and what can be done about it.
pub(super) fn account_card(g: &mut Painter, view: &View, x: f32, y: f32, col: f32, h: f32) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let buttons = account_buttons(g, view, col);
    let lines = button_lines(&buttons.iter().map(|b| b.3).collect::<Vec<_>>(), col - 40.0);
    let code = account_code(view);
    let code_h = if code.is_some() { 40.0 } else { 0.0 };
    g.tile(x, y, col, h, CARD);
    g.label(&text(view.lang, &Msg::PanelAccount), x + 20.0, y + S4, col - 40.0);
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
                None => format!("{} · {host}", text(view.lang, &Msg::ConnectWhy)),
            },
        ),
    };
    g.fill(g.r(x + 20.0, y + 52.0, 10.0, 10.0), dot);
    let r = g.r(x + 40.0, y + 42.0, col - 60.0, 30.0);
    g.text(&headline, r, T_LEAD, semi, Face::Ui, FOREGROUND, DT_LEFT);
    if let Some(code) = code {
        let r = g.r(x + 40.0, y + 68.0, col - 60.0, code_h);
        g.text(code, r, T_VALUE_L, semi, Face::Num, FOREGROUND, DT_LEFT);
    }
    let r = g.r(x + 40.0, y + 70.0 + code_h, col - 60.0, 20.0);
    g.text(&muted, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
    // The buttons, in as many lines as the card's width needs: connecting comes first while there is no account (or it
    // refused this computer).
    for ((action, label, primary, w), &(line, bx)) in buttons.iter().zip(&lines) {
        let by = y + 104.0 + code_h + line as f32 * (BUTTON_H + BUTTON_GAP);
        if by + BUTTON_H > y + h - S3 {
            break;
        }
        let r = g.r(x + 20.0 + bx, by, *w, BUTTON_H);
        let (fill, edge, ink) = if *primary {
            (PRIMARY, None, ON_PRIMARY)
        } else {
            (CARD, Some(BORDER), FOREGROUND)
        };
        g.round(r, fill, edge);
        g.text(label, r, T_BODY, semi, Face::Ui, ink, DT_CENTER);
        view.buttons.borrow_mut().push((*action, r));
    }
}

/// Updates: this version and what the updater is doing, a bar while something is under way, and the one button that fits
/// (Update now, Check now, Try again). Red when the running version must be replaced.
pub(super) fn update_card(g: &mut Painter, view: &View, x: f32, uy: f32, col: f32) {
    let semi = FW_SEMIBOLD as i32;
    let update = present::update_card(
        view.lang,
        env!("CARGO_PKG_VERSION"),
        view.update,
        view.check,
        view.download_percent,
        view.now_ms,
    );
    g.tile(x, uy, col, UPDATE_H, CARD);
    g.label(&text(view.lang, &Msg::PanelUpdate), x + 20.0, uy + S4, col - 40.0);
    let button = update.button.map(|b| (b, b.label(view.lang)));
    let button_w = button
        .as_ref()
        .map_or(0.0, |(_, label)| (g.width_of(label, T_BODY, semi, Face::Ui) + 36.0).min(col - 40.0));
    let dot = match update.tone {
        present::CardTone::Quiet => GREY,
        present::CardTone::Good => SUCCESS,
        present::CardTone::Brand => PRIMARY,
        present::CardTone::Warn => WARN,
        present::CardTone::Danger => DESTRUCTIVE,
    };
    g.fill(g.r(x + 20.0, uy + 50.0, 10.0, 10.0), dot);
    let room = (col - 60.0 - if button.is_some() { button_w + 14.0 } else { 0.0 }).max(40.0);
    let ink = if update.tone == present::CardTone::Danger {
        DESTRUCTIVE
    } else {
        FOREGROUND
    };
    g.text(
        &update.status,
        g.r(x + 40.0, uy + 40.0, room, 30.0),
        T_BODY,
        semi,
        Face::Ui,
        ink,
        DT_LEFT,
    );
    // The bar under the line: how much of the download arrived, or a short piece sliding while it is not known.
    let (bx, by, bw, bh) = (x + 40.0, uy + 66.0, room, 4.0);
    match update.bar {
        present::CardBar::None => {}
        present::CardBar::Percent(p) => {
            g.round(g.r(bx, by, bw, bh), SECONDARY, None);
            let filled = bw * f32::from(p.min(100)) / 100.0;
            if filled > 0.5 {
                g.round(g.r(bx, by, filled, bh), PRIMARY, None);
            }
        }
        present::CardBar::Busy => {
            g.round(g.r(bx, by, bw, bh), SECONDARY, None);
            let t = (view.now_ms.rem_euclid(1100)) as f32 / 1100.0;
            let piece = bw * 0.35;
            let start = (-piece + (bw + piece) * t).max(0.0);
            let end = (-piece + (bw + piece) * t + piece).min(bw);
            if end - start > 0.5 {
                g.round(g.r(bx + start, by, end - start, bh), PRIMARY, None);
            }
        }
    }
    if let Some((kind, label)) = button {
        let r = g.r(x + col - 20.0 - button_w, uy + 30.0, button_w, 36.0);
        let (fill, edge, ink, action) = match kind {
            present::CardButton::UpdateNow => (PRIMARY, None, ON_PRIMARY, Action::UpdateNow),
            present::CardButton::CheckNow | present::CardButton::TryAgain => (CARD, Some(BORDER), FOREGROUND, Action::CheckUpdates),
        };
        g.round(r, fill, edge);
        g.text(&label, r, T_BODY, semi, Face::Ui, ink, DT_CENTER);
        view.buttons.borrow_mut().push((action, r));
    }
}

/// Preferences: the language and the four units as rows of small choices (the one in use outlined in yellow), then the three
/// switches. Each row's height shrinks with the card, never below what its words need.
pub(super) fn prefs_card(g: &mut Painter, view: &View, x: f32, y: f32, col: f32, h: f32) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    g.tile(x, y, col, h, CARD);
    g.label(&text(view.lang, &Msg::PanelPreferences), x + 20.0, y + S4, col - 40.0);
    let top = y + 46.0;
    let row_h = ((h - 46.0 - S3) / PREF_ROWS).clamp(28.0, 42.0);
    let (left, right) = (x + 20.0, x + col - 20.0);
    let mut row = 0.0_f32;
    let mut next = |g: &mut Painter| -> Option<f32> {
        let ry = top + row * row_h;
        row += 1.0;
        if ry + row_h > y + h - S2 {
            return None;
        }
        if row > 1.0 {
            g.fill(g.r(left, ry, right - left, 1.0), BORDER);
        }
        Some(ry)
    };
    // A row of choices: its name at the left, the choices at the right, the one in use outlined in yellow.
    let chip_h = (row_h - 12.0).min(26.0);
    let choices = |g: &mut Painter, ry: f32, name: &str, labels: &[String], chosen: usize, action: &dyn Fn(usize) -> Action| {
        let widths: Vec<f32> = labels.iter().map(|l| g.width_of(l, T_CAPTION, semi, Face::Ui) + 18.0).collect();
        let total = widths.iter().sum::<f32>() + S1 * (widths.len().saturating_sub(1)) as f32;
        let name_room = (right - left - total - S3).max(0.0);
        g.text(
            name,
            g.r(left, ry, name_room, row_h),
            T_BODY,
            normal,
            Face::Ui,
            FOREGROUND_2,
            DT_LEFT,
        );
        let mut cx = right - total;
        for (i, (label, cw)) in labels.iter().zip(&widths).enumerate() {
            let r = g.r(cx.max(left), ry + (row_h - chip_h) / 2.0, *cw, chip_h);
            let hot = view.mouse.is_some_and(|(mx, my)| inside(&r, mx, my));
            let (edge, ink) = if i == chosen {
                (PRIMARY, PRIMARY)
            } else if hot {
                (MUTED_TEXT, FOREGROUND)
            } else {
                (BORDER, MUTED_TEXT)
            };
            g.round(r, CARD, Some(edge));
            g.text(label, r, T_CAPTION, semi, Face::Ui, ink, DT_CENTER);
            view.buttons.borrow_mut().push((action(i), r));
            cx += cw + S1;
        }
    };
    if let Some(ry) = next(g) {
        let now = Lang::ALL.iter().position(|l| *l == view.lang).unwrap_or(0);
        // The languages by name in their own words, or by their codes when the names do not fit beside the row's name.
        let names: Vec<String> = Lang::ALL.iter().map(|l| l.name().to_owned()).collect();
        let fits = names
            .iter()
            .map(|n| g.width_of(n, T_CAPTION, semi, Face::Ui) + 18.0 + S1)
            .sum::<f32>()
            + 110.0
            <= right - left;
        let labels: Vec<String> = if fits {
            names
        } else {
            Lang::ALL.iter().map(|l| l.code().to_uppercase()).collect()
        };
        choices(g, ry, &text(view.lang, &Msg::MenuLanguage), &labels, now, &Action::Lang);
    }
    for kind in UnitKind::ALL {
        let Some(ry) = next(g) else { return };
        let (labels, now) = kind.choices(view.units);
        let labels: Vec<String> = labels.into_iter().map(str::to_owned).collect();
        choices(g, ry, &text(view.lang, &kind.msg()), &labels, now, &|i| Action::Unit(kind, i));
    }
    // The switches: the whole row is the button.
    for (pref, msg) in [
        (Pref::Autostart, Msg::MenuAutostart),
        (Pref::AutoUpdate, Msg::MenuAutoUpdate),
        (Pref::PhoneView, Msg::MenuPhoneView),
    ] {
        let Some(ry) = next(g) else { return };
        let on = view.prefs.get(pref);
        let row_r = g.r(left, ry, right - left, row_h);
        let hot = view.mouse.is_some_and(|(mx, my)| inside(&row_r, mx, my));
        let (sw, sh) = (34.0, 18.0);
        let label_ink = if hot { FOREGROUND } else { FOREGROUND_2 };
        g.text(
            &text(view.lang, &msg),
            g.r(left, ry, right - left - sw - S3, row_h),
            T_BODY,
            normal,
            Face::Ui,
            label_ink,
            DT_LEFT,
        );
        // The switch: a square track, yellow when on, with a square knob at the side it is on.
        let (tx, ty) = (right - sw, ry + (row_h - sh) / 2.0);
        let (track, knob, knob_x) = if on {
            (PRIMARY, ON_PRIMARY, tx + sw - sh + 3.0)
        } else {
            (SECONDARY, if hot { FOREGROUND } else { MUTED_TEXT }, tx + 3.0)
        };
        g.round(g.r(tx, ty, sw, sh), track, if on { None } else { Some(BORDER) });
        g.round(g.r(knob_x, ty + 3.0, sh - 6.0, sh - 6.0), knob, None);
        view.buttons.borrow_mut().push((Action::Toggle(pref), row_r));
    }
}

/// Support: the button that copies the support text, the version and build, and what is worth a word (copied, or a part that
/// stopped).
pub(super) fn support_card(g: &mut Painter, view: &View, x: f32, y: f32, col: f32, h: f32) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    g.tile(x, y, col, h, CARD);
    g.label(&text(view.lang, &Msg::PanelSupport), x + 20.0, y + S4, col - 40.0);
    let copy = text(view.lang, &Msg::DiagnosticsCopy);
    let copy_w = (g.width_of(&copy, T_BODY, semi, Face::Ui) + 36.0).min(col - 40.0);
    let r = g.r(x + 20.0, y + 42.0, copy_w, BUTTON_H);
    g.round(r, CARD, Some(BORDER));
    g.text(&copy, r, T_BODY, semi, Face::Ui, FOREGROUND, DT_CENTER);
    view.buttons.borrow_mut().push((Action::CopyDiagnostics, r));
    let note_x = x + 20.0 + copy_w + 14.0;
    let room = (x + col - 20.0 - note_x).max(0.0);
    let (line, color) = if !view.failed.is_empty() {
        (text(view.lang, &Msg::WorkersFailed(view.failed.to_owned())), DESTRUCTIVE)
    } else if view.copied {
        (text(view.lang, &Msg::DiagnosticsCopied), MUTED_TEXT)
    } else {
        (
            format!("v{} · Build {}", env!("CARGO_PKG_VERSION"), env!("XPEED_BUILD")),
            MUTED_TEXT,
        )
    };
    g.text(
        &line,
        g.r(note_x, y + 42.0, room, BUTTON_H),
        T_CAPTION,
        normal,
        Face::Ui,
        color,
        DT_LEFT,
    );
}
