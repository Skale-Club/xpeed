//! What the panel shows while someone drives: the latest reading of the car, and the gap to the best lap of this run
//! (the delta). Every game's frames come through here (Le Mans Ultimate's are turned into the same `Frame` first), so
//! the panel does not need to know which game it is. Pure, so it is tested without a screen.

use std::sync::Arc;

use crate::game::{Caps, CarState, Drs, Flag, Frame, Phase, Tyre};
use crate::lapfile::SessionKind;
use crate::lmu::snapshot::{PlayerTelemetry, ScoringFrame};
use crate::maps::Store;
use crate::norm;
use crate::session::{Event, Session};

/// Le Mans Ultimate's two streams as one `Frame` (`lmu/source.rs` makes one for every telemetry update, and the panel
/// and the lap cutter read it like any other game's).
///
/// Scoring comes a few times a second; the distance is carried forward from it at the car's speed. Just after the line
/// the scoring can still show the end of the last lap: that distance is not given until the scoring catches up, so the
/// new lap is not taken as joined midway.
pub fn lmu_frame(t: &PlayerTelemetry, scoring: Option<&ScoringFrame>) -> Frame {
    let mut frame = Frame::empty();
    let speed = t.speed_ms();
    // The game's session clock, which never goes back while a session runs (the recorder reads a clock going back as a
    // restart); a reading that is not a time is left at 0.
    if t.elapsed_time.is_finite() && t.elapsed_time >= 0.0 {
        frame.clock_s = t.elapsed_time;
    }
    frame.set_phase(lmu_phase(scoring));
    frame.lap = t.lap_number;
    let lap_time = t.elapsed_time - t.lap_start_et;
    frame.lap_time_s = (0.0..=86_400.0).contains(&lap_time).then_some(lap_time);
    // The raw values go through `norm`, the tolerances every other reader uses: finite and in range, else "not given".
    frame.speed_ms = norm::within(speed as f32, 0.0, 1000.0);
    frame.rpm = norm::within(t.rpm as f32, 0.0, 100_000.0);
    frame.gear = norm::gear(t.gear);
    // `mMaxGears`: maximum forward gears; 0 is unset.
    frame.gears = (t.max_gears > 0).then_some(t.max_gears);
    frame.throttle = norm::pedal(t.throttle as f32);
    frame.brake = norm::pedal(t.brake as f32);
    frame.clutch = norm::pedal(t.clutch as f32);
    frame.steer = norm::steer(t.steering as f32);
    frame.fuel_l = norm::within(t.fuel_l as f32, 0.0, 10_000.0);
    // The car's place in the world, for the track map; a reading that is not finite or absurd is not given.
    (frame.x, frame.y, frame.z) = (
        norm::position(t.pos[0] as f32),
        norm::position(t.pos[1] as f32),
        norm::position(t.pos[2] as f32),
    );
    let tyres: [Tyre; 4] = std::array::from_fn(|i| {
        let w = &t.wheels[i];
        // The game's quirk, kept: the tyre temperatures are Kelvin (three readings across the tread, 0 when not written), so
        // the mean is turned to Celsius first, and a tyre with any of the three at 0 K has no temperature yet ("not given",
        // not a mean pulled down by the missing one). The range is then `norm::tyre_c`'s, like every other reader.
        let kelvin = w.temperature_k.iter().sum::<f64>() / 3.0;
        Tyre {
            brake_c: norm::brake_c(w.brake_temp_c as f32),
            temp_c: if w.temperature_k.iter().all(|k| *k > 0.0) {
                norm::tyre_c((kelvin - 273.15) as f32)
            } else {
                f32::NAN
            },
            pressure_kpa: norm::pressure_kpa(w.pressure_kpa as f32),
            // The tyre's wear is what is left, 0..1; 0 is what an unwritten field holds.
            left: if w.wear > 0.0 {
                norm::within(w.wear as f32, 0.0, 1.0)
            } else {
                f32::NAN
            },
            // The three readings are the tyre's own left, centre and right (the game says so: not inside, centre, outside),
            // so on a left tyre (front left, rear left) the right edge is the inner one, on a right tyre the left edge
            // (ASSUMED, as the other readers' sides). All three or none, like the mean.
            tread_c: if w.temperature_k.iter().all(|k| *k > 0.0) {
                let c = |k: f64| (k - 273.15) as f32;
                let [left, middle, right] = w.temperature_k.map(c);
                norm::tread_points(left, middle, right).map(|[l, m, r]| if i.is_multiple_of(2) { [r, m, l] } else { [l, m, r] })
            } else {
                None
            },
        }
    });
    frame.tyres = tyres.iter().any(Tyre::known).then_some(tyres);
    frame.state = lmu_state(t, scoring.and_then(|s| s.player.as_ref()));
    frame.car = t.vehicle_name.clone();
    frame.track = t.track_name.clone();
    if let Some(s) = scoring {
        let length = (s.session.track_length_m > 0.0).then_some(s.session.track_length_m);
        frame.track_length_m = length;
        frame.session_kind = lmu_session_kind(s.session.session);
        if !s.session.track_name.is_empty() {
            frame.track = s.session.track_name.clone();
        }
        if let Some(player) = &s.player {
            frame.in_pits = player.in_pits;
            frame.car_class = (!player.vehicle_class.is_empty()).then(|| player.vehicle_class.clone());
            frame.last_lap_s = (player.last_lap_time > 0.0).then_some(player.last_lap_time);
            let lag = (t.elapsed_time - s.session.current_et).clamp(0.0, 1.0);
            let dist = player.lap_dist + speed * lag;
            let stale_from_last_lap = length.is_some_and(|l| lap_time < 10.0 && dist > l * 0.5);
            frame.dist_m = (dist.is_finite() && dist >= 0.0 && !stale_from_last_lap).then_some(dist);
        }
    }
    // The garage and the pause keep the last telemetry in memory: no car values outside `Driving`.
    frame.withhold_car_values_unless_driving();
    debug_assert!(frame.phase_consistent());
    #[cfg(test)]
    crate::game::assert_frame_within_caps(&frame, crate::lmu::snapshot::LMU_CAPS, "lmu");
    frame
}

/// The kind of the game's session from its number (`mSession`, the rFactor 2 numbering the game inherits): 0 is the test
/// day and 1 to 4 practice, 9 the warm-up, 5 to 8 qualifying, 10 to 13 the race. A number outside those says nothing
/// (it must not end a session by looking like another kind). Not checked against every session type of a live game;
/// the kind is what `session.rs` uses to tell one session of the game from the next.
fn lmu_session_kind(number: i32) -> Option<SessionKind> {
    match number {
        0..=4 | 9 => Some(SessionKind::Practice),
        5..=8 => Some(SessionKind::Qualifying),
        10..=13 => Some(SessionKind::Race),
        _ => None,
    }
}

/// What the player is doing in Le Mans Ultimate, from the scoring stream (the telemetry stream says nothing of it):
/// `Unknown` until the first scoring update; `Garage` when `in_realtime` is false (the player is at the monitor or in
/// the garage, not in the car); then `mGamePhase` (the rFactor 2 numbers): 9 is `Paused`; 2 (grid walk-through), 3
/// (formation lap) and 4 (starting-light countdown) are `Loading`; 1 (reconnaissance laps), 5 to 8 (green,
/// full-course yellow, stopped, over) and 0 are `Driving`; a number past 9 is `Unknown`. 0 is "before the session has
/// begun" in the header, but also what a field nobody wrote holds, and which number a practice session shows once the
/// car is out has not been checked against a live game, so it does not stop a lap (the previous rule, `in_realtime`
/// alone, did not look at it). Not told apart: `Menu` (no stream at all), `Replay` and `Spectating` (the player entry
/// has no control field here).
pub fn lmu_phase(scoring: Option<&ScoringFrame>) -> Phase {
    let Some(s) = scoring else { return Phase::Unknown };
    if !s.session.in_realtime {
        return Phase::Garage;
    }
    match s.session.game_phase {
        9 => Phase::Paused,
        2..=4 => Phase::Loading,
        0 | 1 | 5..=8 => Phase::Driving,
        _ => Phase::Unknown,
    }
}

/// The dashboard lights, temperatures, electronics and damage of Le Mans Ultimate's car (`TelemInfoV01`, and the
/// player's scoring entry for the flag). The header has no handbrake, no gearbox or engine damage and no suspension
/// damage, so those stay `None`.
fn lmu_state(t: &PlayerTelemetry, player: Option<&crate::lmu::snapshot::VehicleScoring>) -> CarState {
    // The coolant and the oil, in Celsius; 0 is what an unwritten field holds (`norm`).
    let water = Some(norm::water_c(t.water_c as f32)).filter(|c| c.is_finite());
    let oil = Some(norm::oil_c(t.oil_c as f32)).filter(|c| c.is_finite());
    // A setting is given for a car that has the aid (its maximum is above 0).
    let setting = |value: u8, max: u8| (max > 0).then_some(value);
    // `mDentSeverity`: eight places, each 0 none, 1 some, 2 more. Body damage is their sum over the worst case
    // (all eight at 2), so 1.0 is a car dented everywhere.
    let dents = t.dents.iter().map(|&d| u32::from(d.min(2))).sum::<u32>() as f32 / 16.0;
    // `mRearBrakeBias` is the rear share; 0 is what an unset field holds, and a bias is never all on one axle.
    let bias = 1.0 - t.rear_brake_bias;
    // The rear flap (DRS-like): open when activated; 2 = allowed, 1 = the criteria are met but not yet. 0 is also what
    // a car without the device writes, so it is not given.
    let drs = if t.rear_flap_activated {
        Some(Drs::Open)
    } else {
        match t.rear_flap_legal {
            2 => Some(Drs::Available),
            1 => Some(Drs::Off),
            _ => None,
        }
    };
    // The header names only green (0) and blue (6) for `mFlag`; a car that took the full-course caution is under yellow.
    let flag = player.and_then(|p| norm::flag_showing(&[(p.under_yellow, Flag::Yellow), (p.flag == 6, Flag::Blue)]));
    CarState {
        pit_limiter: Some(t.speed_limiter_active),
        abs_active: Some(t.abs_active),
        tc_active: Some(t.tc_active),
        drs,
        headlights: Some(t.headlights),
        handbrake: None,
        engine_warning: Some(t.overheating),
        flag,
        water_c: water,
        oil_c: oil,
        tc_level: setting(t.tc, t.tc_max),
        abs_level: setting(t.abs, t.abs_max),
        engine_map: setting(t.motor_map, t.motor_map_max),
        brake_bias: (t.rear_brake_bias > 0.0 && t.rear_brake_bias < 1.0).then_some(bias as f32),
        damage_body: Some(dents),
        damage_engine: None,
        damage_gearbox: None,
        damage_suspension: None,
    }
}

