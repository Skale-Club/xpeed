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
    Widget {
        id: "flag",
        pane: Pane::Flag,
        needs: "the flag the game shows",
    },
    Widget {
        id: "fuel_calc",
        pane: Pane::FuelCalc,
        needs: "the fuel in the tank",
    },
    Widget {
        id: "tyre_trend",
        pane: Pane::TyreTrend,
        needs: "the tread left on the tyres",
    },
    Widget {
        id: "sectors",
        pane: Pane::Sectors,
        needs: "the sector times",
    },
    Widget {
        id: "delta_bar",
        pane: Pane::DeltaBar,
        needs: "the delta to the best lap",
    },
    Widget {
        id: "session",
        pane: Pane::Session,
        needs: "the place in the race, or the time or laps left",
    },
    Widget {
        id: "relative",
        pane: Pane::Relative,
        needs: "the other cars of the session, with how far round the lap each is",
    },
    Widget {
        id: "standings",
        pane: Pane::Standings,
        needs: "the other cars of the session, with their places",
    },
    Widget {
        id: "gaps",
        pane: Pane::Gaps,
        needs: "the other cars of the session, with their places and the gaps",
    },
    Widget {
        id: "radar",
        pane: Pane::Radar,
        needs: "the other cars' world positions, or the game's own left and right signal",
    },
    Widget {
        id: "delta_ref",
        pane: Pane::DeltaRef,
        needs: "the lap time and the distance into the lap, and a reference lap from the Xpeed server",
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
