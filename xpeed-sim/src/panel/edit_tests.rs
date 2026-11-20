//! Tests of the saved views (`views.rs`) and the edit operations (`edit.rs`): persistence, every operation at every place of every
//! built-in view, thousands of random edits, the hit tests and the gear's least size.

use super::*;

// ---- helpers ----

/// The slots of a game that gives everything: every card of the catalog is on the plan (the edit mode's plan).
fn all_slots() -> Slots {
    let caps = crate::game::Caps::ALL
        .iter()
        .fold(crate::game::Caps::NONE, |all, (cap, _)| all.or(*cap));
    let s = slots(caps);
    assert_eq!(s.cards.len(), catalog::ALL.len(), "every card of the catalog can be drawn");
    s
}

fn every_view() -> Vec<(DashboardId, Layout, SavedView)> {
    let mut out = Vec::new();
    for dash in DashboardId::ALL {
        for (layout, _) in LAYOUT_KEYS {
            out.push((dash, layout, SavedView::default_for(dash, layout)));
        }
    }
    out
}

fn positions_of(view: &SavedView) -> Vec<Pos> {
    let mut out = Vec::new();
    for (row, r) in view.rows.iter().enumerate() {
        for card in 0..r.cards.len() {
            out.push(Pos { row, card });
        }
    }
    out
}

/// The ids of the view's cards, sorted.
fn ids(view: &SavedView) -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = view.panes().into_iter().map(catalog::id_of).collect();
    ids.sort_unstable();
    ids
}

/// A view that differs from the built-in one: the first row a little taller and, when it works, two cards swapped.
fn edited(dash: DashboardId, layout: Layout) -> SavedView {
    let base = SavedView::default_for(dash, layout);
    let taller = resize_row(&base, layout, 0, base.rows[0].h + 10.0).unwrap();
    let last = taller.rows.len() - 1;
    let from = Pos { row: 0, card: 0 };
    let to = Pos {
        row: last,
        card: taller.rows[last].cards.len() - 1,
    };
    if from != to {
        if let Ok(swapped) = move_card(&taller, layout, from, Target::Swap(to)) {
            return swapped;
        }
    }
    taller
}

fn drawn_ok(view: &SavedView, layout: Layout, s: &Slots) -> Result<(), String> {
    let eps = 0.01;
    let plan = layout.plan_view(view, s, usize::MAX);
    if plan.cards.len() != view.panes().len() {
        return Err(format!("{} cards drawn of {}", plan.cards.len(), view.panes().len()));
    }
    if (plan.w - layout.width()).abs() > eps {
        return Err(format!("the canvas is {} wide", plan.w));
    }
    for (i, (pane, a)) in plan.cards.iter().enumerate() {
        if a.0 < -eps || a.1 < -eps || a.0 + a.2 > plan.w + eps || a.1 + a.3 > plan.h + eps {
            return Err(format!("{pane:?} {a:?} is outside the canvas {} x {}", plan.w, plan.h));
        }
        if a.2 + eps < card_min_w(*pane) || a.3 + eps < card_min_h(*pane) {
            return Err(format!("{pane:?} is {} x {}", a.2, a.3));
        }
        for (other, b) in &plan.cards[i + 1..] {
            if a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3 {
                return Err(format!("{pane:?} is over {other:?}"));
            }
        }
        if *pane == Pane::Centre {
            let (_, _, _, inside_h) = inner(*a);
            let gear = centre_plan(*a, s).gear.3;
            if gear + eps < (GEAR_MIN_SHARE * inside_h).min(GEAR_MAX_H) {
                return Err(format!("the gear is {gear} of {inside_h}"));
            }
        }
    }
    Ok(())
}

fn assert_good(view: &SavedView, layout: Layout, s: &Slots, what: &str) {
    if let Err(why) = check_view(view, layout) {
        panic!("{what}: {why}");
    }
    if let Err(why) = drawn_ok(view, layout, s) {
        panic!("{what}: drawn: {why}");
    }
}

/// A small xorshift generator: fixed seeds, no crate.
struct Rng(u64);

impl Rng {
    fn step(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.step() % n.max(1) as u64) as usize
    }

    fn unit(&mut self) -> f32 {
        (self.step() >> 40) as f32 / (1u64 << 24) as f32
    }
}

fn random_pos(rng: &mut Rng, view: &SavedView) -> Pos {
    if rng.below(12) == 0 {
        return Pos {
            row: rng.below(view.rows.len() + 2),
            card: rng.below(8),
        };
    }
    let row = rng.below(view.rows.len());
    Pos {
        row,
        card: rng.below(view.rows[row].cards.len()),
    }
}

fn random_op(rng: &mut Rng, view: &SavedView) -> EditOp {
    match rng.below(11) {
        0..=3 => {
            let from = random_pos(rng, view);
            let target = match rng.below(3) {
                0 => Target::Swap(random_pos(rng, view)),
                1 => Target::Beside(random_pos(rng, view), if rng.below(2) == 0 { Side::Left } else { Side::Right }),
                _ => Target::NewRow(rng.below(view.rows.len() + 2)),
            };
            EditOp::Move(from, target)
        }
        4..=6 => {
            let row = rng.below(view.rows.len() + 1);
            EditOp::ResizeSplit {
                row,
                left: rng.below(6),
                delta: rng.unit() * 1200.0 - 600.0,
            }
        }
        7 => EditOp::ResizeRow {
            row: rng.below(view.rows.len() + 1),
            h: rng.unit() * 1000.0,
        },
        8 => EditOp::Remove(random_pos(rng, view)),
        _ => EditOp::Add(catalog::ALL[rng.below(catalog::ALL.len())].pane),
    }
}