/// One picture of the car for the panel. Values the game does not give are `NaN` or `None`, like in `Frame`.
#[derive(Clone, Debug, PartialEq)]
pub struct Live {
    pub game: &'static str,
    pub track: String,
    pub car: String,
    pub driving: bool,
    /// What the player is doing in the game (the panel's view model decides what to show from it).
    pub phase: Phase,
    /// What the game can give (`Source::caps`); the observed values of the run when the source never said (tests, the
    /// demo). It describes the game, not the moment: a value inside it may be missing now.
    pub caps: Caps,
    pub in_pits: bool,
    pub lap: i32,
    pub lap_time_s: Option<f64>,
    /// `Some(false)` when the game says the lap being driven will not count.
    pub lap_valid: Option<bool>,
    pub last_lap_s: Option<f64>,
    /// The best complete lap seen in this run on this track with this car.
    pub best_lap_s: Option<f64>,
    /// Time on this lap minus the best lap's time at the same distance (negative: faster).
    pub delta_s: Option<f64>,
    /// The first two sector times of the lap being driven (each once done) and of the lap before it, in milliseconds.
    pub sectors_ms: [Option<u32>; 2],
    pub last_sectors_ms: [Option<u32>; 2],
    pub session_kind: Option<SessionKind>,
    /// The compound of the tyres on the car, as the game names it.
    pub tyre_compound: Option<String>,
    pub dist_m: Option<f64>,
    pub track_length_m: Option<f64>,
    pub speed_ms: f32,
    pub rpm: f32,
    /// The highest RPM seen in this run with this car: the top of the rev bar (the games do not all give the limit).
    pub rpm_top: f32,
    pub gear: f32,
    /// How many forward gears the car has: the game's own count, else the top gear seen to be left (see `Tracker`).
    pub gears: Option<u8>,
    pub throttle: f32,
    pub brake: f32,
    pub clutch: f32,
    pub steer: f32,
    pub fuel_l: f32,
    /// Front left to rear right, when the game gives them.
    pub tyres: Option<[Tyre; 4]>,
    /// Dashboard lights, engine temperatures, electronics settings and damage, as the game gives them.
    pub state: crate::game::CarState,
    /// Fuel used per lap (litres), from the laps driven in this run; `None` until one full lap is known.
    pub fuel_per_lap_l: Option<f32>,
    /// The size of the tank, as far as it is known (for the panel's fuel gauge);  until a fuel reading is seen.
    pub fuel_tank_l: Option<f32>,
    /// The track as the car has driven it (the best lap's path, or the first full lap's until there is a best one),
    /// in the game's x and z; shared, as it changes once a lap at most.
    pub map: Option<Arc<Vec<(f32, f32)>>>,
    /// The game's road widths, when an actual layout is available (a driven map is only a line).
    pub road: Option<Arc<crate::perspective::Road>>,
    /// Actual recent positions, independent of the saved circuit and of a reference lap.
    pub trail: Arc<Vec<(f32, f32)>>,
    /// A valid best path from this session, shown only for an explicit practice/qualifying context.
    pub reference: Option<Arc<Vec<(f32, f32)>>>,
    /// Forward direction inferred from recent live movement, never from replay progression.
    pub heading: Option<(f32, f32)>,
    /// Where the car is now, in the same x and z.
    pub pos: Option<(f32, f32)>,
    /// `map` is a whole lap (or the real layout), a closed shape. When false it is the path driven so far, an open
    /// line, and may hold jumps (`MAP_JUMP_METRES`) the drawing must not join.
    pub map_complete: bool,
    /// The slow-changing values as last seen, kept while the frames do not carry them (a pause, the menu, the garage).
    pub last_seen: LastSeen,
    /// When this reading arrived (Unix ms), so the panel can tell a stale one.
    pub at_ms: i64,
}

/// What was last read of the values that outlive the moment they were read in: the panel shows them dimmed while the
/// game gives nothing new (paused, in a menu or the garage).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LastSeen {
    pub gear: Option<f32>,
    pub speed_ms: Option<f32>,
    pub fuel_l: Option<f32>,
    pub tyres: Option<[Tyre; 4]>,
    pub water_c: Option<f32>,
    pub oil_c: Option<f32>,
}

/// A lap's time at each distance it was seen at, in order of distance.
type Profile = Vec<(f64, f64)>;
/// A lap's path, (x, z) every few metres.
type Path = Vec<(f32, f32)>;

/// Keeps what the delta needs: the lap being driven, and the best one so far.
#[derive(Default)]
pub struct Tracker {
    /// Track, car and layout the best lap belongs to; a change starts over (the map included). A new session of the
    /// same track and car (a restart, practice then qualifying) starts over too, but keeps the map.
    key: Option<(String, String, Option<String>)>,
    /// Where maps are kept between sessions; none in tests and the demo.
    store: Option<Store>,
    /// The map is the real layout the game's files gave: laps do not replace it.
    map_is_layout: bool,
    /// What the frames mean (which session, which lap, a restart, a teleport): decided by `session.rs`, the same
    /// machine the lap cutter reads, so the panel and the laps written cannot disagree.
    session: Session,
    lap: i32,
    current: Profile,
    /// Seen from the line: a lap joined midway has no delta and cannot become the best.
    current_from_line: bool,
    /// The game called the lap being driven invalid at some point: it can never become the best.
    called_invalid: bool,
    /// A lap that just ended and waits for the game's official time: its profile, its path, the official time showing
    /// while it was driven, and whether the game called it invalid.
    finished: Option<(Profile, Path, Option<f64>, bool)>,
    /// The current lap's path (x, z), a point every few metres.
    path: Path,
    /// The current lap's path has a jump in it (a restart, the pits, a teleport): it is not a lap's map.
    path_jumped: bool,
    /// The path shown as the map.
    map: Option<Arc<Path>>,
    /// Cached growing path: publishing a stationary frame must not copy/rebuild the whole map.
    partial_map: Option<Arc<Path>>,
    road: Option<Arc<crate::perspective::Road>>,
    trail: Arc<Path>,
    heading: crate::perspective::MotionHeading,
    best_path: Option<Arc<Path>>,
    best: Option<(f64, Profile)>,
    /// The official time of the last lap as the previous reading showed it.
    official: Option<f64>,
    rpm_top: f32,
    /// The highest forward gear seen with this car, and whether the car was seen in a lower one afterwards.
    top_gear: u8,
    top_gear_left: bool,
    /// The fuel (litres) when the lap being driven began, when this run saw it begin (a lap joined midway has none).
    fuel_lap_start: Option<f32>,
    /// The last fuel reading of this lap.
    fuel_prev: Option<f32>,
    /// Nothing so far on this lap makes its fuel use meaningless (no refuel, no pit lane, never out of the car).
    fuel_clean: bool,
    /// The biggest fuel reading seen with this car: the tank, as far as the run has seen it.
    fuel_tank: f32,
    /// The fuel used by the last complete laps (at most `FUEL_LAPS`), oldest first.
    fuel_laps: Vec<f32>,
    /// What the source says its game can give (`set_caps`), and what the frames of this run filled.
    caps: Caps,
    caps_seen: Caps,
    /// The first two sector times seen on the lap being driven, and those of the lap before it.
    lap_sectors: [Option<u32>; 2],
    last_sectors: [Option<u32>; 2],
    last_seen: LastSeen,
}

/// How many of the last laps the fuel per lap averages.
const FUEL_LAPS: usize = 3;
/// A lap that uses more than this share of the tank is not a lap's fuel use (a refuel the readings missed).
const FUEL_MAX_SHARE: f32 = 0.3;
/// A rise in the fuel above this (litres) between two readings is a refuel, not noise.
const REFUEL_LITRES: f32 = 0.2;

/// A first reading further than this from the line means the lap was joined midway.
const FROM_LINE_METRES: f64 = 50.0;
/// The map keeps a point every this many metres of the car's path.
const MAP_STEP_METRES: f32 = 4.0;
/// Two points of the path further apart than this are not one drive (points are kept every `MAP_STEP_METRES`): a
/// restart, a return to the pits or a teleport. The map is not drawn across it, and such a lap is not a map.
pub const MAP_JUMP_METRES: f32 = 40.0;
/// A path shorter than this is not a map yet.
const MAP_MIN_POINTS: usize = 30;
/// A finished lap must cover this share of the track (when its length is known) to be a full lap.
const FULL_LAP_SHARE: f64 = 0.9;

impl Tracker {
    /// A tracker that keeps each track's map on disk and starts from it (see `maps.rs`).
    pub fn stored(store: Store) -> Tracker {
        Tracker {
            store: Some(store),
            ..Tracker::default()
        }
    }

    /// What the source's game can give, set by the engine from `Source::caps` (cheap: it is a number).
    pub fn set_caps(&mut self, caps: Caps) {
        self.caps = caps;
    }

