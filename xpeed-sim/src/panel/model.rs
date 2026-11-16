use super::*;

/// `1:42.318` for seconds; nothing when there is none (the caller then draws nothing).
pub(super) fn lap_clock(s: Option<f64>) -> Option<String> {
    s.filter(|s| s.is_finite() && *s >= 0.0).map(|s| clock((s * 1000.0).round() as u32))
}

/// `+0.42` or `-1.07`; nothing when there is none.
pub(super) fn delta_text(d: Option<f64>) -> Option<String> {
    d.filter(|d| d.is_finite())
        .map(|d| format!("{}{:.2}", if d < 0.0 { "-" } else { "+" }, d.abs()))
}

/// The gears either side of `gear` (R, N, 1, 2, ...): the one below and the one above. There is nothing below
/// reverse, and nothing above the top gear when the car's forward gear count (`gears`) is known; when it is not, there
/// is always one above a forward gear.
pub(super) fn neighbour_gears(gear: f32, gears: Option<u8>) -> (Option<String>, Option<String>) {
    if !gear.is_finite() {
        return (None, None);
    }
    let g = gear.round() as i32;
    let below = (g > -1).then(|| gear_text((g - 1) as f32));
    let in_top_gear = g >= 1 && gears.is_some_and(|count| g >= i32::from(count));
    let above = (!in_top_gear).then(|| gear_text((g + 1) as f32));
    (below, above)
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

pub(super) fn pedal_count(h: f32) -> usize {
    (((h + PEDAL_GAP) / (PEDAL_SEG + PEDAL_GAP)).floor() as usize).max(1)
}

/// How many of `count` blocks a pedal at `value` (0..1; out of range is clamped) lights, from the bottom. A pedal
/// pressed a little shows at least one block; one released, or one the game does not give (NaN), none.
pub(super) fn pedal_lit(value: f32, count: usize) -> usize {
    if !value.is_finite() || value <= 0.02 {
        return 0;
    }
    ((value.clamp(0.0, 1.0) * count as f32).round() as usize).clamp(1, count)
}

/// The one-letter tag under a pedal bar: the first letter of its (translated) name, in capitals.
pub(super) fn pedal_tag(name: &str) -> String {
    name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()
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
// * "Live" readings (gear, speed, revs, pedals, wheel, lights) are `Shown` only while the car is being driven and the
//   frames keep coming. Paused, in a menu or the garage, or with no frames for a while, they are `Dimmed` (the last
//   gear seen, never a stale "R").
// * "Slow" readings (fuel, tyres, temperatures, the electronics' settings, damage) are `Shown` while the frame carries
//   them; when it does not, the last value seen is kept `Dimmed`. With no frames at all, everything is `Dimmed`.
// * A record of a finished lap (last lap, best lap, the delta to the best) that does not exist yet (the first lap) is
//   `Hidden`, but its place stays: nothing moves when it appears.

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
}

/// One element of the dashboard: its label, its value as text, its unit, its meaning and how it is shown. A gauge also
/// has its share (`frac`: 0..1, or -1..1 for the wheel; 0 when it has none).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Elem {
    pub(super) show: Show,
    pub(super) role: Role,
    pub(super) label: String,
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

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Light {
    pub(super) kind: PillKind,
    pub(super) glow: Glow,
    pub(super) flag: Option<crate::game::Flag>,
    pub(super) show: Show,
}

/// A readout: a small caps label over a figure.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Cell {
    pub(super) label: String,
    pub(super) value: String,
    pub(super) role: Role,
    pub(super) show: Show,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Damage {
    pub(super) label: String,
    /// 0 = none .. 1 = destroyed.
    pub(super) share: f32,
    pub(super) show: Show,
}

/// The four tyres: what is shown, and the values (the last seen when the frame has none).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct TyresModel {
    pub(super) show: Show,
    pub(super) tyres: [crate::game::Tyre; 4],
    pub(super) title: String,
    pub(super) compound: Option<String>,
}

