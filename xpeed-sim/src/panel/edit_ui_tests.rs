//! Tests of the edit mode's state machine and geometry (`edit_ui.rs`), with no window: drags to every kind of target, the two kinds
//! of line, ×, the add list, the reset's two clicks, the keys, the messages, the toolbar and the add list's places, what a point is
//! and which cursor it gets, and the saving.

use super::*;

const XF: Xf = (1.0, 0, 0);

fn race_wide() -> EditUi {
    EditUi::new(
        DashboardId::Race,
        Layout::Wide,
        SavedView::default_for(DashboardId::Race, Layout::Wide),
    )
}

fn area(ui: &EditUi, row: usize, card: usize) -> Area {
    card_area(&ui.session.current, &ui.plan(), Pos { row, card }).expect("the card is on the plan")
}

fn middle((x, y, w, h): Area) -> (f32, f32) {
    (x + w / 2.0, y + h / 2.0)
}

/// Presses on `from`, moves to `to` in two steps and lets go there.
fn drag(ui: &mut EditUi, from: (f32, f32), to: (f32, f32), now: i64) {
    ui.press(EditHit::Canvas(from.0, from.1), XF, now);
    ui.mouse_moved(EditHit::Canvas(to.0, to.1), ((from.0 + to.0) / 2.0, (from.1 + to.1) / 2.0));
    ui.mouse_moved(EditHit::Canvas(to.0, to.1), to);
    ui.released(to, now);
}

#[test]
fn a_card_dragged_to_every_kind_of_target_is_moved_there_and_shows_where_it_would_land() {
    let original = SavedView::default_for(DashboardId::Race, Layout::Wide);
    let last = original.rows.len() - 1;
    assert!(
        original.rows.len() >= 3 && original.rows[0].cards.len() >= 3,
        "the Race/Wide view has rows to play with"
    );
    let from = Pos { row: 0, card: 0 };
    let probe = race_wide();
    let (a, b, c) = (area(&probe, 0, 2), area(&probe, last, 0), area(&probe, 0, 0));
    let new_row_y = c.1 + c.3 + GAP / 2.0;
    let cases = [
        ("swap", middle(b), Target::Swap(Pos { row: last, card: 0 })),
        (
            "beside on the left",
            (a.0 + a.2 * 0.15, a.1 + a.3 / 2.0),
            Target::Beside(Pos { row: 0, card: 2 }, Side::Left),
        ),
        (
            "beside on the right",
            (b.0 + b.2 * 0.9, b.1 + b.3 / 2.0),
            Target::Beside(Pos { row: last, card: 0 }, Side::Right),
        ),
        ("a new row between the first two", (a.0 + a.2 / 2.0, new_row_y), Target::NewRow(1)),
        ("a new row above the first", (a.0 + 10.0, CARDS_TOP - 3.0), Target::NewRow(0)),
    ];
    for (what, to, target) in cases {
        let mut ui = race_wide();
        let start = middle(c);
        ui.press(EditHit::Canvas(start.0, start.1), XF, 0);
        assert!(
            matches!(ui.drag, Some(Drag::Card { moved: false, .. })),
            "{what}: a press on a card takes it"
        );
        assert_eq!(ui.frozen, Some(XF), "{what}: the transform is frozen while dragging");
        ui.mouse_moved(EditHit::Canvas(to.0, to.1), to);
        assert_eq!(ui.drop_target(), Some(target), "{what}: the indicator says where it would land");
        assert_eq!(ui.session.current, original, "{what}: nothing changes before the button comes up");
        ui.released(to, 0);
        let expected = move_card(&original, Layout::Wide, from, target).expect(what);
        assert_eq!(ui.session.current, expected, "{what}");
        assert_ne!(ui.session.current, original, "{what}: it did move");
        assert!(ui.drag.is_none() && ui.frozen.is_none(), "{what}: the drag is over");
        assert!(ui.note_at(0).is_none(), "{what}");
    }
}

