use super::*;

/// `1:42.318` for seconds; nothing when there is none (the caller then draws nothing).
pub(super) fn lap_clock(s: Option<f64>) -> Option<String> {
    s.filter(|s| s.is_finite() && *s >= 0.0).map(|s| clock((s * 1000.0).round() as u32))
}

/// `+0.421` or `-1.074`; nothing when there is none.
pub(super) fn delta_text(d: Option<f64>) -> Option<String> {
    d.filter(|d| d.is_finite())
        .map(|d| format!("{}{:.3}", if d < 0.0 { "-" } else { "+" }, d.abs()))
}

/// The gears either side of `gear` (R, N, 1, 2, ...) at rest: the one below and the one above (see `gear_places`).
/// There is nothing below reverse, and nothing above the top gear when the car's forward gear count (`gears`) is known;
/// when it is not, there is always one above a forward gear.
#[cfg(test)]
pub(super) fn neighbour_gears(gear: f32, gears: Option<u8>) -> (Option<String>, Option<String>) {
    let places = gear_places(gear, gears, None, 0);
    let at = |place: f32| places.iter().find(|(_, p)| *p == place).map(|(text, _)| text.clone());
    (at(-1.0), at(1.0))
}

/// The gears on the carousel's track (see `DashModel::gear_track`): the track stands on `gear`, or, for
/// `GEAR_SLIDE_MS` after a shift (`shift`: the gear before it and when it was seen), on its way there, easing out. A gear
/// is on it while it is less than one and a half places from where the track stands. There is nothing below reverse,
/// and nothing above the top gear when the car's forward gear count (`gears`) is known.
pub(super) fn gear_places(gear: f32, gears: Option<u8>, shift: Option<(f32, i64)>, now_ms: i64) -> Vec<(String, f32)> {
    if !gear.is_finite() {
        return Vec::new();
    }
    let to = gear.round();
    // A shift slides one place even when the reader went through neutral or skipped a gear (4, N, 5 is 4 to 5 on
    // screen, not a spin through 1, 2 and 3); a reading stamped a hair ahead of the panel's clock starts the slide.
    let at = match shift {
        Some((from, since)) if from != to && now_ms - since < GEAR_SLIDE_MS => {
            let from = if (to - from).abs() > 1.0 { to - (to - from).signum() } else { from };
            let t = (now_ms - since).max(0) as f32 / GEAR_SLIDE_MS as f32;
            from + (to - from) * (1.0 - (1.0 - t).powi(3))
        }
        _ => to,
    };
    let exists = |g: i32| g == to as i32 || (g >= -1 && (g < 1 || gears.is_none_or(|count| g <= i32::from(count))));
    let (low, high) = (at.min(to).floor() as i32 - 1, at.max(to).ceil() as i32 + 1);
    (low..=high)
        .filter(|&g| exists(g))
        .map(|g| (gear_text(g as f32), g as f32 - at))
        .filter(|(_, place)| place.abs() < 1.5)
        .collect()
}

pub(super) fn gear_text(gear: f32) -> String {
    match gear {
        g if !g.is_finite() => "–".to_owned(),
        g if g < -0.5 => "R".to_owned(),
        g if g < 0.5 => "N".to_owned(),
        g => format!("{}", g.round() as i32),
    }
}

/// How many shift lights are lit at `share` of the top RPM, and whether they flash (time to shift).
pub(super) fn lights_lit(share: f32) -> (usize, bool) {
    if !share.is_finite() {
        return (0, false);
    }
    if share >= SHIFT_AT {
        return (LIGHTS, true);
    }
    let lit = ((share - LIGHTS_FROM) / (SHIFT_AT - LIGHTS_FROM) * LIGHTS as f32).floor();
    (lit.clamp(0.0, LIGHTS as f32) as usize, false)
}

/// The fastest lap that counted, in milliseconds; an invalid lap is never the fastest.
pub(super) fn fastest_valid(laps: &[SavedLap]) -> Option<u32> {
    laps.iter().filter(|l| l.valid).map(|l| l.time_ms).min()
}

/// The track map is drawn once the car has driven enough of a path.
pub(super) fn has_map(live: &Live) -> bool {
    live.map.as_ref().is_some_and(|m| m.len() >= 30)
}

/// Under this many laps of fuel, while driving, the fuel warns.
pub(super) const FUEL_LOW_LAPS: f32 = 2.0;

/// The fuel to show: nothing when the game gives none, and nothing for a 0 taken while the car is not driving (in the
/// menu or the garage some games drop their fuel reading to 0).
pub(super) fn fuel_reading(live: &Live) -> Option<f32> {
    Some(live.fuel_l).filter(|f| f.is_finite() && (live.driving || *f > 0.0))
}

/// The laps of fuel left at the car's use per lap; nothing until the use per lap is known.
pub(super) fn fuel_laps_left(fuel_l: f32, per_lap_l: Option<f32>) -> Option<f32> {
    let per = per_lap_l.filter(|p| p.is_finite() && *p > 0.0)?;
    fuel_l.is_finite().then(|| fuel_l.max(0.0) / per)
}

/// How full the tank is, 0..1, against its size (the biggest the tank is known to be, never less than the fuel).
pub(super) fn fuel_share(fuel: f32, tank: Option<f32>) -> Option<f32> {
    let tank = tank.filter(|t| t.is_finite() && *t > 0.0)?;
    (fuel.is_finite() && fuel >= 0.0).then(|| (fuel / tank.max(fuel)).clamp(0.0, 1.0))
}

