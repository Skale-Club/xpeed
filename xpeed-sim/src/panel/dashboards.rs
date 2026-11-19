//! The dashboards: which widgets the panel shows and where, as data.
//!
//! A dashboard is an id and, per window shape (`Layout`), its rows of widgets with the share of the row each takes. The
//! Practice keeps the original seven cards; Race, Qualifying and Time trial each hold their own mix of the catalog's
//! widgets (the flag, the fuel strategy, the tyre wear, the sectors, the delta bar). Which one is on screen is picked from
//! the session (`pick`), or by hand with `D`, remembered per game in `dashboards.json`.

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
    rows: race_rows,
};
const QUALIFYING: Dashboard = Dashboard {
    id: DashboardId::Qualifying,
    rows: qualifying_rows,
};
const PRACTICE: Dashboard = Dashboard {
    id: DashboardId::Practice,
    rows: builtin_rows,
};
const TIME_TRIAL: Dashboard = Dashboard {
    id: DashboardId::TimeTrial,
    rows: time_trial_rows,
};

/// The built-in dashboard with this id.
pub(super) fn builtin(id: DashboardId) -> &'static Dashboard {
    match id {
        DashboardId::Race => &RACE,
        DashboardId::Qualifying => &QUALIFYING,
        DashboardId::Practice => &PRACTICE,
        DashboardId::TimeTrial => &TIME_TRIAL,
    }
}

/// Practice: the rows the panel always had.
fn builtin_rows(layout: Layout) -> &'static [Row] {
    layout.default_rows()
}

fn race_rows(layout: Layout) -> &'static [Row] {
    match layout {
        Layout::Classic => RACE_CLASSIC,
        Layout::Ultrawide => RACE_ULTRAWIDE,
        Layout::Wide => RACE_WIDE,
        Layout::Square => RACE_SQUARE,
        Layout::Portrait => RACE_PORTRAIT,
        Layout::Stack => RACE_STACK,
    }
}

fn qualifying_rows(layout: Layout) -> &'static [Row] {
    match layout {
        Layout::Classic => FLYING_CLASSIC,
        Layout::Ultrawide => QUALIFYING_ULTRAWIDE,
        Layout::Wide => QUALIFYING_WIDE,
        Layout::Square => QUALIFYING_SQUARE,
        Layout::Portrait => QUALIFYING_PORTRAIT,
        Layout::Stack => QUALIFYING_STACK,
    }
}

fn time_trial_rows(layout: Layout) -> &'static [Row] {
    match layout {
        Layout::Classic => FLYING_CLASSIC,
        Layout::Ultrawide => TIME_TRIAL_ULTRAWIDE,
        Layout::Wide => TIME_TRIAL_WIDE,
        Layout::Square => TIME_TRIAL_SQUARE,
        Layout::Portrait => TIME_TRIAL_PORTRAIT,
        Layout::Stack => TIME_TRIAL_STACK,
    }
}

// Race: the times, the centre, the flag, the tyres; the fuel strategy, the tyre wear, the track and the alerts.

const RACE_WIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Flag, 0.8), (Pane::Tyres, 1.05)],
    },
    Row {
        h: 262.0,
        cards: &[
            (Pane::FuelCalc, 1.1),
            (Pane::TyreTrend, 1.1),
            (Pane::Track, 1.0),
            (Pane::Alerts, 1.0),
        ],
    },
];

const RACE_ULTRAWIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.2),
            (Pane::Flag, 0.8),
            (Pane::Tyres, 1.1),
            (Pane::Alerts, 1.0),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::FuelCalc, 1.2), (Pane::TyreTrend, 1.2), (Pane::Track, 1.0)],
    },
];

const RACE_SQUARE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Flag, 0.8)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::FuelCalc, 1.2), (Pane::TyreTrend, 1.2)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Track, 1.0), (Pane::Alerts, 1.0)],
    },
];

