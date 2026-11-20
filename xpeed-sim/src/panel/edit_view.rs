//! Drawing the edit mode: the dashboard with every card of the view on it (a card the game cannot fill dimmed, saying so), what the
//! mouse is over, the card being carried and where it would land, the toolbar and the add list. It only reads the `EditUi`; what
//! the mouse does is `edit_ui.rs`.

use super::*;

/// The dashboard tab while a layout is edited.
pub(super) fn edit_screen(g: &mut Painter, body: RECT, d: &Dash, ui: &EditUi) {
    let view = d.view;
    let size = (body.right + g.px(S4), body.bottom + g.px(S4));
    let bar = edit_toolbar(size.0, view.scale);
    let plan = ui.plan();
    let room = rect(body.left, bar.band.bottom + g.px(S2), body.right, body.bottom);
    let fit = canvas_fit_wh(room, plan.w, plan.h);
    view.edit_xf.set(Some(fit));
    let (s, ox, oy) = ui.frozen.unwrap_or(fit);
    g.place(s, ox, oy);
    super::dash_view::header(g, d, plan.w);
    for &(pane, area) in &plan.cards {
        if d.slots.cards.contains(&pane) {
            card_frame(g, area);
            draw_pane(g, d, pane, area);
        } else {
            missing_card(g, d, pane, area);
        }
    }
    canvas_overlay(g, d, ui, &plan);
    g.place(view.scale, 0, 0);
    toolbar(g, d, ui, &bar);
    if ui.add_open {
        add_list(g, d, ui, &bar, size);
    }
}

/// A card of the view that the game cannot fill: its name and why it is empty, dimmed.
fn missing_card(g: &mut Painter, d: &Dash, pane: Pane, area: Area) {
    card_frame(g, area);
    let (x, y, w, h) = inner(area);
    let lang = d.view.lang;
    shown(g, Show::Dimmed, |g| {
        caption(g, &pane_title(pane, lang), (x, y, w, h), DT_LEFT);
        let note = text(lang, &Msg::EditNotGiven);
        g.wrapped(&note, x, y + CAPTION_H + S2, w, T_BODY, FW_NORMAL as i32, Face::Ui, MUTED_TEXT, DT_LEFT, 20.0);
    });
}

/// Over the cards: the shade on the card being carried, the outline of the one under the mouse, every × , the line being
/// dragged, the place a drop would land and the ghost of the card carried.
fn canvas_overlay(g: &mut Painter, d: &Dash, ui: &EditUi, plan: &Plan) {
    let view = &ui.session.current;
    let semi = FW_SEMIBOLD as i32;
    let carried = match &ui.drag {
        Some(Drag::Card { from, at, moved: true, .. }) => Some((*from, *at)),
        _ => None,
    };
    if let Some((from, _)) = carried {
        if let Some((x, y, w, h)) = card_area(view, plan, from) {
            g.veil_exact(g.exact(x, y, w, h), BACKGROUND, EDIT_SOURCE_VEIL);
        }
    }
    if let (Hover::Card(pos), None) = (ui.hover, carried) {
        if let Some((x, y, w, h)) = card_area(view, plan, pos) {
            g.outline(g.r(x, y, w, h), PRIMARY, STROKE_ACCENT);
        }
    }
    for (row, cards) in edit_rows(view, plan).iter().enumerate() {
        for (card, (_, area)) in cards.iter().enumerate() {
            let (x, y, w, h) = edit_remove_rect(*area);
            let hot = ui.hover == Hover::Card(Pos { row, card });
            let r = g.r(x, y, w, h);
            g.round(r, SURFACE, Some(if hot { PRIMARY } else { BORDER }));
            g.text("\u{d7}", r, T_BODY, semi, Face::Ui, FOREGROUND, DT_CENTER);
        }
    }
    let line = match (&ui.drag, ui.hover) {
        (Some(Drag::Split { row, left, .. }), _) => Some(Boundary::Split { row: *row, left: *left }),
        (Some(Drag::Row { row, .. }), _) => Some(Boundary::RowBottom(*row)),
        (None, Hover::Line(line)) => Some(line),
        _ => None,
    };
    if let Some((x, y, w, h)) = line.and_then(|line| boundary_line(view, plan, line)) {
        g.fill(g.r(x, y, w, h), PRIMARY);
    }
    if let Some(target) = ui.drop_target() {
        match target {
            Target::Swap(pos) => {
                if let Some((x, y, w, h)) = card_area(view, plan, pos) {
                    g.veil_exact(g.exact(x, y, w, h), PRIMARY, EDIT_DROP_VEIL);
                    g.outline(g.r(x, y, w, h), PRIMARY, STROKE_ACCENT);
                }
            }
            _ => {
                if let Some((x, y, w, h)) = drop_line(view, plan, target) {
                    g.fill(g.r(x, y, w, h), PRIMARY);
                }
            }
        }
    }
    if let Some((from, (mx, my))) = carried {
        if let Some((_, _, w, h)) = card_area(view, plan, from) {
            let ghost = g.r(mx - w / 2.0, my - h / 2.0, w, h);
            g.outline(ghost, FOREGROUND_2, STROKE_ACCENT);
            let name = view.rows.get(from.row).and_then(|r| r.cards.get(from.card)).map(|c| pane_title(c.0, d.view.lang));
            g.text(&name.unwrap_or_default(), ghost, T_LEAD, semi, Face::Ui, FOREGROUND_2, DT_CENTER);
        }
    }
}