#[test]
fn a_press_that_hardly_moves_is_a_click_and_changes_nothing() {
    let mut ui = race_wide();
    let at = middle(area(&ui, 0, 0));
    drag(&mut ui, at, (at.0 + 2.0, at.1 + 1.0), 0);
    assert!(!ui.session.is_dirty());
    assert!(ui.drag.is_none());
}

#[test]
fn dropping_a_card_where_nothing_lands_or_on_itself_changes_nothing() {
    let mut ui = race_wide();
    let start = middle(area(&ui, 0, 0));
    drag(&mut ui, start, (-50.0, start.1), 0);
    assert!(!ui.session.is_dirty(), "outside the canvas's width: no target");
    drag(&mut ui, start, (start.0 + 1.0, start.1 + 40.0), 0);
    assert!(!ui.session.is_dirty(), "on its own middle: it stays");
}

#[test]
fn a_split_follows_the_total_delta_live_and_lands_where_it_was_let_go() {
    let original = SavedView::default_for(DashboardId::Race, Layout::Wide);
    let mut ui = race_wide();
    let (a, b) = (area(&ui, 0, 0), area(&ui, 0, 1));
    let mid = (a.0 + a.2 + b.0) / 2.0;
    let y = a.1 + a.3 / 2.0;
    ui.press(EditHit::Canvas(mid, y), XF, 0);
    assert!(matches!(ui.drag, Some(Drag::Split { row: 0, left: 0, .. })));
    assert_eq!(ui.hover, Hover::Line(Boundary::Split { row: 0, left: 0 }));
    assert_eq!(edit_cursor(&ui, EditHit::Canvas(mid, y)), EditCursor::SizeWe);
    // The delta is what the mouse is from the press, as the state machine computes it.
    let split = |to: f32| resize_split(&original, Layout::Wide, 0, 0, to - mid).unwrap();
    ui.mouse_moved(EditHit::Canvas(mid + 30.0, y), (mid + 30.0, y));
    assert_eq!(ui.session.current, split(mid + 30.0), "live");
    ui.mouse_moved(EditHit::Canvas(mid + 10.0, y), (mid + 10.0, y));
    assert_eq!(ui.session.current, split(mid + 10.0), "the delta is from the press, not added up");
    ui.mouse_moved(EditHit::Canvas(mid - 25.0, y), (mid - 25.0, y));
    ui.released((mid - 25.0, y), 0);
    assert_eq!(ui.session.current, split(mid - 25.0), "final");
    assert!(ui.drag.is_none() && ui.frozen.is_none());
    assert!(ui.is_modified());
}

#[test]
fn a_row_bottom_follows_the_total_delta_and_stops_at_what_its_cards_need() {
    let original = SavedView::default_for(DashboardId::Race, Layout::Wide);
    let mut ui = race_wide();
    let a = area(&ui, 0, 0);
    let (x, y) = (a.0 + 40.0, a.1 + a.3 + GAP / 2.0);
    ui.press(EditHit::Canvas(x, y), XF, 0);
    assert!(matches!(ui.drag, Some(Drag::Row { row: 0, .. })));
    assert_eq!(edit_cursor(&ui, EditHit::Canvas(x, y)), EditCursor::SizeNs);
    let h = original.rows[0].h;
    ui.mouse_moved(EditHit::Canvas(x, y + 40.0), (x, y + 40.0));
    assert_eq!(ui.session.current, resize_row(&original, Layout::Wide, 0, h + 40.0).unwrap());
    assert_eq!(ui.session.current.rows[0].h, h + 40.0);
    ui.mouse_moved(EditHit::Canvas(x, y + 15.0), (x, y + 15.0));
    assert_eq!(ui.session.current.rows[0].h, h + 15.0, "not added up");
    ui.mouse_moved(EditHit::Canvas(x, y - 5000.0), (x, y - 5000.0));
    assert_eq!(
        ui.session.current.rows[0].h,
        row_min_h(&original.rows[0].cards),
        "never under what the cards need"
    );
    ui.released((x, y - 5000.0), 0);
    assert!(ui.drag.is_none());
}

