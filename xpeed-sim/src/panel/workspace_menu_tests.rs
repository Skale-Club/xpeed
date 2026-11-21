//! Tests of the workspace menu (`workspace_menu.rs`), with no window: its rows and which one is checked, dotted or off, where they
//! are, what a click does (the reset's two clicks with a clock handed in), what choosing changes of the per-game choice, and the
//! name of the Hot lap workspace in the three languages.

use super::*;

const WIDTH: i32 = 1536;

/// The saved views of the given workspaces: each has a taller first row in the Wide shape.
fn views_with(dashboards: &[DashboardId]) -> Views {
    let mut views = Views::default();
    for &dashboard in dashboards {
        let base = SavedView::default_for(dashboard, Layout::Wide);
        let taller = resize_row(&base, Layout::Wide, 0, base.rows[0].h + 20.0);
        views.set(dashboard, Layout::Wide, taller.expect("a taller first row"));
    }
    views
}

fn menu_at(width: i32, scale: f32, manual: Option<DashboardId>, in_use: DashboardId, views: &Views) -> WorkspaceMenu {
    match workspace_menu(width, scale, manual, in_use, views) {
        Some(menu) => menu,
        None => panic!("the pill has room at {width} wide, scale {scale}"),
    }
}

fn menu_of(manual: Option<DashboardId>, in_use: DashboardId, views: &Views) -> WorkspaceMenu {
    menu_at(WIDTH, 1.0, manual, in_use, views)
}

fn row_of(menu: &WorkspaceMenu, item: WorkspaceItem) -> WorkspaceRow {
    match menu.rows.iter().find(|r| r.item == item) {
        Some(row) => *row,
        None => panic!("{item:?} is a row of the menu"),
    }
}

fn middle_of_row(menu: &WorkspaceMenu, item: WorkspaceItem) -> (i32, i32) {
    let r = row_of(menu, item).rect;
    ((r.left + r.right) / 2, (r.top + r.bottom) / 2)
}

fn click(menu: &WorkspaceMenu, item: WorkspaceItem, now: i64, reset_until: i64) -> (WorkspaceAct, i64) {
    let (x, y) = middle_of_row(menu, item);
    workspace_click(menu, x, y, now, reset_until)
}

fn within(inner: RECT, outer: RECT) -> bool {
    inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
}

fn items_where(menu: &WorkspaceMenu, keep: impl Fn(&WorkspaceRow) -> bool) -> Vec<WorkspaceItem> {
    menu.rows.iter().filter(|r| keep(r)).map(|r| r.item).collect()
}

#[test]
fn the_menu_lists_automatic_the_four_workspaces_and_the_two_actions_in_order_under_the_pill() {
    let views = Views::default();
    for scale in [1.0, 1.5, 2.0] {
        let width = (WIDTH as f32 * scale) as i32;
        let menu = menu_at(width, scale, None, DashboardId::Race, &views);
        let items = items_where(&menu, |_| true);
        assert_eq!(
            items,
            [
                WorkspaceItem::Auto,
                WorkspaceItem::Pick(DashboardId::Race),
                WorkspaceItem::Pick(DashboardId::Qualifying),
                WorkspaceItem::Pick(DashboardId::TimeTrial),
                WorkspaceItem::Pick(DashboardId::Practice),
                WorkspaceItem::Edit,
                WorkspaceItem::Reset,
            ]
        );
        let Some(pill) = dashboard_hit(width, scale) else {
            panic!("the pill at scale {scale}");
        };
        assert!(menu.list.top > pill.bottom, "scale {scale}: under the pill");
        assert!(
            menu.list.left <= pill.left && menu.list.left >= 0,
            "scale {scale}: from the pill's left edge"
        );
        assert!(menu.list.right <= width, "scale {scale}");
        for pair in menu.rows.windows(2) {
            assert!(pair[0].rect.bottom <= pair[1].rect.top, "scale {scale}: rows do not overlap");
        }
        let least = (WORKSPACE_ROW_H * scale) as i32 - 1;
        for row in &menu.rows {
            assert!(within(row.rect, menu.list), "{:?} is inside the box", row.item);
            assert!(row.rect.bottom - row.rect.top >= least, "{:?} is tall enough to click", row.item);
        }
        // The divider is between the last workspace and the first action, inside the box.
        let practice = row_of(&menu, WorkspaceItem::Pick(DashboardId::Practice));
        let edit = row_of(&menu, WorkspaceItem::Edit);
        assert!(menu.divider.top >= practice.rect.bottom, "scale {scale}");
        assert!(menu.divider.bottom <= edit.rect.top, "scale {scale}");
        assert!(within(menu.divider, menu.list), "scale {scale}");
    }
    // The order is the owner's: Race, Qualifying, Hot lap, Practice (not the order `D` cycles in).
    assert_eq!(WORKSPACE_ORDER.len(), DashboardId::ALL.len());
    assert!(DashboardId::ALL.iter().all(|d| WORKSPACE_ORDER.contains(d)));
}