    pub fn on_frame(&mut self, game: &'static str, frame: &Frame, at_ms: i64) -> Live {
        let key = (frame.track.clone(), frame.car.clone(), frame.track_variant.clone());
        if self.key.as_ref() != Some(&key) {
            *self = Tracker {
                key: Some(key),
                store: self.store.take(),
                caps: self.caps,
                caps_seen: self.caps_seen,
                ..Tracker::default()
            };
            // A track seen before has its map from the first frame (the real layout when there is one).
            if let (Some(store), false) = (&self.store, frame.track.is_empty()) {
                if let Some(path) = store.start(&frame.track, frame.track_variant.as_deref()) {
                    self.map_is_layout = store.layout(&frame.track, frame.track_variant.as_deref()).is_some();
                    self.road = store.road(&frame.track, frame.track_variant.as_deref()).map(Arc::new);
                    self.map = Some(Arc::new(path));
                }
            }
        }
        let step = self.session.feed(frame);
        for event in &step.events {
            match event {
                Event::SessionEnded { .. } => self.new_session(),
                Event::LapReset { .. } => self.lap_lost(frame),
                Event::LapClosed { .. } => {
                    self.last_sectors = std::mem::take(&mut self.lap_sectors);
                    self.lap_closed(frame);
                }
                Event::LapStarted { number, from_line, .. } => {
                    self.lap = *number;
                    self.current_from_line = *from_line;
                }
                Event::SessionStarted { .. } => {}
            }
        }
        if let Some((profile, path, official_before, invalid)) = self.finished.take() {
            match frame.last_lap_s {
                // A new official time: it belongs to the lap that just ended.
                Some(time) if Some(time) != official_before => self.offer_best(time, profile, path, invalid),
                _ => self.finished = Some((profile, path, official_before, invalid)),
            }
        }
        let pos = (frame.x.is_finite() && frame.z.is_finite()).then_some((frame.x, frame.z));
        let heading = self.heading.update(pos, at_ms, frame.driving);
        if let Some(here) = pos.filter(|_| frame.driving) {
            let previous = self.trail.last().copied();
            let distance = previous.map(|p| (p.0 - here.0).hypot(p.1 - here.1));
            if distance.is_none_or(|d| d >= MAP_STEP_METRES) {
                let trail = Arc::make_mut(&mut self.trail);
                if distance.is_some_and(|d| d > MAP_JUMP_METRES) {
                    trail.clear();
                }
                if trail.len() >= 32 {
                    trail.remove(0);
                }
                trail.push(here);
            }
        } else if pos.is_none() {
            self.trail = Arc::default();
            if frame.driving {
                // An unknown span is not a measured racing line; start learning a fresh continuous section.
                self.path.clear();
                self.partial_map = None;
                self.path_jumped = true;
            }
        }
        if frame.driving && frame.x.is_finite() && frame.z.is_finite() {
            let here = (frame.x, frame.z);
            let far_enough = self
                .path
                .last()
                .is_none_or(|&(x, z)| (x - here.0).hypot(z - here.1) >= MAP_STEP_METRES);
            if far_enough {
                if self
                    .path
                    .last()
                    .is_some_and(|&(x, z)| (x - here.0).hypot(z - here.1) > MAP_JUMP_METRES)
                {
                    self.path_jumped = true;
                }
                self.path.push(here);
                self.partial_map = (self.path.len() >= MAP_MIN_POINTS).then(|| Arc::new(self.path.clone()));
            }
        }
        if frame.lap == self.lap {
            self.fuel_seen(frame);
            if frame.driving {
                for (seen, now) in self.lap_sectors.iter_mut().zip(frame.sectors_ms) {
                    *seen = now.or(*seen);
                }
            }
        }
        self.caps_seen = self.caps_seen.or(frame.filled());
        self.remember(frame);
        self.official = frame.last_lap_s;
        // The distance into the lap: the game's, else the speed added up (`session.rs` decides which).
        let dist_m = step.sample.map(|s| s.dist_m);
        if frame.driving {
            self.called_invalid |= frame.lap_valid == Some(false);
        }
        if let (Some(sample), Some(_)) = (step.sample, frame.lap_time_s) {
            if self.current.last().is_none_or(|&(d, _)| sample.dist_m > d) {
                self.current.push((sample.dist_m, sample.t_s));
            }
        }
        if frame.rpm.is_finite() && frame.rpm > self.rpm_top {
            self.rpm_top = frame.rpm;
        }
        self.see_gear(frame.gear);
        let delta_s = match (&self.best, step.sample, frame.lap_time_s) {
            (Some((_, best)), Some(sample), Some(_)) if self.current_from_line => {
                time_at(best, sample.dist_m).map(|best_t| sample.t_s - best_t)
            }
            _ => None,
        };
        Live {
            game,
            track: frame.track.clone(),
            car: frame.car.clone(),
            driving: frame.driving,
            phase: frame.phase,
            caps: if self.caps.is_empty() { self.caps_seen } else { self.caps },
            in_pits: frame.in_pits,
            lap: frame.lap,
            lap_time_s: frame.lap_time_s,
            lap_valid: frame.lap_valid,
            last_lap_s: frame.last_lap_s,
            best_lap_s: self.best.as_ref().map(|(t, _)| *t),
            delta_s,
            sectors_ms: self.lap_sectors,
            last_sectors_ms: self.last_sectors,
            session_kind: frame.session_kind,
            tyre_compound: frame.tyre_compound.clone(),
            dist_m: frame.dist_m.or(dist_m),
            track_length_m: frame.track_length_m,
            speed_ms: frame.speed_ms,
            rpm: frame.rpm,
            rpm_top: self.rpm_top,
            gear: frame.gear,
            gears: frame.gears.or_else(|| self.top_gear_left.then_some(self.top_gear)),
            throttle: frame.throttle,
            brake: frame.brake,
            clutch: frame.clutch,
            steer: frame.steer,
            fuel_l: frame.fuel_l,
            tyres: frame.tyres,
            state: frame.state,
            fuel_per_lap_l: (!self.fuel_laps.is_empty()).then(|| self.fuel_laps.iter().sum::<f32>() / self.fuel_laps.len() as f32),
            fuel_tank_l: (self.fuel_tank > 0.0).then_some(self.fuel_tank),
            map: self.map.clone().or_else(|| self.partial_map.clone()),
            map_complete: self.map.is_some(),
            road: self.road.clone(),
            trail: self.trail.clone(),
            reference: matches!(frame.session_kind, Some(SessionKind::Practice | SessionKind::Qualifying))
                .then(|| self.best_path.clone())
                .flatten(),
            heading,
            pos,
            last_seen: self.last_seen.clone(),
            at_ms,
        }
    }

    /// Keeps the slow-changing values the frame carries, for the panel to show dimmed when a later frame has none.
    fn remember(&mut self, frame: &Frame) {
        let seen = &mut self.last_seen;
        if frame.driving && frame.gear.is_finite() {
            seen.gear = Some(frame.gear);
        }
        if frame.driving && frame.speed_ms.is_finite() {
            seen.speed_ms = Some(frame.speed_ms);
        }
        // Some games drop their fuel reading to 0 outside the car: that is not a reading.
        if frame.fuel_l.is_finite() && (frame.driving || frame.fuel_l > 0.0) {
            seen.fuel_l = Some(frame.fuel_l);
        }
        if let Some(tyres) = frame.tyres.filter(|t| t.iter().any(Tyre::known)) {
            seen.tyres = Some(tyres);
        }
        if let Some(t) = frame.state.water_c.filter(|t| t.is_finite()) {
            seen.water_c = Some(t);
        }
        if let Some(t) = frame.state.oil_c.filter(|t| t.is_finite()) {
            seen.oil_c = Some(t);
        }
    }

    /// The session ended (a restart, a new kind of session; a new car or track starts the whole tracker over before it
    /// gets here): the best lap, the fuel per lap, the rev bar's top and the gears belong to the session that is over.
    /// The map is the track's, not the session's, and stays.
    fn new_session(&mut self) {
        *self = Tracker {
            caps: self.caps,
            caps_seen: self.caps_seen,
            key: self.key.take(),
            store: self.store.take(),
            map_is_layout: self.map_is_layout,
            map: self.map.take(),
            road: self.road.take(),
            session: std::mem::take(&mut self.session),
            ..Tracker::default()
        };
    }

    /// The lap in progress is dropped (a restart that went on to a new session, a teleport, a lap number that jumped,
    /// a long time away): nothing of it becomes a best lap, a delta, a path or a fuel use.
    fn lap_lost(&mut self, frame: &Frame) {
        self.current.clear();
        self.path.clear();
        self.partial_map = None;
        self.trail = Arc::default();
        self.heading.reset();
        self.path_jumped = false;
        self.called_invalid = false;
        self.current_from_line = false;
        self.lap_sectors = [None; 2];
        self.fuel_lap_ended(frame, false);
    }

    /// The lap ended at the line: keep it until its official time shows (it can come a moment after the new lap starts),
    /// with the official time that was showing while it was driven (the one before it).
    fn lap_closed(&mut self, frame: &Frame) {
        self.fuel_lap_ended(frame, true);
        self.look_for_layout();
        let done = std::mem::take(&mut self.current);
        let jumped = std::mem::take(&mut self.path_jumped);
        let done_path = if jumped { Vec::new() } else { std::mem::take(&mut self.path) };
        self.path.clear();
        self.partial_map = None;
        let full = self.current_from_line && is_full(&done, frame.track_length_m);
        let invalid = std::mem::take(&mut self.called_invalid);
        if full && self.map.is_none() && done_path.len() >= MAP_MIN_POINTS {
            self.keep_map(done_path.clone());
        }
        self.finished = full.then_some((done, done_path, self.official, invalid));
        self.current_from_line = false;
    }

    /// A lap ended. If it went up by one (`advanced`), the lap began where this run saw it and nothing spoiled it (no
    /// refuel, no pit lane, never out of the car), the fuel it used counts: what it started with less what the last
    /// reading of it held, when that is above 0 and below `FUEL_MAX_SHARE` of the tank. The next lap starts with this
    /// frame's fuel.
    fn fuel_lap_ended(&mut self, frame: &Frame, advanced: bool) {
        if let (true, true, Some(start), Some(end)) = (advanced, self.fuel_clean, self.fuel_lap_start, self.fuel_prev) {
            let used = start - end;
            if used > 0.0 && used < FUEL_MAX_SHARE * self.fuel_tank {
                self.fuel_laps.push(used);
                if self.fuel_laps.len() > FUEL_LAPS {
                    self.fuel_laps.remove(0);
                }
            }
        }
        let fuel = Some(frame.fuel_l).filter(|f| f.is_finite());
        self.see_tank(frame, fuel.unwrap_or(0.0));
        self.fuel_clean = frame.driving && !frame.in_pits;
        self.fuel_lap_start = fuel.filter(|_| advanced && self.fuel_clean);
        self.fuel_prev = fuel;
    }

    /// The tank: the game's own capacity when it gives one, else the biggest fuel reading seen.
    fn see_tank(&mut self, frame: &Frame, fuel: f32) {
        self.fuel_tank = match frame.fuel_capacity_l.filter(|c| c.is_finite() && *c > 0.0) {
            Some(capacity) => capacity,
            None => self.fuel_tank.max(fuel),
        };
    }

    /// A reading within the lap: the tank, the last fuel, and whether the lap is still clean.
    fn fuel_seen(&mut self, frame: &Frame) {
        if !frame.driving || frame.in_pits {
            self.fuel_clean = false;
        }
        if frame.fuel_l.is_finite() {
            if self.fuel_prev.is_some_and(|prev| frame.fuel_l > prev + REFUEL_LITRES) {
                self.fuel_clean = false;
            }
            self.see_tank(frame, frame.fuel_l);
            self.fuel_prev = Some(frame.fuel_l);
        }
    }