/// Everything the dashboard shows.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct DashModel {
    pub(super) status: Option<(StatusKind, String)>,
    pub(super) track: String,
    pub(super) car: String,
    pub(super) lap: Elem,
    /// The lap being driven will not count.
    pub(super) invalid: bool,
    /// The revs against the top seen (`frac`): the rev bar and the shift lights.
    pub(super) rev: Elem,
    pub(super) lap_time: Elem,
    pub(super) last_lap: Elem,
    pub(super) best_lap: Elem,
    pub(super) delta: Elem,
    pub(super) gear: Elem,
    pub(super) gear_below: Elem,
    pub(super) gear_above: Elem,
    pub(super) speed: Elem,
    pub(super) brake: Elem,
    pub(super) throttle: Elem,
    pub(super) clutch: Elem,
    pub(super) steer: Elem,
    /// The litres.
    pub(super) fuel: Elem,
    /// How full the tank is (0..1), when the tank's size is known.
    pub(super) fuel_share: Option<f32>,
    pub(super) fuel_laps: Elem,
    pub(super) fuel_per_lap: Elem,
    pub(super) fuel_low: bool,
    /// The share of the lap done (`frac`), and the distance.
    pub(super) progress: Elem,
    pub(super) distance: Elem,
    pub(super) lights: Vec<Light>,
    pub(super) engine: Vec<Cell>,
    pub(super) electronics: Vec<Cell>,
    pub(super) damage: Vec<Damage>,
    pub(super) tyres: Option<TyresModel>,
    pub(super) map: Show,
    pub(super) map_title: String,
}

/// What the model needs besides the reading.
#[derive(Clone, Copy, Debug)]
pub(super) struct ModelCtx {
    pub(super) lang: Lang,
    pub(super) now_ms: i64,
}

/// A reading older than this is not live.
pub(super) fn fresh(live: &Live, now_ms: i64) -> bool {
    now_ms - live.at_ms <= STALE_MS
}