/// How far the wheel is turned, -1 (full left) to 1 (full right); straight without a value.
pub(super) fn steer_share(steer: f32) -> f32 {
    if steer.is_finite() {
        steer.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PillKind {
    Pit,
    Abs,
    Tc,
    Drs,
    Headlights,
    Fuel,
    Engine,
    Handbrake,
    Flag,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Glow {
    Off,
    On,
    /// DRS allowed but not open: an outline in the light's colour.
    Ready,
}

/// The Account card's headline when connected: who, or just "Connected" while the account is not known (never the host).
pub(super) fn connected_line(lang: Lang, who: Option<&str>) -> String {
    match who {
        Some(who) => text(lang, &Msg::ConnectedAs(who.to_owned())),
        None => text(lang, &Msg::ConnectedPlain),
    }
}

/// `HH:MM:SS` on this computer's clock for a Unix time in ms.
pub(super) fn local_time(unix_ms: i64) -> String {
    // FILETIME counts 100 ns since 1601-01-01.
    let ticks = (unix_ms.max(0) as u64 + 11_644_473_600_000) * 10_000;
    let file = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    unsafe {
        let mut utc: SYSTEMTIME = std::mem::zeroed();
        let mut local: SYSTEMTIME = std::mem::zeroed();
        if FileTimeToSystemTime(&file, &mut utc) == 0 || SystemTimeToTzSpecificLocalTime(null(), &utc, &mut local) == 0 {
            return String::new();
        }
        format!("{:02}:{:02}:{:02}", local.wHour, local.wMinute, local.wSecond)
    }
}

/// The game list for the monitor: Le Mans Ultimate, then each reader, with the best state any of its games reports.
/// The games list: one line per reader, only for games installed here (all of them when none was found, and always
/// a game that is running). A line for several games names only those installed ("ACC · AC Rally"), and a single one
/// by its full name.
pub(super) fn game_rows(ctx: &Context, installed: Option<&HashSet<&'static str>>) -> Vec<GameRow> {
    let reported = ctx.shared.games();
    let rank = |g: &Game| match g {
        Game::Recording(_) => 4,
        Game::Connected => 3,
        Game::Unsupported => 3,
        Game::Paused => 2,
        Game::Silent | Game::Loading => 1,
        Game::Waiting => 0,
    };
    let state_of = |ids: &[&str]| {
        reported
            .iter()
            .filter(|(id, _, _)| ids.contains(id))
            .map(|(_, _, g)| g.clone())
            .max_by_key(rank)
            .unwrap_or(Game::Waiting)
    };
    let lines = std::iter::once(("Le Mans Ultimate".to_owned(), vec!["lmu"])).chain(ctx.readers.iter().cloned());
    lines
        .filter_map(|(title, ids)| {
            let state = state_of(&ids);
            let here: Vec<&'static str> = match installed {
                Some(set) if !set.is_empty() => ids.iter().copied().filter(|id| set.contains(id)).collect(),
                _ => ids.clone(),
            };
            if here.is_empty() && matches!(state, Game::Waiting) {
                return None;
            }
            let here = if here.is_empty() { ids.clone() } else { here };
            Some(GameRow {
                key: here[0],
                title: line_title(&title, &ids, &here),
                state,
            })
        })
        .collect()
}

/// The title of a line for the games `here` among the reader's `ids` (its title naming them in order, "A · B · C").
pub(super) fn line_title(title: &str, ids: &[&'static str], here: &[&'static str]) -> String {
    let parts: Vec<&str> = title.split(" \u{b7} ").collect();
    if parts.len() != ids.len() || here.len() == ids.len() {
        return title.to_owned();
    }
    if let [only] = here {
        if let Some((_, name)) = crate::covers::GAMES.iter().find(|(key, _)| key == only) {
            return (*name).to_owned();
        }
    }
    ids.iter()
        .zip(&parts)
        .filter(|(id, _)| here.contains(id))
        .map(|(_, part)| *part)
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

/// An activity as a message of the person's language.
/// The colour of an activity's dot in the Monitor (owner-approved module 10, 2026-11-19): green a lap saved, amber a lap
/// not valid or something to do, blue a connection, red what failed, grey the rest.
pub(super) fn activity_tone(event: &Activity) -> Role {
    match event {
        Activity::Notice(Notice::LapSaved(lap)) if lap.valid => Role::Good,
        Activity::Notice(Notice::LapSaved(_) | Notice::NeedsSetup { .. }) | Activity::WorkerRestarting(_) => Role::Warn,
        Activity::GameConnected(_) | Activity::Notice(Notice::Paired(_) | Notice::LapsSent(_)) => Role::Info,
        Activity::GameUnsupported(_) | Activity::WorkerFailed(_) => Role::Danger,
        Activity::Notice(Notice::Refused | Notice::UpdateBlocked(_)) => Role::Danger,
        _ => Role::Muted,
    }
}

pub(super) fn activity_message(event: Activity) -> Msg {
    match event {
        Activity::GameConnected(name) => Msg::ActivityGameConnected(name.to_owned()),
        Activity::GameClosed(name) => Msg::ActivityGameClosed(name.to_owned()),
        Activity::GameUnsupported(name) => Msg::ActivityGameUnsupported(name.to_owned()),
        Activity::WorkerRestarting(id) => Msg::ActivityWorkerRestarting(crate::supervisor::title(id).to_owned()),
        Activity::WorkerFailed(id) => Msg::ActivityWorkerFailed(crate::supervisor::title(id).to_owned()),
        Activity::Notice(Notice::LapSaved(lap)) => Msg::NoticeLapSaved(lap),
        Activity::Notice(Notice::LapsSent(n)) => Msg::NoticeLapsSent(n),
        Activity::Notice(Notice::Paired(name)) => Msg::NoticePaired(name),
        Activity::Notice(Notice::NotPaired) => Msg::CloudNotPaired,
        Activity::Notice(Notice::Refused) => Msg::NoticeRefused,
        Activity::Notice(Notice::Updated(version)) => Msg::NoticeUpdated(version),
        Activity::Notice(Notice::UpdateBlocked(version)) => Msg::NoticeUpdateBlocked(version),
        Activity::Notice(Notice::UpToDate(version)) => Msg::NoticeUpToDate(version),
        Activity::Notice(Notice::UpdateCheckFailed) => Msg::NoticeUpdateCheckFailed,
        Activity::Notice(Notice::NeedsSetup { id, name }) => Msg::NoticeNeedsSetup(id, name),
    }
}

// The dashboard view model: WHAT the dashboard shows, decided from a `Live` (what the game gives: `caps`; what it is
// doing: `phase`; what was last seen) and nothing else. No pixels, no fonts, no positions: the views (`dash_view.rs`)
// only draw it, and the layout (`layout.rs`) is chosen from the game's caps, never from which value is there now.
//
// The rules, per element:
//
// * An element the game never gives (not in `caps`) is `Hidden`.
// * "Live" readings (gear, speed, revs, pedals, wheel, alerts) are `Shown` only while the car is being driven and the
//   frames keep coming. Paused, in a menu or the garage, or with no frames for a while, they are `Dimmed` (the last
//   gear seen, never a stale "R").
// * "Slow" readings (fuel, tyres, temperatures, the electronics' settings, damage) are `Shown` while the frame carries
//   them; when it does not, the last value seen is kept `Dimmed`. With no frames at all, everything is `Dimmed`.
// * A record of a finished lap (last lap, best lap, the delta to the best) that does not exist yet (the first lap) is
//   `Hidden`, but its place stays: nothing moves when it appears.
// * Every value is written in the units the person picked (`Units`): the readers' metric values are turned here and
//   nowhere else.

/// How an element is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Show {
    Shown,
    /// There, but not live: drawn quiet, so it reads as "last known".
    Dimmed,
    Hidden,
}

/// The meaning of a colour; the views map it to a token (`Role::colour`, in `paint.rs`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Role {
    #[default]
    Text,
    Muted,
    Primary,
    Good,
    Danger,
    Warn,
    Best,
    Info,
    /// A cold tyre.
    Cold,
}

/// One element of the dashboard: its label, its value as text, its unit, its meaning and how it is shown. A gauge also
/// has its share (`frac`: 0..1, or -1..1 for the wheel; 0 when it has none).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Elem {
    pub(super) show: Show,
    pub(super) role: Role,
    pub(super) label: String,
    /// The label in fewer letters, for where the full one does not fit.
    pub(super) short: String,
    pub(super) text: String,
    pub(super) unit: &'static str,
    pub(super) frac: f32,
}

impl Default for Elem {
    fn default() -> Elem {
        Elem::hidden()
    }
}

impl Elem {
    pub(super) fn hidden() -> Elem {
        Elem {
            show: Show::Hidden,
            role: Role::Text,
            label: String::new(),
            short: String::new(),
            text: String::new(),
            unit: "",
            frac: 0.0,
        }
    }

    fn with(show: Show, role: Role, text: impl Into<String>) -> Elem {
        Elem {
            show,
            role,
            text: text.into(),
            ..Elem::hidden()
        }
    }

    fn labelled(mut self, label: String) -> Elem {
        self.label = label;
        self
    }

    fn short(mut self, short: String) -> Elem {
        self.short = short;
        self
    }

    fn unit(mut self, unit: &'static str) -> Elem {
        self.unit = unit;
        self
    }

    fn frac(mut self, frac: f32) -> Elem {
        self.frac = frac;
        self
    }

    /// Drawn at all (shown or dimmed).
    pub(super) fn visible(&self) -> bool {
        self.show != Show::Hidden
    }
}

/// What the line over the dashboard's right corner says about the state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StatusKind {
    /// No frames for a while, the game still connected: everything shows its last value, dimmed.
    NoData,
    Pits,
    Paused,
    NotDriving,
}