#[test]
fn the_menu_stays_inside_the_window_wherever_it_can_open_and_is_not_there_without_a_pill() {
    let views = Views::default();
    for scale in [1.0, 1.25, 1.5] {
        for width in (400..3000).step_by(13) {
            let Some(menu) = workspace_menu(width, scale, None, DashboardId::Practice, &views) else {
                assert!(dashboard_hit(width, scale).is_none(), "{width} at {scale}");
                continue;
            };
            assert!(menu.list.left >= 0, "{width} at {scale}");
            assert!(menu.list.right <= width, "{width} at {scale}");
        }
    }
    // A window narrower than a phone leaves no room for the pill, so there is nothing to open it from.
    assert!(workspace_menu(300, 1.0, None, DashboardId::Race, &views).is_none());
}

#[test]
fn the_check_is_on_the_workspace_in_use_and_on_automatic_only_when_nothing_is_picked_by_hand() {
    let views = Views::default();
    // Automatic: the session picked Race; Automatic and Race are marked.
    let auto = menu_of(None, DashboardId::Race, &views);
    let checked = items_where(&auto, |r| r.checked);
    assert_eq!(checked, [WorkspaceItem::Auto, WorkspaceItem::Pick(DashboardId::Race)]);
    // By hand: only the workspace picked.
    for dashboard in DashboardId::ALL {
        let menu = menu_of(Some(dashboard), dashboard, &views);
        let checked = items_where(&menu, |r| r.checked);
        assert_eq!(checked, [WorkspaceItem::Pick(dashboard)], "{dashboard:?}");
    }
    // The actions are never checked.
    assert!(!row_of(&auto, WorkspaceItem::Edit).checked);
    assert!(!row_of(&auto, WorkspaceItem::Reset).checked);
}

#[test]
fn a_workspace_with_a_saved_view_has_the_dot_and_nothing_else_has() {
    let none = menu_of(None, DashboardId::Practice, &Views::default());
    assert!(items_where(&none, |r| r.dotted).is_empty(), "no saved views, no dots");
    let views = views_with(&[DashboardId::Qualifying, DashboardId::TimeTrial]);
    let menu = menu_of(Some(DashboardId::Race), DashboardId::Race, &views);
    assert_eq!(
        items_where(&menu, |r| r.dotted),
        [
            WorkspaceItem::Pick(DashboardId::Qualifying),
            WorkspaceItem::Pick(DashboardId::TimeTrial)
        ]
    );
}

