//! Editing a view: the operations of the panel's edit mode as pure functions on a `SavedView`, and the hit testing that maps
//! the mouse (in design units, on the drawn plan) to them. The window only turns mouse events into these calls.
//!
//! Every operation returns a new view that passes `check_view`, or is refused with a reason and nothing changes. Moving a
//! card onto itself changes nothing (the view comes back as it was). The plan the hit tests read is the edit mode's: every card
//! of the view is on it (the ones the game cannot fill too, drawn greyed), so its rows and cards are the view's rows and cards.
//!
//! The edit mode (`edit_ui.rs`) is built on top of these; a few helpers (`cancel`, the `Refused` cases only tests reach) are
//! still only used by tests.
#![allow(dead_code)]

use super::*;

/// A card of a view: its row and its place in the row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Pos {
    pub(super) row: usize,
    pub(super) card: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Side {
    Left,
    Right,
}

/// Where a dragged card is dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Target {
    /// On the middle of a card: the two change places.
    Swap(Pos),
    /// On a card's left or right third: the card goes in beside it.
    Beside(Pos, Side),
    /// In a gap between rows (or above the first, under the last): a new row before this index (the row count appends).
    NewRow(usize),
}

/// A line that can be dragged to resize.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Boundary {
    /// Between the card `left` and the one after it, in a row.
    Split { row: usize, left: usize },
    /// Under a row.
    RowBottom(usize),
}

/// Why an operation changed nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refused {
    NoSuchCard,
    NoSuchRow,
    /// The row would have more than six cards.
    RowFull,
    /// The cards of the row could not all keep their least width.
    TooNarrow,
    /// The view would have more than twelve rows.
    TooManyRows,
    /// It is the only card left.
    LastCard,
    AlreadyInView,
    /// A number that is not one (NaN, infinite).
    BadNumber,
    /// The result broke a limit `finish` did not foresee (a bug, never expected).
    Invalid,
}

/// One edit, for `EditSession::apply`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum EditOp {
    Move(Pos, Target),
    ResizeSplit { row: usize, left: usize, delta: f32 },
    ResizeRow { row: usize, h: f32 },
    Remove(Pos),
    Add(Pane),
}

/// Rows made into a view that keeps every limit: empty rows go, heights are raised to what the cards need, shares are settled
/// so every card keeps its least width. Refused when that cannot be done.
fn finish(mut rows: Vec<OwnedRow>, layout: Layout) -> Result<SavedView, Refused> {
    rows.retain(|r| !r.cards.is_empty());
    if rows.is_empty() {
        return Err(Refused::LastCard);
    }
    if rows.len() > VIEW_MAX_ROWS {
        return Err(Refused::TooManyRows);
    }
    let width = layout.width();
    for row in &mut rows {
        if row.cards.len() > VIEW_MAX_CARDS {
            return Err(Refused::RowFull);
        }
        if !settle_row(&mut row.cards, width) {
            return Err(Refused::TooNarrow);
        }
        row.h = row.h.max(row_min_h(&row.cards)).min(ROW_H_MAX);
    }
    let view = SavedView { rows };
    check_view(&view, layout).map(|()| view).map_err(|_| Refused::Invalid)
}

fn card_of(view: &SavedView, pos: Pos) -> Option<(Pane, f32)> {
    view.rows.get(pos.row).and_then(|r| r.cards.get(pos.card)).copied()
}

/// Moves a card: onto another card (swap), beside one, or into a new row.
pub(super) fn move_card(view: &SavedView, layout: Layout, from: Pos, target: Target) -> Result<SavedView, Refused> {
    let moved = card_of(view, from).ok_or(Refused::NoSuchCard)?;
    let mut rows = view.rows.clone();
    match target {
        Target::Swap(to) => {
            if to == from {
                return Ok(view.clone());
            }
            let other = card_of(view, to).ok_or(Refused::NoSuchCard)?;
            // The places keep their widths; the cards change places.
            rows[from.row].cards[from.card].0 = other.0;
            rows[to.row].cards[to.card].0 = moved.0;
        }
        Target::Beside(to, side) => {
            if to == from {
                return Ok(view.clone());
            }
            card_of(view, to).ok_or(Refused::NoSuchCard)?;
            let at = to.card + usize::from(side == Side::Right);
            rows[to.row].cards.insert(at, moved);
            let source = if to.row == from.row && at <= from.card {
                from.card + 1
            } else {
                from.card
            };
            rows[from.row].cards.remove(source);
        }
        Target::NewRow(index) => {
            if index > view.rows.len() {
                return Err(Refused::NoSuchRow);
            }
            let alone = view.rows[from.row].cards.len() == 1;
            let h = if alone { view.rows[from.row].h } else { card_min_h(moved.0) };
            rows[from.row].cards.remove(from.card);
            let mut at = index;
            if rows[from.row].cards.is_empty() {
                rows.remove(from.row);
                if from.row < index {
                    at -= 1;
                }
            }
            rows.insert(
                at,
                OwnedRow {
                    h,
                    cards: vec![(moved.0, 1.0)],
                },
            );
        }
    }
    finish(rows, layout)
}