// ---- the limits ----

#[test]
fn every_builtin_view_keeps_the_limits_in_every_window_shape() {
    let s = all_slots();
    for (dash, layout, view) in every_view() {
        assert_good(&view, layout, &s, &format!("{dash:?} {layout:?}"));
    }
}

#[test]
fn check_view_names_each_limit_that_is_broken() {
    let base = SavedView::default_for(DashboardId::Race, Layout::Wide);
    let layout = Layout::Wide;
    assert!(check_view(&base, layout).is_ok());
    let broken = |change: fn(&mut SavedView)| {
        let mut v = base.clone();
        change(&mut v);
        check_view(&v, layout).is_err()
    };
    assert!(broken(|v| v.rows.clear()), "no rows");
    assert!(broken(|v| v.rows[0].cards.clear()), "an empty row");
    assert!(
        broken(|v| v.rows[0].cards.extend([(Pane::Fuel, 1.0), (Pane::Laps, 1.0)])),
        "a row seven cards strong"
    );
    assert!(broken(|v| v.rows[0].cards[1].0 = Pane::Times), "a card twice");
    assert!(broken(|v| v.rows[0].cards[0].1 = f32::NAN), "a share that is not a number");
    assert!(broken(|v| v.rows[0].cards[0].1 = 0.0), "a share of nothing");
    assert!(broken(|v| v.rows[0].cards[0].1 = 9.0), "a share over the limit");
    assert!(broken(|v| v.rows[0].h = 100.0), "a row shorter than its cards need");
    assert!(broken(|v| v.rows[0].h = 901.0), "a row taller than the limit");
    assert!(broken(|v| v.rows[0].h = f32::INFINITY), "a height that is not a number");
    assert!(
        broken(|v| v.rows[0].cards[1].1 = 0.3),
        "the centre card narrower than its least width"
    );
    let mut many = base.clone();
    while many.rows.len() <= VIEW_MAX_ROWS {
        many.rows.push(OwnedRow {
            h: 200.0,
            cards: vec![(Pane::Times, 1.0)],
        });
    }
    assert!(check_view(&many, layout).is_err(), "thirteen rows");
}

// ---- persistence ----