const RACE_CLASSIC: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Flag, 0.8)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::FuelCalc, 1.2), (Pane::Track, 0.8)],
    },
];

const RACE_PORTRAIT: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 120.0,
        cards: &[(Pane::Flag, 1.0)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::FuelCalc, 0.9), (Pane::Tyres, 1.1)],
    },
    Row {
        h: 230.0,
        cards: &[(Pane::TyreTrend, 1.0), (Pane::Track, 1.0)],
    },
    Row {
        h: 240.0,
        cards: &[(Pane::Alerts, 1.0)],
    },
];

const RACE_STACK: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 120.0,
        cards: &[(Pane::Flag, 1.0)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::FuelCalc, 1.0)],
    },
    Row {
        h: 270.0,
        cards: &[(Pane::Tyres, 1.0)],
    },
    Row {
        h: 230.0,
        cards: &[(Pane::TyreTrend, 1.0)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Track, 1.0)],
    },
    Row {
        h: 240.0,
        cards: &[(Pane::Alerts, 1.0)],
    },
];

// Qualifying: the times, the sectors, the delta bar, the centre, the tyres, the track and the flag.

const QUALIFYING_WIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.1), (Pane::Sectors, 1.15), (Pane::Tyres, 1.1)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::DeltaBar, 2.25), (Pane::Track, 1.0), (Pane::Flag, 1.05)],
    },
];

const QUALIFYING_ULTRAWIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.1),
            (Pane::Sectors, 1.15),
            (Pane::Tyres, 1.1),
            (Pane::Flag, 0.8),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::DeltaBar, 2.6), (Pane::Track, 1.0)],
    },
];

const QUALIFYING_SQUARE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Sectors, 1.2)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::Track, 1.0), (Pane::Flag, 0.9)],
    },
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
];

const QUALIFYING_PORTRAIT: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Sectors, 1.0)],
    },
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 250.0,
        cards: &[(Pane::Tyres, 1.1), (Pane::Flag, 0.9)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Track, 1.0)],
    },
];

const QUALIFYING_STACK: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Sectors, 1.0)],
    },
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 270.0,
        cards: &[(Pane::Tyres, 1.0)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Track, 1.0)],
    },
    Row {
        h: 120.0,
        cards: &[(Pane::Flag, 1.0)],
    },
];

// Time trial: the delta bar on top, then the times, the sectors, the centre, the tyres, the laps and the track.

const TIME_TRIAL_WIDE: &[Row] = &[
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.1), (Pane::Sectors, 1.15), (Pane::Tyres, 1.1)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.25), (Pane::Track, 1.0)],
    },
];

const TIME_TRIAL_ULTRAWIDE: &[Row] = &[
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.1), (Pane::Sectors, 1.15), (Pane::Tyres, 1.1)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.6), (Pane::Track, 1.0)],
    },
];

const TIME_TRIAL_SQUARE: &[Row] = &[
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Sectors, 1.2)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::Track, 1.0)],
    },
    Row {
        h: 206.0,
        cards: &[(Pane::Laps, 1.0)],
    },
];

const TIME_TRIAL_PORTRAIT: &[Row] = &[
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Sectors, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 250.0,
        cards: &[(Pane::Tyres, 1.1), (Pane::Track, 0.9)],
    },
    Row {
        h: 200.0,
        cards: &[(Pane::Laps, 1.0)],
    },
];

const TIME_TRIAL_STACK: &[Row] = &[
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Sectors, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 270.0,
        cards: &[(Pane::Tyres, 1.0)],
    },
    Row {
        h: 200.0,
        cards: &[(Pane::Laps, 1.0)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Track, 1.0)],
    },
];

/// Qualifying and Time trial in the smallest window (Classic): three cards over three, the delta bar among them.
const FLYING_CLASSIC: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Sectors, 1.3)],
    },
    Row {
        h: 230.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::DeltaBar, 1.3), (Pane::Track, 0.8)],
    },
];

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