#[test]
fn escape_while_dragging_a_line_puts_it_back_and_the_session_goes_on() {
    let original = SavedView::default_for(DashboardId::Race, Layout::Wide);
    let mut ui = race_wide();
    let (a, b) = (area(&ui, 0, 0), area(&ui, 0, 1));
    let mid = (a.0 + a.2 + b.0) / 2.0;
    let y = a.1 + a.3 / 2.0;
    ui.press(EditHit::Canvas(mid, y), XF, 0);
    ui.mouse_moved(EditHit::Canvas(mid + 40.0, y), (mid + 40.0, y));
    assert_ne!(ui.session.current, original);
    assert_eq!(ui.key(EditKey::Escape), None, "the first Esc only lets go");
    assert_eq!(ui.session.current, original);
    assert!(ui.drag.is_none() && ui.frozen.is_none());
}

#[test]
fn the_x_takes_a_card_out_and_the_last_card_refuses_with_a_message_that_expires() {
    let mut ui = race_wide();
    let before = ui.session.current.panes().len();
    ui.press(EditHit::Remove(Pos { row: 0, card: 0 }), XF, 1000);
    assert_eq!(ui.session.current.panes().len(), before - 1);
    let one = SavedView {
        rows: vec![OwnedRow {
            h: 300.0,
            cards: vec![(Pane::Times, 1.0)],
        }],
    };
    let mut ui = EditUi::new(DashboardId::Race, Layout::Wide, one.clone());
    ui.press(EditHit::Remove(Pos { row: 0, card: 0 }), XF, 1000);
    assert_eq!(ui.session.current, one, "the last card stays");
    assert_eq!(ui.note_at(1000), Some(EditNote::Refused(Refused::LastCard)));
    assert_eq!(ui.note_at(1000 + EDIT_NOTE_MS - 1), Some(EditNote::Refused(Refused::LastCard)));
    assert_eq!(ui.note_at(1000 + EDIT_NOTE_MS), None, "gone after three seconds");
}

#[test]
fn the_add_list_opens_closes_and_adds() {
    let mut ui = race_wide();
    let missing = addable(&ui.session.current);
    assert!(!missing.is_empty(), "the Race view does not hold every card");
    assert_eq!(ui.press(EditHit::Button(EditButton::Add), XF, 0), None);
    assert!(ui.add_open);
    ui.press(EditHit::Button(EditButton::Add), XF, 0);
    assert!(!ui.add_open, "the button again closes it");
    ui.press(EditHit::Button(EditButton::Add), XF, 0);
    ui.press(EditHit::ListInside, XF, 0);
    assert!(ui.add_open, "a click between rows keeps it");
    ui.press(EditHit::ListOutside, XF, 0);
    assert!(!ui.add_open, "a click outside closes it");
    ui.press(EditHit::Button(EditButton::Add), XF, 0);
    assert_eq!(ui.key(EditKey::Escape), None);
    assert!(!ui.add_open, "Esc closes it");
    ui.press(EditHit::Button(EditButton::Add), XF, 0);
    let pane = missing[0];
    ui.press(EditHit::ListItem(pane), XF, 0);
    assert!(!ui.add_open);
    assert!(ui.session.current.panes().contains(&pane), "the panel is added");
    assert_eq!(
        ui.session.current,
        add(&SavedView::default_for(DashboardId::Race, Layout::Wide), Layout::Wide, pane).unwrap()
    );
    ui.press(EditHit::ListItem(pane), XF, 50);
    assert_eq!(
        ui.note_at(50),
        Some(EditNote::Refused(Refused::AlreadyInView)),
        "a card twice is refused"
    );
}

#[test]
fn with_every_panel_on_the_dashboard_the_add_button_says_so() {
    let panes: Vec<Pane> = catalog::ALL.iter().map(|w| w.pane).collect();
    let rows = panes
        .chunks(5)
        .map(|chunk| OwnedRow {
            h: 300.0,
            cards: chunk.iter().map(|p| (*p, 1.0)).collect(),
        })
        .collect();
    let mut ui = EditUi::new(DashboardId::Race, Layout::Wide, SavedView { rows });
    assert!(addable(&ui.session.current).is_empty());
    ui.press(EditHit::Button(EditButton::Add), XF, 10);
    assert!(!ui.add_open);
    assert_eq!(ui.note_at(10), Some(EditNote::NothingToAdd));
}

