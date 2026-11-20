//! The panel's edit mode without a window: what a press, a move, a release and a key do to an edit session (`EditUi`), where the
//! toolbar, the add list and the cards' × buttons are (pixels, from the window's size and scale), and what the mouse is over
//! (`edit_hit`, `edit_cursor`). `window.rs` only turns Win32 messages into these calls and `edit_view.rs` only draws what they
//! say, so all of it is checked without a window (`edit_ui_tests.rs`).
//!
//! The canvas is the plan of the view being edited (`edit_plan`: every card of the view, the ones the game cannot fill too),
//! drawn at the scale and offset `canvas_fit_wh` gives (`Xf`). While something is dragged that transform is frozen at the press,
//! so a row growing under the mouse does not change the scale the mouse is read with.

use super::*;
use std::path::Path;

/// The scale and the origin (pixels) the canvas is drawn at.
pub(super) type Xf = (f32, i32, i32);

/// The four buttons of the toolbar, left to right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditButton {
    Add,
    Reset,
    Cancel,
    Save,
}

impl EditButton {
    pub(super) const ALL: [EditButton; 4] = [EditButton::Add, EditButton::Reset, EditButton::Cancel, EditButton::Save];

    pub(super) fn msg(self) -> Msg {
        match self {
            EditButton::Add => Msg::EditAdd,
            EditButton::Reset => Msg::EditReset,
            EditButton::Cancel => Msg::EditCancel,
            EditButton::Save => Msg::EditSave,
        }
    }
}

/// A short message the toolbar shows for `EDIT_NOTE_MS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditNote {
    Refused(Refused),
    NothingToAdd,
    SaveFailed,
}

impl EditNote {
    pub(super) fn msg(self) -> Msg {
        match self {
            EditNote::Refused(Refused::TooNarrow) => Msg::EditTooNarrow,
            EditNote::Refused(Refused::RowFull) => Msg::EditRowFull,
            EditNote::Refused(Refused::TooManyRows) => Msg::EditTooManyRows,
            EditNote::Refused(Refused::LastCard) => Msg::EditLastCard,
            EditNote::Refused(Refused::AlreadyInView) => Msg::EditAlreadyIn,
            EditNote::Refused(_) => Msg::EditCannot,
            EditNote::NothingToAdd => Msg::EditNothingToAdd,
            EditNote::SaveFailed => Msg::EditSaveFailed,
        }
    }
}

/// What the mouse is over on the canvas (without a button down).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Hover {
    #[default]
    Nothing,
    Card(Pos),
    Line(Boundary),
}

/// What a press started.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Drag {
    /// A card taken by its body: where the press was, where the mouse is, and whether it went far enough to be a move.
    Card {
        from: Pos,
        start: (f32, f32),
        at: (f32, f32),
        moved: bool,
    },
    /// The line between two cards of a row: where the press was (x) and the view then, so the total delta is what counts.
    Split {
        row: usize,
        left: usize,
        start: f32,
        base: SavedView,
    },
    /// The line under a row: where the press was (y) and the view then.
    Row { row: usize, start: f32, base: SavedView },
}

/// How an edit session ends; the window does the rest (it owns the saved views and the file).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditEnd {
    Save,
    Cancel,
    /// The saved views of the dashboard go and the session goes on from the built-in rows.
    Reset,
}

/// The keys edit mode answers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditKey {
    Escape,
    Enter,
    CtrlS,
}

/// What a point of the window is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum EditHit {
    Button(EditButton),
    /// A row of the add list.
    ListItem(Pane),
    /// The add list's box between its rows.
    ListInside,
    /// Anywhere else while the add list is open.
    ListOutside,
    /// The × of a card.
    Remove(Pos),
    /// The canvas, at this point (design units).
    Canvas(f32, f32),
    /// The header and the toolbar's band.
    Outside,
}

/// The mouse cursor to show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditCursor {
    Arrow,
    Hand,
    SizeWe,
    SizeNs,
    SizeAll,
}

