//! The workspace menu: what opens under the header's dashboard pill (like the workspace menu of a design program). It lists
//! Automatic (follow the session), the four workspaces (a check on the one in use, a dot on one that has a saved view) and, under
//! a divider, two actions: edit the layout of the workspace in use, and reset it to its default (a second click within
//! `WORKSPACE_RESET_MS` confirms).
//!
//! Everything here is a pure function of what the window knows (its width and scale, the manual choice, the workspace in use,
//! the saved views, a clock): the rows and where they are (`workspace_menu`), what a click does (`workspace_click`) and what it
//! changes of the per-game choice (`workspace_apply`). `chrome.rs` draws what `workspace_menu` says and `window.rs` only forwards
//! clicks to `workspace_click`, so all of it is checked without a window (`workspace_menu_tests.rs`).

use super::*;

/// The workspaces in the order the menu lists them (`D` cycles through `DashboardId::ALL`, which has Hot lap last).
pub(super) const WORKSPACE_ORDER: [DashboardId; 4] = [
    DashboardId::Race,
    DashboardId::Qualifying,
    DashboardId::TimeTrial,
    DashboardId::Practice,
];

/// One row of the menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceItem {
    /// Follow the session (no manual choice).
    Auto,
    /// This workspace, by hand.
    Pick(DashboardId),
    /// Edit the layout of the workspace in use.
    Edit,
    /// Back to the default layout of the workspace in use (all window shapes).
    Reset,
}

/// A row: what it is, whether it is marked as the one in use, whether it has the dot of a saved view, whether it can be clicked,
/// and where it is (pixels).
#[derive(Clone, Copy)]
pub(super) struct WorkspaceRow {
    pub(super) item: WorkspaceItem,
    pub(super) checked: bool,
    pub(super) dotted: bool,
    pub(super) enabled: bool,
    pub(super) rect: RECT,
}

/// The open menu: its box, the divider between the workspaces and the actions, and the rows in order.
#[derive(Clone)]
pub(super) struct WorkspaceMenu {
    pub(super) list: RECT,
    pub(super) divider: RECT,
    pub(super) rows: Vec<WorkspaceRow>,
}

impl WorkspaceMenu {
    /// The row under a point (pixels), disabled or not.
    pub(super) fn row_at(&self, x: i32, y: i32) -> Option<&WorkspaceRow> {
        self.rows.iter().find(|r| inside(&r.rect, x, y))
    }

    /// The point is in the menu's box.
    pub(super) fn contains(&self, x: i32, y: i32) -> bool {
        inside(&self.list, x, y)
    }
}

/// What a click on the open menu does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceAct {
    /// The menu stays open (a click on its padding or its divider, on a row that is off, or the first click of a reset).
    Keep,
    /// A click outside: the menu closes and nothing else happens.
    Close,
    /// A workspace, or (`None`) automatic, is chosen for the game that is open; the menu closes.
    Choose(Option<DashboardId>),
    /// Edit the layout of the workspace in use; the menu closes.
    Edit,
    /// Reset the workspace in use to its default; the menu closes.
    Reset,
}

/// The menu for a window `width` pixels wide at `scale`: under the dashboard pill, its right edge kept inside the window.
/// `manual` is the choice made by hand for the game that is open (`None`: automatic) and `in_use` the workspace on screen.
/// `None` when the window leaves no room for the dashboard pill (then there is nothing to open it from).
pub(super) fn workspace_menu(
    width: i32,
    scale: f32,
    manual: Option<DashboardId>,
    in_use: DashboardId,
    views: &Views,
) -> Option<WorkspaceMenu> {
    let anchor = dashboard_hit(width, scale)?;
    let p = |v: f32| (v * scale).round() as i32;
    let (row_h, pad) = (p(WORKSPACE_ROW_H), p(WORKSPACE_PAD));
    let (w, gap) = (p(WORKSPACE_W), p(WORKSPACE_DIVIDER_H));
    let left = anchor.left.min(width - p(S2) - w).max(p(S2));
    let top = anchor.bottom + p(6.0);
    let mut y = top + pad;
    let mut rows = Vec::new();
    let mut row = |item: WorkspaceItem, checked: bool, dotted: bool, enabled: bool, y: &mut i32| {
        rows.push(WorkspaceRow {
            item,
            checked,
            dotted,
            enabled,
            rect: rect(left + pad, *y, left + w - pad, *y + row_h),
        });
        *y += row_h;
    };
    row(WorkspaceItem::Auto, manual.is_none(), false, true, &mut y);
    for dashboard in WORKSPACE_ORDER {
        row(
            WorkspaceItem::Pick(dashboard),
            dashboard == in_use,
            views.is_modified(dashboard),
            true,
            &mut y,
        );
    }
    let line = p(1.0).max(1);
    let divider = rect(left + pad, y + (gap - line) / 2, left + w - pad, y + (gap - line) / 2 + line);
    y += gap;
    row(WorkspaceItem::Edit, false, false, true, &mut y);
    row(WorkspaceItem::Reset, false, false, views.is_modified(in_use), &mut y);
    Some(WorkspaceMenu {
        list: rect(left, top, left + w, y + pad),
        divider,
        rows,
    })
}

/// What a click at `(x, y)` does to the open menu at `now`, and the time the reset waits for its second click until (0 when it is
/// not waiting). A reset needs two clicks within `WORKSPACE_RESET_MS`: the first only arms it, the second does it; any other
/// click that is not on the reset disarms it.
pub(super) fn workspace_click(menu: &WorkspaceMenu, x: i32, y: i32, now: i64, reset_until: i64) -> (WorkspaceAct, i64) {
    if !menu.contains(x, y) {
        return (WorkspaceAct::Close, 0);
    }
    let Some(row) = menu.row_at(x, y).filter(|r| r.enabled) else {
        return (WorkspaceAct::Keep, reset_until);
    };
    match row.item {
        WorkspaceItem::Auto => (WorkspaceAct::Choose(None), 0),
        WorkspaceItem::Pick(dashboard) => (WorkspaceAct::Choose(Some(dashboard)), 0),
        WorkspaceItem::Edit => (WorkspaceAct::Edit, 0),
        WorkspaceItem::Reset if now < reset_until => (WorkspaceAct::Reset, 0),
        WorkspaceItem::Reset => (WorkspaceAct::Keep, now + WORKSPACE_RESET_MS),
    }
}

/// The part of an action that changes the per-game manual choice (the same change `D` makes): a workspace, or automatic, is set
/// for `game`. `true` when the choice was touched (so it has to be saved).
pub(super) fn workspace_apply(act: WorkspaceAct, choices: &mut Choices, game: &str) -> bool {
    match act {
        WorkspaceAct::Choose(choice) => {
            choices.set(game, choice);
            true
        }
        _ => false,
    }
}

/// The words of a row.
pub(super) fn workspace_msg(item: WorkspaceItem) -> Msg {
    match item {
        WorkspaceItem::Auto => Msg::PanelPickAuto,
        WorkspaceItem::Pick(dashboard) => dashboard.msg(),
        WorkspaceItem::Edit => Msg::PanelPickEdit,
        WorkspaceItem::Reset => Msg::PanelPickReset,
    }
}
