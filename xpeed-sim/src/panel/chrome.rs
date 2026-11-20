use super::*;

/// Draws one frame of the window.
pub fn paint(hdc: HDC, width: i32, height: i32, view: &View) {
    let mut g = Painter::new(hdc, view.scale);
    g.backdrop(width, height);
    header(&mut g, width, view);
    let top = g.px(HEADER_H);
    let body = rect(g.px(S4), top, width - g.px(S4), height - g.px(S4));
    match view.tab {
        Tab::Dash => dashboard_screen(&mut g, body, view),
        Tab::Monitor => monitor(&mut g, body, view),
    }
    if view.lang_open {
        lang_list(&mut g, width, view);
    } else if view.workspace_open {
        workspace_list(&mut g, width, view);
    } else {
        tooltip(&mut g, width, view);
    }
}

/// The workspace menu, open under the dashboard pill (`workspace_menu` says what is in it and where): Automatic, the four
/// workspaces (a check on the one in use, a yellow mark on one with a saved view), a divider, Edit layout and Reset. The row under
/// the mouse is lit; a row that is off is dim; a reset waiting for its second click says so, in red.
pub(super) fn workspace_list(g: &mut Painter, width: i32, view: &View) {
    let Some(menu) = workspace_menu(width, view.scale, view.dashboard, view.dashboard_in_use(), view.views) else {
        return;
    };
    g.place(view.scale, 0, 0);
    let semi = FW_SEMIBOLD as i32;
    g.round(menu.list, POPOVER, Some(BORDER));
    g.fill(menu.divider, BORDER);
    for row in &menu.rows {
        let armed = row.item == WorkspaceItem::Reset && row.enabled && view.now_ms < view.workspace_reset_until;
        let hot = row.enabled && view.mouse.is_some_and(|(mx, my)| inside(&row.rect, mx, my));
        if hot {
            g.fill(row.rect, ROW_HOVER);
        }
        let gutter = g.px(WORKSPACE_GUTTER);
        if row.checked {
            let mark = rect(row.rect.left, row.rect.top, row.rect.left + gutter, row.rect.bottom);
            check_icon(g, mark, PRIMARY);
        }
        let ink = if !row.enabled {
            dim(FOREGROUND)
        } else if armed {
            DESTRUCTIVE
        } else if row.checked {
            PRIMARY
        } else {
            FOREGROUND
        };
        let label = text(view.lang, &if armed { Msg::EditResetAsk } else { workspace_msg(row.item) });
        let words = rect(row.rect.left + gutter, row.rect.top, row.rect.right - g.px(S4), row.rect.bottom);
        let room = (words.right - words.left) as f32 / g.s;
        let size = g.fitted(&label, room, T_BODY, T_CAPTION, semi, Face::Ui);
        g.text(&label, words, size, semi, Face::Ui, ink, DT_LEFT);
        if row.dotted {
            let dot = g.px(MARK_DOT);
            let (x, y) = (row.rect.right - g.px(S3) - dot, (row.rect.top + row.rect.bottom - dot) / 2);
            g.fill(rect(x, y, x + dot, y + dot), PRIMARY);
        }
    }
}

/// A check mark in a box (pixels), upright and square like the other icons: a short stroke down to the right, a long one up.
pub(super) fn check_icon(g: &mut Painter, r: RECT, color: COLORREF) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let (t, step) = (g.px(2.6), 1.6);
    let short = (0..3).map(|i| (-6.0 + i as f32 * step, -0.5 + i as f32 * step));
    let long = (0..6).map(|i| (-1.2 + i as f32 * step, 2.3 - i as f32 * step));
    for (dx, dy) in short.chain(long) {
        let (x, y) = (cx + g.px(dx), cy + g.px(dy));
        g.fill(rect(x, y, x + t, y + t), color);
    }
}