/// The state of the edit mode: the session and what the mouse and the keys have on hold.
#[derive(Clone, Debug)]
pub(super) struct EditUi {
    pub(super) session: EditSession,
    pub(super) drag: Option<Drag>,
    /// The canvas's transform as it was when the press that started `drag` came.
    pub(super) frozen: Option<Xf>,
    pub(super) hover: Hover,
    /// The add list is open.
    pub(super) add_open: bool,
    /// The message on show and when it goes (ms).
    pub(super) note: Option<(EditNote, i64)>,
    /// A reset waits for its second click until this time (ms).
    pub(super) reset_until: i64,
}

impl EditUi {
    pub(super) fn new(dashboard: DashboardId, layout: Layout, original: SavedView) -> EditUi {
        EditUi {
            session: EditSession::new(dashboard, layout, original),
            drag: None,
            frozen: None,
            hover: Hover::Nothing,
            add_open: false,
            note: None,
            reset_until: 0,
        }
    }

    /// The canvas of the view being edited.
    pub(super) fn plan(&self) -> Plan {
        edit_plan(&self.session.current, self.session.layout)
    }

    /// The message to show at `now`.
    pub(super) fn note_at(&self, now: i64) -> Option<EditNote> {
        self.note.filter(|(_, until)| now < *until).map(|(note, _)| note)
    }

    /// The reset has been clicked once and waits for the second.
    pub(super) fn reset_armed(&self, now: i64) -> bool {
        now < self.reset_until
    }

    /// The view being edited is not the built-in one (the dot after the name in the toolbar).
    pub(super) fn is_modified(&self) -> bool {
        self.session.current != SavedView::default_for(self.session.dashboard, self.session.layout)
    }

    fn say(&mut self, note: EditNote, now: i64) {
        self.note = Some((note, now + EDIT_NOTE_MS));
    }

    fn apply(&mut self, op: EditOp, now: i64) {
        if let Err(why) = self.session.apply(op) {
            self.say(EditNote::Refused(why), now);
        }
    }

    /// The writing failed: the message says so and the session goes on.
    pub(super) fn save_failed(&mut self, now: i64) {
        self.say(EditNote::SaveFailed, now);
    }

    /// Goes on from `view` (after a reset): the view to come back to on cancel and the one being edited are both it.
    pub(super) fn restart(&mut self, view: SavedView) {
        self.session = EditSession::new(self.session.dashboard, self.session.layout, view);
        self.drag = None;
        self.frozen = None;
        self.hover = Hover::Nothing;
        self.add_open = false;
        self.reset_until = 0;
    }

    /// What a card dropped now would do, while one is being dragged.
    pub(super) fn drop_target(&self) -> Option<Target> {
        match &self.drag {
            Some(Drag::Card { at, moved: true, .. }) => target_at(&self.plan(), at.0, at.1),
            _ => None,
        }
    }

    /// A button of the toolbar, or a press on the canvas, or a row of the add list.
    pub(super) fn press(&mut self, hit: EditHit, xf: Xf, now: i64) -> Option<EditEnd> {
        match hit {
            EditHit::ListItem(pane) => {
                self.add_open = false;
                self.apply(EditOp::Add(pane), now);
                None
            }
            EditHit::ListInside | EditHit::Outside => None,
            EditHit::ListOutside => {
                self.add_open = false;
                None
            }
            EditHit::Button(button) => self.button(button, now),
            EditHit::Remove(pos) => {
                self.apply(EditOp::Remove(pos), now);
                None
            }
            EditHit::Canvas(x, y) => {
                self.start_drag(x, y, xf);
                None
            }
        }
    }

    fn button(&mut self, button: EditButton, now: i64) -> Option<EditEnd> {
        if button != EditButton::Reset {
            self.reset_until = 0;
        }
        match button {
            EditButton::Add => {
                if addable(&self.session.current).is_empty() {
                    self.add_open = false;
                    self.say(EditNote::NothingToAdd, now);
                } else {
                    self.add_open = !self.add_open;
                }
                None
            }
            EditButton::Reset => {
                self.add_open = false;
                if self.reset_armed(now) {
                    self.reset_until = 0;
                    Some(EditEnd::Reset)
                } else {
                    self.reset_until = now + EDIT_NOTE_MS;
                    None
                }
            }
            EditButton::Cancel => Some(EditEnd::Cancel),
            EditButton::Save => Some(EditEnd::Save),
        }
    }

