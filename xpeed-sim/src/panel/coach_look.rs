//! How the Coach window (`coach/dialog.rs`) looks: its backdrop and cards, its buttons, the switch that turns it on,
//! the session picker and its labels, all drawn with the panel's painter and tokens so the two windows read as one
//! program. The Coach keeps native controls (focus, keyboard, screen readers, text editing); this file only paints
//! them. Everything here takes pixels and the window's scale (its DPI over 96).

use super::*;

/// The colours the Coach's native controls are given (`WM_CTLCOLOR*`): what the window paints around them.
pub(crate) const COACH_CARD: COLORREF = CARD;
/// The inside of an input box (the question draft, the session picker's list).
pub(crate) const COACH_INPUT: COLORREF = SURFACE;
/// Text typed or shown in a control.
pub(crate) const COACH_TEXT: COLORREF = FOREGROUND;
/// The text of a control that cannot be used now.
pub(crate) const COACH_TEXT_OFF: COLORREF = MUTED_TEXT;
/// The window's own background, behind the cards (also the title bar's colour).
pub(crate) const COACH_BACKGROUND: COLORREF = BACKGROUND;

/// The type sizes of the Coach, in design pixels (from the panel's scale).
pub(crate) const COACH_BODY: f32 = T_BODY;

/// A button's part in the window: the one action to take (yellow) or any other.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoachButton {
    Primary,
    Secondary,
}

/// What a control is doing as it is drawn.
#[derive(Clone, Copy, Default)]
pub(crate) struct CoachState {
    pub disabled: bool,
    pub pressed: bool,
    pub hot: bool,
    pub focus: bool,
}

/// The font of the Coach's text controls (the draft, the conversation, the picker's list): Chakra Petch at body size.
/// The caller deletes it.
pub(crate) fn coach_font(scale: f32) -> HFONT {
    register_fonts();
    let (name, weight, italic) = Face::Ui.font(FW_NORMAL as i32);
    let name = win::wide(name);
    unsafe {
        CreateFontW(
            -((COACH_BODY * scale).round() as i32).max(1),
            0,
            0,
            0,
            weight,
            u32::from(italic),
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_NATURAL_QUALITY,
            0,
            name.as_ptr(),
        )
    }
}

/// The window behind its controls: the panel's backdrop, then each card (`cards`) and each input box (`inputs`, with
/// a yellow edge on the one being typed in), and a hairline across each of `rules`.
pub(crate) fn coach_backdrop(hdc: HDC, width: i32, height: i32, scale: f32, cards: &[RECT], inputs: &[(RECT, bool)], rules: &[RECT]) {
    let g = Painter::new(hdc, scale);
    // Drawn each time rather than through the panel's kept copy: that copy is one per thread, and this window shares
    // the panel's thread, so the two sizes would keep replacing each other. The Coach repaints seldom.
    draw_backdrop(hdc, width, height, (7.0 * scale).max(5.0));
    for card in cards {
        g.round(*card, R_CARD, CARD, Some(BORDER));
    }
    for (input, focused) in inputs {
        g.round(*input, R_TILE, SURFACE, Some(if *focused { PRIMARY } else { BORDER }));
    }
    for rule in rules {
        g.fill(*rule, BORDER);
    }
}

/// A button: the yellow pill of the panel's chosen tab for the main action, a quiet card-coloured one for the others.
pub(crate) fn coach_button(hdc: HDC, r: RECT, label: &str, kind: CoachButton, state: CoachState, scale: f32) {
    let mut g = Painter::new(hdc, scale);
    g.fill(r, CARD);
    let (fill, edge, ink) = match (kind, state.disabled) {
        (_, true) => (CARD, Some(BORDER), mix(CARD, MUTED_TEXT, 0.6)),
        (CoachButton::Primary, false) if state.pressed => (mix(PRIMARY, BACKGROUND, 0.18), None, ON_PRIMARY),
        (CoachButton::Primary, false) if state.hot => (mix(PRIMARY, FOREGROUND, 0.25), None, ON_PRIMARY),
        (CoachButton::Primary, false) => (PRIMARY, None, ON_PRIMARY),
        (CoachButton::Secondary, false) if state.pressed => (SURFACE, Some(BORDER), FOREGROUND),
        (CoachButton::Secondary, false) if state.hot => (ROW_HOVER, Some(mix(BORDER, FOREGROUND, 0.12)), FOREGROUND),
        (CoachButton::Secondary, false) => (SECONDARY, Some(BORDER), FOREGROUND),
    };
    // The keyboard's place: a yellow edge (on the yellow button, a dark ring inside it).
    let edge = if state.focus && !state.disabled {
        Some(if kind == CoachButton::Primary { FOREGROUND } else { PRIMARY })
    } else {
        edge
    };
    g.round(r, R_TILE, fill, edge);
    g.text(label, r, T_BODY, FW_SEMIBOLD as i32, Face::Ui, ink, DT_CENTER);
}