/// The box over a dashboard that is paused or whose game has gone silent: a title and one line of explanation.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Banner {
    pub(super) kind: StatusKind,
    pub(super) title: String,
    pub(super) note: String,
}

/// A light of the lights card: its kind (for its colour), whether it is off, on or ready, the words it says and how it is
/// shown. Every light the game can give is in the model, lit or not, so each keeps its place.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Light {
    pub(super) kind: PillKind,
    pub(super) glow: Glow,
    pub(super) flag: Option<crate::game::Flag>,
    pub(super) word: String,
    pub(super) show: Show,
}

/// A readout: a small caps label over a figure.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Cell {
    pub(super) label: String,
    pub(super) value: String,
    pub(super) role: Role,
    pub(super) show: Show,
    /// How far towards its limit the value is (0..1), for a bar of blocks under it; none for a plain readout.
    pub(super) frac: Option<f32>,
}

/// One of the fuel card's use numbers: a small caps label, the figure, and a short note in its own colour (owner-approved
/// module 6, 2026-11-19).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct FuelStat {
    pub(super) label: String,
    pub(super) value: String,
    pub(super) note: String,
    pub(super) note_role: Role,
}

/// The fuel card's stint planner: how much fuel a run of so many laps takes at the average use, against what is in
/// the car, and how far a full tank goes (owner-approved module 6, 2026-11-19).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct FuelPlanner {
    pub(super) title: String,
    /// `at 2.90 L/lap`.
    pub(super) at: String,
    /// What the run is, what it needs, and the colour of that.
    pub(super) rows: Vec<(String, String, Role)>,
}

/// Where a tyre's temperature is, against what a racing tyre likes (°C, a guide: each game and compound has its own
/// window).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TyreState {
    Cold,
    Ok,
    Hot,
    Over,
}

/// Under this the tyre is cold, under the next it is in its window, under the last it is hot, from there it is over.
pub(super) const TYRE_COLD_BELOW: f32 = 65.0;
pub(super) const TYRE_HOT_FROM: f32 = 95.0;
pub(super) const TYRE_OVER_FROM: f32 = 105.0;

impl TyreState {
    /// Nothing without a temperature.
    pub(super) fn of(temp_c: f32) -> Option<TyreState> {
        match temp_c {
            t if !t.is_finite() => None,
            t if t < TYRE_COLD_BELOW => Some(TyreState::Cold),
            t if t < TYRE_HOT_FROM => Some(TyreState::Ok),
            t if t < TYRE_OVER_FROM => Some(TyreState::Hot),
            _ => Some(TyreState::Over),
        }
    }

    pub(super) fn role(self) -> Role {
        match self {
            TyreState::Cold => Role::Cold,
            TyreState::Ok => Role::Good,
            TyreState::Hot => Role::Warn,
            TyreState::Over => Role::Danger,
        }
    }

    fn msg(self) -> Msg {
        match self {
            TyreState::Cold => Msg::PanelTyreCold,
            TyreState::Ok => Msg::PanelTyreOk,
            TyreState::Hot => Msg::PanelTyreHot,
            TyreState::Over => Msg::PanelTyreOver,
        }
    }
}

/// One tyre's tile: its corner and state, the temperature big, the temperatures across the tread when the game gives
/// them, and the small row under them.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct TyreTile {
    pub(super) corner: String,
    /// The state as a word (empty without a temperature).
    pub(super) word: String,
    pub(super) role: Role,
    pub(super) temp: String,
    /// The colour of the tyre's temperature (`heat_colour`), for the big number.
    pub(super) heat: COLORREF,
    /// The tyre drawn from above, left to right as it sits on the car: three bands (outer, middle, inner on a left
    /// tyre; inner, middle, outer on a right one) when the game gives the tread, one block otherwise.
    pub(super) shape: TyreShape,
    /// The three readings across the tread as drawn (left to right), each with its colour.
    pub(super) tread_text: Option<[(String, COLORREF); 3]>,
    /// The pressure and its unit.
    pub(super) pressure: Option<(String, &'static str)>,
    pub(super) brake: Option<String>,
    /// How much of the tread is left, 0..1.
    pub(super) wear: Option<f32>,
}

/// A tyre seen from above, in the colours of its temperatures. Owner decision 2026-11-19: only the tyre (no car), three
/// vertical bands for a game that gives the readings across the tread (`Caps::TYRE_TREAD`), a solid block otherwise.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum TyreShape {
    Solid(COLORREF),
    /// Left to right as drawn.
    Bands([COLORREF; 3]),
}

/// The four tyres: what is shown, and the tiles (made from the last values seen when the frame has none).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct TyresModel {
    pub(super) show: Show,
    pub(super) tiles: [TyreTile; 4],
    pub(super) title: String,
    pub(super) compound: Option<String>,
    /// The word before a brake's temperature.
    pub(super) brake_label: String,
}

/// What a row of the laps table is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LapKind {
    /// The lap being driven.
    Live,
    Done,
    /// The fastest lap that counted.
    Best,
    /// A lap that did not count.
    Invalid,
}

/// One row of the laps table: texts and the meaning of their colours.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct LapRow {
    pub(super) kind: LapKind,
    pub(super) show: Show,
    pub(super) number: String,
    pub(super) time: String,
    pub(super) time_role: Role,
    pub(super) gap: String,
    pub(super) gap_role: Role,
    /// How far behind the best lap a lap done was, 0..1 of `LAP_GAP_FULL_S`: a short bar beside its gap.
    pub(super) gap_bar: Option<f32>,
    /// Sector 1, 2 and 3: nothing for a sector not done yet.
    pub(super) sectors: [Option<(String, Role)>; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct LapsModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// The column heads: lap, time, gap.
    pub(super) heads: [String; 3],
    /// The game gives sector times: S1, S2, S3 have their columns.
    pub(super) sectors: bool,
    /// Newest first: the lap being driven, then the ones done.
    pub(super) rows: Vec<LapRow>,
    /// What the table says while it has no row.
    pub(super) empty: String,
}