    fn start_drag(&mut self, x: f32, y: f32, xf: Xf) {
        let plan = self.plan();
        if let Some(line) = boundary_at(&plan, x, y, EDIT_GRAB) {
            let base = self.session.current.clone();
            self.drag = Some(match line {
                Boundary::Split { row, left } => Drag::Split { row, left, start: x, base },
                Boundary::RowBottom(row) => Drag::Row { row, start: y, base },
            });
            self.hover = Hover::Line(line);
            self.frozen = Some(xf);
        } else if let Some(from) = card_at(&plan, x, y) {
            self.drag = Some(Drag::Card {
                from,
                start: (x, y),
                at: (x, y),
                moved: false,
            });
            self.frozen = Some(xf);
        }
    }

    /// The mouse moved to `pt` (design units, read with the frozen transform while dragging), over `hit`.
    pub(super) fn mouse_moved(&mut self, hit: EditHit, pt: (f32, f32)) {
        if self.drag.is_none() {
            self.hover = match hit {
                EditHit::Canvas(x, y) => self.hover_at(x, y),
                EditHit::Remove(pos) => Hover::Card(pos),
                _ => Hover::Nothing,
            };
            return;
        }
        let layout = self.session.layout;
        match &mut self.drag {
            Some(Drag::Card { start, at, moved, .. }) => {
                *at = pt;
                if (pt.0 - start.0).hypot(pt.1 - start.1) >= EDIT_DRAG_MIN {
                    *moved = true;
                }
            }
            Some(Drag::Split { row, left, start, base }) => {
                let op = EditOp::ResizeSplit {
                    row: *row,
                    left: *left,
                    delta: pt.0 - *start,
                };
                if let Ok(view) = apply_op(base, layout, op) {
                    self.session.current = view;
                }
            }
            Some(Drag::Row { row, start, base }) => {
                let h = base.rows.get(*row).map_or(0.0, |r| r.h) + pt.1 - *start;
                if let Ok(view) = apply_op(base, layout, EditOp::ResizeRow { row: *row, h }) {
                    self.session.current = view;
                }
            }
            None => {}
        }
    }

    fn hover_at(&self, x: f32, y: f32) -> Hover {
        let plan = self.plan();
        if let Some(line) = boundary_at(&plan, x, y, EDIT_GRAB) {
            Hover::Line(line)
        } else if let Some(pos) = card_at(&plan, x, y) {
            Hover::Card(pos)
        } else {
            Hover::Nothing
        }
    }

    /// The mouse is not over the window any more.
    pub(super) fn mouse_left(&mut self) {
        if self.drag.is_none() {
            self.hover = Hover::Nothing;
        }
    }

    /// The button came up at `pt`: a card that was carried is dropped where it is (a drop that is refused says why and changes
    /// nothing); a line that was dragged already has its new place.
    pub(super) fn released(&mut self, pt: (f32, f32), now: i64) {
        self.frozen = None;
        if let Some(Drag::Card { from, at, moved: true, .. }) = self.drag.take() {
            let here = if pt.0.is_finite() && pt.1.is_finite() { pt } else { at };
            if let Some(target) = target_at(&self.plan(), here.0, here.1) {
                self.apply(EditOp::Move(from, target), now);
            }
        }
    }

    /// Lets go of what is being dragged, putting a line back where it was.
    pub(super) fn cancel_drag(&mut self) {
        self.frozen = None;
        if let Some(Drag::Split { base, .. } | Drag::Row { base, .. }) = self.drag.take() {
            self.session.current = base;
        }
    }

    pub(super) fn key(&mut self, key: EditKey) -> Option<EditEnd> {
        match key {
            EditKey::Escape => {
                if self.drag.is_some() {
                    self.cancel_drag();
                    None
                } else if self.add_open {
                    self.add_open = false;
                    None
                } else {
                    Some(EditEnd::Cancel)
                }
            }
            EditKey::Enter | EditKey::CtrlS => {
                self.cancel_drag();
                Some(EditEnd::Save)
            }
        }
    }
}