/// The band under the header: "Editing · Race · Wide" (a dot after it when the view is not the built-in one; the message of a
/// refused edit in its place for a moment) and the four buttons.
fn toolbar(g: &mut Painter, d: &Dash, ui: &EditUi, bar: &Toolbar) {
    let view = d.view;
    let (lang, now, semi) = (view.lang, view.now_ms, FW_SEMIBOLD as i32);
    g.round(bar.band, CARD, Some(BORDER));
    let words = rect(bar.title.left + g.px(S3), bar.title.top, bar.title.right, bar.title.bottom);
    if let Some(note) = ui.note_at(now) {
        g.text(&text(lang, &note.msg()), words, T_BODY, semi, Face::Ui, WARN, DT_LEFT);
    } else {
        let title = format!(
            "{} \u{b7} {} \u{b7} {}",
            text(lang, &Msg::EditTitle),
            text(lang, &ui.session.dashboard.msg()),
            text(lang, &Msg::EditShape(layout_key(ui.session.layout)))
        );
        g.text(&title, words, T_BODY, semi, Face::Ui, FOREGROUND, DT_LEFT);
        if ui.is_modified() {
            let measured = g.width_of(&title, T_BODY, semi, Face::Ui);
            let used = g.px(measured);
            let dot = g.px(MARK_DOT);
            let (x, y) = (words.left + used + g.px(S2), (words.top + words.bottom - dot) / 2);
            g.fill(rect(x, y, x + dot, y + dot), PRIMARY);
        }
    }
    for (button, r) in bar.buttons {
        let hot = view.mouse.is_some_and(|(mx, my)| inside(&r, mx, my));
        let armed = button == EditButton::Reset && ui.reset_armed(now);
        let label = text(lang, &if armed { Msg::EditResetAsk } else { button.msg() });
        let rest = if hot { ROW_HOVER } else { CARD };
        let (fill, edge, ink) = match button {
            EditButton::Save => (PRIMARY, None, ON_PRIMARY),
            EditButton::Add if ui.add_open => (CARD, Some(PRIMARY), FOREGROUND),
            EditButton::Reset if armed => (CARD, Some(DESTRUCTIVE), DESTRUCTIVE),
            _ => (rest, Some(BORDER), FOREGROUND),
        };
        g.round(r, fill, edge);
        let room = (r.right - r.left) as f32 / g.s - S3;
        let size = g.fitted(&label, room, T_BODY, T_CAPTION, semi, Face::Ui);
        g.text(&label, r, size, semi, Face::Ui, ink, DT_CENTER);
    }
}

/// The panels that can be added, in a box under the Add button.
fn add_list(g: &mut Painter, d: &Dash, ui: &EditUi, bar: &Toolbar, size: (i32, i32)) {
    let view = d.view;
    let panes = addable(&ui.session.current);
    let list = edit_list(bar, size, view.scale, panes.len());
    g.round(list.outer, POPOVER, Some(BORDER));
    for (pane, r) in panes.iter().zip(&list.items) {
        if view.mouse.is_some_and(|(mx, my)| inside(r, mx, my)) {
            g.fill(*r, ROW_HOVER);
        }
        let label = rect(r.left + g.px(S3), r.top, r.right - g.px(S2), r.bottom);
        let ink = if d.slots.cards.contains(pane) { FOREGROUND } else { MUTED_TEXT };
        g.text(&pane_title(*pane, view.lang), label, T_BODY, FW_SEMIBOLD as i32, Face::Ui, ink, DT_LEFT);
    }
}