/// Everything the dashboard shows.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct DashModel {
    pub(super) status: Option<(StatusKind, String)>,
    /// The banner over the cards: only while paused or while the game is silent (the other states keep the state line).
    pub(super) banner: Option<Banner>,
    pub(super) track: String,
    pub(super) car: String,
    /// The session's name for the chip next to the track (nothing when the game does not say).
    pub(super) session: Option<String>,
    pub(super) lap: Elem,
    /// The lap being driven will not count.
    pub(super) invalid: bool,
    /// The revs against the top seen (`frac`): the rev bar and the shift lights.
    pub(super) rev: Elem,
    pub(super) lap_time: Elem,
    pub(super) last_lap: Elem,
    pub(super) best_lap: Elem,
    /// The delta to the best lap as a signed number of seconds (`frac`: where its bar's fill ends).
    pub(super) delta: Elem,
    /// `vs best`, beside the delta.
    pub(super) delta_vs: String,
    /// On the first lap, where the delta will be: why it is not there yet.
    pub(super) delta_note: Option<String>,
    /// `Projected 1:46.934`: the best lap plus the delta now, while there is a delta.
    pub(super) projected: Option<String>,
    /// This lap's highest and lowest speed in the panel's unit, for the centre card's corners.
    pub(super) lap_top: Option<String>,
    pub(super) lap_min: Option<String>,
    /// The inputs card's caption, whether the game marks ABS and TC on its trace, and this lap's time flat out, braking
    /// and on neither pedal (`62%`), each with its word.
    pub(super) inputs_title: String,
    pub(super) aids: (bool, bool),
    pub(super) lap_share: Option<[(String, String); 3]>,
    pub(super) gear: Elem,
    /// The gears on the centre card's track at this instant: each one's text and its place, 0 the middle, -1 and 1 the
    /// edges (the gears either side), in between while a shift slides (owner, 2026-11-19).
    pub(super) gear_track: Vec<(String, f32)>,
    pub(super) speed: Elem,
    /// A pedal: its name (and a short one), the percentage as its text and the share as `frac`.
    pub(super) brake: Elem,
    pub(super) throttle: Elem,
    pub(super) clutch: Elem,
    pub(super) steer: Elem,
    /// The title of the card that holds the fuel: "Fuel", or "Engine" when the game gives only temperatures.
    pub(super) fuel_title: String,
    /// The fuel in the tank, the number (its `unit` is the litres' or gallons').
    pub(super) fuel: Elem,
    /// How full the tank is (0..1), when the tank's size is known.
    pub(super) fuel_share: Option<f32>,
    /// One lap's fuel as a share of the gauge: the distance between its ticks.
    pub(super) fuel_tick: Option<f32>,
    /// The laps the fuel lasts, the number (its `label` is the word after it) in the colour of how pressing it is.
    pub(super) fuel_laps: Elem,
    /// `of 60 L`.
    pub(super) fuel_tank: Elem,
    /// `2.6 L per lap · each tick = 1 lap`.
    pub(super) fuel_per_lap: Elem,
    /// `~24 min`: how long the fuel left lasts at the recent lap time.
    pub(super) fuel_minutes: Option<String>,
    /// The average use a lap, the last lap against it, and this lap so far (those the run knows).
    pub(super) fuel_stats: Vec<FuelStat>,
    pub(super) fuel_planner: Option<FuelPlanner>,
    pub(super) fuel_low: bool,
    /// The water and the oil, when the game gives them.
    pub(super) engine: Vec<Cell>,
    /// The share of the lap done (`frac`), and the distance.
    pub(super) progress: Elem,
    pub(super) distance: Elem,
    pub(super) alerts_title: String,
    /// Every light the game can give, in a fixed order, lit or not.
    pub(super) alerts: Vec<Light>,
    pub(super) no_alerts: String,
    /// The driver's settings: TC, ABS, engine map, brake bias.
    pub(super) electronics: Vec<Cell>,
    /// `Damage: none`, or the parts that are hurt.
    pub(super) damage: Elem,
    pub(super) tyres: Option<TyresModel>,
    pub(super) laps: LapsModel,
    pub(super) map: Show,
    pub(super) map_title: String,
}

/// What the model needs besides the reading.
#[derive(Clone, Copy, Debug)]
pub(super) struct ModelCtx<'a> {
    pub(super) lang: Lang,
    pub(super) now_ms: i64,
    pub(super) units: crate::config::Units,
    /// The laps that were saved, oldest first (the laps table's rows).
    pub(super) laps: &'a [SavedLap],
}

/// A reading older than this is not live.
pub(super) fn fresh(live: &Live, now_ms: i64) -> bool {
    now_ms - live.at_ms <= STALE_MS
}

fn finite(v: f32) -> Option<f32> {
    Some(v).filter(|v| v.is_finite())
}

// Units: the readers give metres per second, °C, kPa and litres; these write them as the person asked.

/// The speed as a whole number.
pub(super) fn speed_text(ms: f32, unit: crate::config::SpeedUnit) -> String {
    use crate::config::SpeedUnit;
    let v = match unit {
        SpeedUnit::Kmh => ms * 3.6,
        SpeedUnit::Mph => ms * 2.236_936,
    };
    format!("{v:.0}")
}

/// A temperature in `unit`.
pub(super) fn temp_in(c: f32, unit: crate::config::TempUnit) -> f32 {
    match unit {
        crate::config::TempUnit::C => c,
        crate::config::TempUnit::F => c * 9.0 / 5.0 + 32.0,
    }
}

/// `92 °C`.
pub(super) fn temp_text(c: f32, unit: crate::config::TempUnit) -> String {
    format!("{:.0} {}", temp_in(c, unit), unit.label())
}

/// `84°`: a tile's figure, the unit left to the tile's other texts.
pub(super) fn temp_short(c: f32, unit: crate::config::TempUnit) -> String {
    format!("{:.0}°", temp_in(c, unit))
}

/// `84`: one of the readings across a tread, a bare number (the big figure above it has the degree).
pub(super) fn temp_number(c: f32, unit: crate::config::TempUnit) -> String {
    format!("{:.0}", temp_in(c, unit))
}

/// A tyre's pressure and its unit: psi with a decimal, bar with two, kPa whole.
pub(super) fn pressure_text(kpa: f32, unit: crate::config::PressureUnit) -> (String, &'static str) {
    use crate::config::PressureUnit;
    let number = match unit {
        PressureUnit::Psi => format!("{:.1}", kpa / 6.894_757),
        PressureUnit::Bar => format!("{:.2}", kpa / 100.0),
        PressureUnit::Kpa => format!("{kpa:.0}"),
    };
    (number, unit.label())
}

/// Litres in `unit` (US gallons).
pub(super) fn fuel_in(litres: f32, unit: crate::config::FuelUnit) -> f32 {
    match unit {
        crate::config::FuelUnit::Litre => litres,
        crate::config::FuelUnit::Gallon => litres / 3.785_412,
    }
}

/// The fuel as a number with a decimal.
pub(super) fn fuel_text(litres: f32, unit: crate::config::FuelUnit) -> String {
    format!("{:.1}", fuel_in(litres, unit))
}

/// A fuel use, a lap's worth or less, with two decimals: `2.90`.
pub(super) fn fuel_use_text(litres: f32, unit: crate::config::FuelUnit) -> String {
    format!("{:.2}", fuel_in(litres, unit))
}

/// The tank's size, with its unit: `60 L` (whole when it is), `15.9 gal`.
pub(super) fn tank_text(litres: f32, unit: crate::config::FuelUnit) -> String {
    let v = fuel_in(litres, unit);
    let whole = (v - v.round()).abs() < 0.05;
    format!("{} {}", if whole { format!("{v:.0}") } else { format!("{v:.1}") }, unit.label())
}

/// Under this many laps of fuel, while driving, the fuel is pressing (amber); under `FUEL_LOW_LAPS` it is critical.
pub(super) const FUEL_PRESSING_LAPS: f32 = 5.0;

/// The colour of the fuel left by the laps it lasts: green, amber under five laps and red under two, while driving;
/// green otherwise (a reading taken in the menu never warns).
pub(super) fn fuel_role(laps: Option<f32>, driving: bool) -> Role {
    match laps {
        Some(n) if driving && n < FUEL_LOW_LAPS => Role::Danger,
        Some(n) if driving && n < FUEL_PRESSING_LAPS => Role::Warn,
        _ => Role::Good,
    }
}

fn heat_role(temp_c: f32, warm: f32, hot: f32) -> Role {
    if temp_c >= hot {
        Role::Danger
    } else if temp_c >= warm {
        Role::Warn
    } else {
        Role::Text
    }
}