/// Drags the boundary after card `left` of a row by `delta` design units: the width moves between the two neighbours, as far as
/// both keep their least width (and their shares stay in range).
pub(super) fn resize_split(view: &SavedView, layout: Layout, row: usize, left: usize, delta: f32) -> Result<SavedView, Refused> {
    if !delta.is_finite() {
        return Err(Refused::BadNumber);
    }
    let r = view.rows.get(row).ok_or(Refused::NoSuchRow)?;
    if left + 1 >= r.cards.len() {
        return Err(Refused::NoSuchCard);
    }
    let room = layout.width() - GAP * (r.cards.len() as f32 - 1.0);
    let sum: f32 = r.cards.iter().map(|c| c.1).sum();
    let (a, b) = (r.cards[left], r.cards[left + 1]);
    let (wa, wb) = (room * a.1 / sum, room * b.1 / sum);
    let (pair_w, pair_s) = (wa + wb, a.1 + b.1);
    let share_lo = SHARE_MIN.max(pair_s - SHARE_MAX);
    let share_hi = SHARE_MAX.min(pair_s - SHARE_MIN);
    let lo = card_min_w(a.0).max(share_lo * pair_w / pair_s);
    let hi = (pair_w - card_min_w(b.0)).min(share_hi * pair_w / pair_s);
    if lo > hi + 0.001 {
        return Err(Refused::TooNarrow);
    }
    let new_wa = (wa + delta).clamp(lo, hi.max(lo));
    let new_sa = pair_s * new_wa / pair_w;
    let mut rows = view.rows.clone();
    rows[row].cards[left].1 = new_sa;
    rows[row].cards[left + 1].1 = pair_s - new_sa;
    finish(rows, layout)
}

/// Sets a row's height, kept between what its cards need and `ROW_H_MAX`.
pub(super) fn resize_row(view: &SavedView, layout: Layout, row: usize, new_h: f32) -> Result<SavedView, Refused> {
    if !new_h.is_finite() {
        return Err(Refused::BadNumber);
    }
    let r = view.rows.get(row).ok_or(Refused::NoSuchRow)?;
    let h = new_h.clamp(row_min_h(&r.cards), ROW_H_MAX);
    let mut rows = view.rows.clone();
    rows[row].h = h;
    finish(rows, layout)
}

/// Takes a card out (its row goes with it when it was alone). The last card of a view stays.
pub(super) fn remove(view: &SavedView, layout: Layout, pos: Pos) -> Result<SavedView, Refused> {
    card_of(view, pos).ok_or(Refused::NoSuchCard)?;
    if view.rows.iter().map(|r| r.cards.len()).sum::<usize>() == 1 {
        return Err(Refused::LastCard);
    }
    let mut rows = view.rows.clone();
    rows[pos.row].cards.remove(pos.card);
    finish(rows, layout)
}

/// Adds a card: at the end of the last row when it has room (fewer than six cards, tall enough, every card keeps its least
/// width), else in a new row of the card's least height.
pub(super) fn add(view: &SavedView, layout: Layout, pane: Pane) -> Result<SavedView, Refused> {
    if view.panes().contains(&pane) {
        return Err(Refused::AlreadyInView);
    }
    let mut rows = view.rows.clone();
    if let Some(last) = rows.last_mut() {
        if last.cards.len() < VIEW_MAX_CARDS && last.h + VIEW_EPS >= card_min_h(pane) {
            let mean = last.cards.iter().map(|c| c.1).sum::<f32>() / last.cards.len() as f32;
            let mut cards = last.cards.clone();
            cards.push((pane, mean));
            if settle_row(&mut cards, layout.width()) {
                last.cards = cards;
                return finish(rows, layout);
            }
        }
    }
    rows.push(OwnedRow {
        h: card_min_h(pane),
        cards: vec![(pane, 1.0)],
    });
    finish(rows, layout)
}

/// The catalog's widgets that are not in the view, in the catalog's order.
pub(super) fn addable(view: &SavedView) -> Vec<Pane> {
    let have = view.panes();
    catalog::ALL.iter().map(|w| w.pane).filter(|p| !have.contains(p)).collect()
}

/// Applies one edit.
pub(super) fn apply_op(view: &SavedView, layout: Layout, op: EditOp) -> Result<SavedView, Refused> {
    match op {
        EditOp::Move(from, target) => move_card(view, layout, from, target),
        EditOp::ResizeSplit { row, left, delta } => resize_split(view, layout, row, left, delta),
        EditOp::ResizeRow { row, h } => resize_row(view, layout, row, h),
        EditOp::Remove(pos) => remove(view, layout, pos),
        EditOp::Add(pane) => add(view, layout, pane),
    }
}

