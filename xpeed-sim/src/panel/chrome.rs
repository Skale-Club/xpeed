use super::*;

/// Draws one frame of the window.
pub fn paint(hdc: HDC, width: i32, height: i32, view: &View) {
    let mut g = Painter::new(hdc, view.scale);
    g.backdrop(width, height);
    header(&mut g, width, view);
    let top = g.px(HEADER_H);
    let body = rect(g.px(16.0), top, width - g.px(16.0), height - g.px(16.0));
    match view.tab {
        Tab::Dash => dashboard(&mut g, body, view),
        Tab::Monitor => monitor(&mut g, body, view),
    }
    if view.lang_open {
        lang_list(&mut g, width, view);
    } else {
        tooltip(&mut g, width, view);
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
    g.round(list, CORNER, CARD, Some(EDGE));
    for (i, lang) in Lang::ALL.into_iter().enumerate() {
        let top = list.top + pad + row_h * i as i32;
        let row = rect(list.left + pad, top, list.right - pad, top + row_h);
        let current = lang == view.lang;
        if view.mouse.is_some_and(|(mx, my)| inside(&row, mx, my)) {
            g.fill(row, mix(CARD, TEXT, 0.07));
        }
        if current {
            g.fill(
                rect(row.left, row.top + g.px(8.0), row.left + g.px(3.0), row.bottom - g.px(8.0)),
                ACCENT,
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
        let label = rect(flag.right + g.px(12.0), top, row.right - g.px(8.0), top + row_h);
        g.text(
            lang.name(),
            label,
            14.0,
            FW_SEMIBOLD as i32,
            Face::Ui,
            if current { ACCENT } else { TEXT },
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
    let (r, label) = if let Some(v) = version {
        (v, format!("Build {}", env!("XPEED_BUILD")))
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
    let measured = g.width_of(&label, 12.5, FW_SEMIBOLD as i32, Face::Ui);
    let w = g.px(measured + 20.0);
    let h = g.px(28.0);
    let tip = rect(r.right - w, r.bottom + g.px(6.0), r.right, r.bottom + g.px(6.0) + h);
    g.round(tip, CORNER, CARD, Some(EDGE));
    g.text(&label, tip, 12.5, FW_SEMIBOLD as i32, Face::Ui, TEXT, DT_CENTER);
}

pub(super) fn header(g: &mut Painter, width: i32, view: &View) {
    g.place(view.scale, 0, 0);
    let [dash, mon, lang, full, top] = header_hits(width, view.scale);
    let semi = FW_SEMIBOLD as i32;
    // The tabs: one pill, the chosen tab a yellow pill inside it.
    let control = rect(dash.left - g.px(4.0), g.px(13.0), mon.right + g.px(4.0), g.px(51.0));
    g.round(control, CORNER, CARD, Some(EDGE));
    let tab_size = if mon.right - dash.left < g.px(200.0) { 12.0 } else { 14.0 };
    for (r, tab, label) in [(dash, Tab::Dash, Msg::PanelTabDash), (mon, Tab::Monitor, Msg::PanelTabMonitor)] {
        let selected = view.tab == tab;
        if selected {
            g.round(r, CORNER, ACCENT, None);
        }
        let color = if selected { BG } else { MUTED };
        g.text(&text(view.lang, &label), r, tab_size, semi, Face::Ui, color, DT_CENTER);
    }
    // Full screen and always on top: square icon buttons; one that is on is filled yellow. Full screen uses
    // Windows' own icon; the pin is drawn here, upright and square like the rest.
    // The language: a square button with its flag (yellow edge while its list is open); a click opens the list.
    g.round(lang, CORNER, CARD, Some(if view.lang_open { ACCENT } else { EDGE }));
    let (fw, fh) = (g.px(22.5), g.px(18.0));
    let (cx, cy) = ((lang.left + lang.right) / 2, (lang.top + lang.bottom) / 2);
    let image = flag_image(view.lang);
    if image.is_null() {
        g.text(&view.lang.code().to_uppercase(), lang, 12.5, semi, Face::Ui, TEXT, DT_CENTER);
    } else {
        g.image(rect(cx - fw / 2, cy - fh / 2, cx - fw / 2 + fw, cy - fh / 2 + fh), image);
    }
    for (r, active) in [(full, view.full), (top, view.on_top)] {
        let (fill, edge) = if active { (ACCENT, None) } else { (CARD, Some(EDGE)) };
        g.round(r, CORNER, fill, edge);
    }
    let (full_ink, pin_ink) = (if view.full { BG } else { TEXT }, if view.on_top { BG } else { TEXT });
    full_icon(g, full, full_ink, view.full);
    pin_icon(g, top, pin_ink);
    // The version, small, left of the icon buttons, where every tab shows it.
    let version = concat!("v", env!("CARGO_PKG_VERSION"));
    if let Some(r) = version_hit(width, view.scale) {
        g.text(version, r, 12.0, FW_NORMAL as i32, Face::Ui, MUTED, DT_RIGHT);
    }
}

/// Four square corners in a box (pixels): pointing out to go full screen, in to leave it.
pub(super) fn full_icon(g: &mut Painter, r: RECT, color: COLORREF, leaving: bool) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let (reach, near, arm, t) = (g.px(8.0), g.px(3.0), g.px(5.0), g.px(1.6).max(1));
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