/// The language list, open under the language button: each language's flag and its name in its own words, the one
/// in use marked in yellow, the row under the mouse lit.
pub(super) fn lang_list(g: &mut Painter, width: i32, view: &View) {
    let [_, _, button, _, _] = header_hits(width, view.scale);
    g.place(view.scale, 0, 0);
    let (row_h, pad, list_w) = (g.px(40.0), g.px(6.0), g.px(200.0));
    let rows = Lang::ALL.len() as i32;
    let list = rect(
        button.right - list_w,
        button.bottom + g.px(6.0),
        button.right,
        button.bottom + g.px(6.0) + pad * 2 + row_h * rows,
    );
    g.round(list, POPOVER, Some(BORDER));
    for (i, lang) in Lang::ALL.into_iter().enumerate() {
        let top = list.top + pad + row_h * i as i32;
        let row = rect(list.left + pad, top, list.right - pad, top + row_h);
        let current = lang == view.lang;
        if view.mouse.is_some_and(|(mx, my)| inside(&row, mx, my)) {
            g.fill(row, ROW_HOVER);
        }
        if current {
            g.fill(
                rect(row.left, row.top + g.px(S2), row.left + g.px(3.0), row.bottom - g.px(S2)),
                PRIMARY,
            );
        }
        let (fw, fh) = (g.px(25.0), g.px(20.0));
        let flag = rect(
            row.left + g.px(14.0),
            top + (row_h - fh) / 2,
            row.left + g.px(14.0) + fw,
            top + (row_h - fh) / 2 + fh,
        );
        let image = flag_image(lang);
        if !image.is_null() {
            g.image(flag, image);
        }
        let label = rect(flag.right + g.px(S3), top, row.right - g.px(S2), top + row_h);
        g.text(
            lang.name(),
            label,
            T_BODY,
            FW_SEMIBOLD as i32,
            Face::Ui,
            if current { PRIMARY } else { FOREGROUND },
            DT_LEFT,
        );
        view.buttons.borrow_mut().push((Action::Lang(i), row));
    }
}

/// The name of the icon button under the mouse, in a small label below it.
pub(super) fn tooltip(g: &mut Painter, width: i32, view: &View) {
    let Some((mx, my)) = view.mouse else { return };
    let [_, _, lang, full, top] = header_hits(width, view.scale);
    let version = version_hit(width, view.scale).filter(|v| inside(v, mx, my));
    let edit = edit_button(width, view).filter(|e| inside(e, mx, my));
    let exit = view
        .buttons
        .borrow()
        .iter()
        .find(|(action, r)| *action == Action::ExitPreview && inside(r, mx, my))
        .map(|(_, r)| *r);
    let (r, label) = if let Some(v) = version {
        (v, format!("Build {}", env!("XPEED_BUILD")))
    } else if let Some(e) = exit {
        (e, text(view.lang, &Msg::PanelPreviewClose))
    } else if let Some(e) = edit {
        (e, text(view.lang, &Msg::PanelEditLayout))
    } else if inside(&lang, mx, my) {
        (lang, text(view.lang, &Msg::MenuLanguage))
    } else if inside(&full, mx, my) {
        (
            full,
            text(
                view.lang,
                if view.full {
                    &Msg::PanelExitFullScreen
                } else {
                    &Msg::PanelFullScreen
                },
            ),
        )
    } else if inside(&top, mx, my) {
        (top, text(view.lang, &Msg::PanelOnTop))
    } else {
        return;
    };
    g.place(view.scale, 0, 0);
    let measured = g.width_of(&label, T_CAPTION, FW_SEMIBOLD as i32, Face::Ui);
    let w = g.px(measured + 20.0);
    let h = g.px(28.0);
    let tip = rect(r.right - w, r.bottom + g.px(6.0), r.right, r.bottom + g.px(6.0) + h);
    g.round(tip, POPOVER, Some(BORDER));
    g.text(&label, tip, T_CAPTION, FW_SEMIBOLD as i32, Face::Ui, FOREGROUND, DT_CENTER);
}