#[test]
fn reset_is_off_unless_the_workspace_in_use_has_a_saved_view_and_everything_else_is_on() {
    let plain = menu_of(None, DashboardId::Race, &Views::default());
    assert!(!row_of(&plain, WorkspaceItem::Reset).enabled);
    assert_eq!(items_where(&plain, |r| !r.enabled), [WorkspaceItem::Reset]);
    // Another workspace's saved view does not turn it on.
    let other = menu_of(None, DashboardId::Race, &views_with(&[DashboardId::Practice]));
    assert!(!row_of(&other, WorkspaceItem::Reset).enabled);
    // The one in use does.
    let own = menu_of(None, DashboardId::Race, &views_with(&[DashboardId::Race]));
    assert!(row_of(&own, WorkspaceItem::Reset).enabled);
    assert!(items_where(&own, |r| !r.enabled).is_empty());
    // And a reset of it turns it off again.
    let mut views = views_with(&[DashboardId::Race]);
    views.reset(DashboardId::Race, None);
    let after = menu_of(None, DashboardId::Race, &views);
    assert!(!row_of(&after, WorkspaceItem::Reset).enabled);
}

#[test]
fn a_click_outside_closes_a_click_between_rows_or_on_a_row_that_is_off_keeps_the_menu_open() {
    let menu = menu_of(None, DashboardId::Race, &Views::default());
    let l = menu.list;
    assert_eq!(
        workspace_click(&menu, 5, 5, 0, 0),
        (WorkspaceAct::Close, 0),
        "the header's far corner"
    );
    assert_eq!(workspace_click(&menu, l.right + 2, l.top + 2, 0, 0).0, WorkspaceAct::Close);
    assert_eq!(workspace_click(&menu, l.left + 2, l.bottom + 2, 0, 0).0, WorkspaceAct::Close);
    // The box's padding and its divider are inside it and do nothing.
    assert_eq!(workspace_click(&menu, l.left + 1, l.top + 1, 0, 0).0, WorkspaceAct::Keep);
    let (mid, line) = ((menu.divider.left + menu.divider.right) / 2, menu.divider.top);
    assert_eq!(workspace_click(&menu, mid, line, 0, 0).0, WorkspaceAct::Keep);
    // Reset is off here: a click keeps the menu open and does not arm it.
    assert_eq!(click(&menu, WorkspaceItem::Reset, 1_000, 0), (WorkspaceAct::Keep, 0));
}

#[test]
fn a_click_on_a_row_does_what_the_row_says() {
    let views = views_with(&[DashboardId::Race]);
    let menu = menu_of(None, DashboardId::Race, &views);
    assert_eq!(click(&menu, WorkspaceItem::Auto, 0, 0), (WorkspaceAct::Choose(None), 0));
    for dashboard in DashboardId::ALL {
        let (act, until) = click(&menu, WorkspaceItem::Pick(dashboard), 0, 0);
        assert_eq!((act, until), (WorkspaceAct::Choose(Some(dashboard)), 0));
    }
    assert_eq!(click(&menu, WorkspaceItem::Edit, 0, 0), (WorkspaceAct::Edit, 0));
}

#[test]
fn a_reset_needs_a_second_click_within_three_seconds_and_any_other_click_disarms_it() {
    let menu = menu_of(None, DashboardId::Race, &views_with(&[DashboardId::Race]));
    assert_eq!(WORKSPACE_RESET_MS, 3000);
    // The first click arms it, the menu stays open.
    let (act, until) = click(&menu, WorkspaceItem::Reset, 10_000, 0);
    assert_eq!((act, until), (WorkspaceAct::Keep, 13_000));
    // The second, in time, does it and disarms.
    assert_eq!(click(&menu, WorkspaceItem::Reset, 12_999, until), (WorkspaceAct::Reset, 0));
    // Too late (at the very moment it runs out, or after): it is a first click again.
    assert_eq!(click(&menu, WorkspaceItem::Reset, 13_000, until), (WorkspaceAct::Keep, 16_000));
    assert_eq!(click(&menu, WorkspaceItem::Reset, 20_000, until), (WorkspaceAct::Keep, 23_000));
    // Another row in between: it does its own thing and the reset is not waiting any more.
    assert_eq!(click(&menu, WorkspaceItem::Edit, 11_000, until), (WorkspaceAct::Edit, 0));
    assert_eq!(click(&menu, WorkspaceItem::Auto, 11_000, until), (WorkspaceAct::Choose(None), 0));
    assert_eq!(workspace_click(&menu, 5, 5, 11_000, until), (WorkspaceAct::Close, 0));
    // A click on the box's padding leaves it waiting.
    let (x, y) = (menu.list.left + 1, menu.list.top + 1);
    assert_eq!(workspace_click(&menu, x, y, 11_000, until), (WorkspaceAct::Keep, until));
}