    /// Remembers the highest forward gear. It only counts as the car's top gear once the car has been seen in a lower
    /// one after it: just reaching a gear says nothing about whether there is another above it.
    fn see_gear(&mut self, gear: f32) {
        if !gear.is_finite() || !(1.0..=30.0).contains(&gear.round()) {
            return;
        }
        let g = gear.round() as u8;
        if g > self.top_gear {
            self.top_gear = g;
            self.top_gear_left = false;
        } else if g < self.top_gear {
            self.top_gear_left = true;
        }
    }

    fn offer_best(&mut self, time: f64, profile: Profile, path: Path, invalid: bool) {
        if invalid {
            return;
        }
        if self.best.as_ref().is_none_or(|(best, _)| time < *best) {
            self.best = Some((time, profile));
            self.best_path = (path.len() >= MAP_MIN_POINTS).then(|| Arc::new(path.clone()));
            if path.len() >= MAP_MIN_POINTS && !self.map_is_layout {
                self.keep_map(path);
            }
        }
    }

    /// Makes `path` the map and saves it for this track, so the next session starts with it.
    fn keep_map(&mut self, path: Path) {
        if let (Some(store), Some((track, _, variant))) = (&self.store, &self.key) {
            if let Err(error) = store.save(track, variant.as_deref(), &path) {
                crate::applog::line(&format!("Cannot keep the map of {track}: {error}"));
            }
        }
        self.map = Some(Arc::new(path));
    }

    /// The layout is built a moment after the game says its track: take it once it is there.
    fn look_for_layout(&mut self) {
        if self.map_is_layout {
            return;
        }
        if let (Some(store), Some((track, _, variant))) = (&self.store, &self.key) {
            if let Some(path) = store.layout(track, variant.as_deref()) {
                self.map = Some(Arc::new(path));
                self.road = store.road(track, variant.as_deref()).map(Arc::new);
                self.map_is_layout = true;
            }
        }
    }
}

/// From near the line to (when the length is known) most of the way round.
fn is_full(profile: &Profile, length: Option<f64>) -> bool {
    let (Some(first), Some(last)) = (profile.first(), profile.last()) else {
        return false;
    };
    first.0 <= FROM_LINE_METRES && length.is_none_or(|length| last.0 >= length * FULL_LAP_SHARE)
}