pub(super) fn header(g: &mut Painter, width: i32, view: &View) {
    g.place(view.scale, 0, 0);
    let [dash, mon, lang, full, top] = header_hits(width, view.scale);
    let semi = FW_SEMIBOLD as i32;
    // The tabs: one square pill, the chosen tab a yellow square pill inside it (corners: `R_CORNER`).
    let control = rect(dash.left - g.px(S1), g.px(13.0), mon.right + g.px(S1), g.px(51.0));
    g.round(control, CARD, Some(BORDER));
    let tab_size = if mon.right - dash.left < g.px(200.0) { T_CAPTION } else { T_BODY };
    for (r, tab, label) in [(dash, Tab::Dash, Msg::PanelTabDash), (mon, Tab::Monitor, Msg::PanelTabMonitor)] {
        let selected = view.tab == tab;
        if selected {
            g.round(r, PRIMARY, None);
        }
        let color = if selected { BACKGROUND } else { MUTED_TEXT };
        g.text(&text(view.lang, &label), r, tab_size, semi, Face::Ui, color, DT_CENTER);
    }
    // Full screen and always on top: square icon buttons; one that is on is filled yellow. Full screen uses
    // Windows' own icon; the pin is drawn here, upright and square like the rest.
    // The language: a square button with its flag (yellow edge while its list is open); a click opens the list.
    g.round(lang, CARD, Some(if view.lang_open { PRIMARY } else { BORDER }));
    let (fw, fh) = (g.px(22.5), g.px(18.0));
    let (cx, cy) = ((lang.left + lang.right) / 2, (lang.top + lang.bottom) / 2);
    let image = flag_image(view.lang);
    if image.is_null() {
        g.text(
            &view.lang.code().to_uppercase(),
            lang,
            T_CAPTION,
            semi,
            Face::Ui,
            FOREGROUND,
            DT_CENTER,
        );
    } else {
        g.image(rect(cx - fw / 2, cy - fh / 2, cx - fw / 2 + fw, cy - fh / 2 + fh), image);
    }
    for (r, active) in [(full, view.full), (top, view.on_top)] {
        let (fill, edge) = if active { (PRIMARY, None) } else { (CARD, Some(BORDER)) };
        g.round(r, fill, edge);
    }
    let (full_ink, pin_ink) = (
        if view.full { BACKGROUND } else { FOREGROUND },
        if view.on_top { BACKGROUND } else { FOREGROUND },
    );
    full_icon(g, full, full_ink, view.full);
    pin_icon(g, top, pin_ink);
    // The dashboard in use, as a small pill after the tabs ("Race · Auto" when picked from the session).
    if view.tab == Tab::Dash && dashboard_shown(view.live, &view.snapshot.game, view.now_ms) {
        if let Some(r) = dashboard_hit(width, view.scale) {
            let name = text(view.lang, &view.dashboard_in_use().msg());
            let label = if view.dashboard.is_none() {
                format!("{name} · {}", text(view.lang, &Msg::PanelDashAuto))
            } else {
                name
            };
            let pill = rect(r.left, r.top, r.right, r.bottom);
            // A click opens the workspace menu: the pill's edge is yellow while it is open.
            g.round(pill, SURFACE, view.workspace_open.then_some(PRIMARY));
            // A dashboard with a layout of the driver's own saved has a small yellow mark after its name.
            if view.views.is_modified(view.dashboard_in_use()) {
                let (dot, room) = (g.px(MARK_DOT), g.px(S4));
                let y = (pill.top + pill.bottom - dot) / 2;
                g.fill(rect(pill.right - g.px(S3) - dot, y, pill.right - g.px(S3), y + dot), PRIMARY);
                let words = rect(pill.left, pill.top, pill.right - room, pill.bottom);
                g.caps(&label, words, T_CAPTION, FOREGROUND_2, DT_CENTER);
            } else {
                g.caps(&label, pill, T_CAPTION, FOREGROUND_2, DT_CENTER);
            }
        }
        // The example: a yellow-edged pill after the name that says so and closes it (×). The phone mark is not shown then.
        if let Some(label) = &view.preview {
            let want = g.caps_width(label, T_CAPTION) + 2.0 * S4 + S6;
            if let Some(r) = preview_hit(width, view.scale, want) {
                let hot = view.mouse.is_some_and(|(mx, my)| inside(&r, mx, my));
                g.round(r, if hot { ROW_HOVER } else { SURFACE }, Some(PRIMARY));
                let close = rect(r.right - g.px(S6), r.top, r.right - g.px(S1), r.bottom);
                g.text("×", close, T_BODY, semi, Face::Ui, PRIMARY, DT_CENTER);
                let words = rect(r.left + g.px(S3), r.top, close.left, r.bottom);
                g.caps(label, words, T_CAPTION, PRIMARY, DT_LEFT);
                view.buttons.borrow_mut().push((Action::ExitPreview, r));
            }
        } else if let Some(r) = phone_hit(width, view.scale).filter(|_| view.phone_viewers > 0) {
            // A phone is watching through the server: a small pill after the name.
            g.round(r, SURFACE, None);
            g.caps(&text(view.lang, &Msg::PanelPhone), r, T_CAPTION, PRIMARY, DT_CENTER);
        }
    }
    // Edit layout: a square button with a pencil, while the dashboard is on (edit mode has its own toolbar).
    if let Some(r) = edit_button(width, view) {
        g.round(r, CARD, Some(BORDER));
        pencil_icon(g, r, FOREGROUND);
    }
    // The version, small, left of the icon buttons, where every tab shows it.
    let version = concat!("v", env!("CARGO_PKG_VERSION"));
    if let Some(r) = version_hit(width, view.scale) {
        g.text(version, r, T_CAPTION, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_RIGHT);
    }
}