#[test]
fn reset_needs_a_second_click_within_three_seconds() {
    let mut ui = race_wide();
    assert_eq!(ui.press(EditHit::Button(EditButton::Reset), XF, 1000), None);
    assert!(ui.reset_armed(1000) && ui.reset_armed(1000 + EDIT_NOTE_MS - 1));
    assert!(!ui.reset_armed(1000 + EDIT_NOTE_MS));
    assert_eq!(ui.press(EditHit::Button(EditButton::Reset), XF, 2000), Some(EditEnd::Reset));
    assert!(!ui.reset_armed(2000), "used up");
    // Too late: the second click only arms it again.
    ui.press(EditHit::Button(EditButton::Reset), XF, 10_000);
    assert_eq!(ui.press(EditHit::Button(EditButton::Reset), XF, 10_000 + EDIT_NOTE_MS), None);
    assert!(ui.reset_armed(10_000 + EDIT_NOTE_MS + 1));
    // Another button in between takes it back.
    let mut ui = race_wide();
    ui.press(EditHit::Button(EditButton::Reset), XF, 0);
    ui.press(EditHit::Button(EditButton::Add), XF, 1);
    assert_eq!(ui.press(EditHit::Button(EditButton::Reset), XF, 2), None);
}

#[test]
fn after_a_reset_the_session_goes_on_from_the_built_in_rows() {
    let mut ui = race_wide();
    let at = middle(area(&ui, 0, 0));
    let to = middle(area(&ui, 2, 0));
    drag(&mut ui, at, to, 0);
    assert!(ui.is_modified());
    ui.restart(SavedView::default_for(DashboardId::Race, Layout::Wide));
    assert!(!ui.is_modified() && !ui.session.is_dirty());
    assert_eq!(ui.key(EditKey::Escape), Some(EditEnd::Cancel));
}

#[test]
fn escape_cancels_with_the_original_back_and_enter_or_ctrl_s_save() {
    let original = SavedView::default_for(DashboardId::Race, Layout::Wide);
    let mut ui = race_wide();
    let at = middle(area(&ui, 0, 0));
    let to = middle(area(&ui, 2, 0));
    drag(&mut ui, at, to, 0);
    let edited = ui.session.current.clone();
    assert_ne!(edited, original);
    assert_eq!(ui.key(EditKey::Enter), Some(EditEnd::Save));
    assert_eq!(ui.session.current, edited, "Enter saves what is on the canvas");
    assert_eq!(ui.key(EditKey::CtrlS), Some(EditEnd::Save));
    assert_eq!(ui.key(EditKey::Escape), Some(EditEnd::Cancel));
    assert_eq!(ui.session.cancel(), original, "cancelling gives back exactly the original");
    let mut ui = race_wide();
    assert_eq!(ui.press(EditHit::Button(EditButton::Cancel), XF, 0), Some(EditEnd::Cancel));
    assert_eq!(ui.press(EditHit::Button(EditButton::Save), XF, 0), Some(EditEnd::Save));
}

