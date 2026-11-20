//! The dashboards: which widgets the panel shows and where, as data.
//!
//! A dashboard is an id and, per window shape (`Layout`), its rows of widgets with the share of the row each takes. The
//! Practice keeps the original seven cards (and, in the two wide shapes, one more row); Race, Qualifying and Hot lap (the
//! `time_trial` id) each hold their own mix of the catalog's
//! widgets (the flag, the fuel strategy, the tyre wear, the sectors, the delta bar, the session and the rivals: relative,
//! standings, gaps). The smallest window (Classic) leaves the rivals out. Which one is on screen is picked from
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
    rows: practice_rows,
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

/// Practice: the rows the panel always had (`Layout::default_rows`); the two wide shapes have one more row after them (the
/// sectors, the tyre wear and the reference lap: what a practice run is for).
fn practice_rows(layout: Layout) -> &'static [Row] {
    match layout {
        Layout::Wide => PRACTICE_WIDE,
        Layout::Ultrawide => PRACTICE_ULTRAWIDE,
        _ => layout.default_rows(),
    }
}

/// The height of Practice's extra row: a little over the tallest least height of its cards (the sectors, 228).
const PRACTICE_EXTRA_H: f32 = 232.0;

const PRACTICE_WIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 0.74),
            (Pane::Inputs, 0.56),
            (Pane::Fuel, 0.8),
            (Pane::Tyres, 1.2),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.25), (Pane::Track, 1.0), (Pane::Alerts, 1.05)],
    },
    Row {
        h: PRACTICE_EXTRA_H,
        cards: &[(Pane::Sectors, 1.0), (Pane::TyreTrend, 1.0), (Pane::DeltaRef, 1.0)],
    },
];

const PRACTICE_ULTRAWIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 0.68),
            (Pane::Inputs, 0.52),
            (Pane::Fuel, 0.85),
            (Pane::Tyres, 1.25),
            (Pane::Alerts, 1.0),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.6), (Pane::Track, 1.0)],
    },
    Row {
        h: PRACTICE_EXTRA_H,
        cards: &[(Pane::Sectors, 1.0), (Pane::TyreTrend, 1.0), (Pane::DeltaRef, 1.0)],
    },
];

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
        Layout::Classic => QUALIFYING_CLASSIC,
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

// Race: the times, the centre, the pedals, the tyres and the alerts; the rivals (relative, standings, gaps) with the session; the
// fuel strategy and the track. Owner decision 2026-11-20: no flag card (the alerts card carries the flag as a band), no tyre wear
// card (the tyres card carries the laps left on each tyre) and no radar.

const RACE_WIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.2),
            (Pane::Inputs, 0.7),
            (Pane::Tyres, 1.1),
            (Pane::Alerts, 1.0),
        ],
    },
    Row {
        h: 262.0,
        cards: &[
            (Pane::Relative, 1.2),
            (Pane::Standings, 1.3),
            (Pane::Gaps, 0.9),
            (Pane::Session, 0.8),
        ],
    },
    Row {
        h: 256.0,
        cards: &[(Pane::FuelCalc, 1.1), (Pane::Track, 1.0)],
    },
];

const RACE_ULTRAWIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.2),
            (Pane::Inputs, 0.7),
            (Pane::Tyres, 1.15),
            (Pane::Alerts, 1.0),
        ],
    },
    Row {
        h: 262.0,
        cards: &[
            (Pane::Relative, 1.2),
            (Pane::Standings, 1.3),
            (Pane::Gaps, 0.9),
            (Pane::Session, 0.8),
        ],
    },
    Row {
        h: 256.0,
        cards: &[(Pane::FuelCalc, 1.2), (Pane::Track, 1.0)],
    },
];

const RACE_SQUARE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Alerts, 0.9)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::FuelCalc, 1.2)],
    },
    Row {
        h: 250.0,
        cards: &[(Pane::Relative, 1.1), (Pane::Standings, 1.3), (Pane::Gaps, 0.9)],
    },
    Row {
        h: 232.0,
        cards: &[(Pane::Session, 0.8), (Pane::Track, 1.0)],
    },
];

const RACE_CLASSIC: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Alerts, 0.9), (Pane::Session, 0.8)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::FuelCalc, 1.2), (Pane::Track, 0.8)],
    },
];