fn finite(v: f32) -> Option<f32> {
    Some(v).filter(|v| v.is_finite())
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

/// The dashboard model for a reading. Pure: the same reading, language and time always give the same model.
pub(super) fn dashboard(live: &Live, ctx: &ModelCtx) -> DashModel {
    use crate::game::{Caps, Drs};
    let lang = ctx.lang;
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

    let lap = if live.driving && fresh {
        Elem::with(Show::Shown, Role::Primary, say(Msg::PanelLap(live.lap)).to_uppercase())
    } else if live.phase == crate::game::Phase::Paused || (!fresh && live.driving) {
        Elem::with(Show::Dimmed, Role::Primary, say(Msg::PanelLap(live.lap)).to_uppercase())
    } else {
        Elem::hidden()
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
    let (below, above) = match gear_val.filter(|_| slots.gear) {
        Some(g) => neighbour_gears(g, live.gears),
        None => (None, None),
    };
    let neighbour = |t: Option<String>| t.map_or_else(Elem::hidden, |t| Elem::with(gear_show, Role::Muted, t));
    let speed_now = finite(live.speed_ms);
    let speed = if slots.speed {
        let kmh = speed_now
            .or(seen.speed_ms)
            .map_or_else(|| "–".to_owned(), |v| format!("{:.0}", v * 3.6));
        Elem::with(reading(live_now, speed_now.is_some()), Role::Text, kmh).unit("km/h")
    } else {
        Elem::hidden()
    };
    let pedal = |on: bool, value: f32, msg: Msg, role: Role| {
        if !on {
            return Elem::hidden();
        }
        let v = finite(value);
        Elem::with(reading(live_now, v.is_some()), role, "")
            .labelled(pedal_tag(&say(msg)))
            .frac(v.unwrap_or(0.0).clamp(0.0, 1.0))
    };
    let brake = pedal(slots.brake, live.brake, Msg::PanelBrake, Role::Danger);
    let throttle = pedal(slots.throttle, live.throttle, Msg::PanelThrottle, Role::Good);
    let clutch = pedal(slots.clutch, live.clutch, Msg::PanelClutch, Role::Info);
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
            Elem::with(reading(live_now, true), role, t)
                .labelled(say(Msg::PanelDelta))
                .frac(frac)
        }
        _ => Elem::hidden(),
    };

    // Fuel.
    let fuel_now = fuel_reading(live);
    let fuel_val = fuel_now.or(seen.fuel_l);
    let fuel_show = if fresh && fuel_now.is_some() { Show::Shown } else { Show::Dimmed };
    let laps_left_val = fuel_val.and_then(|f| fuel_laps_left(f, live.fuel_per_lap_l));
    let low = live_now && laps_left_val.is_some_and(|n| n < FUEL_LOW_LAPS);
    let fuel = if slots.fuel {
        Elem::with(
            fuel_show,
            Role::Text,
            fuel_val.map_or_else(|| "–".to_owned(), |f| format!("{f:.1}")),
        )
        .labelled(say(Msg::PanelFuel))
        .unit("L")
    } else {
        Elem::hidden()
    };
    let fuel_laps = match (slots.fuel, laps_left_val) {
        (true, Some(n)) => {
            let role = if low { Role::Danger } else { Role::Primary };
            Elem::with(fuel_show, role, format!("≈ {}", say(Msg::PanelFuelLaps(format!("{n:.1}")))))
        }
        _ => Elem::hidden(),
    };
    let per_lap = live.fuel_per_lap_l.filter(|p| p.is_finite() && *p > 0.0);
    let fuel_per_lap = match (slots.fuel, per_lap) {
        (true, Some(per)) => Elem::with(
            if fresh { Show::Shown } else { Show::Dimmed },
            Role::Muted,
            say(Msg::PanelFuelPerLap(format!("{per:.1}"))),
        ),
        _ => Elem::hidden(),
    };

    // Where in the lap.
    let (progress, distance) = match (slots.progress, live.dist_m, live.track_length_m) {
        (true, Some(d), Some(l)) if l > 0.0 => {
            let p = (d / l).clamp(0.0, 1.0) as f32;
            let show = if timing { Show::Shown } else { Show::Dimmed };
            (
                Elem::with(show, Role::Text, format!("{:.0}%", p * 100.0))
                    .labelled(say(Msg::PanelLapProgress))
                    .frac(p),
                Elem::with(show, Role::Muted, format!("{:.0} / {:.0} m", d.clamp(0.0, l), l)),
            )
        }
        _ => (Elem::hidden(), Elem::hidden()),
    };

    // The lights, from what the game can give: one it cannot give is not there; one it can, and has no value for now,
    // is there and off, dimmed.
    let s = &live.state;
    let lit = |on: bool| if on { Glow::On } else { Glow::Off };
    let mut lights = Vec::new();
    let mut light = |kind, glow: Glow, flag, present: bool| {
        lights.push(Light {
            kind,
            glow,
            flag,
            show: reading(live_now, present),
        });
    };
    if caps.has(Caps::PIT_LIMITER) {
        light(PillKind::Pit, lit(s.pit_limiter == Some(true)), None, s.pit_limiter.is_some());
    }
    if caps.has(Caps::ABS_ACTIVE) {
        light(PillKind::Abs, lit(s.abs_active == Some(true)), None, s.abs_active.is_some());
    }
    if caps.has(Caps::TC_ACTIVE) {
        light(PillKind::Tc, lit(s.tc_active == Some(true)), None, s.tc_active.is_some());
    }
    if caps.has(Caps::DRS) {
        let glow = match s.drs {
            Some(Drs::Open) => Glow::On,
            Some(Drs::Available) => Glow::Ready,
            _ => Glow::Off,
        };
        light(PillKind::Drs, glow, None, s.drs.is_some());
    }
    if caps.has(Caps::HEADLIGHTS) {
        light(PillKind::Headlights, lit(s.headlights == Some(true)), None, s.headlights.is_some());
    }
    if caps.has(Caps::FUEL) {
        light(PillKind::Fuel, lit(low), None, laps_left_val.is_some());
    }
    if caps.has(Caps::ENGINE_WARNING) {
        light(
            PillKind::Engine,
            lit(s.engine_warning == Some(true)),
            None,
            s.engine_warning.is_some(),
        );
    }
    if caps.has(Caps::HANDBRAKE) {
        light(PillKind::Handbrake, lit(s.handbrake == Some(true)), None, s.handbrake.is_some());
    }
    if caps.has(Caps::FLAG) {
        light(PillKind::Flag, Glow::Off, s.flag, s.flag.is_some());
    }

    // The engine and fuel card.
    let temp_cell = |on: bool, now: Option<f32>, last: Option<f32>, msg: Msg, warm: f32, hot: f32| {
        on.then(|| {
            let t = now.filter(|t| t.is_finite());
            let val = t.or(last);
            Cell {
                label: say(msg),
                value: val.map_or_else(|| "–".to_owned(), |t| format!("{t:.0} °C")),
                role: val.map_or(Role::Muted, |t| heat_role(t, warm, hot)),
                show: if fresh && t.is_some() { Show::Shown } else { Show::Dimmed },
            }
        })
    };
    let mut engine = Vec::new();
    engine.extend(temp_cell(slots.water, s.water_c, seen.water_c, Msg::PanelWater, 105.0, 115.0));
    engine.extend(temp_cell(slots.oil, s.oil_c, seen.oil_c, Msg::PanelOil, 130.0, 145.0));
    if slots.fuel {
        engine.push(Cell {
            label: say(Msg::PanelPerLap),
            value: per_lap.map_or_else(|| "–".to_owned(), |p| format!("{p:.1} L")),
            role: Role::Text,
            show: if fresh && per_lap.is_some() { Show::Shown } else { Show::Dimmed },
        });
        engine.push(Cell {
            label: say(Msg::PanelLapsLeft),
            value: laps_left_val.map_or_else(|| "–".to_owned(), |n| format!("{n:.1}")),
            role: if low { Role::Danger } else { Role::Text },
            show: if fresh && fuel_now.is_some() && laps_left_val.is_some() {
                Show::Shown
            } else {
                Show::Dimmed
            },
        });
    }

    // The electronics and damage card.
    let level = |n: u8| if n == 0 { "OFF".to_owned() } else { n.to_string() };
    let mut electronics = Vec::new();
    let mut setting = |on: bool, label: String, value: Option<String>| {
        if on {
            electronics.push(Cell {
                label,
                show: if fresh && value.is_some() { Show::Shown } else { Show::Dimmed },
                value: value.unwrap_or_else(|| "–".to_owned()),
                role: Role::Text,
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
    let damage: Vec<Damage> = [
        (Caps::DAMAGE_BODY, Msg::PanelDmgBody, s.damage_body),
        (Caps::DAMAGE_ENGINE, Msg::PanelDmgEngine, s.damage_engine),
        (Caps::DAMAGE_GEARBOX, Msg::PanelDmgGearbox, s.damage_gearbox),
        (Caps::DAMAGE_SUSPENSION, Msg::PanelDmgSusp, s.damage_suspension),
    ]
    .into_iter()
    .filter(|(cap, _, _)| caps.has(*cap))
    .map(|(_, msg, d)| {
        let d = d.filter(|d| d.is_finite());
        Damage {
            label: say(msg),
            share: d.unwrap_or(0.0).clamp(0.0, 1.0),
            show: if fresh && d.is_some() { Show::Shown } else { Show::Dimmed },
        }
    })
    .collect();

    // The tyres and the map.
    let tyres = slots.tyres.then(|| {
        let now = live.tyres.filter(|t| t.iter().any(crate::game::Tyre::known));
        let unknown = crate::game::Tyre {
            brake_c: f32::NAN,
            temp_c: f32::NAN,
            pressure_kpa: f32::NAN,
            left: f32::NAN,
        };
        TyresModel {
            show: if fresh && now.is_some() { Show::Shown } else { Show::Dimmed },
            tyres: now.or(seen.tyres).unwrap_or([unknown; 4]),
            title: say(Msg::PanelTyres),
            compound: live.tyre_compound.clone(),
        }
    });
    let map = if !slots.map {
        Show::Hidden
    } else if fresh && has_map(live) {
        Show::Shown
    } else {
        Show::Dimmed
    };

    DashModel {
        status,
        track: live.track.to_uppercase(),
        car: [live.car.as_str(), live.game]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("  ·  "),
        lap,
        invalid: live.driving && fresh && live.lap_valid == Some(false),
        rev,
        lap_time,
        last_lap,
        best_lap,
        delta,
        gear,
        gear_below: neighbour(below),
        gear_above: neighbour(above),
        speed,
        brake,
        throttle,
        clutch,
        steer,
        fuel,
        fuel_share: fuel_val.and_then(|f| fuel_share(f, live.fuel_tank_l)),
        fuel_laps,
        fuel_per_lap,
        fuel_low: low,
        progress,
        distance,
        lights,
        engine,
        electronics,
        damage,
        tyres,
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