/// The canvas of a view, every card of it: the rows as the view has them (their own heights, none shrunk to what a game fills),
/// so the plan's rows and cards are the view's rows and cards.
pub(super) fn edit_plan(view: &SavedView, layout: Layout) -> Plan {
    let w = layout.width();
    let mut cards = Vec::new();
    let mut y = CARDS_TOP;
    for row in &view.rows {
        for ((pane, _), (x, cw)) in row.cards.iter().zip(row_places(0.0, w, GAP, &row.cards)) {
            cards.push((*pane, (x, y, cw, row.h)));
        }
        y += row.h + GAP;
    }
    Plan {
        w,
        h: if cards.is_empty() { y } else { y - GAP },
        cards,
    }
}

/// The plan's cards by row, in the view's order.
pub(super) fn edit_rows(view: &SavedView, plan: &Plan) -> Vec<Vec<(Pane, Area)>> {
    let mut at = 0;
    view.rows
        .iter()
        .map(|row| {
            let end = (at + row.cards.len()).min(plan.cards.len());
            let cards = plan.cards[at.min(end)..end].to_vec();
            at = end;
            cards
        })
        .collect()
}

/// The place of the × of a card: a small tab at the card's top right that sits over the gap above the card and the card's top
/// padding (it ends where the card's inside begins, `inner`), so it never covers the caption line or what stands at its right.
pub(super) fn edit_remove_rect((x, y, w, _): Area) -> Area {
    (x + w - S1 - EDIT_X_SIZE, y + S3 - EDIT_X_SIZE, EDIT_X_SIZE, EDIT_X_SIZE)
}

/// The line of a card where its caption (and a figure or a word at its right) is drawn: the first line of the card's inside.
pub(super) fn card_title_line(area: Area) -> Area {
    let (x, y, w, _) = inner(area);
    (x, y, w, CAPTION_H)
}

fn within((x, y, w, h): Area, px: f32, py: f32) -> bool {
    (x..x + w).contains(&px) && (y..y + h).contains(&py)
}

/// The card whose × is at a point of the canvas.
pub(super) fn remove_at(view: &SavedView, plan: &Plan, x: f32, y: f32) -> Option<Pos> {
    for (row, cards) in edit_rows(view, plan).iter().enumerate() {
        for (card, (_, area)) in cards.iter().enumerate() {
            if within(edit_remove_rect(*area), x, y) {
                return Some(Pos { row, card });
            }
        }
    }
    None
}

/// The line to draw for a boundary: a bar across the gap it sits in (design units).
pub(super) fn boundary_line(view: &SavedView, plan: &Plan, line: Boundary) -> Option<Area> {
    let rows = edit_rows(view, plan);
    match line {
        Boundary::Split { row, left } => {
            let cards = rows.get(row)?;
            let (a, b) = (cards.get(left)?.1, cards.get(left + 1)?.1);
            let mid = (a.0 + a.2 + b.0) / 2.0;
            Some((mid - EDIT_LINE / 2.0, a.1, EDIT_LINE, a.3))
        }
        Boundary::RowBottom(row) => {
            let a = rows.get(row)?.first()?.1;
            Some((0.0, a.1 + a.3 + GAP / 2.0 - EDIT_LINE / 2.0, plan.w, EDIT_LINE))
        }
    }
}

/// The bar that shows where a dropped card would go: beside a card, or between rows. A swap has none (the card is tinted).
pub(super) fn drop_line(view: &SavedView, plan: &Plan, target: Target) -> Option<Area> {
    let rows = edit_rows(view, plan);
    match target {
        Target::Beside(pos, side) => {
            let a = rows.get(pos.row)?.get(pos.card)?.1;
            let x = match side {
                Side::Left => a.0 - GAP / 2.0,
                Side::Right => a.0 + a.2 + GAP / 2.0,
            };
            Some((x - EDIT_LINE / 2.0, a.1, EDIT_LINE, a.3))
        }
        Target::NewRow(index) => {
            let y = match rows.get(index) {
                Some(cards) => cards.first()?.1 .1 - GAP / 2.0,
                None => rows.last().and_then(|cards| cards.first()).map(|c| c.1 .1 + c.1 .3 + GAP / 2.0)?,
            };
            Some((0.0, y - EDIT_LINE / 2.0, plan.w, EDIT_LINE))
        }
        Target::Swap(_) => None,
    }
}

/// The area of a card of the plan.
pub(super) fn card_area(view: &SavedView, plan: &Plan, pos: Pos) -> Option<Area> {
    edit_rows(view, plan).get(pos.row)?.get(pos.card).map(|c| c.1)
}