/// One edit session on a dashboard in a window shape: the view as it was when editing began and the one being edited.
#[derive(Clone, Debug)]
pub(super) struct EditSession {
    pub(super) dashboard: DashboardId,
    pub(super) layout: Layout,
    pub(super) original: SavedView,
    pub(super) current: SavedView,
}

impl EditSession {
    pub(super) fn new(dashboard: DashboardId, layout: Layout, original: SavedView) -> EditSession {
        EditSession {
            dashboard,
            layout,
            current: original.clone(),
            original,
        }
    }

    /// Applies an edit to the view being edited; when it is refused nothing changes.
    pub(super) fn apply(&mut self, op: EditOp) -> Result<(), Refused> {
        self.current = apply_op(&self.current, self.layout, op)?;
        Ok(())
    }

    /// Leaves the session: the view as it was.
    pub(super) fn cancel(self) -> SavedView {
        self.original
    }

    /// Something was changed.
    pub(super) fn is_dirty(&self) -> bool {
        self.current != self.original
    }
}

/// The cards of a plan grouped by row (the cards with the same top), left to right.
fn plan_rows(plan: &Plan) -> Vec<Vec<(Pane, Area)>> {
    let mut rows: Vec<Vec<(Pane, Area)>> = Vec::new();
    for (pane, area) in &plan.cards {
        match rows.last_mut() {
            Some(row) if row.first().is_some_and(|(_, a)| (a.1 - area.1).abs() < 0.01) => row.push((*pane, *area)),
            _ => rows.push(vec![(*pane, *area)]),
        }
    }
    rows
}

/// The card at a point of the plan (design units), if there is one.
pub(super) fn card_at(plan: &Plan, x: f32, y: f32) -> Option<Pos> {
    for (row, cards) in plan_rows(plan).iter().enumerate() {
        for (card, (_, a)) in cards.iter().enumerate() {
            if (a.0..a.0 + a.2).contains(&x) && (a.1..a.1 + a.3).contains(&y) {
                return Some(Pos { row, card });
            }
        }
    }
    None
}

/// What a card dropped at a point would do: on a card, its left third puts it beside on the left, its right third beside on
/// the right and its middle swaps; in a gap between two rows (or above the first, under the last) it makes a new row; anywhere
/// else (between two cards of a row, outside the canvas's width) nothing.
pub(super) fn target_at(plan: &Plan, x: f32, y: f32) -> Option<Target> {
    let rows = plan_rows(plan);
    if let Some(pos) = card_at(plan, x, y) {
        let area = rows[pos.row][pos.card].1;
        let along = (x - area.0) / area.2;
        return Some(if along < 1.0 / 3.0 {
            Target::Beside(pos, Side::Left)
        } else if along > 2.0 / 3.0 {
            Target::Beside(pos, Side::Right)
        } else {
            Target::Swap(pos)
        });
    }
    if !(0.0..=plan.w).contains(&x) {
        return None;
    }
    let bands: Vec<(f32, f32)> = rows
        .iter()
        .map(|cards| {
            let a = cards[0].1;
            (a.1, a.1 + a.3)
        })
        .collect();
    let (Some(first), Some(last)) = (bands.first(), bands.last()) else {
        return Some(Target::NewRow(0));
    };
    if y < first.0 {
        return Some(Target::NewRow(0));
    }
    if y >= last.1 {
        return Some(Target::NewRow(bands.len()));
    }
    bands
        .windows(2)
        .position(|pair| y >= pair[0].1 && y < pair[1].0)
        .map(|i| Target::NewRow(i + 1))
}

/// The boundary within `tolerance` of a point (the nearest; a split before a row's bottom on a tie): the line in the middle of
/// the gap between two cards of a row, or the one in the middle of the gap under a row.
pub(super) fn boundary_at(plan: &Plan, x: f32, y: f32, tolerance: f32) -> Option<Boundary> {
    let mut best: Option<(f32, Boundary)> = None;
    let mut offer = |distance: f32, boundary: Boundary| {
        if distance <= tolerance && best.is_none_or(|(d, _)| distance < d) {
            best = Some((distance, boundary));
        }
    };
    for (row, cards) in plan_rows(plan).iter().enumerate() {
        let (top, h) = (cards[0].1 .1, cards[0].1 .3);
        if (top..=top + h).contains(&y) {
            for (left, pair) in cards.windows(2).enumerate() {
                let mid = (pair[0].1 .0 + pair[0].1 .2 + pair[1].1 .0) / 2.0;
                offer((x - mid).abs(), Boundary::Split { row, left });
            }
        }
        if (0.0..=plan.w).contains(&x) {
            offer((y - (top + h + GAP / 2.0)).abs(), Boundary::RowBottom(row));
        }
    }
    best.map(|(_, b)| b)
}