#[test]
fn every_refusal_has_a_message_in_every_language() {
    let all = [
        Refused::NoSuchCard,
        Refused::NoSuchRow,
        Refused::RowFull,
        Refused::TooNarrow,
        Refused::TooManyRows,
        Refused::LastCard,
        Refused::AlreadyInView,
        Refused::BadNumber,
        Refused::Invalid,
    ];
    let mut notes: Vec<EditNote> = all.into_iter().map(EditNote::Refused).collect();
    notes.extend([EditNote::NothingToAdd, EditNote::SaveFailed]);
    for note in notes {
        for lang in Lang::ALL {
            assert!(!text(lang, &note.msg()).trim().is_empty(), "{note:?} {lang:?}");
        }
    }
    assert_eq!(
        text(Lang::En, &EditNote::Refused(Refused::TooNarrow).msg()),
        "Not enough room in that row"
    );
    assert_eq!(text(Lang::En, &EditNote::Refused(Refused::RowFull).msg()), "That row is full");
    assert_eq!(
        text(Lang::En, &EditNote::Refused(Refused::TooManyRows).msg()),
        "Twelve rows at most"
    );
    assert_eq!(
        text(Lang::En, &EditNote::Refused(Refused::LastCard).msg()),
        "A dashboard keeps at least one panel"
    );
    assert_eq!(
        text(Lang::En, &EditNote::Refused(Refused::AlreadyInView).msg()),
        "Already on this dashboard"
    );
}

#[test]
fn a_failed_save_says_so_and_the_session_goes_on() {
    let mut ui = race_wide();
    ui.save_failed(5);
    assert_eq!(ui.note_at(5), Some(EditNote::SaveFailed));
    assert_eq!(ui.note_at(5 + EDIT_NOTE_MS), None);
}

#[test]
fn the_edit_plan_has_every_card_of_the_view_in_the_views_rows() {
    for dash in DashboardId::ALL {
        for (layout, _) in LAYOUT_KEYS {
            let view = SavedView::default_for(dash, layout);
            let plan = edit_plan(&view, layout);
            assert_eq!(plan.cards.len(), view.panes().len());
            let rows = edit_rows(&view, &plan);
            for (row, cards) in view.rows.iter().zip(&rows) {
                assert_eq!(row.cards.len(), cards.len());
                assert!(
                    cards.iter().all(|(_, a)| a.3 == row.h),
                    "a row is as tall as the view says, never shrunk"
                );
            }
            assert!(plan.h > CARDS_TOP);
            assert_eq!(
                card_at(&plan, plan.cards[0].1 .0 + 1.0, plan.cards[0].1 .1 + 1.0),
                Some(Pos { row: 0, card: 0 })
            );
        }
    }
}

#[test]
fn hovering_a_card_a_line_or_nothing_is_told_apart() {
    let mut ui = race_wide();
    let (a, b) = (area(&ui, 0, 0), area(&ui, 0, 1));
    let y = a.1 + a.3 / 2.0;
    let mid = (a.0 + a.2 + b.0) / 2.0;
    let on_card = middle(a);
    ui.mouse_moved(EditHit::Canvas(on_card.0, on_card.1), on_card);
    assert_eq!(ui.hover, Hover::Card(Pos { row: 0, card: 0 }));
    assert_eq!(edit_cursor(&ui, EditHit::Canvas(on_card.0, on_card.1)), EditCursor::SizeAll);
    ui.mouse_moved(EditHit::Canvas(mid, y), (mid, y));
    assert_eq!(ui.hover, Hover::Line(Boundary::Split { row: 0, left: 0 }));
    let gap_y = a.1 + a.3 + GAP / 2.0;
    ui.mouse_moved(EditHit::Canvas(on_card.0, gap_y), (on_card.0, gap_y));
    assert_eq!(ui.hover, Hover::Line(Boundary::RowBottom(0)));
    assert_eq!(edit_cursor(&ui, EditHit::Canvas(on_card.0, gap_y)), EditCursor::SizeNs);
    ui.mouse_moved(EditHit::Canvas(-40.0, 5.0), (-40.0, 5.0));
    assert_eq!(ui.hover, Hover::Nothing);
    assert_eq!(edit_cursor(&ui, EditHit::Canvas(-40.0, 5.0)), EditCursor::Arrow);
    ui.mouse_moved(EditHit::Remove(Pos { row: 0, card: 1 }), on_card);
    assert_eq!(ui.hover, Hover::Card(Pos { row: 0, card: 1 }));
    assert_eq!(edit_cursor(&ui, EditHit::Remove(Pos { row: 0, card: 1 })), EditCursor::Hand);
    assert_eq!(edit_cursor(&ui, EditHit::Button(EditButton::Save)), EditCursor::Hand);
    assert_eq!(edit_cursor(&ui, EditHit::Outside), EditCursor::Arrow);
    ui.mouse_left();
    assert_eq!(ui.hover, Hover::Nothing);
}