/// The toolbar, in pixels: its band under the header, the room for the title, and the buttons.
#[derive(Clone, Copy)]
pub(super) struct Toolbar {
    pub(super) band: RECT,
    pub(super) title: RECT,
    pub(super) buttons: [(EditButton, RECT); 4],
}

/// Where the toolbar is in a window `width` pixels wide at `scale`: in one row (the title, then the buttons at the right), or
/// in two (the title, then the buttons sharing the width) when the window is narrow.
pub(super) fn edit_toolbar(width: i32, scale: f32) -> Toolbar {
    let p = |v: f32| (v * scale).round() as i32;
    let (left, right, top) = (p(S4), width - p(S4), p(HEADER_H));
    let (gap, h) = (p(S2), p(EDIT_BTN_H));
    if width as f32 / scale >= EDIT_ONE_ROW_W {
        let bar_h = p(EDIT_BAR_H);
        let band = rect(left, top, right, top + bar_h);
        let y = top + (bar_h - h) / 2;
        let mut buttons = [(EditButton::Add, band); 4];
        let mut x = right;
        for (i, button) in EditButton::ALL.into_iter().enumerate().rev() {
            let w = p(EDIT_BTN_W[i]);
            buttons[i] = (button, rect(x - w, y, x, y + h));
            x -= w + gap;
        }
        Toolbar {
            band,
            title: rect(left, top, x.max(left), top + bar_h),
            buttons,
        }
    } else {
        let band = rect(left, top, right, top + 2 * h + p(S1));
        let each = (right - left - 3 * gap) / 4;
        let mut buttons = [(EditButton::Add, band); 4];
        for (i, button) in EditButton::ALL.into_iter().enumerate() {
            let x = left + i as i32 * (each + gap);
            buttons[i] = (button, rect(x, top + h, x + each, top + 2 * h));
        }
        Toolbar {
            band,
            title: rect(left, top, right, top + h),
            buttons,
        }
    }
}

/// The add list, in pixels: its box and a row for each panel that can be added, flowed into as many columns as the window's
/// height needs.
pub(super) struct AddList {
    pub(super) outer: RECT,
    pub(super) items: Vec<RECT>,
}

pub(super) fn edit_list(bar: &Toolbar, size: (i32, i32), scale: f32, count: usize) -> AddList {
    let p = |v: f32| (v * scale).round() as i32;
    let anchor = bar.buttons[0].1;
    let (row_h, pad) = (p(EDIT_ROW_H), p(S1));
    let top = anchor.bottom + p(S2);
    let room = (size.1 - top - p(S4) - 2 * pad).max(row_h);
    let per_column = ((room / row_h) as usize).max(1);
    let columns = count.div_ceil(per_column).max(1);
    let rows = count.div_ceil(columns).max(1);
    let col_w = p(EDIT_COL_W).min((size.0 - 2 * p(S2) - 2 * pad) / columns as i32).max(p(S8));
    let w = columns as i32 * col_w + 2 * pad;
    let left = anchor.left.min(size.0 - p(S2) - w).max(p(S2));
    let outer = rect(left, top, left + w, top + rows as i32 * row_h + 2 * pad);
    let items = (0..count)
        .map(|i| {
            let (column, row) = (i / rows, i % rows);
            let x = left + pad + column as i32 * col_w;
            let y = top + pad + row as i32 * row_h;
            rect(x, y, x + col_w, y + row_h)
        })
        .collect();
    AddList { outer, items }
}

/// A point of the window as a point of the canvas (design units).
pub(super) fn edit_point((s, ox, oy): Xf, x: i32, y: i32) -> (f32, f32) {
    ((x - ox) as f32 / s, (y - oy) as f32 / s)
}