// A phone held upright: what a race needs most, so the canvas stays short enough to read (the track is on the bigger layouts).
const RACE_PORTRAIT: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 220.0,
        cards: &[(Pane::Session, 1.0), (Pane::Alerts, 1.0)],
    },
    Row {
        h: 244.0,
        cards: &[(Pane::Relative, 1.0)],
    },
    Row {
        h: 200.0,
        cards: &[(Pane::Gaps, 1.0)],
    },
    Row {
        h: 242.0,
        cards: &[(Pane::Standings, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::FuelCalc, 0.9), (Pane::Tyres, 1.1)],
    },
];

const RACE_STACK: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 170.0,
        cards: &[(Pane::Session, 1.0)],
    },
    Row {
        h: 244.0,
        cards: &[(Pane::Relative, 1.0)],
    },
    Row {
        h: 200.0,
        cards: &[(Pane::Gaps, 1.0)],
    },
    Row {
        h: 242.0,
        cards: &[(Pane::Standings, 1.0)],
    },
    Row {
        h: 280.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 300.0,
        cards: &[(Pane::Alerts, 1.0)],
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
        h: 210.0,
        cards: &[(Pane::Track, 1.0)],
    },
];

// Qualifying: the times, the sectors, the delta bar and the reference lap, the session, the centre, the tyres, the track and the flag
// (the flag is not on the wide window's second row: the reference card has its place).

const QUALIFYING_WIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.1),
            (Pane::Inputs, 0.65),
            (Pane::Sectors, 1.15),
            (Pane::Tyres, 1.1),
        ],
    },
    Row {
        h: 262.0,
        cards: &[
            (Pane::DeltaBar, 1.3),
            (Pane::DeltaRef, 1.0),
            (Pane::Standings, 1.2),
            (Pane::Session, 0.8),
        ],
    },
];

const QUALIFYING_ULTRAWIDE: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.1),
            (Pane::Inputs, 0.65),
            (Pane::Sectors, 1.15),
            (Pane::Tyres, 1.1),
            (Pane::Flag, 0.8),
        ],
    },
    Row {
        h: 262.0,
        cards: &[
            (Pane::DeltaBar, 1.5),
            (Pane::DeltaRef, 1.0),
            (Pane::Standings, 1.3),
            (Pane::Session, 0.9),
            (Pane::Track, 1.0),
        ],
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
        h: 242.0,
        cards: &[
            (Pane::DeltaBar, 1.1),
            (Pane::DeltaRef, 1.0),
            (Pane::Standings, 1.4),
            (Pane::Session, 0.9),
        ],
    },
];

const QUALIFYING_PORTRAIT: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 170.0,
        cards: &[(Pane::Session, 1.0)],
    },
    Row {
        h: 242.0,
        cards: &[(Pane::Standings, 1.0)],
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
        h: 160.0,
        cards: &[(Pane::DeltaRef, 1.0)],
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
        h: 170.0,
        cards: &[(Pane::Session, 1.0)],
    },
    Row {
        h: 242.0,
        cards: &[(Pane::Standings, 1.0)],
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
        h: 160.0,
        cards: &[(Pane::DeltaRef, 1.0)],
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
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.1),
            (Pane::Inputs, 0.65),
            (Pane::Sectors, 1.15),
            (Pane::Tyres, 1.1),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.0), (Pane::DeltaRef, 1.0), (Pane::Track, 0.9)],
    },
];