/// One tyre's tile.
fn tyre_tile(lang: Lang, units: crate::config::Units, index: usize, t: &crate::game::Tyre) -> TyreTile {
    let state = TyreState::of(t.temp_c);
    // `tread_c` is inner, middle, outer; inner faces the car's centre, so a left tyre (FL, RL) shows it on its right.
    let left_side = index.is_multiple_of(2);
    let drawn = t.tread_c.map(|[inner, middle, outer]| {
        if left_side {
            [outer, middle, inner]
        } else {
            [inner, middle, outer]
        }
    });
    let heat = heat_colour(t.temp_c);
    let shape = match drawn {
        Some(points) => TyreShape::Bands(points.map(heat_colour)),
        None => TyreShape::Solid(heat),
    };
    let reading = |c: f32| (temp_number(c, units.temperature), heat_colour(c));
    TyreTile {
        heat,
        shape,
        tread_text: drawn.map(|points| points.map(reading)),
        corner: text(lang, &Msg::PanelTyreCorner(index as u8)),
        word: state.map_or_else(String::new, |s| text(lang, &s.msg())),
        role: state.map_or(Role::Muted, TyreState::role),
        temp: if t.temp_c.is_finite() {
            temp_short(t.temp_c, units.temperature)
        } else {
            "–".to_owned()
        },
        pressure: t.pressure_kpa.is_finite().then(|| pressure_text(t.pressure_kpa, units.pressure)),
        brake: t.brake_c.is_finite().then(|| temp_short(t.brake_c, units.temperature)),
        wear: t.left.is_finite().then(|| t.left.clamp(0.0, 1.0)),
    }
}

/// A sector or lap time in seconds with its thousandths: `27.811`.
pub(super) fn sector_text(ms: u32) -> String {
    format!("{:.3}", f64::from(ms) / 1000.0)
}

/// The laps table: the lap being driven first, then the laps saved, newest first. The fastest lap that counted says
/// "best", the others their gap to it (and how far behind, for a bar); a lap that did not count says so. Sectors take the
/// timing colours: purple the fastest of any lap that counted, green faster than the best lap there, yellow slower.
fn laps_model(live: &Live, ctx: &ModelCtx, slots: &Slots, fresh: bool, lap_time: &Elem, delta: &Elem) -> LapsModel {
    let lang = ctx.lang;
    let say = |msg: Msg| text(lang, &msg);
    let saved = ctx.laps;
    let best_ms = fastest_valid(saved)
        .into_iter()
        .chain(
            live.best_lap_s
                .filter(|s| s.is_finite() && *s > 0.0)
                .map(|s| (s * 1000.0).round() as u32),
        )
        .min();
    let best_sector: [Option<u32>; 3] =
        std::array::from_fn(|i| saved.iter().filter(|l| l.valid).filter_map(|l| l.sectors_ms.get(i).copied()).min());
    // The sectors of the best lap, to say where another lap was faster (green) or slower (yellow) than it.
    let best_lap_sector: [Option<u32>; 3] = std::array::from_fn(|i| {
        let best_lap = best_ms.and_then(|best| saved.iter().find(|l| l.valid && l.time_ms == best));
        best_lap.and_then(|l| l.sectors_ms.get(i).copied())
    });
    // Timing colours (owner-approved module 4, 2026-11-19): purple the fastest sector of any lap that counted, green
    // faster than the best lap there, yellow slower; with nothing to compare, `plain`.
    let sector_role = |i: usize, ms: u32, plain: Role| -> Role {
        match (best_sector[i], best_lap_sector[i]) {
            (Some(best), _) if ms <= best => Role::Best,
            (_, Some(lap)) if ms < lap => Role::Good,
            (_, Some(lap)) if ms > lap => Role::Warn,
            _ => plain,
        }
    };
    let steady = if fresh { Show::Shown } else { Show::Dimmed };
    let mut rows = Vec::new();
    // The lap being driven: only while there is a lap to number (not in a menu).
    if slots.lap_time && (live.driving || live.phase == crate::game::Phase::Paused) {
        let sectors = std::array::from_fn(|i| {
            let done = live.sectors_ms.get(i).copied().flatten();
            done.map(|ms| (sector_text(ms), sector_role(i, ms, Role::Primary)))
        });
        rows.push(LapRow {
            kind: LapKind::Live,
            show: if fresh && live.driving { Show::Shown } else { Show::Dimmed },
            number: live.lap.max(1).to_string(),
            time: if lap_time.visible() && live.lap_time_s.is_some() {
                lap_time.text.clone()
            } else {
                "–".to_owned()
            },
            time_role: Role::Primary,
            gap: if delta.visible() { delta.text.clone() } else { "–".to_owned() },
            gap_role: if delta.visible() { delta.role } else { Role::Muted },
            gap_bar: None,
            sectors,
        });
    }
    for lap in saved.iter().rev() {
        let kind = match (lap.valid, best_ms) {
            (false, _) => LapKind::Invalid,
            (true, Some(best)) if lap.time_ms == best => LapKind::Best,
            _ => LapKind::Done,
        };
        let (gap, gap_role) = match (kind, best_ms) {
            (LapKind::Invalid, _) => (say(Msg::PanelInvalid), Role::Danger),
            (LapKind::Best, _) => (say(Msg::PanelBestLap), Role::Best),
            (_, Some(best)) => (format!("+{:.3}", f64::from(lap.time_ms.saturating_sub(best)) / 1000.0), Role::Muted),
            (_, None) => ("–".to_owned(), Role::Muted),
        };
        // A lap that did not count is never coloured: it sets nothing.
        let sectors = std::array::from_fn(|i| {
            lap.sectors_ms.get(i).map(|&ms| {
                let role = if kind == LapKind::Invalid {
                    Role::Text
                } else {
                    sector_role(i, ms, Role::Text)
                };
                (sector_text(ms), role)
            })
        });
        // How far behind the best: a short bar of blocks, full at `LAP_GAP_FULL_S`.
        let gap_bar = match (kind, best_ms) {
            (LapKind::Done, Some(best)) => {
                let behind = f64::from(lap.time_ms.saturating_sub(best)) / 1000.0;
                Some((behind / f64::from(LAP_GAP_FULL_S)).clamp(0.0, 1.0) as f32)
            }
            _ => None,
        };
        rows.push(LapRow {
            kind,
            show: steady,
            number: lap.number.to_string(),
            time: clock(lap.time_ms),
            time_role: match kind {
                LapKind::Best => Role::Best,
                LapKind::Invalid => Role::Muted,
                _ => Role::Text,
            },
            gap,
            gap_role,
            gap_bar,
            sectors,
        });
    }
    LapsModel {
        show: if slots.lap_time || slots.last { steady } else { Show::Hidden },
        title: say(Msg::PanelRecentLaps),
        heads: [say(Msg::PanelColLap), say(Msg::PanelColTime), say(Msg::PanelColGap)],
        sectors: slots.sectors,
        rows,
        empty: say(Msg::PanelNoLapsYet),
    }
}