/// What the point `(x, y)` of a window `size` pixels big at `scale` is, with the canvas drawn at `xf`.
pub(super) fn edit_hit(ui: &EditUi, size: (i32, i32), scale: f32, xf: Xf, x: i32, y: i32) -> EditHit {
    let bar = edit_toolbar(size.0, scale);
    let button = bar.buttons.iter().find(|(_, r)| inside(r, x, y)).map(|(b, _)| *b);
    if ui.add_open {
        let panes = addable(&ui.session.current);
        let list = edit_list(&bar, size, scale, panes.len());
        if let Some(i) = list.items.iter().position(|r| inside(r, x, y)) {
            return EditHit::ListItem(panes[i]);
        }
        if inside(&list.outer, x, y) {
            return EditHit::ListInside;
        }
        return button.map_or(EditHit::ListOutside, EditHit::Button);
    }
    if let Some(button) = button {
        return EditHit::Button(button);
    }
    if y < bar.band.bottom {
        return EditHit::Outside;
    }
    let (px, py) = edit_point(xf, x, y);
    match remove_at(&ui.session.current, &ui.plan(), px, py) {
        Some(pos) => EditHit::Remove(pos),
        None => EditHit::Canvas(px, py),
    }
}

/// The cursor for a point: a hand over a button, a × or a row of the list; a resize arrow over a line; the four arrows over a
/// card; while something is dragged, the one of the drag.
pub(super) fn edit_cursor(ui: &EditUi, hit: EditHit) -> EditCursor {
    match (&ui.drag, hit) {
        (Some(Drag::Split { .. }), _) => EditCursor::SizeWe,
        (Some(Drag::Row { .. }), _) => EditCursor::SizeNs,
        (Some(Drag::Card { .. }), _) => EditCursor::SizeAll,
        (None, EditHit::Button(_) | EditHit::ListItem(_) | EditHit::Remove(_)) => EditCursor::Hand,
        (None, EditHit::Canvas(x, y)) => match ui.hover_at(x, y) {
            Hover::Line(Boundary::Split { .. }) => EditCursor::SizeWe,
            Hover::Line(Boundary::RowBottom(_)) => EditCursor::SizeNs,
            Hover::Card(_) => EditCursor::SizeAll,
            Hover::Nothing => EditCursor::Arrow,
        },
        (None, _) => EditCursor::Arrow,
    }
}

/// The card's name in a language: the add list's rows and the placeholder of a card the game cannot fill.
pub(super) fn pane_msg(pane: Pane) -> Msg {
    match pane {
        Pane::Times => Msg::PanelLapTime,
        Pane::Centre => Msg::PanelCentreTitle,
        Pane::Inputs => Msg::PanelInputsTitle,
        Pane::Fuel => Msg::PanelFuel,
        Pane::Tyres => Msg::PanelTyres,
        Pane::Laps => Msg::PanelRecentLaps,
        Pane::Track => Msg::PanelTrack,
        Pane::Alerts => Msg::PanelAlerts,
        Pane::Flag => Msg::PanelFlagTitle,
        Pane::FuelCalc => Msg::PanelFuelStrategy,
        Pane::TyreTrend => Msg::PanelTyreWear,
        Pane::Sectors => Msg::PanelSectors,
        Pane::DeltaBar => Msg::PanelDeltaTitle,
        Pane::Session => Msg::PanelSessionTitle,
        Pane::Relative => Msg::PanelRelativeTitle,
        Pane::Standings => Msg::PanelStandingsTitle,
        Pane::Gaps => Msg::PanelGapsTitle,
        Pane::Radar => Msg::PanelRadarTitle,
        Pane::DeltaRef => Msg::PanelRefTitle,
    }
}

pub(super) fn pane_title(pane: Pane, lang: Lang) -> String {
    text(lang, &pane_msg(pane))
}

/// The views with the session's view kept for its dashboard and window shape, written to `dashboards.json` in `home`. The views
/// handed in are not touched: the new ones come back only when they were written.
pub(super) fn save_edit(views: &Views, session: &EditSession, home: Option<&Path>) -> Result<Views, String> {
    let home = home.ok_or_else(|| "there is no settings folder".to_owned())?;
    let mut next = views.clone();
    next.set(session.dashboard, session.layout, session.current.clone());
    next.save(home)?;
    Ok(next)
}

/// The views without any of the dashboard's saved views (every window shape), written to `dashboards.json` in `home`.
pub(super) fn reset_edit(views: &Views, dashboard: DashboardId, home: Option<&Path>) -> Result<Views, String> {
    let home = home.ok_or_else(|| "there is no settings folder".to_owned())?;
    let mut next = views.clone();
    next.reset(dashboard, None);
    next.save(home)?;
    Ok(next)
}
