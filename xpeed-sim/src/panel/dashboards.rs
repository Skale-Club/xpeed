//! The dashboards: which widgets the panel shows and where, as data.
//!
//! A dashboard is an id and, per window shape (`Layout`), its rows of widgets with the share of the row each takes. The
//! four built-ins use the same rows for now; they are separate so each can grow its own widgets later. Which one is on
//! screen is picked from the session (`pick`), or by hand with `D`, remembered per game in `dashboards.json`.

use super::*;
use std::collections::BTreeMap;
use std::path::Path;

use crate::lapfile::SessionKind;

/// The built-in dashboards. The ids are a contract (files and the phone name them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DashboardId {
    Race,
    Qualifying,
    Practice,
    TimeTrial,
}

impl DashboardId {
    /// In the order `D` cycles through them.
    pub(super) const ALL: [DashboardId; 4] = [
        DashboardId::Race,
        DashboardId::Qualifying,
        DashboardId::Practice,
        DashboardId::TimeTrial,
    ];

    pub(super) fn id(self) -> &'static str {
        match self {
            DashboardId::Race => "race",
            DashboardId::Qualifying => "qualifying",
            DashboardId::Practice => "practice",
            DashboardId::TimeTrial => "time_trial",
        }
    }

    pub(super) fn from_id(id: &str) -> Option<DashboardId> {
        Self::ALL.into_iter().find(|d| d.id() == id)
    }

    /// The name shown in the header.
    pub(super) fn msg(self) -> Msg {
        match self {
            DashboardId::Race => Msg::PanelDashRace,
            DashboardId::Qualifying => Msg::PanelDashQualifying,
            DashboardId::Practice => Msg::PanelDashPractice,
            DashboardId::TimeTrial => Msg::PanelDashTimeTrial,
        }
    }
}

/// A dashboard: its id and its rows for each layout.
pub(super) struct Dashboard {
    #[allow(dead_code)]
    pub(super) id: DashboardId,
    rows: fn(Layout) -> &'static [Row],
}

impl Dashboard {
    pub(super) fn rows_for(&self, layout: Layout) -> &'static [Row] {
        (self.rows)(layout)
    }
}

const RACE: Dashboard = Dashboard {
    id: DashboardId::Race,
    rows: builtin_rows,
};
const QUALIFYING: Dashboard = Dashboard {
    id: DashboardId::Qualifying,
    rows: builtin_rows,
};
const PRACTICE: Dashboard = Dashboard {
    id: DashboardId::Practice,
    rows: builtin_rows,
};
const TIME_TRIAL: Dashboard = Dashboard {
    id: DashboardId::TimeTrial,
    rows: builtin_rows,
};

/// The built-in dashboard with this id.
pub(super) fn dashboard(id: DashboardId) -> &'static Dashboard {
    match id {
        DashboardId::Race => &RACE,
        DashboardId::Qualifying => &QUALIFYING,
        DashboardId::Practice => &PRACTICE,
        DashboardId::TimeTrial => &TIME_TRIAL,
    }
}

/// Today's rows, which every built-in uses until each gets its own.
fn builtin_rows(layout: Layout) -> &'static [Row] {
    layout.default_rows()
}

/// The dashboard to show: the person's choice, else the one that fits the session. Time trial is only ever chosen by
/// hand (no game's session kind says it yet).
pub(super) fn pick(session: Option<SessionKind>, manual: Option<DashboardId>) -> DashboardId {
    manual.unwrap_or(match session {
        Some(SessionKind::Race) => DashboardId::Race,
        Some(SessionKind::Qualifying) => DashboardId::Qualifying,
        Some(SessionKind::Practice | SessionKind::Unknown) | None => DashboardId::Practice,
    })
}

/// What `D` chooses after `current`: race, qualifying, practice, time trial, then automatic.
pub(super) fn next_manual(current: Option<DashboardId>) -> Option<DashboardId> {
    match current {
        None => Some(DashboardId::ALL[0]),
        Some(d) => {
            let at = DashboardId::ALL.iter().position(|x| *x == d).unwrap_or(0);
            DashboardId::ALL.get(at + 1).copied()
        }
    }
}

/// The dashboard chosen by hand for each game (its key), kept in `dashboards.json` in the Companion's home.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Choices(BTreeMap<String, DashboardId>);

const FILE: &str = "dashboards.json";

impl Choices {
    /// Reads the file; a missing or damaged one means no choice anywhere (automatic), never an error.
    pub(super) fn load(home: &Path) -> Choices {
        let read = || -> Option<Choices> {
            let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join(FILE)).ok()?).ok()?;
            let manual = value.get("manual")?.as_object()?;
            Some(Choices(
                manual
                    .iter()
                    .filter_map(|(game, id)| Some((game.clone(), DashboardId::from_id(id.as_str()?)?)))
                    .collect(),
            ))
        };
        read().unwrap_or_default()
    }

    pub(super) fn get(&self, game: &str) -> Option<DashboardId> {
        self.0.get(game).copied()
    }

    /// Chooses (or, with `None`, goes back to automatic) for a game.
    pub(super) fn set(&mut self, game: &str, id: Option<DashboardId>) {
        match id {
            Some(id) => self.0.insert(game.to_owned(), id),
            None => self.0.remove(game),
        };
    }

    pub(super) fn save(&self, home: &Path) -> Result<(), String> {
        let manual: serde_json::Map<String, serde_json::Value> = self.0.iter().map(|(g, d)| (g.clone(), d.id().into())).collect();
        let body = serde_json::json!({ "manual": manual });
        std::fs::create_dir_all(home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
        let path = home.join(FILE);
        std::fs::write(&path, body.to_string()).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }
}