#[test]
fn a_saved_view_comes_back_exactly_for_every_dashboard_and_window_shape() {
    let home = crate::config::scratch_dir("views-roundtrip");
    let mut views = Views::default();
    for (dash, layout, _) in every_view() {
        views.set(dash, layout, edited(dash, layout));
    }
    assert!(DashboardId::ALL.iter().all(|d| views.is_modified(*d)));
    views.save(&home).unwrap();
    let back = Views::load(&home);
    assert_eq!(back, views);
    for (dash, layout, base) in every_view() {
        let again = back.rows_for(dash, layout);
        assert_eq!(again, edited(dash, layout), "{dash:?} {layout:?}");
        assert_ne!(again, base, "{dash:?} {layout:?} is an edited view");
    }
    // The same through the text of a whole file.
    let text = serde_json::json!({ "views": views.to_value() }).to_string();
    assert_eq!(Views::parse(&text), views);
    // The built-in rows are not kept: saving them modifies nothing and loads back as the defaults.
    let mut plain = Views::default();
    for (dash, layout, base) in every_view() {
        plain.set(dash, layout, base);
    }
    assert_eq!(plain, Views::default());
    for dash in DashboardId::ALL {
        assert!(!plain.is_modified(dash));
    }
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn the_file_format_is_the_documented_one() {
    let mut views = Views::default();
    let view = SavedView {
        rows: vec![OwnedRow {
            h: 300.0,
            cards: vec![(Pane::Times, 1.0), (Pane::Centre, 1.5)],
        }],
    };
    views.set(DashboardId::Race, Layout::Wide, view.clone());
    let json = views.to_value();
    assert_eq!(json["race"]["wide"]["rows"][0]["h"], 300.0);
    assert_eq!(json["race"]["wide"]["rows"][0]["cards"][1][0], "centre");
    assert_eq!(json["race"]["wide"]["rows"][0]["cards"][1][1], 1.5);
    let text = r#"{"manual":{},"views":{"race":{"wide":{"rows":[{"h":300,"cards":[["times",1.0],["centre",1.5]]}]}}}}"#;
    assert_eq!(Views::parse(text).rows_for(DashboardId::Race, Layout::Wide), view);
    for (_, key) in LAYOUT_KEYS {
        assert_eq!(layout_key(layout_from_key(key).unwrap()), key);
    }
    assert!(layout_from_key("huge").is_none());
}

#[test]
fn the_manual_choices_and_the_views_share_one_file_without_losing_each_other() {
    let home = crate::config::scratch_dir("views-and-choices");
    let mut views = Views::default();
    views.set(
        DashboardId::Qualifying,
        Layout::Square,
        edited(DashboardId::Qualifying, Layout::Square),
    );
    let mut choices = Choices::default();
    choices.set("ac", Some(DashboardId::Race));
    choices.save(&home).unwrap();
    views.save(&home).unwrap();
    assert_eq!(
        Choices::load(&home).get("ac"),
        Some(DashboardId::Race),
        "the choice survives a views save"
    );
    assert_eq!(Views::load(&home), views);
    choices.set("lmu", Some(DashboardId::TimeTrial));
    choices.save(&home).unwrap();
    assert_eq!(Views::load(&home), views, "the views survive a choices save");
    assert_eq!(Choices::load(&home).get("lmu"), Some(DashboardId::TimeTrial));
    // Keys the program does not know stay too, and a write leaves no half file behind.
    std::fs::write(home.join("dashboards.json"), r#"{"manual":{},"views":{},"future":{"a":1}}"#).unwrap();
    choices.save(&home).unwrap();
    views.save(&home).unwrap();
    assert!(read_file(&home).contains_key("future"));
    assert!(!home.join("dashboards.json.part").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn reset_goes_back_to_the_built_in_rows_for_one_shape_or_all() {
    let home = crate::config::scratch_dir("views-reset");
    let mut views = Views::default();
    for (dash, layout, _) in every_view() {
        views.set(dash, layout, edited(dash, layout));
    }
    let dash = DashboardId::Race;
    views.reset(dash, Some(Layout::Wide));
    assert_eq!(views.rows_for(dash, Layout::Wide), SavedView::default_for(dash, Layout::Wide));
    assert!(!views.is_modified_in(dash, Layout::Wide));
    assert!(
        views.is_modified_in(dash, Layout::Square) && views.is_modified(dash),
        "the other shapes stay"
    );
    views.reset(dash, None);
    assert!(!views.is_modified(dash));
    for (layout, _) in LAYOUT_KEYS {
        assert_eq!(views.rows_for(dash, layout), SavedView::default_for(dash, layout));
    }
    assert!(views.is_modified(DashboardId::Practice), "another dashboard is untouched");
    views.save(&home).unwrap();
    assert_eq!(Views::load(&home), views);
    assert!(!Views::load(&home).is_modified(dash));
    let _ = std::fs::remove_dir_all(&home);
}

/// Every text a file could hold that is not a clean one: it never fails and every view it leaves passes the checks.
const DAMAGED: &[&str] = &[
    "",
    "{ not json",
    "[]",
    "null",
    "42",
    r#""views""#,
    r#"{"views": 5}"#,
    r#"{"views": []}"#,
    r#"{"views": null}"#,
    r#"{"views": {"race": 7}}"#,
    r#"{"views": {"race": []}}"#,
    r#"{"views": {"race": {"wide": 5}}}"#,
    r#"{"views": {"race": {"wide": {}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": "x"}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [5, "x", null, []]}}}}"#,
    r#"{"views": {"nonsense": {"wide": {"rows": [{"h": 300, "cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"enormous": {"rows": [{"h": 300, "cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 300, "cards": [["bogus", 1], ["nothing", 2]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 300, "cards": [["times", 1], ["times", 2], ["times", 3]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 300, "cards": [["times", 0], ["centre", -3], ["fuel", "x"], ["tyres", 1e30]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 300, "cards": [["times"], [], 7, {"a": 1}, ["centre", null]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 0, "cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": -50, "cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 1e9, "cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": "tall", "cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"cards": [["times", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": []}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 300, "cards": []}, {"h": 300}]}}}}"#,
    r#"{"views": {"stack": {"stack": {"rows": [{"h": 300, "cards": [["times", 1], ["centre", 1], ["fuel", 1], ["tyres", 1]]}]}}}}"#,
    r#"{"views": {"race": {"stack": {"rows": [{"h": 300, "cards": [["times", 1], ["centre", 1], ["fuel", 1], ["tyres", 1]]}]}}}}"#,
    r#"{"views": {"race": {"portrait": {"rows": [{"h": 300, "cards": [["times", 1], ["centre", 1], ["fuel", 1], ["tyres", 1]]}]}}}}"#,
    r#"{"views": {"race": {"wide": {"rows": [{"h": 300, "cards": [["times", 1]], "extra": true}], "more": 1}}}, "other": [1, 2]}"#,
    r#"{"manual": {"ac": "race"}, "views": {"race": {"wide": {"rows": [{"h": 300, "cards": [["times", 1]]}]}}}}"#,
];

#[test]
fn a_damaged_file_never_fails_and_every_view_it_leaves_passes_the_checks() {
    let home = crate::config::scratch_dir("views-damaged");
    let s = all_slots();
    for text in DAMAGED {
        for views in [Views::parse(text), {
            std::fs::write(home.join("dashboards.json"), text).unwrap();
            Views::load(&home)
        }] {
            let _ = Choices::load(&home);
            for (dash, layout, _) in every_view() {
                assert_good(&views.rows_for(dash, layout), layout, &s, &format!("{text} -> {dash:?} {layout:?}"));
            }
        }
    }
    // The file does not even exist.
    std::fs::remove_file(home.join("dashboards.json")).unwrap();
    assert_eq!(Views::load(&home), Views::default());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_damaged_file_is_read_as_much_as_it_can_be() {
    let read = |text: &str| Views::parse(text).rows_for(DashboardId::Race, Layout::Wide);
    let rows = |h: f32, cards: &[(Pane, f32)]| SavedView {
        rows: vec![OwnedRow { h, cards: cards.to_vec() }],
    };
    let wrap = |row: &str| format!(r#"{{"views":{{"race":{{"wide":{{"rows":[{row}]}}}}}}}}"#);
    let default = SavedView::default_for(DashboardId::Race, Layout::Wide);
    // Unknown ids go, a card seen twice goes (the first stays).
    assert_eq!(
        read(&wrap(r#"{"h":300,"cards":[["bogus",1],["times",1],["times",2],["centre",1.2]]}"#)),
        rows(300.0, &[(Pane::Times, 1.0), (Pane::Centre, 1.2)])
    );
    // Nothing readable, nothing left, an empty view: the built-in rows.
    for text in [
        wrap(r#"{"h":300,"cards":[["bogus",1]]}"#),
        wrap(r#"{"h":300,"cards":[]}"#),
        wrap(""),
        "{}".to_owned(),
    ] {
        assert_eq!(read(&text), default, "{text}");
    }
    // Heights: raised to what the cards need, clamped to the limit; a missing or odd one is the least.
    let times_h = card_min_h(Pane::Times);
    for (h, want) in [
        ("0", times_h),
        ("-50", times_h),
        ("1e9", ROW_H_MAX),
        ("\"x\"", times_h),
        ("350", 350.0),
    ] {
        let got = read(&wrap(&format!(r#"{{"h":{h},"cards":[["times",1]]}}"#)));
        assert_eq!(got, rows(want, &[(Pane::Times, 1.0)]), "h = {h}");
    }
    // Shares that are not numbers become 1, huge ones are held at the limit (then the row keeps every card its least width).
    let got = read(&wrap(
        r#"{"h":300,"cards":[["times",0],["centre",-3],["fuel","x"],["tyres",1e30]]}"#,
    ));
    assert_eq!(got.rows.len(), 1);
    assert_eq!(got.panes(), [Pane::Times, Pane::Centre, Pane::Fuel, Pane::Tyres]);
    // Nineteen cards in a row are split into rows; nineteen rows are cut to twelve.
    let all: Vec<String> = catalog::ALL.iter().map(|w| format!(r#"["{}",1]"#, w.id)).collect();
    let packed = read(&wrap(&format!(r#"{{"h":300,"cards":[{}]}}"#, all.join(","))));
    assert_eq!(packed.panes().len(), 19);
    assert!(packed.rows.iter().all(|r| r.cards.len() <= VIEW_MAX_CARDS));
    let singles: Vec<String> = catalog::ALL
        .iter()
        .map(|w| format!(r#"{{"h":300,"cards":[["{}",1]]}}"#, w.id))
        .collect();
    let tall = read(&wrap(&singles.join(",")));
    assert_eq!(tall.rows.len(), VIEW_MAX_ROWS);
}

#[test]
fn sanitising_numbers_that_are_not_numbers_gives_a_view_that_passes_the_checks() {
    let s = all_slots();
    let junk = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, -1.0, 1e-9, 1e30, 3.0];
    for (layout, _) in LAYOUT_KEYS {
        for (i, share) in junk.iter().enumerate() {
            for h in junk {
                // Every card of the catalog in one row, each with a junk share and the row a junk height.
                let row = OwnedRow {
                    h,
                    cards: catalog::ALL
                        .iter()
                        .enumerate()
                        .map(|(n, w)| (w.pane, if n % 2 == 0 { *share } else { junk[(i + n) % junk.len()] }))
                        .collect(),
                };
                let view = sanitise(vec![row], layout).expect("something is left");
                assert_good(&view, layout, &s, &format!("{layout:?} share {share} h {h}"));
                assert_eq!(view.panes().len(), 19, "{layout:?}: no card is lost to the splitting");
            }
        }
    }
    assert!(sanitise(Vec::new(), Layout::Wide).is_none());
    let empty = OwnedRow {
        h: 100.0,
        cards: Vec::new(),
    };
    assert!(sanitise(vec![empty.clone(), empty], Layout::Wide).is_none());
}

// ---- the operations ----

#[test]
fn moving_a_card_onto_itself_changes_nothing_and_a_move_that_empties_a_row_removes_it() {
    for (_, layout, view) in every_view() {
        for pos in positions_of(&view) {
            assert_eq!(move_card(&view, layout, pos, Target::Swap(pos)).unwrap(), view);
            for side in [Side::Left, Side::Right] {
                assert_eq!(move_card(&view, layout, pos, Target::Beside(pos, side)).unwrap(), view);
            }
        }
    }
    // Practice Wide: the second row's three cards go one by one to the first row's end: the row goes with the last.
    let layout = Layout::Wide;
    let mut view = SavedView::default_for(DashboardId::Practice, layout);
    assert_eq!(view.rows.len(), 2);
    let last_of_first = Pos { row: 0, card: 4 };
    view = move_card(&view, layout, Pos { row: 1, card: 0 }, Target::Beside(last_of_first, Side::Right)).unwrap_or(view);
    let s = all_slots();
    assert_good(&view, layout, &s, "after the first move");
    // A card alone in its row moved to a new row at the other end: the old row is gone, the count is the same.
    let stack = SavedView::default_for(DashboardId::Practice, Layout::Stack);
    let rows = stack.rows.len();
    let moved = move_card(&stack, Layout::Stack, Pos { row: 0, card: 0 }, Target::NewRow(rows)).unwrap();
    assert_eq!(moved.rows.len(), rows);
    assert_eq!(moved.rows.last().unwrap().cards[0].0, stack.rows[0].cards[0].0);
    assert_eq!(moved.rows[0].cards[0].0, stack.rows[1].cards[0].0);
    // A row's card made a row of its own: one more row.
    let wide = SavedView::default_for(DashboardId::Practice, Layout::Wide);
    let split = move_card(&wide, Layout::Wide, Pos { row: 0, card: 1 }, Target::NewRow(1)).unwrap();
    assert_eq!(split.rows.len(), wide.rows.len() + 1);
    assert_eq!(split.rows[1].cards.len(), 1);
    assert_eq!(split.rows[0].cards.len(), wide.rows[0].cards.len() - 1);
}

#[test]
fn a_swap_changes_places_and_a_beside_puts_the_card_next_to_the_other() {
    let layout = Layout::Wide;
    let view = SavedView::default_for(DashboardId::Race, layout);
    let a = Pos { row: 0, card: 0 };
    let b = Pos { row: 1, card: 2 };
    let swapped = move_card(&view, layout, a, Target::Swap(b)).unwrap();
    assert_eq!(swapped.rows[0].cards[0].0, view.rows[1].cards[2].0);
    assert_eq!(swapped.rows[1].cards[2].0, view.rows[0].cards[0].0);
    assert_eq!(ids(&swapped), ids(&view));
    // Times beside Gaps (row 1, card 2), on its left and on its right.
    let left = move_card(&view, layout, a, Target::Beside(b, Side::Left)).unwrap();
    let panes = |v: &SavedView, row: usize| -> Vec<Pane> { v.rows[row].cards.iter().map(|c| c.0).collect() };
    assert_eq!(&panes(&left, 1)[1..4], &[Pane::Standings, Pane::Times, Pane::Gaps]);
    let right = move_card(&view, layout, a, Target::Beside(b, Side::Right)).unwrap();
    assert_eq!(&panes(&right, 1)[2..4], &[Pane::Gaps, Pane::Times]);
    assert_eq!(left.rows[0].cards.len(), 4);
    // Past six cards a row refuses.
    let full = SavedView::default_for(DashboardId::Race, Layout::Ultrawide);
    assert_eq!(full.rows[0].cards.len(), 6);
    assert_eq!(
        move_card(
            &full,
            Layout::Ultrawide,
            Pos { row: 2, card: 0 },
            Target::Beside(Pos { row: 0, card: 2 }, Side::Left)
        ),
        Err(Refused::RowFull)
    );
    // Wrong places are refused.
    assert_eq!(
        move_card(&view, layout, Pos { row: 9, card: 0 }, Target::Swap(a)),
        Err(Refused::NoSuchCard)
    );
    assert_eq!(
        move_card(&view, layout, a, Target::Swap(Pos { row: 0, card: 9 })),
        Err(Refused::NoSuchCard)
    );
    assert_eq!(move_card(&view, layout, a, Target::NewRow(99)), Err(Refused::NoSuchRow));
}

#[test]
fn the_view_never_has_more_than_twelve_rows_or_loses_its_last_card() {
    let layout = Layout::Stack;
    let view = SavedView::default_for(DashboardId::Race, layout);
    assert_eq!(view.rows.len(), VIEW_MAX_ROWS);
    // A card of a row of one into a new row somewhere: the same number of rows. Into a full house from a row with company: no.
    let beside = move_card(
        &view,
        layout,
        Pos { row: 0, card: 0 },
        Target::Beside(Pos { row: 1, card: 0 }, Side::Right),
    )
    .unwrap();
    assert_eq!(beside.rows.len(), VIEW_MAX_ROWS - 1);
    assert_eq!(
        move_card(&beside, layout, Pos { row: 0, card: 1 }, Target::NewRow(0)).map(|v| v.rows.len()),
        Ok(VIEW_MAX_ROWS)
    );
    let crowded = SavedView {
        rows: (0..VIEW_MAX_ROWS)
            .map(|i| OwnedRow {
                h: if i == VIEW_MAX_ROWS - 1 { 170.0 } else { 300.0 },
                cards: if i == 0 {
                    vec![(Pane::Times, 1.0), (Pane::Centre, 1.4)]
                } else {
                    vec![(catalog::ALL[i + 1].pane, 1.0)]
                },
            })
            .collect(),
    };
    assert!(check_view(&crowded, layout).is_ok());
    assert_eq!(
        move_card(&crowded, layout, Pos { row: 0, card: 1 }, Target::NewRow(3)),
        Err(Refused::TooManyRows)
    );
    assert_eq!(add(&crowded, layout, Pane::Radar), Err(Refused::TooManyRows));
    // The last card cannot be removed.
    let one = SavedView {
        rows: vec![OwnedRow {
            h: 300.0,
            cards: vec![(Pane::Times, 1.0)],
        }],
    };
    assert_eq!(remove(&one, layout, Pos { row: 0, card: 0 }), Err(Refused::LastCard));
}

#[test]
fn adding_fills_the_last_row_then_opens_a_new_one_and_refuses_a_card_already_there() {
    let layout = Layout::Wide;
    let view = SavedView::default_for(DashboardId::Practice, layout);
    let addable_now = addable(&view);
    assert_eq!(addable_now.len(), catalog::ALL.len() - view.panes().len());
    assert!(addable_now.iter().all(|p| !view.panes().contains(p)));
    let positions: Vec<usize> = addable_now
        .iter()
        .map(|p| catalog::ALL.iter().position(|w| w.pane == *p).unwrap())
        .collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "in the catalog's order");
    // Practice Wide's last row has three cards and is 262 tall: a card that fits goes in it, a taller one makes a row.
    let session = add(&view, layout, Pane::Session).unwrap();
    assert_eq!(session.rows.len(), view.rows.len());
    assert_eq!(session.rows[1].cards.len(), 4);
    assert_eq!(session.rows[1].cards[3].0, Pane::Session);
    let tall = add(&view, layout, Pane::FuelCalc).unwrap_or_else(|_| view.clone());
    assert!(tall.rows.len() >= view.rows.len());
    assert_eq!(add(&view, layout, Pane::Times), Err(Refused::AlreadyInView));
    // Until the row is full: then a new one, as tall as the card needs.
    let mut grown = view.clone();
    let mut fed = 0;
    for pane in addable(&view) {
        grown = add(&grown, layout, pane).unwrap();
        fed += 1;
        assert!(check_view(&grown, layout).is_ok(), "after {fed} cards");
    }
    assert!(addable(&grown).is_empty());
    assert_eq!(grown.panes().len(), catalog::ALL.len());
    assert!(grown.rows.last().unwrap().h >= row_min_h(&grown.rows.last().unwrap().cards));
}

#[test]
fn a_split_moves_width_between_the_neighbours_only_and_stops_at_the_least_width() {
    let layout = Layout::Wide;
    let view = SavedView::default_for(DashboardId::Race, layout);
    let width_of = |v: &SavedView, row: usize, card: usize| -> f32 {
        let r = &v.rows[row];
        let room = layout.width() - GAP * (r.cards.len() as f32 - 1.0);
        room * r.cards[card].1 / r.cards.iter().map(|c| c.1).sum::<f32>()
    };
    let wider = resize_split(&view, layout, 0, 0, 60.0).unwrap();
    assert!((width_of(&wider, 0, 0) - width_of(&view, 0, 0) - 60.0).abs() < 0.1);
    assert!((width_of(&wider, 0, 1) - width_of(&view, 0, 1) + 60.0).abs() < 0.1);
    for card in 2..5 {
        assert!(
            (width_of(&wider, 0, card) - width_of(&view, 0, card)).abs() < 0.1,
            "card {card} keeps its width"
        );
    }
    // Dragged a very long way: the centre card keeps its least width, the other the same.
    let squeezed = resize_split(&view, layout, 0, 0, 5_000.0).unwrap();
    assert!((width_of(&squeezed, 0, 1) - CENTRE_W_MIN).abs() < 0.1 || width_of(&squeezed, 0, 1) >= CENTRE_W_MIN);
    assert!(width_of(&squeezed, 0, 1) + 0.01 >= CENTRE_W_MIN);
    let squeezed_back = resize_split(&view, layout, 0, 0, -5_000.0).unwrap();
    assert!(width_of(&squeezed_back, 0, 0) + 0.01 >= CARD_W_MIN);
    assert_eq!(
        resize_split(&view, layout, 0, 4, 10.0),
        Err(Refused::NoSuchCard),
        "nothing after the last card"
    );
    assert_eq!(resize_split(&view, layout, 9, 0, 10.0), Err(Refused::NoSuchRow));
    assert_eq!(resize_split(&view, layout, 0, 0, f32::NAN), Err(Refused::BadNumber));
}

#[test]
fn a_row_is_never_shorter_than_its_cards_need_nor_taller_than_the_limit() {
    for (dash, layout, view) in every_view() {
        for (row, r) in view.rows.iter().enumerate() {
            let low = resize_row(&view, layout, row, 0.0).unwrap();
            assert_eq!(low.rows[row].h, row_min_h(&r.cards), "{dash:?} {layout:?} row {row}");
            let high = resize_row(&view, layout, row, 5_000.0).unwrap();
            assert_eq!(high.rows[row].h, ROW_H_MAX);
            let mid = resize_row(&view, layout, row, 500.0).unwrap();
            assert_eq!(mid.rows[row].h, 500.0);
        }
        assert_eq!(resize_row(&view, layout, 99, 300.0), Err(Refused::NoSuchRow));
        assert_eq!(resize_row(&view, layout, 0, f32::INFINITY), Err(Refused::BadNumber));
    }
}

#[test]
fn every_edit_at_every_place_of_every_builtin_view_keeps_the_limits_and_the_cards() {
    let s = all_slots();
    let (mut done, mut refused) = (0_usize, 0_usize);
    for (dash, layout, view) in every_view() {
        let tag = format!("{dash:?} {layout:?}");
        let positions = positions_of(&view);
        let mut ops: Vec<EditOp> = Vec::new();
        for &from in &positions {
            for &to in &positions {
                ops.push(EditOp::Move(from, Target::Swap(to)));
                ops.push(EditOp::Move(from, Target::Beside(to, Side::Left)));
                ops.push(EditOp::Move(from, Target::Beside(to, Side::Right)));
            }
            for index in 0..=view.rows.len() {
                ops.push(EditOp::Move(from, Target::NewRow(index)));
            }
            ops.push(EditOp::Remove(from));
        }
        for (row, r) in view.rows.iter().enumerate() {
            for left in 0..r.cards.len().saturating_sub(1) {
                for delta in [-500.0, -50.0, 50.0, 500.0] {
                    ops.push(EditOp::ResizeSplit { row, left, delta });
                }
            }
            for h in [0.0, 50.0, 300.0, 2000.0] {
                ops.push(EditOp::ResizeRow { row, h });
            }
        }
        for pane in addable(&view) {
            ops.push(EditOp::Add(pane));
        }
        for op in ops {
            match apply_op(&view, layout, op) {
                Ok(next) => {
                    done += 1;
                    assert_good(&next, layout, &s, &format!("{tag} {op:?}"));
                    match op {
                        EditOp::Remove(pos) => {
                            let gone = catalog::id_of(view.rows[pos.row].cards[pos.card].0);
                            let mut want = ids(&view);
                            want.retain(|id| *id != gone);
                            assert_eq!(ids(&next), want, "{tag} {op:?}");
                        }
                        EditOp::Add(pane) => {
                            let mut want = ids(&view);
                            want.push(catalog::id_of(pane));
                            want.sort_unstable();
                            assert_eq!(ids(&next), want, "{tag} {op:?}");
                        }
                        _ => assert_eq!(ids(&next), ids(&view), "{tag} {op:?}: the same cards"),
                    }
                }
                Err(why) => {
                    refused += 1;
                    assert_ne!(why, Refused::Invalid, "{tag} {op:?}");
                }
            }
        }
    }
    assert!(done > 2_000 && done > refused, "{done} edits applied, {refused} refused");
}

#[test]
fn thousands_of_random_edits_keep_every_limit_and_cancel_restores_the_view() {
    let s = all_slots();
    let views = every_view();
    let mut total = 0_usize;
    let mut applied = 0_usize;
    for seed in [
        0x9E37_79B9_7F4A_7C15_u64,
        0xD1B5_4A32_D192_ED03,
        0x2545_F491_4F6C_DD1D,
        0x1234_5678_9ABC_DEF1,
    ] {
        let mut rng = Rng(seed);
        for session in 0..50 {
            let (dash, layout, original) = views[rng.below(views.len())].clone();
            let mut edit = EditSession::new(dash, layout, original.clone());
            assert!(!edit.is_dirty());
            for step in 0..25 {
                let op = random_op(&mut rng, &edit.current);
                let before = edit.current.clone();
                match edit.apply(op) {
                    Ok(()) => applied += 1,
                    Err(why) => {
                        assert_ne!(why, Refused::Invalid, "seed {seed:x} session {session} step {step}: {op:?}");
                        assert_eq!(edit.current, before, "a refused edit changes nothing");
                    }
                }
                total += 1;
                assert_good(
                    &edit.current,
                    layout,
                    &s,
                    &format!("seed {seed:x} session {session} step {step}: {op:?}"),
                );
            }
            assert_eq!(edit.is_dirty(), edit.current != original);
            assert_eq!(edit.cancel(), original, "cancel gives back exactly the original");
        }
    }
    assert!(total >= 5_000, "{total} random edits");
    assert!(applied > total / 5, "{applied} of {total} were applied");
}

#[test]
fn the_gear_stays_big_whatever_is_done_to_the_centre_card() {
    let s = all_slots();
    for (dash, layout, view) in every_view() {
        let Some(at) = positions_of(&view)
            .into_iter()
            .find(|p| view.rows[p.row].cards[p.card].0 == Pane::Centre)
        else {
            continue;
        };
        let tag = format!("{dash:?} {layout:?}");
        // The row as short as it can be.
        let short = resize_row(&view, layout, at.row, 0.0).unwrap();
        assert_good(&short, layout, &s, &tag);
        assert!(short.rows[at.row].h >= CENTRE_H_MIN, "{tag}");
        // The neighbours dragged against the card from both sides, as far as they go.
        let len = view.rows[at.row].cards.len();
        for left in 0..len.saturating_sub(1) {
            for delta in [-5_000.0, 5_000.0] {
                let squeezed = resize_split(&view, layout, at.row, left, delta).unwrap();
                assert_good(&squeezed, layout, &s, &format!("{tag} split {left} {delta}"));
            }
        }
        // The card moved to every other place.
        for to in positions_of(&view) {
            for target in [Target::Swap(to), Target::Beside(to, Side::Left), Target::Beside(to, Side::Right)] {
                if let Ok(moved) = move_card(&view, layout, at, target) {
                    assert_good(&moved, layout, &s, &format!("{tag} {target:?}"));
                }
            }
        }
        // The plan's card and the gear in it.
        let plan = layout.plan_view(&short, &s, usize::MAX);
        let area = plan.area(Pane::Centre).unwrap();
        assert!(area.3 >= CENTRE_H_MIN - 0.01 && area.2 >= CENTRE_W_MIN - 0.01, "{tag}: {area:?}");
        let (_, _, _, inside_h) = inner(area);
        let gear = centre_plan(area, &s).gear.3;
        assert!(
            gear >= (GEAR_MIN_SHARE * inside_h).min(GEAR_MAX_H) - 0.01,
            "{tag}: the gear is half the card"
        );
    }
}

// ---- hit testing ----

/// A plan of two rows: three cards over one, as the edit mode draws them.
fn known_plan() -> Plan {
    Plan {
        w: 1000.0,
        h: 622.0,
        cards: vec![
            (Pane::Times, (0.0, 110.0, 300.0, 300.0)),
            (Pane::Centre, (312.0, 110.0, 300.0, 300.0)),
            (Pane::Inputs, (624.0, 110.0, 376.0, 300.0)),
            (Pane::Laps, (0.0, 422.0, 1000.0, 200.0)),
        ],
    }
}

#[test]
fn a_point_on_the_plan_finds_its_card() {
    let plan = known_plan();
    let at = |x, y| card_at(&plan, x, y);
    assert_eq!(at(50.0, 200.0), Some(Pos { row: 0, card: 0 }));
    assert_eq!(at(312.0, 110.0), Some(Pos { row: 0, card: 1 }), "a card's top left corner is in it");
    assert_eq!(at(999.0, 300.0), Some(Pos { row: 0, card: 2 }));
    assert_eq!(at(0.0, 422.0), Some(Pos { row: 1, card: 0 }));
    assert_eq!(at(999.9, 621.9), Some(Pos { row: 1, card: 0 }));
    assert_eq!(at(306.0, 200.0), None, "the gap between two cards");
    assert_eq!(at(500.0, 416.0), None, "the gap between two rows");
    assert_eq!(at(500.0, 410.0), None, "a card's bottom edge is outside it");
    assert_eq!(at(500.0, 622.0), None);
    assert_eq!(at(500.0, 50.0), None, "the header");
    assert_eq!(at(-1.0, 200.0), None);
    let empty = Plan {
        w: 1000.0,
        h: 110.0,
        cards: Vec::new(),
    };
    assert_eq!(card_at(&empty, 5.0, 5.0), None);
}

#[test]
fn a_drop_on_a_card_is_a_swap_in_its_middle_and_goes_beside_it_at_its_sides() {
    let plan = known_plan();
    let at = |x, y| target_at(&plan, x, y);
    let times = Pos { row: 0, card: 0 };
    let centre = Pos { row: 0, card: 1 };
    assert_eq!(at(10.0, 200.0), Some(Target::Beside(times, Side::Left)));
    assert_eq!(at(99.0, 200.0), Some(Target::Beside(times, Side::Left)));
    assert_eq!(at(150.0, 200.0), Some(Target::Swap(times)));
    assert_eq!(at(199.0, 200.0), Some(Target::Swap(times)));
    assert_eq!(at(290.0, 200.0), Some(Target::Beside(times, Side::Right)));
    // The centre card is 300 wide from 312: thirds at 412 and 512.
    assert_eq!(at(400.0, 200.0), Some(Target::Beside(centre, Side::Left)));
    assert_eq!(at(462.0, 200.0), Some(Target::Swap(centre)));
    assert_eq!(at(600.0, 200.0), Some(Target::Beside(centre, Side::Right)));
    let laps = Pos { row: 1, card: 0 };
    assert_eq!(at(100.0, 500.0), Some(Target::Beside(laps, Side::Left)));
    assert_eq!(at(500.0, 500.0), Some(Target::Swap(laps)));
    assert_eq!(at(900.0, 500.0), Some(Target::Beside(laps, Side::Right)));
}

#[test]
fn a_drop_in_a_gap_above_or_below_makes_a_new_row_and_one_between_two_cards_does_nothing() {
    let plan = known_plan();
    let at = |x, y| target_at(&plan, x, y);
    assert_eq!(at(500.0, 416.0), Some(Target::NewRow(1)), "between the rows");
    assert_eq!(at(500.0, 410.0), Some(Target::NewRow(1)), "the row's bottom edge starts the gap");
    assert_eq!(at(5.0, 421.9), Some(Target::NewRow(1)));
    assert_eq!(at(500.0, 100.0), Some(Target::NewRow(0)), "above the first row");
    assert_eq!(at(500.0, 20.0), Some(Target::NewRow(0)), "in the header");
    assert_eq!(at(500.0, 622.0), Some(Target::NewRow(2)), "under the last");
    assert_eq!(at(500.0, 900.0), Some(Target::NewRow(2)));
    assert_eq!(at(306.0, 200.0), None, "between two cards of a row");
    assert_eq!(at(-5.0, 416.0), None, "outside the canvas");
    assert_eq!(at(1005.0, 416.0), None);
    let empty = Plan {
        w: 1000.0,
        h: 110.0,
        cards: Vec::new(),
    };
    assert_eq!(
        target_at(&empty, 500.0, 500.0),
        Some(Target::NewRow(0)),
        "an empty plan takes a first row"
    );
}

#[test]
fn the_boundaries_are_found_within_the_tolerance_and_the_nearest_wins() {
    let plan = known_plan();
    let at = |x, y, tol| boundary_at(&plan, x, y, tol);
    // Between Times and Centre the line is at 306; between Centre and Inputs at 618.
    assert_eq!(at(306.0, 200.0, 4.0), Some(Boundary::Split { row: 0, left: 0 }));
    assert_eq!(
        at(310.0, 200.0, 4.0),
        Some(Boundary::Split { row: 0, left: 0 }),
        "the tolerance is inclusive"
    );
    assert_eq!(at(311.0, 200.0, 4.0), None);
    assert_eq!(at(618.0, 300.0, 4.0), Some(Boundary::Split { row: 0, left: 1 }));
    assert_eq!(
        at(306.0, 111.0, 4.0),
        Some(Boundary::Split { row: 0, left: 0 }),
        "along the card's whole height"
    );
    assert_eq!(at(306.0, 450.0, 4.0), None, "a row of one card has no split");
    // Under the rows: the middle of the gap, 416 and 628.
    assert_eq!(at(500.0, 416.0, 4.0), Some(Boundary::RowBottom(0)));
    assert_eq!(at(500.0, 420.0, 4.0), Some(Boundary::RowBottom(0)));
    assert_eq!(at(500.0, 421.0, 4.0), None);
    assert_eq!(at(500.0, 628.0, 4.0), Some(Boundary::RowBottom(1)));
    assert_eq!(at(-1.0, 416.0, 4.0), None, "outside the canvas");
    // A corner: the nearest line, and the split on a tie.
    assert_eq!(at(306.0, 410.0, 10.0), Some(Boundary::Split { row: 0, left: 0 }));
    assert_eq!(
        at(306.0, 416.0, 4.0),
        Some(Boundary::RowBottom(0)),
        "out of the row's band, only the bottom line is near"
    );
    assert_eq!(at(500.0, 200.0, 4.0), None);
}

#[test]
fn on_a_real_edit_plan_every_card_is_found_and_every_row_gap_takes_a_new_row() {
    let s = all_slots();
    for (dash, layout, view) in every_view() {
        let plan = layout.plan_view(&view, &s, usize::MAX);
        let tag = format!("{dash:?} {layout:?}");
        for (pane, (x, y, w, h)) in &plan.cards {
            let pos = card_at(&plan, x + w / 2.0, y + h / 2.0).unwrap_or_else(|| panic!("{tag}: {pane:?} is not found"));
            assert_eq!(view.rows[pos.row].cards[pos.card].0, *pane, "{tag}");
            assert_eq!(target_at(&plan, x + w / 2.0, y + h / 2.0), Some(Target::Swap(pos)), "{tag}");
        }
        let mut tops: Vec<f32> = plan.cards.iter().map(|c| c.1 .1).collect();
        tops.dedup_by(|a, b| (*a - *b).abs() < 0.01);
        assert_eq!(tops.len(), view.rows.len(), "{tag}: the plan has the view's rows");
        for (i, top) in tops.iter().enumerate().skip(1) {
            assert_eq!(target_at(&plan, plan.w / 2.0, top - GAP / 2.0), Some(Target::NewRow(i)), "{tag}");
        }
        assert_eq!(target_at(&plan, plan.w / 2.0, CARDS_TOP - 5.0), Some(Target::NewRow(0)), "{tag}");
        assert_eq!(
            target_at(&plan, plan.w / 2.0, plan.h + 5.0),
            Some(Target::NewRow(view.rows.len())),
            "{tag}"
        );
    }
}