const TIME_TRIAL_ULTRAWIDE: &[Row] = &[
    Row {
        h: 140.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 300.0,
        cards: &[
            (Pane::Times, 1.0),
            (Pane::Centre, 1.1),
            (Pane::Inputs, 0.65),
            (Pane::Sectors, 1.15),
            (Pane::Tyres, 1.1),
        ],
    },
    Row {
        h: 262.0,
        cards: &[(Pane::Laps, 2.3), (Pane::DeltaRef, 1.0), (Pane::Track, 1.0)],
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
        cards: &[(Pane::Tyres, 1.1), (Pane::DeltaRef, 1.0), (Pane::Track, 0.9)],
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
        h: 160.0,
        cards: &[(Pane::DeltaRef, 1.0)],
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
        h: 160.0,
        cards: &[(Pane::DeltaRef, 1.0)],
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

/// Qualifying in the smallest window (Classic): four cards over three, the session beside the sectors.
const QUALIFYING_CLASSIC: &[Row] = &[
    Row {
        h: 300.0,
        cards: &[(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Sectors, 1.3), (Pane::Session, 0.8)],
    },
    Row {
        h: 230.0,
        cards: &[(Pane::Tyres, 1.2), (Pane::DeltaBar, 1.3), (Pane::Track, 0.8)],
    },
];

/// Time trial in the smallest window (Classic): three cards over three, the delta bar among them.
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

/// The dashboard to show: the person's choice, else the one that fits the session. A hot lap or time attack (the
/// game's `time_trial`) gets Hot lap, though its session kind is practice.
pub(super) fn pick(session: Option<SessionKind>, time_trial: bool, manual: Option<DashboardId>) -> DashboardId {
    manual.unwrap_or(match session {
        _ if time_trial => DashboardId::TimeTrial,
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

/// The whole file as a JSON object; empty when it is missing, damaged or not an object.
pub(super) fn read_file(home: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(home.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// Replaces one key of the file and keeps every other (the manual choices and the saved views are written by different
/// parts of the panel). Written to a `.part` file that then takes the file's place, so a reader never sees half a file.
pub(super) fn write_key(home: &Path, key: &str, value: serde_json::Value) -> Result<(), String> {
    let mut file = read_file(home);
    file.insert(key.to_owned(), value);
    std::fs::create_dir_all(home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    let (path, part) = (home.join(FILE), home.join(format!("{FILE}.part")));
    std::fs::write(&part, serde_json::Value::Object(file).to_string()).map_err(|e| format!("cannot write {}: {e}", part.display()))?;
    std::fs::rename(&part, &path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

impl Choices {
    /// Reads the file; a missing or damaged one means no choice anywhere (automatic), never an error.
    pub(super) fn load(home: &Path) -> Choices {
        let file = read_file(home);
        let manual = file.get("manual").and_then(|m| m.as_object());
        Choices(
            manual
                .map(|manual| {
                    manual
                        .iter()
                        .filter_map(|(game, id)| Some((game.clone(), DashboardId::from_id(id.as_str()?)?)))
                        .collect()
                })
                .unwrap_or_default(),
        )
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
        write_key(home, "manual", serde_json::Value::Object(manual))
    }
}

// The phone view's own layouts: how each dashboard sits on a phone held upright and on one on its side. The Companion draws the
// panel itself with them (its header, its cards, its fonts: nothing of the look changes) and sends the picture (`relay`). Not a
// `Layout`: the PC never picks them for its window. Each is sized so that, scaled to the phone's screen, the panel's smallest text
// is still about 9 px; what does not fit at that size is left out.

/// How the phone is held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PhoneShape {
    Upright,
    Sideways,
}

impl PhoneShape {
    #[cfg(test)]
    pub(super) const ALL: [PhoneShape; 2] = [PhoneShape::Upright, PhoneShape::Sideways];

    /// The shape of a screen `w` x `h`: on its side when wider than tall.
    pub(super) fn of(w: f32, h: f32) -> PhoneShape {
        if w > h {
            PhoneShape::Sideways
        } else {
            PhoneShape::Upright
        }
    }

    /// The canvas width in design units: upright, one column (pairs of the narrow cards), as wide as Stack; on its side, one row
    /// of four cards, each about as wide as on the PC's wide window (the panel's cards need it: the fuel strategy's table, the
    /// times).
    pub(super) fn width(self) -> f32 {
        match self {
            PhoneShape::Upright => 400.0,
            PhoneShape::Sideways => 1100.0,
        }
    }

    /// The room a phone gives the picture, in CSS pixels: a 390 x 844 phone with the page's header and margins taken off.
    #[cfg(test)]
    pub(super) fn room(self) -> (f32, f32) {
        match self {
            PhoneShape::Upright => (374.0, 737.0),
            PhoneShape::Sideways => (828.0, 330.0),
        }
    }
}

/// The least scale a phone layout is shown at in that room: the panel's caption (12 units) at about 9 px.
#[cfg(test)]
pub(super) const PHONE_MIN_SCALE: f32 = 0.75;

/// The rows of a dashboard on the phone, held as `shape` says.
pub(super) fn phone_shape_rows(id: DashboardId, shape: PhoneShape) -> &'static [Row] {
    match (id, shape) {
        (DashboardId::Race, PhoneShape::Upright) => RACE_PHONE_UPRIGHT,
        (DashboardId::Qualifying, PhoneShape::Upright) => QUALIFYING_PHONE_UPRIGHT,
        (DashboardId::TimeTrial, PhoneShape::Upright) => TIME_TRIAL_PHONE_UPRIGHT,
        (DashboardId::Practice, PhoneShape::Upright) => PRACTICE_PHONE_UPRIGHT,
        (DashboardId::Race, PhoneShape::Sideways) => RACE_PHONE_SIDEWAYS,
        (DashboardId::Qualifying, PhoneShape::Sideways) => QUALIFYING_PHONE_SIDEWAYS,
        (DashboardId::TimeTrial, PhoneShape::Sideways) => TIME_TRIAL_PHONE_SIDEWAYS,
        (DashboardId::Practice, PhoneShape::Sideways) => PRACTICE_PHONE_SIDEWAYS,
    }
}

// Upright: the times and the place, the flag, the cars around, the gear.
const RACE_PHONE_UPRIGHT: &[Row] = &[
    Row {
        h: 220.0,
        cards: &[(Pane::Times, 1.0), (Pane::Session, 1.0)],
    },
    Row {
        h: 110.0,
        cards: &[(Pane::Flag, 1.0)],
    },
    Row {
        h: 244.0,
        cards: &[(Pane::Relative, 1.0)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Centre, 1.0)],
    },
];

const QUALIFYING_PHONE_UPRIGHT: &[Row] = &[
    Row {
        h: 210.0,
        cards: &[(Pane::Times, 1.0), (Pane::Session, 1.0)],
    },
    Row {
        h: 130.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 228.0,
        cards: &[(Pane::Sectors, 1.0)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Centre, 1.0)],
    },
];

const TIME_TRIAL_PHONE_UPRIGHT: &[Row] = &[
    Row {
        h: 130.0,
        cards: &[(Pane::DeltaBar, 1.0)],
    },
    Row {
        h: 210.0,
        cards: &[(Pane::Times, 1.0), (Pane::DeltaRef, 1.0)],
    },
    Row {
        h: 228.0,
        cards: &[(Pane::Sectors, 1.0)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Centre, 1.0)],
    },
];

// Practice upright: the panel's fuel card needs the whole width; the tyres are on the sideways layout.
const PRACTICE_PHONE_UPRIGHT: &[Row] = &[
    Row {
        h: 230.0,
        cards: &[(Pane::Times, 1.0)],
    },
    Row {
        h: 190.0,
        cards: &[(Pane::Fuel, 1.0)],
    },
    Row {
        h: 260.0,
        cards: &[(Pane::Centre, 1.0)],
    },
    Row {
        h: 124.0,
        cards: &[(Pane::Laps, 1.0)],
    },
];

// On its side: one row of cards under the panel's header.
// Race on its side: no room for a fifth card at a size the panel's cards read at; the flag is on the upright layout.
const RACE_PHONE_SIDEWAYS: &[Row] = &[Row {
    h: 280.0,
    cards: &[
        (Pane::Times, 1.05),
        (Pane::Centre, 0.85),
        (Pane::Relative, 0.95),
        (Pane::FuelCalc, 1.15),
    ],
}];

const QUALIFYING_PHONE_SIDEWAYS: &[Row] = &[Row {
    h: 280.0,
    cards: &[(Pane::Times, 1.0), (Pane::DeltaBar, 1.0), (Pane::Centre, 1.0), (Pane::Sectors, 1.0)],
}];

const TIME_TRIAL_PHONE_SIDEWAYS: &[Row] = &[Row {
    h: 280.0,
    cards: &[(Pane::DeltaBar, 1.0), (Pane::Times, 1.0), (Pane::Centre, 1.0), (Pane::Sectors, 1.0)],
}];

const PRACTICE_PHONE_SIDEWAYS: &[Row] = &[Row {
    h: 280.0,
    cards: &[(Pane::Times, 1.0), (Pane::Centre, 0.8), (Pane::Fuel, 1.0), (Pane::Tyres, 1.2)],
}];
