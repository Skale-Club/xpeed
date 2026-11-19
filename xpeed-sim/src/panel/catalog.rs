//! The widget catalog: every card a dashboard can hold, by a stable id.
//!
//! The ids are a contract: dashboard files and, later, the phone view name widgets by them, so an id is never renamed
//! or reused (a test pins the list). `Pane` stays the key the painters match on; this table only gives it a name and
//! says what data it needs.

use super::*;

/// One widget of the catalog.
pub(super) struct Widget {
    /// The stable id, written in dashboard files and read by the phone.
    pub(super) id: &'static str,
    pub(super) pane: Pane,
    /// The data the widget draws from, in a line (what a game must give for it to appear).
    #[allow(dead_code)]
    pub(super) needs: &'static str,
}

/// Every widget, in the order the layouts place them.
pub(super) const ALL: &[Widget] = &[
    Widget {
        id: "times",
        pane: Pane::Times,
        needs: "lap time, last lap or best lap",
    },
    Widget {
        id: "centre",
        pane: Pane::Centre,
        needs: "gear, speed, pedals or wheel",
    },
    Widget {
        id: "fuel",
        pane: Pane::Fuel,
        needs: "fuel, water or oil temperature",
    },
    Widget {
        id: "tyres",
        pane: Pane::Tyres,
        needs: "tyre or brake temperature, pressure, wear or tread",
    },
    Widget {
        id: "laps",
        pane: Pane::Laps,
        needs: "lap time or last lap",
    },
    Widget {
        id: "track",
        pane: Pane::Track,
        needs: "the car's position or the lap's progress",
    },
    Widget {
        id: "alerts",
        pane: Pane::Alerts,
        needs: "lights, electronics settings, flags or damage",
    },
];

/// The widget with this id.
#[allow(dead_code)]
pub(super) fn by_id(id: &str) -> Option<Pane> {
    ALL.iter().find(|w| w.id == id).map(|w| w.pane)
}

/// The id of a widget.
#[allow(dead_code)]
pub(super) fn id_of(pane: Pane) -> &'static str {
    ALL.iter().find(|w| w.pane == pane).map_or("", |w| w.id)
}