/// The switch that turns the Coach on, with its label to the right (the site's switch: yellow when on).
pub(crate) fn coach_switch(hdc: HDC, r: RECT, label: &str, on: bool, state: CoachState, scale: f32) {
    let mut g = Painter::new(hdc, scale);
    g.fill(r, CARD);
    let (track_w, track_h) = (g.px(40.0), g.px(22.0));
    let top = (r.top + r.bottom - track_h) / 2;
    let track = rect(r.left + g.px(2.0), top, r.left + g.px(2.0) + track_w, top + track_h);
    let pill = track_h as f32 / 2.0 / scale;
    let (fill, edge, knob) = match (on, state.disabled) {
        (true, false) => (PRIMARY, None, ON_PRIMARY),
        (true, true) => (mix(CARD, PRIMARY, 0.35), None, mix(CARD, ON_PRIMARY, 0.6)),
        (false, false) => (SECONDARY, Some(if state.hot { MUTED_TEXT } else { BORDER }), MUTED_TEXT),
        (false, true) => (SURFACE, Some(BORDER), mix(CARD, MUTED_TEXT, 0.5)),
    };
    let edge = if state.focus && !state.disabled { Some(FOREGROUND) } else { edge };
    g.round(track, pill, fill, edge);
    let inset = g.px(3.0);
    let size = track_h - 2 * inset;
    let x = if on { track.right - inset - size } else { track.left + inset };
    g.round(
        rect(x, track.top + inset, x + size, track.top + inset + size),
        size as f32 / 2.0 / scale,
        knob,
        None,
    );
    let text = rect(track.right + g.px(S3), r.top, r.right, r.bottom);
    let ink = if state.disabled { MUTED_TEXT } else { FOREGROUND };
    g.text(label, text, T_BODY, FW_SEMIBOLD as i32, Face::Ui, ink, DT_LEFT);
}