/// The dashboard model for a reading. Pure: the same reading, laps, language, units and time always give the same model.
pub(super) fn dashboard(live: &Live, ctx: &ModelCtx) -> DashModel {
    use crate::game::{Caps, Drs};
    let (lang, units) = (ctx.lang, ctx.units);
    let slots = slots(live.caps);
    let caps = live.caps;
    let seen = &live.last_seen;
    let fresh = fresh(live, ctx.now_ms);
    // The car is being driven and frames are coming: the live readings are live.
    let live_now = fresh && live.driving;
    // The lap clock and the distance mean something while driving and while paused (the car is on the track).
    let timing = fresh && (live.driving || live.phase == crate::game::Phase::Paused);
    let say = |msg: Msg| text(lang, &msg);
    let reading = |on: bool, present: bool| if on && present { Show::Shown } else { Show::Dimmed };

    let status = if !fresh {
        Some((StatusKind::NoData, say(Msg::PanelNoGameData)))
    } else if live.in_pits {
        Some((StatusKind::Pits, say(Msg::PanelPits)))
    } else if live.phase == crate::game::Phase::Paused {
        Some((StatusKind::Paused, say(Msg::PanelPaused)))
    } else if !live.driving {
        Some((StatusKind::NotDriving, say(Msg::PanelNotDriving)))
    } else {
        None
    };

    let banner = match &status {
        Some((StatusKind::Paused, title)) => Some(Banner {
            kind: StatusKind::Paused,
            title: title.to_uppercase(),
            note: say(Msg::PanelPausedNote),
        }),
        Some((StatusKind::NoData, title)) => Some(Banner {
            kind: StatusKind::NoData,
            title: title.to_uppercase(),
            note: say(Msg::PanelNoGameDataNote),
        }),
        _ => None,
    };

    let lap = if live.driving && fresh {
        Elem::with(Show::Shown, Role::Primary, say(Msg::PanelLap(live.lap)).to_uppercase())
    } else if live.phase == crate::game::Phase::Paused || (!fresh && live.driving) {
        Elem::with(Show::Dimmed, Role::Primary, say(Msg::PanelLap(live.lap)).to_uppercase())
    } else {
        Elem::hidden()
    };

    let session = match live.session_kind {
        Some(crate::game::SessionKind::Practice) => Some(say(Msg::PanelSessionPractice)),
        Some(crate::game::SessionKind::Qualifying) => Some(say(Msg::PanelSessionQualifying)),
        Some(crate::game::SessionKind::Race) => Some(say(Msg::PanelSessionRace)),
        Some(crate::game::SessionKind::Unknown) | None => None,
    };

    // The live readings.
    let rpm_share = (live.rpm_top > 0.0).then(|| live.rpm / live.rpm_top).filter(|s| s.is_finite());
    let rev = if slots.rev {
        Elem::with(reading(live_now, rpm_share.is_some()), Role::Text, "").frac(rpm_share.unwrap_or(0.0))
    } else {
        Elem::hidden()
    };
    let gear_now = finite(live.gear);
    let gear_val = gear_now.or(seen.gear);
    let gear_show = reading(live_now, gear_now.is_some());
    let gear = if slots.gear {
        Elem::with(gear_show, Role::Primary, gear_val.map_or_else(|| "–".to_owned(), gear_text))
    } else {
        Elem::hidden()
    };
    let shift = live.gear_shift.filter(|_| gear_now.is_some());
    let gear_track = match gear_val.filter(|_| slots.gear) {
        Some(g) => gear_places(g, live.gears, shift, ctx.now_ms),
        None => Vec::new(),
    };
    let speed_now = finite(live.speed_ms);
    let speed = if slots.speed {
        let value = speed_now
            .or(seen.speed_ms)
            .map_or_else(|| "–".to_owned(), |v| speed_text(v, units.speed));
        Elem::with(reading(live_now, speed_now.is_some()), Role::Text, value).unit(units.speed.label())
    } else {
        Elem::hidden()
    };
    let pedal = |on: bool, value: f32, name: Msg, short: Msg, role: Role| {
        if !on {
            return Elem::hidden();
        }
        let v = finite(value);
        let share = v.unwrap_or(0.0).clamp(0.0, 1.0);
        Elem::with(
            reading(live_now, v.is_some()),
            role,
            if v.is_some() {
                format!("{:.0}%", share * 100.0)
            } else {
                "–".to_owned()
            },
        )
        .labelled(say(name))
        .short(say(short))
        .frac(share)
    };
    let brake = pedal(slots.brake, live.brake, Msg::PanelBrake, Msg::PanelBrakeShort, Role::Danger);
    let throttle = pedal(
        slots.throttle,
        live.throttle,
        Msg::PanelThrottle,
        Msg::PanelThrottleShort,
        Role::Good,
    );
    let clutch = pedal(slots.clutch, live.clutch, Msg::PanelClutch, Msg::PanelClutchShort, Role::Info);
    let steer = if slots.steer {
        Elem::with(reading(live_now, live.steer.is_finite()), Role::Primary, "").frac(steer_share(live.steer))
    } else {
        Elem::hidden()
    };

    // The lap's times. A record that does not exist yet is hidden, its place kept.
    let record = |on: bool, text: Option<String>, role: Role, msg: Msg| match (on, text) {
        (true, Some(t)) => Elem::with(if fresh { Show::Shown } else { Show::Dimmed }, role, t).labelled(say(msg)),
        _ => Elem::hidden(),
    };
    let lap_time = if slots.lap_time {
        let t = lap_clock(live.lap_time_s);
        Elem::with(reading(timing, t.is_some()), Role::Text, t.unwrap_or_else(|| "–:––.–––".to_owned())).labelled(say(Msg::PanelLapTime))
    } else {
        Elem::hidden()
    };
    let last_lap = record(slots.last, lap_clock(live.last_lap_s), Role::Text, Msg::PanelLastLap);
    let best_lap = record(slots.best, lap_clock(live.best_lap_s), Role::Best, Msg::PanelBestLap);
    let delta = match (slots.delta, delta_text(live.delta_s)) {
        (true, Some(t)) => {
            let role = if live.delta_s.is_some_and(|d| d < 0.0) {
                Role::Good
            } else {
                Role::Danger
            };
            let frac = 0.5 + (live.delta_s.unwrap_or(0.0).clamp(-1.0, 1.0) as f32) / 2.0;
            Elem::with(reading(live_now, true), role, t).frac(frac)
        }
        _ => Elem::hidden(),
    };
    // Before there is a best lap to compare with, the delta's place says when it will come.
    let delta_note = (slots.delta && !delta.visible() && !best_lap.visible()).then(|| say(Msg::PanelDeltaFirstLap));
    // This lap's highest and lowest speed, for the centre card's corners.
    let lap_speed = live.lap_speed_ms.filter(|_| slots.speed);
    // The lap time this lap is heading for: the best lap plus the delta now (owner-approved module 5, 2026-11-19).
    let projected = match (delta.visible(), live.best_lap_s, live.delta_s) {
        (true, Some(best), Some(d)) => lap_clock(Some(best + d)).map(|t| say(Msg::PanelProjected(t))),
        _ => None,
    };

    // Fuel.
    let fuel_now = fuel_reading(live);
    let fuel_val = fuel_now.or(seen.fuel_l);
    let fuel_show = if fresh && fuel_now.is_some() { Show::Shown } else { Show::Dimmed };
    let laps_left_val = fuel_val.and_then(|f| fuel_laps_left(f, live.fuel_per_lap_l));
    let low = live_now && laps_left_val.is_some_and(|n| n < FUEL_LOW_LAPS);
    let role = fuel_role(laps_left_val, live_now);
    let per_lap = live.fuel_per_lap_l.filter(|p| p.is_finite() && *p > 0.0);
    let fuel = if slots.fuel {
        Elem::with(
            fuel_show,
            Role::Text,
            fuel_val.map_or_else(|| "–".to_owned(), |f| fuel_text(f, units.fuel)),
        )
        .labelled(say(Msg::PanelFuel))
        .unit(units.fuel.label())
    } else {
        Elem::hidden()
    };
    let fuel_laps = match (slots.fuel, laps_left_val) {
        (true, Some(n)) => Elem::with(fuel_show, role, format!("{n:.1}")).labelled(say(Msg::PanelLapsWord)),
        _ => Elem::hidden(),
    };
    let share = fuel_val.and_then(|f| fuel_share(f, live.fuel_tank_l));
    // The gauge's full scale is the tank (never less than the fuel); a tick is one lap's use of it.
    let scale = fuel_val.zip(live.fuel_tank_l).map(|(f, t)| t.max(f));
    let fuel_tick = per_lap
        .zip(scale)
        .map(|(p, s)| p / s)
        .filter(|t| t.is_finite() && *t > 0.0 && share.is_some());
    let fuel_tank = match (slots.fuel, live.fuel_tank_l.filter(|t| t.is_finite() && *t > 0.0)) {
        (true, Some(t)) => Elem::with(
            if fresh { Show::Shown } else { Show::Dimmed },
            Role::Muted,
            say(Msg::PanelOfTank(tank_text(t, units.fuel))),
        ),
        _ => Elem::hidden(),
    };
    let fuel_per_lap = match (slots.fuel, per_lap) {
        (true, Some(per)) => {
            let amount = format!("{} {}", fuel_text(per, units.fuel), units.fuel.label());
            let line = if fuel_tick.is_some() {
                Msg::PanelFuelPerLapTick(amount)
            } else {
                Msg::PanelFuelPerLapPlain(amount)
            };
            Elem::with(if fresh { Show::Shown } else { Show::Dimmed }, Role::Muted, say(line))
        }
        _ => Elem::hidden(),
    };

    // The fuel card's use numbers, minutes and stint planner (owner-approved module 6, 2026-11-19).
    let amount = |l: f32| fuel_use_text(l, units.fuel);
    let with_unit = |l: f32| format!("{} {}", fuel_text(l, units.fuel), units.fuel.label());
    let mut fuel_stats = Vec::new();
    if slots.fuel {
        if let Some(avg) = per_lap {
            fuel_stats.push(FuelStat {
                label: say(Msg::FuelAvgLap),
                value: amount(avg),
                note: String::new(),
                note_role: Role::Muted,
            });
            if let Some(last) = live.fuel_last_lap_l.filter(|l| l.is_finite() && *l > 0.0) {
                let diff = last - avg;
                // Under the average: green with a minus; over it: red with a plus.
                let (sign, note_role) = if diff < 0.0 { ('-', Role::Good) } else { ('+', Role::Danger) };
                let note = if diff.abs() < 0.005 {
                    String::new()
                } else {
                    format!("{sign}{}", amount(diff.abs()))
                };
                fuel_stats.push(FuelStat {
                    label: say(Msg::FuelLastLap),
                    value: amount(last),
                    note,
                    note_role,
                });
            }
        }
        if let Some(this) = live.fuel_this_lap_l.filter(|l| l.is_finite() && *l >= 0.0) {
            let note = match (live.dist_m, live.track_length_m) {
                (Some(d), Some(l)) if l > 0.0 => format!("{:.0}%", (d / l).clamp(0.0, 1.0) * 100.0),
                _ => String::new(),
            };
            fuel_stats.push(FuelStat {
                label: say(Msg::FuelThisLap),
                value: amount(this),
                note,
                note_role: Role::Muted,
            });
        }
    }
    let lap_s = live.last_lap_s.or(live.best_lap_s).filter(|s| s.is_finite() && *s > 0.0);
    let fuel_minutes = match (slots.fuel, laps_left_val, lap_s) {
        (true, Some(laps), Some(lap)) => Some(say(Msg::FuelMinutes(format!("{:.0}", f64::from(laps) * lap / 60.0)))),
        _ => None,
    };
    let tank_l = live.fuel_tank_l.filter(|t| t.is_finite() && *t > 0.0);
    let fuel_planner = match (slots.fuel, per_lap, fuel_val, tank_l) {
        (true, Some(per), Some(have), Some(tank)) => {
            let mut rows: Vec<(String, String, Role)> = FUEL_PLAN_LAPS
                .iter()
                .map(|&laps| {
                    let need = per * laps as f32;
                    let (value, role) = if need <= have {
                        (say(Msg::FuelYouHaveIt(with_unit(need))), Role::Good)
                    } else {
                        let role = if need > tank { Role::Warn } else { Role::Text };
                        (say(Msg::FuelAdd(with_unit(need), with_unit(need - have))), role)
                    };
                    (say(Msg::FuelPlanLaps(laps)), value, role)
                })
                .collect();
            let full = format!("{:.1} {}", tank / per, say(Msg::PanelLapsWord));
            rows.push((say(Msg::FuelFullTank), full, Role::Text));
            Some(FuelPlanner {
                title: say(Msg::FuelPlanTitle),
                at: say(Msg::FuelPlanAt(with_unit(per))),
                rows,
            })
        }
        _ => None,
    };

    // The water and oil, in the fuel card.
    let temp_cell = |on: bool, now: Option<f32>, last: Option<f32>, msg: Msg, warm: f32, hot: f32| {
        on.then(|| {
            let t = now.filter(|t| t.is_finite());
            let val = t.or(last);
            Cell {
                label: say(msg),
                value: val.map_or_else(|| "–".to_owned(), |t| temp_text(t, units.temperature)),
                role: val.map_or(Role::Muted, |t| heat_role(t, warm, hot)),
                show: if fresh && t.is_some() { Show::Shown } else { Show::Dimmed },
                frac: val.map(|t| (t / hot).clamp(0.0, 1.0)),
            }
        })
    };
    let s = &live.state;
    let mut engine = Vec::new();
    engine.extend(temp_cell(slots.water, s.water_c, seen.water_c, Msg::PanelWater, 105.0, 115.0));
    engine.extend(temp_cell(slots.oil, s.oil_c, seen.oil_c, Msg::PanelOil, 130.0, 145.0));

    // Where in the lap.
    let (progress, distance) = match (slots.progress, live.dist_m, live.track_length_m) {
        (true, Some(d), Some(l)) if l > 0.0 => {
            let p = (d / l).clamp(0.0, 1.0) as f32;
            let show = if timing { Show::Shown } else { Show::Dimmed };
            (
                Elem::with(show, Role::Text, say(Msg::PanelPercentOfLap(format!("{:.0}%", p * 100.0)))).frac(p),
                Elem::with(show, Role::Muted, format!("{:.0} / {:.0} m", d.clamp(0.0, l), l)),
            )
        }
        _ => (Elem::hidden(), Elem::hidden()),
    };

    // The lights: every light the game can give, always in the same order and place (owner decision 2026-11-19), off
    // with its name, on in its colour, ready (DRS allowed) outlined. A light the game cannot give is not there at all;
    // one it can give and has no value for now is off.
    let mut alerts = Vec::new();
    let mut alert = |kind: PillKind, glow: Glow, flag: Option<crate::game::Flag>, word: Msg, present: bool| {
        alerts.push(Light {
            kind,
            glow,
            flag,
            word: say(word),
            show: reading(live_now, present),
        });
    };
    let lit = |on: bool| if on { Glow::On } else { Glow::Off };
    // The word of a light: what it says when lit, its plain name when off.
    // Every light says its short name, lit or not: the colour says it is on (a long word would not fit its tile).
    if caps.has(Caps::PIT_LIMITER) {
        alert(
            PillKind::Pit,
            lit(s.pit_limiter == Some(true)),
            None,
            Msg::AlertPit,
            s.pit_limiter.is_some(),
        );
    }
    if caps.has(Caps::ABS_ACTIVE) {
        alert(
            PillKind::Abs,
            lit(s.abs_active == Some(true)),
            None,
            Msg::AlertAbs,
            s.abs_active.is_some(),
        );
    }
    if caps.has(Caps::TC_ACTIVE) {
        alert(
            PillKind::Tc,
            lit(s.tc_active == Some(true)),
            None,
            Msg::AlertTc,
            s.tc_active.is_some(),
        );
    }
    if caps.has(Caps::DRS) {
        let glow = match s.drs {
            Some(Drs::Open) => Glow::On,
            Some(Drs::Available) => Glow::Ready,
            _ => Glow::Off,
        };
        alert(PillKind::Drs, glow, None, Msg::LightDrs, s.drs.is_some());
    }
    if caps.has(Caps::HEADLIGHTS) {
        alert(
            PillKind::Headlights,
            lit(s.headlights == Some(true)),
            None,
            Msg::AlertHeadlights,
            s.headlights.is_some(),
        );
    }
    if caps.has(Caps::FUEL) {
        alert(PillKind::Fuel, lit(low), None, Msg::AlertFuel, laps_left_val.is_some());
    }
    if caps.has(Caps::ENGINE_WARNING) {
        alert(
            PillKind::Engine,
            lit(s.engine_warning == Some(true)),
            None,
            Msg::AlertEngine,
            s.engine_warning.is_some(),
        );
    }
    if caps.has(Caps::HANDBRAKE) {
        alert(
            PillKind::Handbrake,
            lit(s.handbrake == Some(true)),
            None,
            Msg::AlertHandbrake,
            s.handbrake.is_some(),
        );
    }
    if caps.has(Caps::FLAG) {
        if let Some(flag) = s.flag {
            let word = match flag {
                crate::game::Flag::Green => Msg::PanelFlagGreen,
                crate::game::Flag::Yellow => Msg::PanelFlagYellow,
                crate::game::Flag::Blue => Msg::PanelFlagBlue,
                crate::game::Flag::White => Msg::PanelFlagWhite,
                crate::game::Flag::Black => Msg::PanelFlagBlack,
                crate::game::Flag::Chequered => Msg::PanelFlagChequered,
            };
            alert(PillKind::Flag, Glow::On, Some(flag), word, true);
        } else {
            alert(PillKind::Flag, Glow::Off, None, Msg::LightFlag, true);
        }
    }

    // The electronics and the damage.
    let level = |n: u8| if n == 0 { "OFF".to_owned() } else { n.to_string() };
    let mut electronics = Vec::new();
    let mut setting = |on: bool, label: String, value: Option<String>| {
        if on {
            electronics.push(Cell {
                label,
                show: if fresh && value.is_some() { Show::Shown } else { Show::Dimmed },
                value: value.unwrap_or_else(|| "–".to_owned()),
                role: Role::Text,
                frac: None,
            });
        }
    };
    setting(caps.has(Caps::TC_LEVEL), "TC".to_owned(), s.tc_level.map(level));
    setting(caps.has(Caps::ABS_LEVEL), "ABS".to_owned(), s.abs_level.map(level));
    setting(caps.has(Caps::ENGINE_MAP), "MAP".to_owned(), s.engine_map.map(|n| n.to_string()));
    setting(
        caps.has(Caps::BRAKE_BIAS),
        say(Msg::PanelBias),
        s.brake_bias
            .filter(|b| b.is_finite())
            .map(|b| format!("{:.1} %", b.clamp(0.0, 1.0) * 100.0)),
    );
    let parts: Vec<(Msg, Option<f32>)> = [
        (Caps::DAMAGE_BODY, Msg::PanelDmgBody, s.damage_body),
        (Caps::DAMAGE_ENGINE, Msg::PanelDmgEngine, s.damage_engine),
        (Caps::DAMAGE_GEARBOX, Msg::PanelDmgGearbox, s.damage_gearbox),
        (Caps::DAMAGE_SUSPENSION, Msg::PanelDmgSusp, s.damage_suspension),
    ]
    .into_iter()
    .filter(|(cap, _, _)| caps.has(*cap))
    .map(|(_, msg, d)| (msg, d.filter(|d| d.is_finite()).map(|d| d.clamp(0.0, 1.0))))
    .collect();
    let damage = if parts.is_empty() {
        Elem::hidden()
    } else {
        let known = parts.iter().any(|(_, d)| d.is_some());
        let hurt: Vec<String> = parts
            .into_iter()
            .filter_map(|(msg, d)| d.filter(|d| *d >= 0.01).map(|d| format!("{} {:.0}%", say(msg), d * 100.0)))
            .collect();
        let line = match (known, hurt.is_empty()) {
            (false, _) => say(Msg::PanelDamage("–".to_owned())),
            (true, true) => say(Msg::PanelDamageNone),
            (true, false) => say(Msg::PanelDamage(hurt.join(", "))),
        };
        let worst = if hurt.is_empty() { Role::Muted } else { Role::Warn };
        Elem::with(if fresh && known { Show::Shown } else { Show::Dimmed }, worst, line)
    };

    // The tyres and the map.
    let tyres = slots.tyres.then(|| {
        let now = live.tyres.filter(|t| t.iter().any(crate::game::Tyre::known));
        let unknown = crate::game::Tyre {
            brake_c: f32::NAN,
            temp_c: f32::NAN,
            pressure_kpa: f32::NAN,
            left: f32::NAN,
            tread_c: None,
        };
        let raw = now.or(seen.tyres).unwrap_or([unknown; 4]);
        TyresModel {
            show: if fresh && now.is_some() { Show::Shown } else { Show::Dimmed },
            tiles: std::array::from_fn(|i| tyre_tile(lang, units, i, &raw[i])),
            title: say(Msg::PanelTyres),
            compound: live.tyre_compound.clone().filter(|c| !c.trim().is_empty()),
            brake_label: say(Msg::PanelBrake),
        }
    });
    let map = if !slots.map {
        Show::Hidden
    } else if fresh && has_map(live) {
        Show::Shown
    } else {
        Show::Dimmed
    };

    let laps = laps_model(live, ctx, &slots, fresh, &lap_time, &delta);

    DashModel {
        status,
        banner,
        track: live.track.to_uppercase(),
        car: [live.car.as_str(), live.game]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("  \u{b7}  "),
        session,
        lap,
        invalid: live.driving && fresh && live.lap_valid == Some(false),
        rev,
        lap_time,
        last_lap,
        best_lap,
        delta,
        delta_vs: say(Msg::PanelVsBest),
        delta_note,
        projected,
        lap_top: lap_speed.map(|(top, _)| speed_text(top, units.speed)),
        lap_min: lap_speed.map(|(_, min)| speed_text(min, units.speed)),
        inputs_title: say(Msg::PanelInputsTitle),
        aids: (caps.has(Caps::ABS_ACTIVE), caps.has(Caps::TC_ACTIVE)),
        lap_share: live.lap_inputs.map(|share| {
            let words = [say(Msg::InputsFull), say(Msg::InputsBrake), say(Msg::InputsCoast)];
            std::array::from_fn(|k| (words[k].clone(), format!("{:.0}%", share[k] * 100.0)))
        }),
        gear,
        gear_track,
        speed,
        brake,
        throttle,
        clutch,
        steer,
        fuel_title: say(if slots.fuel { Msg::PanelFuel } else { Msg::PanelEngine }),
        fuel,
        fuel_share: share,
        fuel_tick,
        fuel_laps,
        fuel_tank,
        fuel_per_lap,
        fuel_minutes,
        fuel_stats,
        fuel_planner,
        fuel_low: low,
        engine,
        progress,
        distance,
        alerts_title: say(Msg::PanelAlerts),
        alerts,
        no_alerts: say(Msg::PanelNoAlerts),
        electronics,
        damage,
        tyres,
        laps,
        map,
        map_title: say(Msg::PanelTrack),
    }
}

/// Whether the game is sharing data (it is open and connected; it may be paused or between laps).
pub(super) fn game_connected(game: &Game) -> bool {
    matches!(game, Game::Connected | Game::Recording(_) | Game::Paused)
}

/// The dashboard stays up while a game is connected, even with no frames for a while (it dims and says so); the waiting
/// screen is for no reading at all, or a game that is gone.
pub(super) fn dashboard_shown(live: Option<&Live>, game: &Game, now_ms: i64) -> bool {
    live.is_some_and(|l| fresh(l, now_ms) || game_connected(game))
}
