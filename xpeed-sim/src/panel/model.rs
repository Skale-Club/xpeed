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

/// A saved lap's label (`Lap 3  1:47.918`, or `Lap 5  3:27.250 (not valid)`) in its parts.
#[derive(Debug, PartialEq)]
pub(super) struct LapLabel<'a> {
    pub(super) name: &'a str,
    pub(super) time: &'a str,
    /// The label says the lap did not count.
    pub(super) invalid: bool,
}

/// Splits a saved lap's label into its name, its time and whether the lap was invalid.
pub(super) fn lap_parts(label: &str) -> LapLabel<'_> {
    let (name, rest) = label.split_once("  ").unwrap_or((label, ""));
    let rest = rest.trim();
    match rest.strip_suffix(crate::engine::NOT_VALID_MARK.trim_start()) {
        Some(time) => LapLabel {
            name,
            time: time.trim_end(),
            invalid: true,
        },
        None => LapLabel {
            name,
            time: rest,
            invalid: false,
        },
    }
}

/// The best time among the laps that counted, in seconds; an invalid lap is never the fastest.
pub(super) fn fastest_valid(laps: &[LapLabel]) -> Option<f64> {
    laps.iter()
        .filter(|l| !l.invalid)
        .filter_map(|l| clock_seconds(l.time))
        .reduce(f64::min)
}

/// The track map is drawn once the car has driven enough of a path.
pub(super) fn has_map(live: &Live) -> bool {
    live.map.as_ref().is_some_and(|m| m.len() >= 30)
}

/// Something for the track and tyre column: a map, or tyres.
pub(super) fn has_side(live: &Live) -> bool {
    has_map(live) || live.tyres.is_some()
}

/// `1:47.918` as seconds.
pub(super) fn clock_seconds(text: &str) -> Option<f64> {
    let (minutes, seconds) = text.split_once(':')?;
    Some(minutes.trim().parse::<f64>().ok()? * 60.0 + seconds.trim().parse::<f64>().ok()?)
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

/// The laps of fuel left in the car, from a reading worth showing.
pub(super) fn laps_left(live: &Live) -> Option<f32> {
    fuel_laps_left(fuel_reading(live)?, live.fuel_per_lap_l)
}

/// The fuel warns (red, the FUEL light): the car is driving and the fuel lasts under `FUEL_LOW_LAPS`. A reading taken
/// while the car is not driving never warns.
pub(super) fn fuel_low(live: &Live) -> bool {
    live.driving && laps_left(live).is_some_and(|n| n < FUEL_LOW_LAPS)
}

/// How full the tank is, 0..1, against its size (the biggest the tank is known to be, never less than the fuel).
pub(super) fn fuel_share(fuel: f32, tank: Option<f32>) -> Option<f32> {
    let tank = tank.filter(|t| t.is_finite() && *t > 0.0)?;
    (fuel.is_finite() && fuel >= 0.0).then(|| (fuel / tank.max(fuel)).clamp(0.0, 1.0))
}

/// "≈ 4.7 laps": the laps of fuel left, when known.
pub(super) fn fuel_laps_text(live: &Live, lang: Lang) -> Option<String> {
    laps_left(live).map(|n| format!("≈ {}", text(lang, &Msg::PanelFuelLaps(format!("{n:.1}")))))
}

/// "2.6 L/lap": the use per lap, when known.
pub(super) fn fuel_per_lap_text(live: &Live, lang: Lang) -> Option<String> {
    live.fuel_per_lap_l
        .filter(|p| p.is_finite() && *p > 0.0)
        .map(|per| text(lang, &Msg::PanelFuelPerLap(format!("{per:.1}"))))
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

/// The cards that have something to show, in their order (lights, engine and fuel, electronics and damage).
pub(super) fn present_cards(live: &Live) -> Vec<CarCard> {
    let mut cards = Vec::new();
    if !light_pills(live).is_empty() {
        cards.push(CarCard::Lights);
    }
    if !engine_cells(live, Lang::En).is_empty() {
        cards.push(CarCard::Engine);
    }
    if !electronics_cells(live, Lang::En).is_empty() || !damage_bars(live, Lang::En).is_empty() {
        cards.push(CarCard::Electronics);
    }
    cards
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Pill {
    pub(super) kind: PillKind,
    pub(super) glow: Glow,
    pub(super) flag: Option<crate::game::Flag>,
}

/// The colour a light lights in, by what it means: amber for warnings of the driver's own doing (fuel, the pit
/// limiter), red for the car's (engine, handbrake), blue, green and cyan for aids and lamps being active.
pub(super) fn pill_color(kind: PillKind) -> COLORREF {
    match kind {
        PillKind::Pit | PillKind::Fuel => AMBER,
        PillKind::Abs => BLUE,
        PillKind::Tc | PillKind::Drs => GREEN,
        PillKind::Engine | PillKind::Handbrake => RED,
        PillKind::Headlights => CYAN,
        PillKind::Flag => MUTED,
    }
}

/// The lights the game gives, in their fixed order; a light it does not give is left out (never shown as off). FUEL
/// is given whenever the laps of fuel left are known, and lit when the fuel warns (driving, under two laps).
pub(super) fn light_pills(live: &Live) -> Vec<Pill> {
    use crate::game::Drs;
    let s = &live.state;
    let lit = |on: bool| if on { Glow::On } else { Glow::Off };
    let mut pills = Vec::new();
    let mut add = |kind, glow, flag| pills.push(Pill { kind, glow, flag });
    if let Some(on) = s.pit_limiter {
        add(PillKind::Pit, lit(on), None);
    }
    if let Some(on) = s.abs_active {
        add(PillKind::Abs, lit(on), None);
    }
    if let Some(on) = s.tc_active {
        add(PillKind::Tc, lit(on), None);
    }
    if let Some(drs) = s.drs {
        let glow = match drs {
            Drs::Open => Glow::On,
            Drs::Available => Glow::Ready,
            Drs::Off => Glow::Off,
        };
        add(PillKind::Drs, glow, None);
    }
    if let Some(on) = s.headlights {
        add(PillKind::Headlights, lit(on), None);
    }
    if laps_left(live).is_some() {
        add(PillKind::Fuel, lit(fuel_low(live)), None);
    }
    if let Some(on) = s.engine_warning {
        add(PillKind::Engine, lit(on), None);
    }
    if let Some(on) = s.handbrake {
        add(PillKind::Handbrake, lit(on), None);
    }
    if let Some(f) = s.flag {
        add(PillKind::Flag, Glow::Off, Some(f));
    }
    pills
}

/// A readout: a small caps label over a figure.
pub(super) struct Cell {
    pub(super) label: String,
    pub(super) value: String,
    pub(super) color: COLORREF,
}

/// The Account card's headline when connected: who, or just "Connected" while the account is not known (never the host).
pub(super) fn connected_line(lang: Lang, who: Option<&str>) -> String {
    match who {
        Some(who) => text(lang, &Msg::ConnectedAs(who.to_owned())),
        None => text(lang, &Msg::ConnectedPlain),
    }
}

/// The colour of a temperature that gets worse above `warm` and `hot`.
pub(super) fn heat_color(temp_c: f32, warm: f32, hot: f32) -> COLORREF {
    if temp_c >= hot {
        RED
    } else if temp_c >= warm {
        AMBER
    } else {
        TEXT
    }
}

/// The figures of the engine and fuel card, only those known.
pub(super) fn engine_cells(live: &Live, lang: Lang) -> Vec<Cell> {
    let mut cells = Vec::new();
    if let Some(t) = live.state.water_c.filter(|t| t.is_finite()) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelWater),
            value: format!("{t:.0} °C"),
            color: heat_color(t, 105.0, 115.0),
        });
    }
    if let Some(t) = live.state.oil_c.filter(|t| t.is_finite()) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelOil),
            value: format!("{t:.0} °C"),
            color: heat_color(t, 130.0, 145.0),
        });
    }
    if let Some(per) = live.fuel_per_lap_l.filter(|p| p.is_finite() && *p > 0.0) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelPerLap),
            value: format!("{per:.1} L"),
            color: TEXT,
        });
    }
    if let Some(n) = laps_left(live) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelLapsLeft),
            value: format!("{n:.1}"),
            color: if fuel_low(live) { RED } else { TEXT },
        });
    }
    cells
}