/// The best lap's time at `dist`, between the two readings around it. `None` past either end.
fn time_at(profile: &Profile, dist: f64) -> Option<f64> {
    let after = profile.partition_point(|&(d, _)| d < dist);
    if after == 0 || after == profile.len() {
        return profile.get(after).filter(|&&(d, _)| d == dist).map(|&(_, t)| t);
    }
    let ((d0, t0), (d1, t1)) = (profile[after - 1], profile[after]);
    Some(t0 + (t1 - t0) * (dist - d0) / (d1 - d0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_camera_uses_motion_and_retains_a_bounded_trail_without_rebuilding_a_stationary_map() {
        let mut tracker = Tracker::default();
        let mut live = None;
        for i in 0..100 {
            let mut frame = at(1, f64::from(i) * 4.0, f64::from(i) * 0.1, None);
            frame.x = i as f32 * 4.0;
            frame.z = 0.0;
            live = Some(tracker.on_frame("ac", &frame, i64::from(i) * 100));
        }
        let live = live.unwrap();
        assert_eq!(live.heading, Some((1.0, 0.0)));
        assert_eq!(live.trail.len(), 32);
        let mut frame = at(1, 396.0, 10.0, None);
        frame.x = 396.0;
        frame.z = 0.0;
        let stopped = tracker.on_frame("ac", &frame, 10000);
        assert_eq!(stopped.heading, live.heading);
        assert!(Arc::ptr_eq(live.map.as_ref().unwrap(), stopped.map.as_ref().unwrap()));
        frame.x = 5000.0;
        let jumped = tracker.on_frame("ac", &frame, 10100);
        assert!(jumped.heading.is_none());
        assert!(jumped.trail.len() <= 1, "no line connects a teleport");
    }

    #[test]
    fn session_best_path_is_never_automatically_a_race_reference() {
        let mut tracker = Tracker::default();
        let mut frame = at(1, 0.0, 0.0, None);
        tracker.on_frame("ac", &frame, 0);
        let path = (0..40).map(|i| (0.0, i as f32 * 4.0)).collect();
        tracker.offer_best(60.0, vec![(0.0, 0.0), (1000.0, 60.0)], path, false);
        frame.session_kind = Some(SessionKind::Qualifying);
        let qualifying = tracker.on_frame("ac", &frame, 100);
        assert!(qualifying.reference.is_some());
        frame.session_kind = Some(SessionKind::Race);
        assert!(tracker.on_frame("ac", &frame, 200).reference.is_none());
        let race_path = (0..40).map(|i| (0.0, i as f32 * 4.0)).collect();
        tracker.offer_best(59.0, vec![(0.0, 0.0), (1000.0, 59.0)], race_path, false);
        assert!(
            tracker.on_frame("ac", &frame, 250).reference.is_none(),
            "even a valid race best is not selected as a line to chase"
        );
        frame.session_kind = None;
        assert!(tracker.on_frame("ac", &frame, 300).reference.is_none());
        tracker.new_session();
        frame.session_kind = Some(SessionKind::Practice);
        assert!(
            tracker.on_frame("ac", &frame, 400).reference.is_none(),
            "the reference belongs to its session"
        );
    }

    /// A frame at `dist` metres into lap `lap`, `t` seconds after it began.
    fn at(lap: i32, dist: f64, t: f64, last: Option<f64>) -> Frame {
        let mut frame = Frame::empty();
        frame.driving = true;
        frame.lap = lap;
        frame.dist_m = Some(dist);
        frame.lap_time_s = Some(t);
        frame.last_lap_s = last;
        frame.track = "Monza".into();
        frame.car = "GT3".into();
        frame.track_length_m = Some(1000.0);
        frame.rpm = 5000.0 + dist as f32;
        frame
    }

    /// Drives lap `lap` at a constant `speed` (m/s), ten readings a second; `last` is the official time showing.
    fn drive_lap(tracker: &mut Tracker, lap: i32, speed: f64, last: Option<f64>) -> Vec<Live> {
        let duration = 1000.0 / speed;
        (0..(duration * 10.0) as usize)
            .map(|i| {
                let t = i as f64 / 10.0;
                tracker.on_frame("Test", &at(lap, t * speed, t, last), 0)
            })
            .collect()
    }

    /// Drives lap `lap` with the fuel going from `from` to `to` litres, `pits` of it in the pit lane.
    fn drive_fuel(tracker: &mut Tracker, lap: i32, from: f32, to: f32) -> Live {
        let mut last = None;
        for i in 0..=100 {
            let mut f = at(lap, f64::from(i) * 9.0, f64::from(i) / 10.0, None);
            f.fuel_l = from + (to - from) * i as f32 / 100.0;
            last = Some(tracker.on_frame("Test", &f, 0));
        }
        last.unwrap()
    }

    #[test]
    fn the_fuel_per_lap_is_the_average_of_the_last_three_full_laps() {
        let mut tracker = Tracker::default();
        // Lap 1 is joined from the start of the run, not seen beginning: it does not count.
        let live = drive_fuel(&mut tracker, 1, 50.0, 47.5);
        assert_eq!(live.fuel_per_lap_l, None);
        // Laps 2 and 3 are full: 2 l and 2.5 l.
        let live = drive_fuel(&mut tracker, 2, 47.0, 45.0);
        assert_eq!(live.fuel_per_lap_l, None, "lap 2 is not over until lap 3 starts");
        let live = drive_fuel(&mut tracker, 3, 45.0, 42.5);
        assert_eq!(live.fuel_per_lap_l, Some(2.0), "lap 2 used 47 - 45");
        let live = drive_fuel(&mut tracker, 4, 42.5, 40.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.25), "laps 2 and 3: (2 + 2.5) / 2");
        // The average keeps the last three: lap 5 uses 3 l, lap 6 uses 3.5 l, so laps 4, 5, 6.
        drive_fuel(&mut tracker, 5, 40.0, 37.0);
        drive_fuel(&mut tracker, 6, 37.0, 33.5);
        let live = drive_fuel(&mut tracker, 7, 33.5, 31.0);
        let want = (2.5 + 3.0 + 3.5) / 3.0;
        assert!((live.fuel_per_lap_l.unwrap() - want).abs() < 1e-5, "{:?}", live.fuel_per_lap_l);
    }

    #[test]
    fn the_games_own_tank_size_stands_in_for_the_biggest_reading_seen() {
        // Joined with 10 l left in a 100 l tank: a lap of 4 l is not "more than 30 % of the 10 l seen".
        let drive = |capacity: Option<f32>| {
            let mut tracker = Tracker::default();
            let mut last = None;
            for (lap, from, to) in [(1, 10.0, 9.0), (2, 9.0, 8.0), (3, 8.0, 4.0), (4, 4.0, 3.0)] {
                for i in 0..=100 {
                    let mut f = at(lap, f64::from(i) * 9.0, f64::from(i) / 10.0, None);
                    f.fuel_l = from + (to - from) * i as f32 / 100.0;
                    f.fuel_capacity_l = capacity;
                    last = Some(tracker.on_frame("Test", &f, 0));
                }
            }
            last.unwrap().fuel_per_lap_l
        };
        assert_eq!(
            drive(None),
            Some(1.0),
            "without a capacity the 4 l lap is over 30 % of the 10 l seen: dropped"
        );
        assert_eq!(drive(Some(100.0)), Some(2.5), "laps 2 and 3 used 1 l and 4 l");
    }

    #[test]
    fn a_refuel_a_pit_lap_and_a_partial_lap_do_not_count() {
        let mut tracker = Tracker::default();
        drive_fuel(&mut tracker, 1, 50.0, 48.0);
        drive_fuel(&mut tracker, 2, 48.0, 46.0);
        let live = drive_fuel(&mut tracker, 3, 46.0, 44.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0));
        // Lap 4: the fuel goes up half way round (a refuel) and comes down again.
        for i in 0..=100 {
            let mut f = at(4, f64::from(i) * 9.0, f64::from(i) / 10.0, None);
            f.fuel_l = if i < 50 {
                44.0 - i as f32 / 50.0
            } else {
                60.0 - (i - 50) as f32 / 50.0
            };
            tracker.on_frame("Test", &f, 0);
        }
        let live = drive_fuel(&mut tracker, 5, 59.0, 57.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0), "the refuelled lap 4 added nothing");
        // Lap 5 in the pit lane: not a lap's use either.
        for i in 0..50 {
            let mut f = at(5, 400.0 + f64::from(i), 40.0 + f64::from(i) / 10.0, None);
            f.fuel_l = 57.0;
            f.in_pits = true;
            tracker.on_frame("Test", &f, 0);
        }
        drive_fuel(&mut tracker, 6, 57.0, 55.0);
        let live = drive_fuel(&mut tracker, 7, 55.0, 53.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0));
        // The fuel dropping by more than 30 % of the tank in a lap (a missed refuel or a restart) is not a lap's use.
        drive_fuel(&mut tracker, 8, 53.0, 10.0);
        let live = drive_fuel(&mut tracker, 9, 10.0, 8.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0), "43 l in one lap of a 60 l tank is not credible");
        // A lap that jumps a number (a restart to lap 12) is not a lap one longer than the one before it.
        drive_fuel(&mut tracker, 12, 8.0, 6.0);
        let live = drive_fuel(&mut tracker, 13, 6.0, 4.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0));
        // A reading without a fuel (a game that gives none) never makes a fuel per lap.
        let mut other = Tracker::default();
        for lap in 1..=4 {
            let live = drive_lap(&mut other, lap, 50.0, None).pop().unwrap();
            assert_eq!(live.fuel_per_lap_l, None);
        }
    }

    #[test]
    fn a_new_track_or_car_starts_the_fuel_per_lap_over() {
        let mut tracker = Tracker::default();
        for (lap, from) in [(1, 50.0), (2, 48.0), (3, 46.0), (4, 44.0)] {
            drive_fuel(&mut tracker, lap, from, from - 2.0);
        }
        let live = drive_fuel(&mut tracker, 5, 42.0, 40.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0));
        let mut frame = at(1, 0.0, 0.0, None);
        frame.track = "Spa".into();
        frame.fuel_l = 40.0;
        let live = tracker.on_frame("Test", &frame, 0);
        assert_eq!(live.fuel_per_lap_l, None, "another track");
        // And a lap of the new track begun from its start counts only once seen from the start.
        let live = drive_fuel_on(&mut tracker, "Spa", 2, 40.0, 38.0);
        assert_eq!(live.fuel_per_lap_l, None);
        let live = drive_fuel_on(&mut tracker, "Spa", 3, 38.0, 36.0);
        assert_eq!(live.fuel_per_lap_l, Some(2.0));
        let mut changed_car = at(3, 10.0, 1.0, None);
        changed_car.track = "Spa".into();
        changed_car.car = "LMP2".into();
        changed_car.fuel_l = 30.0;
        assert_eq!(tracker.on_frame("Test", &changed_car, 0).fuel_per_lap_l, None, "another car");
    }

    fn drive_fuel_on(tracker: &mut Tracker, track: &str, lap: i32, from: f32, to: f32) -> Live {
        let mut last = None;
        for i in 0..=100 {
            let mut f = at(lap, f64::from(i) * 9.0, f64::from(i) / 10.0, None);
            f.track = track.into();
            f.fuel_l = from + (to - from) * i as f32 / 100.0;
            last = Some(tracker.on_frame("Test", &f, 0));
        }
        last.unwrap()
    }

    #[test]
    fn no_delta_before_a_best_lap_then_the_gap_to_it() {
        let mut tracker = Tracker::default();
        let first = drive_lap(&mut tracker, 1, 50.0, None);
        assert!(first.iter().all(|l| l.delta_s.is_none() && l.best_lap_s.is_none()));
        // The second lap is slower (40 m/s); its official time for lap 1 (20 s) shows from its start.
        let second = drive_lap(&mut tracker, 2, 40.0, Some(20.0));
        assert_eq!(second[5].best_lap_s, Some(20.0));
        // Halfway: 12.5 s against the best lap's 10 s.
        let halfway = second.iter().find(|l| l.dist_m == Some(500.0)).unwrap();
        assert!((halfway.delta_s.unwrap() - 2.5).abs() < 1e-9, "{:?}", halfway.delta_s);
    }

    #[test]
    fn a_faster_lap_becomes_the_best_and_a_slower_one_does_not() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        drive_lap(&mut tracker, 2, 40.0, Some(20.0));
        let third = drive_lap(&mut tracker, 3, 50.0, Some(25.0));
        assert_eq!(third.last().unwrap().best_lap_s, Some(20.0), "25 s is not better than 20 s");
        let fourth = drive_lap(&mut tracker, 4, 60.0, Some(20.0));
        assert_eq!(fourth.last().unwrap().best_lap_s, Some(20.0));
        let fifth = drive_lap(&mut tracker, 5, 60.0, Some(1000.0 / 60.0));
        assert!(
            (fifth[3].best_lap_s.unwrap() - 1000.0 / 60.0).abs() < 1e-9,
            "the faster lap 4 is the best now"
        );
    }

    #[test]
    fn the_official_time_can_come_a_moment_after_the_new_lap() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        // The first readings of lap 2 still show no last lap; then 20 s shows.
        tracker.on_frame("Test", &at(2, 0.0, 0.0, None), 0);
        tracker.on_frame("Test", &at(2, 5.0, 0.1, None), 0);
        let live = tracker.on_frame("Test", &at(2, 10.0, 0.2, Some(20.0)), 0);
        assert_eq!(live.best_lap_s, Some(20.0));
    }

    #[test]
    fn a_lap_joined_midway_is_not_a_best_lap_and_has_no_delta() {
        let mut tracker = Tracker::default();
        // Joined at 600 m.
        for i in 0..80 {
            tracker.on_frame("Test", &at(1, 600.0 + i as f64 * 5.0, 12.0 + i as f64 * 0.1, None), 0);
        }
        let second = drive_lap(&mut tracker, 2, 50.0, Some(20.0));
        assert!(second.iter().all(|l| l.best_lap_s.is_none() && l.delta_s.is_none()));
    }

    #[test]
    fn another_track_or_car_starts_over() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        drive_lap(&mut tracker, 2, 50.0, Some(20.0));
        let mut other = at(1, 0.0, 0.0, None);
        other.car = "Hypercar".into();
        let live = tracker.on_frame("Test", &other, 0);
        assert_eq!((live.best_lap_s, live.rpm_top), (None, 5000.0));
    }

    #[test]
    fn the_gear_count_is_the_games_or_the_top_gear_seen_once_it_was_left() {
        let mut tracker = Tracker::default();
        let mut frame = at(1, 0.0, 0.0, None);
        let mut gears = |tracker: &mut Tracker, gear: f32, count: Option<u8>| {
            frame.gear = gear;
            frame.gears = count;
            tracker.on_frame("Test", &frame, 0).gears
        };
        // Climbing through the gears says nothing yet: there may be one more above.
        assert_eq!(gears(&mut tracker, 1.0, None), None);
        assert_eq!(gears(&mut tracker, 2.0, None), None);
        assert_eq!(gears(&mut tracker, 6.0, None), None);
        assert_eq!(gears(&mut tracker, 0.0, None), None, "neutral is not a lower gear");
        // Back from 6th to 5th: 6 is the highest seen, and the car has been below it since.
        assert_eq!(gears(&mut tracker, 5.0, None), Some(6));
        assert_eq!(gears(&mut tracker, 6.0, None), Some(6));
        // The game's own count wins.
        assert_eq!(gears(&mut tracker, 6.0, Some(7)), Some(7));
        // Reverse is not a forward gear.
        let mut other = Tracker::default();
        assert_eq!(gears(&mut other, -1.0, None), None);
        assert_eq!(gears(&mut other, f32::NAN, None), None);
    }

    #[test]
    fn another_car_forgets_the_top_gear() {
        let mut tracker = Tracker::default();
        let mut frame = at(1, 0.0, 0.0, None);
        for gear in [4.0, 3.0] {
            frame.gear = gear;
            tracker.on_frame("Test", &frame, 0);
        }
        frame.car = "Other".into();
        assert_eq!(tracker.on_frame("Test", &frame, 0).gears, None);
    }

    #[test]
    fn keeps_the_top_rpm_seen() {
        let mut tracker = Tracker::default();
        let lap = drive_lap(&mut tracker, 1, 50.0, None);
        assert_eq!(lap.last().unwrap().rpm_top, lap.last().unwrap().rpm);
        let mut slow = at(1, 999.5, 19.99, None);
        slow.rpm = 3000.0;
        assert_eq!(tracker.on_frame("Test", &slow, 0).rpm_top, lap.last().unwrap().rpm);
    }

    #[test]
    fn turns_le_mans_ultimate_into_a_frame_and_carries_the_distance_forward() {
        use crate::lmu::snapshot::{SessionScoring, VehicleScoring};
        let t = PlayerTelemetry {
            elapsed_time: 100.4,
            lap_number: 5,
            lap_start_et: 60.0,
            vehicle_name: "Porsche 963".into(),
            track_name: "Sarthe".into(),
            local_vel: [0.0, 0.0, -50.0],
            gear: 5,
            max_gears: 7,
            rpm: 7800.0,
            throttle: 1.0,
            steering: -0.2,
            fuel_l: 40.0,
            ..PlayerTelemetry::default()
        };
        let scoring = ScoringFrame {
            session: SessionScoring {
                track_name: "Circuit de la Sarthe".into(),
                track_length_m: 13_626.0,
                current_et: 100.0,
                in_realtime: true,
                ..SessionScoring::default()
            },
            player: Some(VehicleScoring {
                vehicle_class: "Hypercar".into(),
                lap_dist: 2000.0,
                last_lap_time: 210.5,
                ..VehicleScoring::default()
            }),
        };
        let frame = lmu_frame(&t, Some(&scoring));
        assert!(frame.driving);
        assert_eq!((frame.lap, frame.speed_ms, frame.gear, frame.steer), (5, 50.0, 5.0, -0.2));
        assert_eq!(frame.gears, Some(7));
        assert!((frame.lap_time_s.unwrap() - 40.4).abs() < 1e-9);
        assert!(
            (frame.dist_m.unwrap() - 2020.0).abs() < 1e-9,
            "0.4 s at 50 m/s past the last scoring"
        );
        assert_eq!(frame.last_lap_s, Some(210.5));
        assert_eq!(frame.track, "Circuit de la Sarthe");
        assert_eq!(frame.car_class.as_deref(), Some("Hypercar"));

        // Just over the line, the scoring still shows the end of the last lap.
        let mut just_over = t.clone();
        just_over.lap_start_et = 100.0;
        let mut late = scoring.clone();
        late.player.as_mut().unwrap().lap_dist = 13_600.0;
        assert_eq!(lmu_frame(&just_over, Some(&late)).dist_m, None);
        // Without scoring yet: no distance, and nobody knows yet whether the car is driven (it used to count as driven).
        let alone = lmu_frame(&t, None);
        assert!(!alone.driving && alone.phase == Phase::Unknown);
        assert!(alone.dist_m.is_none() && alone.track == "Sarthe");
        assert!(
            alone.speed_ms.is_nan() && alone.gear.is_nan(),
            "no car values until it is known to be driven"
        );
        assert_eq!(alone.fuel_l, 40.0, "fuel stays");
    }

    fn lmu_scoring(in_realtime: bool, game_phase: u8) -> ScoringFrame {
        ScoringFrame {
            session: crate::lmu::snapshot::SessionScoring {
                in_realtime,
                game_phase,
                ..Default::default()
            },
            player: None,
        }
    }

    #[test]
    fn the_scoring_says_which_phase_le_mans_ultimate_is_in() {
        assert_eq!(lmu_phase(None), Phase::Unknown, "no scoring yet");
        assert_eq!(
            lmu_phase(Some(&lmu_scoring(false, 5))),
            Phase::Garage,
            "not in realtime: the monitor"
        );
        for (game_phase, want) in [
            (0, Phase::Driving),
            (1, Phase::Driving),
            (2, Phase::Loading),
            (3, Phase::Loading),
            (4, Phase::Loading),
            (5, Phase::Driving),
            (6, Phase::Driving),
            (7, Phase::Driving),
            (8, Phase::Driving),
            (9, Phase::Paused),
            (10, Phase::Unknown),
            (255, Phase::Unknown),
        ] {
            assert_eq!(lmu_phase(Some(&lmu_scoring(true, game_phase))), want, "game phase {game_phase}");
        }
    }

    #[test]
    fn le_mans_ultimate_gives_no_car_values_unless_driving_and_scrubs_the_rest() {
        let t = PlayerTelemetry {
            elapsed_time: 321.5,
            local_vel: [0.0, 0.0, -30.0],
            gear: 3,
            rpm: 6000.0,
            throttle: 0.5,
            brake: 0.25,
            clutch: 0.0,
            steering: -0.5,
            fuel_l: 50.0,
            ..PlayerTelemetry::default()
        };
        // The garage keeps the last telemetry in memory: none of the car values reach the frame, the fuel does.
        let garage = lmu_frame(&t, Some(&lmu_scoring(false, 5)));
        assert_eq!(garage.phase, Phase::Garage);
        for v in [
            garage.speed_ms,
            garage.rpm,
            garage.gear,
            garage.throttle,
            garage.brake,
            garage.clutch,
            garage.steer,
        ] {
            assert!(v.is_nan());
        }
        assert_eq!(garage.fuel_l, 50.0);
        let paused = lmu_frame(&t, Some(&lmu_scoring(true, 9)));
        assert_eq!((paused.phase, paused.driving), (Phase::Paused, false));
        assert!(paused.gear.is_nan());
        // Driving: the values, and the clock is the telemetry's elapsed time.
        let on = lmu_frame(&t, Some(&lmu_scoring(true, 5)));
        assert_eq!((on.phase, on.driving, on.clock_s), (Phase::Driving, true, 321.5));
        assert_eq!(
            (on.speed_ms, on.rpm, on.gear, on.throttle, on.brake, on.clutch, on.steer, on.fuel_l),
            (30.0, 6000.0, 3.0, 0.5, 0.25, 0.0, -0.5, 50.0)
        );
        // Garbage is not a value: not finite, absurd, or far out of range is "not given"; a little outside is pulled in.
        let bad = PlayerTelemetry {
            local_vel: [f64::NAN, 0.0, 0.0],
            gear: 99,
            rpm: f64::INFINITY,
            throttle: 7.0,
            brake: 1.2,
            clutch: -0.2,
            steering: f64::NAN,
            fuel_l: -3.0,
            ..t.clone()
        };
        let f = lmu_frame(&bad, Some(&lmu_scoring(true, 5)));
        for v in [f.speed_ms, f.rpm, f.gear, f.throttle, f.steer, f.fuel_l] {
            assert!(v.is_nan());
        }
        assert_eq!((f.brake, f.clutch), (1.0, 0.0));
        // A clock that is not a time stays at 0.
        let f = lmu_frame(
            &PlayerTelemetry {
                elapsed_time: f64::NAN,
                ..t.clone()
            },
            None,
        );
        assert_eq!(f.clock_s, 0.0);
    }

    #[test]
    fn a_le_mans_ultimate_frame_carries_the_car_state() {
        use crate::lmu::snapshot::{SessionScoring, VehicleScoring};
        let t = PlayerTelemetry {
            water_c: 88.5,
            oil_c: 101.25,
            overheating: true,
            headlights: true,
            speed_limiter_active: true,
            abs_active: false,
            tc_active: true,
            tc: 4,
            tc_max: 10,
            abs: 0,
            abs_max: 0,
            motor_map: 3,
            motor_map_max: 5,
            rear_brake_bias: 0.375,
            dents: [0, 2, 1, 0, 0, 0, 0, 1],
            rear_flap_activated: false,
            rear_flap_legal: 2,
            ..PlayerTelemetry::default()
        };
        let scoring = |flag: u8, under_yellow: bool| ScoringFrame {
            session: SessionScoring::default(),
            player: Some(VehicleScoring {
                flag,
                under_yellow,
                ..VehicleScoring::default()
            }),
        };
        let state = lmu_frame(&t, Some(&scoring(6, false))).state;
        assert_eq!(
            state,
            CarState {
                pit_limiter: Some(true),
                abs_active: Some(false),
                tc_active: Some(true),
                drs: Some(Drs::Available),
                headlights: Some(true),
                handbrake: None,
                engine_warning: Some(true),
                flag: Some(Flag::Blue),
                water_c: Some(88.5),
                oil_c: Some(101.25),
                tc_level: Some(4),
                abs_level: None, // the car has no ABS (its maximum is 0)
                engine_map: Some(3),
                brake_bias: Some(0.625), // 0.375 of the braking is on the rear
                damage_body: Some(0.25), // dents 2 + 1 + 1 of a worst case of 16
                damage_engine: None,
                damage_gearbox: None,
                damage_suspension: None,
            }
        );
        assert_eq!(lmu_frame(&t, Some(&scoring(0, true))).state.flag, Some(Flag::Yellow));
        assert_eq!(lmu_frame(&t, Some(&scoring(0, false))).state.flag, None);
        assert_eq!(
            lmu_frame(&t, Some(&scoring(6, true))).state.flag,
            Some(Flag::Yellow),
            "yellow outranks blue (norm::flag_showing)"
        );
        assert_eq!(lmu_frame(&t, None).state.flag, None, "no scoring yet");
        // The rear flap: activated is open; "1" is not yet; 0 is what a car without one writes.
        let mut flap = t.clone();
        flap.rear_flap_activated = true;
        assert_eq!(lmu_frame(&flap, None).state.drs, Some(Drs::Open));
        flap.rear_flap_activated = false;
        flap.rear_flap_legal = 1;
        assert_eq!(lmu_frame(&flap, None).state.drs, Some(Drs::Off));
        flap.rear_flap_legal = 0;
        assert_eq!(lmu_frame(&flap, None).state.drs, None);
        // Nothing the game left at 0 is shown as a temperature or a bias.
        let blank = lmu_frame(&PlayerTelemetry::default(), None).state;
        assert_eq!((blank.water_c, blank.oil_c, blank.brake_bias), (None, None, None));
        assert_eq!((blank.tc_level, blank.engine_map), (None, None));
    }

    #[test]
    fn the_map_is_the_first_full_lap_then_the_best_one_and_shows_where_the_car_is() {
        let mut tracker = Tracker::default();
        let driven = |tracker: &mut Tracker, lap: i32, last: Option<f64>, wobble: f32| {
            let mut out = Vec::new();
            for i in 0..200 {
                let mut frame = at(lap, i as f64 * 5.0, i as f64 * 0.1, last);
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                (frame.x, frame.z) = (160.0 * a.cos() + wobble, 160.0 * a.sin());
                out.push(tracker.on_frame("Test", &frame, 0));
            }
            out
        };
        let first = driven(&mut tracker, 1, None, 0.0);
        assert!(first[10].map.is_none(), "too few points for a map");
        assert!(
            first[199].map.as_ref().is_some_and(|m| m.len() > 100),
            "the lap being driven, until one is done"
        );
        assert_eq!(
            first[199].pos,
            Some((
                160.0 * (199.0f32 / 200.0 * std::f32::consts::TAU).cos(),
                160.0 * (199.0f32 / 200.0 * std::f32::consts::TAU).sin()
            ))
        );
        let second = driven(&mut tracker, 2, Some(20.0), 50.0);
        assert_eq!(second[0].map.as_ref().unwrap()[0], (160.0, 0.0), "the first full lap is the map");
        let third = driven(&mut tracker, 3, Some(19.0), 0.0);
        assert_eq!(
            third[5].map.as_ref().unwrap()[0],
            (210.0, 0.0),
            "lap 2 (19 s) became the best lap, and its path the map"
        );
        let mut tyred = at(3, 1000.0, 20.0, None);
        tyred.tyres = Some(
            [Tyre {
                brake_c: f32::NAN,
                temp_c: 85.0,
                pressure_kpa: 180.0,
                left: 0.9,
                tread_c: None,
            }; 4],
        );
        assert_eq!(tracker.on_frame("Test", &tyred, 0).tyres.unwrap()[2].temp_c, 85.0);
    }

    #[test]
    fn a_le_mans_ultimate_frame_carries_the_car_position_for_the_map() {
        let t = PlayerTelemetry {
            pos: [120.5, 3.0, -840.25],
            ..PlayerTelemetry::default()
        };
        let frame = lmu_frame(&t, None);
        assert_eq!((frame.x, frame.y, frame.z), (120.5, 3.0, -840.25));
        let mut tracker = Tracker::default();
        assert_eq!(tracker.on_frame("Le Mans Ultimate", &frame, 0).pos, Some((120.5, -840.25)));
        for bad in [f64::NAN, f64::INFINITY, 1.0e12] {
            let t = PlayerTelemetry {
                pos: [bad, 0.0, bad],
                ..PlayerTelemetry::default()
            };
            let frame = lmu_frame(&t, None);
            assert!(frame.x.is_nan() && frame.z.is_nan(), "{bad} is not a position");
        }
    }

    #[test]
    fn a_jump_in_the_path_is_not_a_lap_s_map_and_a_partial_path_is_not_complete() {
        let mut tracker = Tracker::default();
        let drive = |tracker: &mut Tracker, lap: i32, last: Option<f64>, jump_at: Option<usize>| {
            let mut out = Vec::new();
            for i in 0..200 {
                let mut frame = at(lap, i as f64 * 5.0, i as f64 * 0.1, last);
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                let r = if jump_at.is_some_and(|j| i >= j) { 300.0 } else { 160.0 };
                (frame.x, frame.z) = (r * a.cos(), r * a.sin());
                out.push(tracker.on_frame("Test", &frame, 0));
            }
            out
        };
        let first = drive(&mut tracker, 1, None, Some(100));
        assert!(first.iter().all(|l| !l.map_complete), "a lap being driven is a partial path");
        // Lap 1 had a teleport: it is no map, even though it was a full lap.
        let second = drive(&mut tracker, 2, Some(20.0), None);
        assert!(!second[5].map_complete, "a path with a jump is not taken as the map");
        drive(&mut tracker, 3, Some(20.0), None);
        let fourth = drive(&mut tracker, 4, Some(20.0), None);
        assert!(fourth[0].map_complete, "a clean full lap is");
        assert_eq!(fourth[0].map.as_ref().unwrap()[0], (160.0, 0.0));
    }

    #[test]
    fn a_saved_map_is_offered_at_once_for_its_track_only() {
        let dir = crate::config::scratch_dir("dash-maps");
        let store = || Store {
            maps: dir.join("maps"),
            layouts: dir.join("tracks"),
            game: "lmu",
        };
        let lap = |tracker: &mut Tracker, lap: i32, last: Option<f64>, radius: f32, track: &str| {
            let mut out = Vec::new();
            for i in 0..200 {
                let mut frame = at(lap, i as f64 * 5.0, i as f64 * 0.1, last);
                frame.track = track.into();
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                (frame.x, frame.z) = (radius * a.cos(), radius * a.sin());
                out.push(tracker.on_frame("Test", &frame, 0));
            }
            out
        };
        let mut first = Tracker::stored(store());
        let one = lap(&mut first, 1, None, 160.0, "Monza");
        assert!(one[0].map.is_none(), "nothing saved yet");
        lap(&mut first, 2, Some(20.0), 210.0, "Monza");
        assert!(
            store().load("Monza", None).is_some_and(|m| m.len() > 100),
            "the first full lap was saved"
        );
        // Lap 2 (19 s) is the best lap once lap 3 shows its time: its path replaces the first, and the file follows.
        lap(&mut first, 3, Some(19.0), 160.0, "Monza");
        assert_eq!(store().load("Monza", None).unwrap()[0], (210.0, 0.0));

        // A new session: the map is there from the first frame, on that track only.
        let mut next = Tracker::stored(store());
        let again = lap(&mut next, 1, None, 50.0, "Monza");
        assert_eq!(again[0].map.as_ref().unwrap()[0], (210.0, 0.0));
        let mut other = Tracker::stored(store());
        assert!(lap(&mut other, 1, None, 50.0, "Spa")[0].map.is_none());
        // Moving to another track on the same tracker drops the old track's map.
        let mut moved = Tracker::stored(store());
        lap(&mut moved, 1, None, 50.0, "Monza");
        assert!(lap(&mut moved, 1, None, 50.0, "Spa")[0].map.is_none());
    }

    #[test]
    fn reads_le_mans_ultimate_tyres_in_celsius_and_leaves_out_what_is_empty() {
        use crate::lmu::snapshot::Wheel;
        let mut t = PlayerTelemetry::default();
        t.wheels[0] = Wheel {
            brake_temp_c: 412.5,
            pressure_kpa: 175.0,
            temperature_k: [358.15, 363.15, 368.15],
            wear: 0.94,
        };
        let frame = lmu_frame(&t, None);
        let tyres = frame.tyres.expect("one wheel is enough");
        assert!((tyres[0].temp_c - 90.0).abs() < 1e-3);
        assert_eq!((tyres[0].pressure_kpa, tyres[0].left), (175.0, 0.94));
        // Across the tread: a left tyre's right edge is its inner one.
        let across = tyres[0].tread_c.expect("the three readings are given");
        for (got, want) in across.iter().zip([95.0, 90.0, 85.0]) {
            assert!((got - want).abs() < 1e-3, "{across:?}");
        }
        assert_eq!(tyres[1].tread_c, None);
        assert_eq!(tyres[0].brake_c, 412.5, "the brake temperature is already Celsius");
        assert!(tyres[1].brake_c.is_nan(), "0 is the header's nothing");
        assert!(!tyres[1].known(), "an empty wheel says nothing");
        // A brake temperature alone is something to show.
        let mut only_brakes = PlayerTelemetry::default();
        only_brakes.wheels[2].brake_temp_c = 350.0;
        let tyres = lmu_frame(&only_brakes, None).tyres.expect("a brake temperature is enough");
        assert!(tyres[2].known() && tyres[2].temp_c.is_nan());
        assert!(lmu_frame(&PlayerTelemetry::default(), None).tyres.is_none());
        // The game's quirk (Kelvin, 0 when not written) goes through the shared tolerances: a reading with one of the three
        // missing, or a unit that is not Kelvin, is "not given", never a cold or an absurd tyre.
        let mut odd = PlayerTelemetry::default();
        for (k, brake, pressure, wear) in [
            ([358.15, 0.0, 368.15], 100.0, 175.0, 0.9),
            ([90.0, 90.0, 90.0], 100.0, 175.0, 0.9),
            ([900.0, 900.0, 900.0], 100.0, 175.0, 0.9),
        ] {
            odd.wheels[1] = Wheel {
                brake_temp_c: brake,
                pressure_kpa: pressure,
                temperature_k: k,
                wear,
            };
            let tyre = lmu_frame(&odd, None).tyres.unwrap()[1];
            assert!(tyre.temp_c.is_nan() && tyre.tread_c.is_none(), "{k:?}");
        }
        // Values far out of range are not given, as in every other reader (`norm`).
        odd.wheels[1] = Wheel {
            brake_temp_c: 2500.0,
            pressure_kpa: 5000.0,
            temperature_k: [358.15; 3],
            wear: 1.5,
        };
        let wheel = lmu_frame(&odd, None).tyres.unwrap()[1];
        assert!(wheel.brake_c.is_nan() && wheel.pressure_kpa.is_nan() && wheel.left.is_nan());
        assert!((wheel.temp_c - 85.0).abs() < 1e-3);
    }

    #[test]
    fn le_mans_ultimate_pedals_the_wheel_and_the_position_use_the_shared_tolerances() {
        let t = PlayerTelemetry {
            throttle: 1.2,
            brake: -0.3,
            clutch: -1.0,
            steering: 1.4,
            pos: [1.0e7 + 1.0e6, -5.0, 2.5],
            water_c: -20.0,
            oil_c: 0.0,
            ..PlayerTelemetry::default()
        };
        let frame = lmu_frame(&t, Some(&lmu_scoring(true, 5)));
        assert_eq!((frame.throttle, frame.brake), (1.0, 0.0), "a hair outside is pulled in");
        assert!(frame.clutch.is_nan(), "-1 is the games' not available");
        assert_eq!(frame.steer, 1.0);
        assert!(frame.x.is_nan() && frame.y == -5.0 && frame.z == 2.5);
        assert_eq!((frame.state.water_c, frame.state.oil_c), (Some(-20.0), None), "0 is not given");
    }

    #[test]
    fn reads_the_best_lap_between_two_points_and_not_past_its_ends() {
        let profile = vec![(0.0, 0.0), (100.0, 4.0), (200.0, 10.0)];
        assert_eq!(time_at(&profile, 50.0), Some(2.0));
        assert_eq!(time_at(&profile, 150.0), Some(7.0));
        assert_eq!(time_at(&profile, 0.0), Some(0.0));
        assert_eq!(time_at(&profile, 200.0), Some(10.0));
        assert_eq!(time_at(&profile, 250.0), None);
        assert_eq!(time_at(&Vec::new(), 1.0), None);
    }

    /// A frame of a game that gives no distance (like AC): the speed and the host clock are all there is.
    fn no_dist(lap: i32, t: f64, speed: f32, last: Option<f64>, valid: Option<bool>) -> Frame {
        let mut frame = at(lap, 0.0, t, last);
        frame.dist_m = None;
        frame.clock_s = 100.0 + t;
        frame.speed_ms = speed;
        frame.lap_valid = valid;
        frame
    }

    /// Drives a lap of 1000 m without the game's distance, ten frames a second.
    fn drive_no_dist(tracker: &mut Tracker, lap: i32, speed: f32, last: Option<f64>) -> Vec<Live> {
        let n = (1000.0 / f64::from(speed) * 10.0) as usize;
        (0..n)
            .map(|i| tracker.on_frame("Test", &no_dist(lap, i as f64 / 10.0, speed, last, Some(true)), 0))
            .collect()
    }

    #[test]
    fn a_game_without_distance_still_gets_a_best_lap_and_a_delta() {
        let mut tracker = Tracker::default();
        drive_no_dist(&mut tracker, 1, 50.0, None);
        drive_no_dist(&mut tracker, 2, 50.0, None);
        let live = tracker.on_frame("Test", &no_dist(3, 0.0, 50.0, Some(20.0), Some(true)), 0);
        assert_eq!(live.best_lap_s, Some(20.0));
        let third = drive_no_dist(&mut tracker, 3, 40.0, Some(20.0));
        let half = &third[third.len() / 2];
        let delta = half.delta_s.expect("a delta against the best lap");
        assert!(delta > 1.0, "slower than the best: {delta}");
        // The distance shown (for the lap progress) is the integrated one.
        assert!((half.dist_m.unwrap() - 500.0).abs() < 30.0, "{:?}", half.dist_m);
    }

    #[test]
    fn without_the_games_distance_a_lap_joined_midway_is_not_from_the_line() {
        let mut tracker = Tracker::default();
        // First frame 30 s into the lap.
        for i in 0..200 {
            tracker.on_frame("Test", &no_dist(1, 30.0 + i as f64 / 10.0, 50.0, None, None), 0);
        }
        tracker.on_frame("Test", &no_dist(2, 0.0, 50.0, Some(80.0), None), 0);
        let live = tracker.on_frame("Test", &no_dist(2, 0.1, 50.0, Some(80.0), None), 0);
        assert_eq!(live.best_lap_s, None, "a lap joined midway is not a best lap");
    }

    #[test]
    fn a_lap_the_game_called_invalid_never_becomes_the_best() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        // Lap 2 is the fastest but the game calls it invalid half way.
        for i in 0..200 {
            let mut f = at(2, f64::from(i) * 5.0, f64::from(i) / 10.0, None);
            f.lap_valid = Some(i < 100);
            tracker.on_frame("Test", &f, 0);
        }
        let live = tracker.on_frame("Test", &at(3, 0.0, 0.0, Some(20.0)), 0);
        assert_eq!(live.best_lap_s, None, "the invalid 20 s lap is not the best");
        // A valid, slower lap 3 is.
        for i in 0..250 {
            let mut f = at(3, f64::from(i) * 4.0, f64::from(i) / 10.0, Some(20.0));
            f.lap_valid = Some(true);
            tracker.on_frame("Test", &f, 0);
        }
        let live = tracker.on_frame("Test", &at(4, 0.0, 0.0, Some(25.0)), 0);
        assert_eq!(live.best_lap_s, Some(25.0));
        // The invalid flag does not leak into the next lap.
        for i in 0..240 {
            tracker.on_frame("Test", &at(4, f64::from(i) * 4.2, f64::from(i) / 10.0, Some(25.0)), 0);
        }
        let live = tracker.on_frame("Test", &at(5, 0.0, 0.0, Some(24.0)), 0);
        assert_eq!(live.best_lap_s, Some(24.0));
    }

    /// A frame of a game that gives no distance on the lap, only the lap clock and the speed; `host` is the program's
    /// own clock.
    fn counted(lap: i32, lap_time: f64, host: f64) -> Frame {
        let mut frame = at(lap, 0.0, lap_time, None);
        frame.dist_m = None;
        frame.clock_s = host;
        frame.speed_ms = 50.0;
        frame
    }

    #[test]
    fn a_restart_without_a_new_lap_number_takes_the_lap_progress_back_to_zero() {
        // The symptom seen in COTA: the lap restarted (the lap clock back at 0, the lap number the same) and the
        // distance kept adding up, so the lap progress reached 100 % at 27 s.
        let mut tracker = Tracker::default();
        let mut host = 0.0;
        let mut last = None;
        for i in 0..250 {
            last = Some(tracker.on_frame("Test", &counted(1, f64::from(i) / 10.0, host), 0));
            host += 0.1;
        }
        let before = last.unwrap().dist_m.unwrap();
        assert!((before - 1245.0).abs() < 1.0, "{before}");
        // The restart: the lap clock is back at 0 on the same lap.
        let after = tracker.on_frame("Test", &counted(1, 0.0, host), 0);
        assert!(after.dist_m.unwrap() < 1.0, "the lap progress starts over: {:?}", after.dist_m);
        host += 0.1;
        let later = tracker.on_frame("Test", &counted(1, 0.1, host), 0);
        assert!(later.dist_m.unwrap() < 10.0, "{:?}", later.dist_m);
    }

    #[test]
    fn the_reading_carries_the_phase_the_caps_and_what_was_last_seen_through_a_pause() {
        use crate::game::Caps;
        let mut tracker = Tracker::default();
        let caps = Caps::GEAR.or(Caps::SPEED).or(Caps::FUEL).or(Caps::TYRE_TEMP).or(Caps::WATER_TEMP);
        tracker.set_caps(caps);
        let tyre = |t: f32| Tyre {
            brake_c: f32::NAN,
            temp_c: t,
            pressure_kpa: f32::NAN,
            left: f32::NAN,
            tread_c: None,
        };
        let mut driving = at(3, 100.0, 12.0, None);
        driving.set_phase(Phase::Driving);
        driving.gear = 4.0;
        driving.speed_ms = 50.0;
        driving.fuel_l = 31.5;
        driving.tyres = Some([tyre(80.0), tyre(82.0), tyre(90.0), tyre(91.0)]);
        driving.state.water_c = Some(88.0);
        let live = tracker.on_frame("Test", &driving, 10);
        assert_eq!((live.phase, live.caps), (Phase::Driving, caps));
        assert_eq!(live.last_seen.gear, Some(4.0));
        // Paused: the game gives no live car values; the tyres, fuel and temperatures still come.
        let mut paused = driving.clone();
        paused.set_phase(Phase::Paused);
        paused.withhold_car_values_unless_driving();
        paused.tyres = None;
        paused.fuel_l = f32::NAN;
        paused.state.water_c = None;
        let live = tracker.on_frame("Test", &paused, 20);
        assert_eq!((live.phase, live.driving), (Phase::Paused, false));
        assert!(live.gear.is_nan() && live.tyres.is_none() && live.fuel_l.is_nan());
        assert_eq!(live.last_seen.gear, Some(4.0), "the last gear seen stays");
        assert_eq!(live.last_seen.speed_ms, Some(50.0));
        assert_eq!(live.last_seen.fuel_l, Some(31.5));
        assert_eq!(live.last_seen.tyres.map(|t| t[3].temp_c), Some(91.0));
        assert_eq!(live.last_seen.water_c, Some(88.0));
        // A zero fuel reading outside the car is not a reading worth keeping.
        let mut menu = paused.clone();
        menu.fuel_l = 0.0;
        assert_eq!(tracker.on_frame("Test", &menu, 30).last_seen.fuel_l, Some(31.5));
    }

    #[test]
    fn a_source_that_never_gave_its_caps_has_the_ones_its_frames_filled() {
        use crate::game::Caps;
        let mut tracker = Tracker::default();
        let live = tracker.on_frame("Test", &at(1, 10.0, 1.0, None), 0);
        assert!(live.caps.has(Caps::LAP_TIME) && live.caps.has(Caps::RPM) && !live.caps.has(Caps::TYRE_TEMP));
        // What the source says wins over what the frames happened to fill.
        tracker.set_caps(Caps::GEAR);
        let live = tracker.on_frame("Test", &at(1, 20.0, 2.0, None), 0);
        assert_eq!(live.caps, Caps::GEAR);
    }

    #[test]
    fn the_sector_times_are_of_the_lap_being_driven_and_move_to_the_last_lap_at_the_line() {
        let mut tracker = Tracker::default();
        let mut frame = at(1, 100.0, 10.0, None);
        frame.sectors_ms = [None, None];
        assert_eq!(tracker.on_frame("Test", &frame, 0).sectors_ms, [None, None]);
        frame = at(1, 400.0, 30.0, None);
        frame.sectors_ms = [Some(28_100), None];
        let live = tracker.on_frame("Test", &frame, 0);
        assert_eq!(live.sectors_ms, [Some(28_100), None]);
        frame = at(1, 800.0, 60.0, None);
        frame.sectors_ms = [Some(28_100), Some(44_500)];
        assert_eq!(tracker.on_frame("Test", &frame, 0).sectors_ms, [Some(28_100), Some(44_500)]);
        // The next lap begins: those are the last lap's now, and the new lap has none yet.
        frame = at(2, 5.0, 0.5, Some(100.0));
        frame.sectors_ms = [None, None];
        let live = tracker.on_frame("Test", &frame, 0);
        assert_eq!(live.last_sectors_ms, [Some(28_100), Some(44_500)]);
        assert_eq!(live.sectors_ms, [None, None]);
    }

    #[test]
    fn a_new_session_starts_the_best_lap_the_fuel_and_the_rev_top_over_but_keeps_the_map() {
        use crate::lapfile::SessionKind;
        let mut tracker = Tracker::default();
        let lap = |tracker: &mut Tracker, n: i32, last: Option<f64>, kind: SessionKind| {
            let mut out = None;
            for i in 0..200 {
                let mut f = at(n, f64::from(i) * 5.0, f64::from(i) / 10.0, last);
                f.session_kind = Some(kind);
                f.fuel_l = 50.0 - i as f32 / 100.0;
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                (f.x, f.z) = (160.0 * a.cos(), 160.0 * a.sin());
                out = Some(tracker.on_frame("Test", &f, 0));
            }
            out.unwrap()
        };
        lap(&mut tracker, 1, None, SessionKind::Practice);
        lap(&mut tracker, 2, None, SessionKind::Practice);
        lap(&mut tracker, 3, Some(20.0), SessionKind::Practice);
        let live = lap(&mut tracker, 4, Some(20.0), SessionKind::Practice);
        assert_eq!(live.best_lap_s, Some(20.0));
        assert!(live.fuel_per_lap_l.is_some() && live.rpm_top > 5000.0 && live.map_complete);
        // Qualifying on the same track and car: another session.
        let mut first = at(1, 0.0, 0.0, Some(20.0));
        first.session_kind = Some(SessionKind::Qualifying);
        first.rpm = 3000.0;
        let live = tracker.on_frame("Test", &first, 0);
        assert_eq!(live.best_lap_s, None, "the best lap of practice is not the best of qualifying");
        assert_eq!((live.fuel_per_lap_l, live.rpm_top), (None, 3000.0));
        assert!(live.map_complete, "the track is the same: its map stays");
    }

    #[test]
    fn a_teleport_drops_the_lap_in_progress_for_the_delta_and_the_best_lap() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        drive_lap(&mut tracker, 2, 50.0, Some(20.0));
        // Part way round lap 3 the car is put back 3 km away.
        let mut live = None;
        for i in 0..100 {
            let mut f = at(3, f64::from(i) * 5.0, f64::from(i) / 10.0, Some(20.0));
            (f.x, f.z) = (i as f32 * 5.0, 0.0);
            live = Some(tracker.on_frame("Test", &f, 0));
        }
        assert!(live.unwrap().delta_s.is_some());
        let mut f = at(3, 500.0, 10.0, Some(20.0));
        (f.x, f.z) = (3000.0, 0.0);
        let live = tracker.on_frame("Test", &f, 0);
        assert_eq!(live.delta_s, None, "the lap is not one any more");
    }
}