/// Four square corners in a box (pixels): pointing out to go full screen, in to leave it.
pub(super) fn full_icon(g: &mut Painter, r: RECT, color: COLORREF, leaving: bool) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let (reach, near, arm, t) = (g.px(S2), g.px(3.0), g.px(5.0), g.px(1.6).max(1));
    // A box from two corners in any order.
    let span = |x0: i32, y0: i32, x1: i32, y1: i32| rect(x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1));
    for (sx, sy) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        // Going full screen: each corner's point at the outside, its arms back toward the middle. Leaving: the
        // point near the middle, its arms out.
        let (vx, vy, d) = if leaving {
            (cx + sx * near, cy + sy * near, 1)
        } else {
            (cx + sx * reach, cy + sy * reach, -1)
        };
        g.fill(span(vx, vy, vx + d * sx * arm, vy + d * sy * t), color);
        g.fill(span(vx, vy, vx + d * sx * t, vy + d * sy * arm), color);
    }
}

/// An upright push pin in a box (pixels): a cap, a body, a wide collar and the needle, all square.
pub(super) fn pin_icon(g: &mut Painter, r: RECT, color: COLORREF) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let p = |v: f32| g.px(v);
    for (x0, y0, x1, y1) in [
        (-4.5, -9.0, 4.5, -6.5),  // cap
        (-3.0, -6.5, 3.0, 1.0),   // body
        (-6.5, 1.0, 6.5, 3.5),    // collar
        (-0.75, 3.5, 0.75, 10.0), // needle
    ] {
        g.fill(rect(cx + p(x0), cy + p(y0), cx + p(x1).max(p(x0) + 1), cy + p(y1)), color);
    }
}

/// The header's Edit button, when it is on offer: the dashboard tab shows a game's dashboard, and nothing is being edited.
pub(super) fn edit_button(width: i32, view: &View) -> Option<RECT> {
    let on = view.tab == Tab::Dash && view.edit.is_none() && dashboard_shown(view.live, &view.snapshot.game, view.now_ms);
    edit_button_hit(width, view.scale).filter(|_| on)
}

/// A pencil on a line in a box (pixels), upright and square like the other icons: its body runs up to the right, its point
/// at the lower left.
pub(super) fn pencil_icon(g: &mut Painter, r: RECT, color: COLORREF) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let (t, step) = (g.px(2.6), 1.6);
    for i in 0..=8 {
        let k = i as f32 * step;
        let (x, y) = (cx + g.px(-6.5 + k), cy + g.px(5.0 - k));
        g.fill(rect(x, y, x + t, y + t), color);
    }
    // The point and the line it writes.
    g.fill(rect(cx + g.px(-7.5), cy + g.px(5.5), cx + g.px(-4.5), cy + g.px(8.5)), color);
    let line_top = cy + g.px(7.0);
    g.fill(
        rect(cx + g.px(-2.0), line_top, cx + g.px(8.0), (cy + g.px(8.5)).max(line_top + 1)),
        color,
    );
}