#[test]
fn the_toolbar_fits_in_every_window_width_and_its_buttons_do_not_overlap() {
    for scale in [1.0_f32, 1.5, 2.0] {
        for design_w in [360.0_f32, 430.0, 540.0, 720.0, 759.0, 760.0, 960.0, 1536.0, 2560.0] {
            let width = (design_w * scale) as i32;
            let bar = edit_toolbar(width, scale);
            assert!(bar.band.bottom > bar.band.top && bar.band.left < bar.band.right, "{width}");
            assert!(bar.band.top >= (HEADER_H * scale).round() as i32, "under the header");
            assert!(bar.title.right >= bar.title.left, "{width}: the title has room");
            for (i, (_, r)) in bar.buttons.iter().enumerate() {
                assert!(
                    r.left >= bar.band.left && r.right <= bar.band.right,
                    "{width} button {i} inside the band"
                );
                assert!(
                    r.top >= bar.band.top && r.bottom <= bar.band.bottom,
                    "{width} button {i} inside the band"
                );
                assert!(r.right > r.left, "{width} button {i} has width");
                if i > 0 {
                    assert!(bar.buttons[i - 1].1.right <= r.left, "{width}: left to right, no overlap");
                }
            }
            if design_w >= EDIT_ONE_ROW_W {
                assert!(
                    bar.title.right <= bar.buttons[0].1.left,
                    "{width}: one row, the title before the buttons"
                );
            } else {
                assert!(bar.title.bottom <= bar.buttons[0].1.top, "{width}: two rows");
            }
            assert_eq!(
                bar.buttons.map(|(b, _)| b),
                EditButton::ALL,
                "Add, Reset, Cancel and Save in this order"
            );
        }
    }
}

#[test]
fn the_add_list_keeps_every_row_inside_the_window() {
    for (w, h) in [(720, 480), (430, 900), (1536, 864), (360, 480), (2560, 1080)] {
        for count in [1, 7, 18] {
            let bar = edit_toolbar(w, 1.0);
            let list = edit_list(&bar, (w, h), 1.0, count);
            assert_eq!(list.items.len(), count);
            assert!(list.outer.left >= 0 && list.outer.right <= w, "{w}x{h} {count}: inside the width");
            for (i, r) in list.items.iter().enumerate() {
                assert!(r.left >= list.outer.left && r.right <= list.outer.right, "{w}x{h} {count} row {i}");
                assert!(r.top >= list.outer.top && r.bottom <= list.outer.bottom, "{w}x{h} {count} row {i}");
                for other in &list.items[..i] {
                    let apart = r.right <= other.left || other.right <= r.left || r.bottom <= other.top || other.bottom <= r.top;
                    assert!(apart, "{w}x{h} {count}: rows do not overlap");
                }
            }
            if h >= 480 && count <= 7 {
                assert!(list.outer.bottom <= h, "{w}x{h} {count}: a short list fits the height");
            }
        }
    }
}