#[test]
fn choosing_a_workspace_sets_the_manual_choice_of_that_game_and_automatic_clears_it() {
    let menu = menu_of(None, DashboardId::Race, &Views::default());
    let mut choices = Choices::default();
    for dashboard in WORKSPACE_ORDER {
        let (act, _) = click(&menu, WorkspaceItem::Pick(dashboard), 0, 0);
        assert!(workspace_apply(act, &mut choices, "lmu"), "a choice is kept");
        assert_eq!(choices.get("lmu"), Some(dashboard));
        assert_eq!(choices.get("ac"), None, "another game keeps its own");
        // The same as `D` would have chosen.
        assert_eq!(pick(None, false, choices.get("lmu")), dashboard);
    }
    let (auto, _) = click(&menu, WorkspaceItem::Auto, 0, 0);
    assert!(workspace_apply(auto, &mut choices, "lmu"));
    assert_eq!(choices.get("lmu"), None, "automatic follows the session again");
    // An action that does not choose leaves the choice alone and says so.
    choices.set("lmu", Some(DashboardId::TimeTrial));
    for act in [WorkspaceAct::Keep, WorkspaceAct::Close, WorkspaceAct::Edit, WorkspaceAct::Reset] {
        assert!(!workspace_apply(act, &mut choices, "lmu"), "{act:?}");
        assert_eq!(choices.get("lmu"), Some(DashboardId::TimeTrial));
    }
}

#[test]
fn the_choice_made_in_the_menu_is_kept_in_the_file_like_the_one_made_with_d() {
    let home = std::env::temp_dir().join(format!("xpeed-workspace-menu-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let mut choices = Choices::default();
    let hot_lap = WorkspaceAct::Choose(Some(DashboardId::TimeTrial));
    assert!(workspace_apply(hot_lap, &mut choices, "lmu"));
    assert_eq!(choices.save(&home), Ok(()));
    assert_eq!(Choices::load(&home).get("lmu"), Some(DashboardId::TimeTrial));
    assert!(workspace_apply(WorkspaceAct::Choose(None), &mut choices, "lmu"));
    assert_eq!(choices.save(&home), Ok(()));
    assert_eq!(Choices::load(&home).get("lmu"), None);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn the_time_trial_workspace_is_called_hot_lap_in_every_language_and_its_id_is_unchanged() {
    assert_eq!(DashboardId::TimeTrial.id(), "time_trial");
    let in_menu = workspace_msg(WorkspaceItem::Pick(DashboardId::TimeTrial));
    for lang in Lang::ALL {
        assert_eq!(text(lang, &DashboardId::TimeTrial.msg()), "Hot lap", "{lang:?}");
        assert_eq!(text(lang, &in_menu), "Hot lap", "{lang:?}");
    }
    // The menu's own words are said in each language.
    for item in [WorkspaceItem::Auto, WorkspaceItem::Edit, WorkspaceItem::Reset] {
        let words: Vec<String> = Lang::ALL.iter().map(|l| text(*l, &workspace_msg(item))).collect();
        assert!(words.iter().all(|w| !w.trim().is_empty()), "{item:?}");
        assert_ne!(words[0], words[1], "{item:?} is translated");
        assert_ne!(words[0], words[2], "{item:?} is translated");
    }
    // The key is in the row.
    assert!(text(Lang::En, &workspace_msg(WorkspaceItem::Edit)).ends_with("(E)"));
}