/// The figures of the electronics half: TC, ABS and MAP levels and the brake bias, only those known.
pub(super) fn electronics_cells(live: &Live, lang: Lang) -> Vec<Cell> {
    let level = |n: u8| if n == 0 { "OFF".to_owned() } else { n.to_string() };
    let s = &live.state;
    let mut cells = Vec::new();
    for (label, value) in [
        ("TC", s.tc_level.map(level)),
        ("ABS", s.abs_level.map(level)),
        ("MAP", s.engine_map.map(|n| n.to_string())),
    ] {
        if let Some(value) = value {
            cells.push(Cell {
                label: label.to_owned(),
                value,
                color: TEXT,
            });
        }
    }
    if let Some(bias) = s.brake_bias.filter(|b| b.is_finite()) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelBias),
            value: format!("{:.1} %", bias.clamp(0.0, 1.0) * 100.0),
            color: TEXT,
        });
    }
    cells
}

/// The damage bars the car has: name and share (0 = none .. 1 = destroyed), only those known.
pub(super) fn damage_bars(live: &Live, lang: Lang) -> Vec<(String, f32)> {
    let s = &live.state;
    [
        (Msg::PanelDmgBody, s.damage_body),
        (Msg::PanelDmgEngine, s.damage_engine),
        (Msg::PanelDmgGearbox, s.damage_gearbox),
        (Msg::PanelDmgSusp, s.damage_suspension),
    ]
    .into_iter()
    .filter_map(|(msg, d)| d.filter(|d| d.is_finite()).map(|d| (text(lang, &msg), d.clamp(0.0, 1.0))))
    .collect()
}

/// Damage's colour: green, through amber, to red.
pub(super) fn damage_color(share: f32) -> COLORREF {
    let s = share.clamp(0.0, 1.0);
    if s < 0.5 {
        mix(GREEN, AMBER, s / 0.5)
    } else {
        mix(AMBER, RED, (s - 0.5) / 0.5)
    }
}

/// The colour of a tyre's temperature: blue cold, green in its window, amber warm, red hot (°C, typical for racing
/// tyres; each game and compound has its own window, so this is a guide, not a target).
pub(super) fn tyre_color(temp_c: f32) -> COLORREF {
    match temp_c {
        t if !t.is_finite() => MUTED,
        t if t < 65.0 => STEEL,
        t if t < 95.0 => GREEN,
        t if t < 110.0 => AMBER,
        _ => RED,
    }
}

/// The colour of a brake disc's temperature: steel blue cold, green working, amber hot, red over the limit.
pub(super) fn brake_color(temp_c: f32) -> COLORREF {
    match temp_c {
        t if !t.is_finite() => MUTED,
        t if t < 150.0 => STEEL,
        t if t < 450.0 => GREEN,
        t if t < 700.0 => AMBER,
        _ => RED,
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
        Activity::Notice(Notice::LapSaved(label)) => Msg::NoticeLapSaved(label),
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