/// A card's small upper-case heading, as the panel labels its cards.
pub(crate) fn coach_label(hdc: HDC, r: RECT, label: &str, scale: f32) {
    let mut g = Painter::new(hdc, scale);
    g.fill(r, CARD);
    g.caps(label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
}

/// What the Coach is doing, in muted text over as many lines as fit (the last one cut with "…").
pub(crate) fn coach_note(hdc: HDC, r: RECT, note: &str, scale: f32) {
    let mut g = Painter::new(hdc, scale);
    g.fill(r, CARD);
    let line_h = (T_BODY * 1.4).round();
    let width = (r.right - r.left) as f32 / scale;
    let rows = (((r.bottom - r.top) as f32 / scale / line_h).floor() as usize).max(1);
    let mut lines = g.wrap_lines(note, width, T_BODY, FW_NORMAL as i32, Face::Ui);
    if lines.len() > rows {
        let rest = lines.split_off(rows - 1).join(" ");
        lines.push(rest);
    }
    for (i, line) in lines.iter().enumerate() {
        let top = r.top + g.px(line_h * i as f32);
        let row = rect(r.left, top, r.right, top + g.px(line_h));
        g.text(line, row, T_BODY, FW_NORMAL as i32, Face::Ui, FOREGROUND_2, DT_LEFT);
    }
}

/// The session picker as it shows when closed: an input box with the chosen session and a chevron.
pub(crate) fn coach_select(hdc: HDC, r: RECT, value: &str, state: CoachState, open: bool, scale: f32) {
    let mut g = Painter::new(hdc, scale);
    g.fill(r, CARD);
    let edge = if open || (state.focus && !state.disabled) {
        PRIMARY
    } else if state.hot && !state.disabled {
        mix(BORDER, FOREGROUND, 0.2)
    } else {
        BORDER
    };
    g.round(r, R_TILE, if state.disabled { CARD } else { SURFACE }, Some(edge));
    let chevron_w = g.px(S8);
    let text = rect(r.left + g.px(S3), r.top, r.right - chevron_w, r.bottom);
    let ink = if state.disabled { MUTED_TEXT } else { FOREGROUND };
    g.text(value, text, T_BODY, FW_NORMAL as i32, Face::Ui, ink, DT_LEFT);
    // A chevron of two strokes, pointing down (up while the list is open).
    let (cx, cy) = (r.right - chevron_w / 2 - g.px(2.0), (r.top + r.bottom) / 2);
    let (half, rise) = (g.px(5.0) as f32, g.px(3.0) as f32 * if open { -1.0 } else { 1.0 });
    let colour = if state.disabled { mix(CARD, MUTED_TEXT, 0.6) } else { MUTED_TEXT };
    smooth(hdc, |graphics| unsafe {
        let mut pen = null_mut();
        GdipCreatePen1(argb(colour), 1.6 * scale, UnitPixel, &mut pen);
        let (x, y) = (cx as f32, cy as f32);
        GdipDrawLine(graphics, pen, x - half, y - rise, x, y + rise);
        GdipDrawLine(graphics, pen, x, y + rise, x + half, y - rise);
        GdipDeletePen(pen);
    });
}

/// One row of the session picker's open list: lit under the mouse, as the panel's language list.
pub(crate) fn coach_list_row(hdc: HDC, r: RECT, value: &str, lit: bool, scale: f32) {
    let mut g = Painter::new(hdc, scale);
    g.fill(r, if lit { ROW_HOVER } else { SURFACE });
    if lit {
        g.fill(rect(r.left, r.top + g.px(S2), r.left + g.px(3.0), r.bottom - g.px(S2)), PRIMARY);
    }
    let text = rect(r.left + g.px(S3), r.top, r.right - g.px(S2), r.bottom);
    g.text(
        value,
        text,
        T_BODY,
        FW_NORMAL as i32,
        Face::Ui,
        if lit { PRIMARY } else { FOREGROUND },
        DT_LEFT,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Graphics::Gdi::{DeleteDC, GdiFlush, GetPixel};

    /// Paints with `draw` into a bitmap of `w` x `h` and gives back a reader of its pixels (as `COLORREF`).
    fn painted(w: i32, h: i32, draw: impl FnOnce(HDC)) -> impl Fn(i32, i32) -> COLORREF {
        unsafe {
            let hdc = CreateCompatibleDC(null_mut());
            let bitmap = dib(hdc, w, h);
            assert!(!bitmap.is_null());
            let old = SelectObject(hdc, bitmap);
            draw(hdc);
            GdiFlush();
            let pixels: Vec<COLORREF> = (0..h)
                .flat_map(|y| (0..w).map(move |x| (x, y)))
                .map(|(x, y)| GetPixel(hdc, x, y))
                .collect();
            SelectObject(hdc, old);
            DeleteObject(bitmap);
            DeleteDC(hdc);
            move |x, y| pixels[(y * w + x) as usize]
        }
    }

    #[test]
    fn the_main_button_is_the_brand_yellow_and_the_others_are_quiet() {
        let r = rect(0, 0, 120, 36);
        let primary = painted(120, 36, |hdc| {
            coach_button(hdc, r, "Send", CoachButton::Primary, CoachState::default(), 1.0)
        });
        let secondary = painted(120, 36, |hdc| {
            coach_button(hdc, r, "Record", CoachButton::Secondary, CoachState::default(), 1.0)
        });
        let off = painted(120, 36, |hdc| {
            let state = CoachState {
                disabled: true,
                ..CoachState::default()
            };
            coach_button(hdc, r, "Send", CoachButton::Primary, state, 1.0)
        });
        // Inside the edge, left of the label.
        assert_eq!(primary(8, 18), PRIMARY);
        assert_eq!(secondary(8, 18), SECONDARY);
        assert_eq!(off(8, 18), CARD);
        // The rounded corner shows the card behind it.
        assert_eq!(primary(0, 0), CARD);
    }

    #[test]
    fn the_switch_is_yellow_when_on_and_grey_when_off() {
        let r = rect(0, 0, 260, 36);
        let on = painted(260, 36, |hdc| {
            coach_switch(hdc, r, "Enable Coach here", true, CoachState::default(), 1.0)
        });
        let off = painted(260, 36, |hdc| {
            coach_switch(hdc, r, "Enable Coach here", false, CoachState::default(), 1.0)
        });
        // The track's left half, beside the knob when on (the knob sits right) and under it when off.
        assert_eq!(on(12, 18), PRIMARY);
        assert_eq!(off(30, 18), SECONDARY);
    }

    #[test]
    fn the_window_draws_its_cards_and_inputs_over_the_backdrop() {
        let (w, h) = (300, 200);
        let card = rect(10, 10, 290, 190);
        let input = rect(30, 120, 270, 170);
        let rule = rect(30, 100, 270, 101);
        let focused = painted(w, h, |hdc| coach_backdrop(hdc, w, h, 1.0, &[card], &[(input, true)], &[rule]));
        let idle = painted(w, h, |hdc| coach_backdrop(hdc, w, h, 1.0, &[card], &[(input, false)], &[rule]));
        assert_eq!(idle(150, 50), CARD);
        assert_eq!(idle(150, 145), SURFACE);
        assert_eq!(idle(150, 100), BORDER);
        assert_eq!(idle(150, 120), BORDER);
        assert_eq!(focused(150, 120), PRIMARY);
        assert_ne!(idle(3, 3), CARD, "outside the card is the backdrop");
    }

    #[test]
    fn the_session_picker_is_an_input_box_with_a_yellow_edge_while_open() {
        let r = rect(0, 0, 400, 36);
        let closed = painted(400, 36, |hdc| coach_select(hdc, r, "Monza", CoachState::default(), false, 1.0));
        let open = painted(400, 36, |hdc| coach_select(hdc, r, "Monza", CoachState::default(), true, 1.0));
        assert_eq!(closed(200, 18), SURFACE);
        assert_eq!(closed(200, 0), BORDER);
        assert_eq!(open(200, 0), PRIMARY);
    }
}