#[test]
fn a_point_of_the_window_is_a_button_a_row_a_cross_a_canvas_point_or_the_header() {
    let (w, h, scale) = (1536, 864, 1.0);
    let mut ui = race_wide();
    let bar = edit_toolbar(w, scale);
    let plan = ui.plan();
    let body = rect(16, (HEADER_H * scale) as i32, w - 16, h - 16);
    let area_below = rect(body.left, bar.band.bottom + 8, body.right, body.bottom);
    let xf = canvas_fit_wh(area_below, plan.w, plan.h);
    let hit = |ui: &EditUi, x: i32, y: i32| edit_hit(ui, (w, h), scale, xf, x, y);
    for (button, r) in bar.buttons {
        assert_eq!(hit(&ui, (r.left + r.right) / 2, (r.top + r.bottom) / 2), EditHit::Button(button));
    }
    assert_eq!(hit(&ui, 5, 5), EditHit::Outside, "the header");
    assert_eq!(hit(&ui, 400, bar.band.bottom - 1), EditHit::Outside, "the band between the buttons");
    // The middle of a card, in pixels, and its ×.
    let to_px = |(x, y): (f32, f32)| ((x * xf.0) as i32 + xf.1, (y * xf.0) as i32 + xf.2);
    let c = middle(area(&ui, 1, 0));
    let (px, py) = to_px(c);
    assert!(matches!(hit(&ui, px, py), EditHit::Canvas(x, y) if (x - c.0).abs() < 2.0 && (y - c.1).abs() < 2.0));
    let (cx, cy, cw, _) = edit_remove_rect(area(&ui, 1, 0));
    let (qx, qy) = to_px((cx + cw / 2.0, cy + 4.0));
    assert_eq!(hit(&ui, qx, qy), EditHit::Remove(Pos { row: 1, card: 0 }));
    // With the list open: a row, the box, a button (it toggles), and anywhere else closes.
    ui.add_open = true;
    let list = edit_list(&bar, (w, h), scale, addable(&ui.session.current).len());
    let first = list.items[0];
    assert_eq!(
        hit(&ui, first.left + 3, first.top + 3),
        EditHit::ListItem(addable(&ui.session.current)[0])
    );
    assert_eq!(hit(&ui, list.outer.left + 1, list.outer.top + 1), EditHit::ListInside);
    let add_button = bar.buttons[0].1;
    assert_eq!(hit(&ui, add_button.left + 3, add_button.top + 3), EditHit::Button(EditButton::Add));
    assert_eq!(hit(&ui, px, py), EditHit::ListOutside);
}

#[test]
fn a_frozen_transform_reads_the_mouse_the_way_the_press_did() {
    let mut ui = race_wide();
    let c = middle(area(&ui, 0, 0));
    let drawn_at: Xf = (0.5, 40, 100);
    ui.press(EditHit::Canvas(c.0, c.1), drawn_at, 0);
    assert_eq!(ui.frozen, Some(drawn_at));
    assert_eq!(edit_point(drawn_at, 40 + 100, 100 + 50), (200.0, 100.0));
    ui.released(c, 0);
    assert_eq!(ui.frozen, None);
}

#[test]
fn every_card_has_a_name_in_every_language() {
    let mut english = Vec::new();
    for w in catalog::ALL {
        for lang in Lang::ALL {
            assert!(!pane_title(w.pane, lang).trim().is_empty(), "{} {lang:?}", w.id);
        }
        english.push(pane_title(w.pane, Lang::En));
    }
    english.sort();
    let before = english.len();
    english.dedup();
    assert_eq!(before, english.len(), "no two cards share a name in the add list");
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("xpeed-edit-ui-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn saving_writes_the_view_and_a_missing_folder_is_an_error_that_changes_nothing() {
    let dir = scratch("save");
    let mut ui = race_wide();
    let at = middle(area(&ui, 0, 0));
    let to = middle(area(&ui, 2, 0));
    drag(&mut ui, at, to, 0);
    let before = Views::default();
    assert!(save_edit(&before, &ui.session, None).is_err(), "no settings folder: an error");
    let saved = save_edit(&before, &ui.session, Some(&dir)).unwrap();
    assert!(saved.is_modified(DashboardId::Race));
    assert_eq!(
        Views::load(&dir).rows_for(DashboardId::Race, Layout::Wide),
        ui.session.current,
        "it reads back as saved"
    );
    assert!(!before.is_modified(DashboardId::Race), "the views handed in are not touched");
    let reset = reset_edit(&saved, DashboardId::Race, Some(&dir)).unwrap();
    assert!(!reset.is_modified(DashboardId::Race));
    assert!(
        !Views::load(&dir).is_modified(DashboardId::Race),
        "the file has no saved view of it any more"
    );
    assert!(reset_edit(&saved, DashboardId::Race, None).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
