//! What every game other than Le Mans Ultimate gives Xpeed Companion, in one shape.
//!
//! Each game has its own door (shared memory, UDP) and its own units. A `Source` opens one of them and turns what it
//! reads into `Frame`s with the units of the lap file (metres, seconds, metres per second, 0..1 pedals), so the lap
//! cutter (`lapcut.rs`) and the engine do not need to know which game it is. A value the game does not give is `NaN`
//! (or `None` for the lap fields): the lap file keeps a column only when the game gives that value.

use std::time::Duration;

pub use crate::lapfile::SessionKind;

/// One tyre as the game tells it; `NaN` for what it does not give.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tyre {
    /// The brake's temperature in °C, when the game gives it.
    pub brake_c: f32,
    /// Temperature in °C: the tread where the game gives it, else the core.
    pub temp_c: f32,
    pub pressure_kpa: f32,
    /// How much of the tread is left, 0..1 (1 = new).
    pub left: f32,
}

impl Tyre {
    /// True when the game said anything about this tyre.
    pub fn known(&self) -> bool {
        self.temp_c.is_finite() || self.pressure_kpa.is_finite() || self.left.is_finite() || self.brake_c.is_finite()
    }
}

/// A flag the race shows the player.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flag {
    Green,
    Yellow,
    Blue,
    White,
    Black,
    Chequered,
}

/// The rear wing's state where the car has DRS (or a push to pass the game reports the same way).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drs {
    /// Not allowed here.
    Off,
    /// Allowed: the driver may open it.
    Available,
    Open,
}

/// The dashboard lights and the car's own state, as the game tells them. `None` (or `NaN`) is what the game does
/// not give, which the panel leaves out rather than showing as off or zero (`Option`, not `NaN`, so frames still
/// compare equal in tests).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CarState {
    /// The pit lane speed limiter is on.
    pub pit_limiter: Option<bool>,
    /// ABS is acting right now (not just switched on).
    pub abs_active: Option<bool>,
    /// Traction control is acting right now.
    pub tc_active: Option<bool>,
    pub drs: Option<Drs>,
    pub headlights: Option<bool>,
    pub handbrake: Option<bool>,
    /// The game warns about the engine (overheating, stalled, damaged).
    pub engine_warning: Option<bool>,
    pub flag: Option<Flag>,
    /// Coolant (water) temperature in °C.
    pub water_c: Option<f32>,
    /// Oil temperature in °C.
    pub oil_c: Option<f32>,
    /// The driver's settings as the car's dash shows them: TC and ABS levels (0 = off) and the engine map.
    pub tc_level: Option<u8>,
    pub abs_level: Option<u8>,
    pub engine_map: Option<u8>,
    /// Share of braking on the front axle, 0..1 (0.56 = 56 % front).
    pub brake_bias: Option<f32>,
    /// Damage, 0 = none .. 1 = destroyed: bodywork and aero, engine, gearbox, and the worst of the four suspensions.
    pub damage_body: Option<f32>,
    pub damage_engine: Option<f32>,
    pub damage_gearbox: Option<f32>,
    pub damage_suspension: Option<f32>,
}

impl CarState {
    /// Nothing known.
    pub const UNKNOWN: CarState = CarState {
        pit_limiter: None,
        abs_active: None,
        tc_active: None,
        drs: None,
        headlights: None,
        handbrake: None,
        engine_warning: None,
        flag: None,
        water_c: None,
        oil_c: None,
        tc_level: None,
        abs_level: None,
        engine_map: None,
        brake_bias: None,
        damage_body: None,
        damage_engine: None,
        damage_gearbox: None,
        damage_suspension: None,
    };
}

/// One reading of the player's car.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// Seconds on a clock that never goes backwards while the game runs (the game's, or the program's own).
    pub clock_s: f64,
    /// False in a menu, a replay or a garage: the frame is not part of any lap.
    pub driving: bool,
    /// The lap being driven, as the game counts it (the number changes when a lap is completed).
    pub lap: i32,
    /// Time on the current lap, in seconds, on the game's own clock. `None` when the game does not give it.
    pub lap_time_s: Option<f64>,
    /// The official time of the last completed lap, in seconds. `None` while there is none yet.
    pub last_lap_s: Option<f64>,
    /// The game's own verdict on the current lap (`Some(false)`: it will not count). `None` when it gives none.
    pub lap_valid: Option<bool>,
    /// Distance covered on the current lap, in metres, when the game gives it (or a fraction of a known length).
    pub dist_m: Option<f64>,
    pub in_pits: bool,
    pub speed_ms: f32,
    pub rpm: f32,
    pub gear: f32,
    /// How many forward gears the car has, when the game says. `None` when it does not.
    pub gears: Option<u8>,
    pub throttle: f32,
    pub brake: f32,
    pub clutch: f32,
    pub steer: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub fuel_l: f32,
    /// Front left, front right, rear left, rear right; `None` when the game gives nothing about tyres.
    pub tyres: Option<[Tyre; 4]>,
    /// Dashboard lights, engine temperatures, electronics settings and damage.
    pub state: CarState,
    pub car: String,
    pub car_class: Option<String>,
    pub track: String,
    pub track_variant: Option<String>,
    pub track_length_m: Option<f64>,
    /// How long the first two sectors of the lap in progress took, in milliseconds, each once it is done (`None`
    /// before that, or for a game that gives no sector times). The last sector is not here: the cutter takes it as
    /// the official lap time minus these two, because a game that shows its third sector's time while it runs may
    /// still hold the one of the lap before. A game with other than three sectors gives `None` for both.
    pub sectors_ms: [Option<u32>; 2],
    /// What kind of session this is, when the game says.
    pub session_kind: Option<SessionKind>,
    /// A short word for the weather ("dry", "rain"), when the game gives it.
    pub weather: Option<String>,
    /// Air and track temperature in °C, when the game gives them.
    pub air_temp_c: Option<f32>,
    pub track_temp_c: Option<f32>,
    /// The compound of the tyres on the car, as the game names it.
    pub tyre_compound: Option<String>,
    /// The car's acceleration in g: sideways (positive toward the car's right: a right-hand corner is positive) and
    /// along the car (positive forward: accelerating is positive, braking negative). `None` when the game gives none
    /// (an `Option`, not `NaN`, so frames still compare equal in tests).
    pub g_lat: Option<f32>,
    pub g_long: Option<f32>,
}

impl Frame {
    /// A frame that says nothing yet: every optional value missing. Sources fill in what their game has.
    pub fn empty() -> Frame {
        Frame {
            clock_s: 0.0,
            driving: false,
            lap: 0,
            lap_time_s: None,
            last_lap_s: None,
            lap_valid: None,
            dist_m: None,
            in_pits: false,
            speed_ms: f32::NAN,
            rpm: f32::NAN,
            gear: f32::NAN,
            gears: None,
            throttle: f32::NAN,
            brake: f32::NAN,
            clutch: f32::NAN,
            steer: f32::NAN,
            x: f32::NAN,
            y: f32::NAN,
            z: f32::NAN,
            fuel_l: f32::NAN,
            tyres: None,
            state: CarState::UNKNOWN,
            car: String::new(),
            car_class: None,
            track: String::new(),
            track_variant: None,
            track_length_m: None,
            sectors_ms: [None; 2],
            session_kind: None,
            weather: None,
            air_temp_c: None,
            track_temp_c: None,
            tyre_compound: None,
            g_lat: None,
            g_long: None,
        }
    }
}

/// The sector times of the lap in progress, for a game that tells only the sector the car is in and the time of the
/// last sector it finished (Assetto Corsa): the time at each change of sector is kept for the first two sectors, and
/// forgotten when the lap number changes.
#[derive(Debug, Default)]
pub struct SectorTracker {
    lap: i32,
    sector: Option<i32>,
    done: [Option<u32>; 2],
}

impl SectorTracker {
    /// One reading: the lap, the sector the car is in now (0 is the first) and the game's "last sector time" in
    /// milliseconds. Returns the sectors done on this lap so far. A change of sector counts only when it goes up by
    /// one (so a reading that jumps, a restart or a car put back on the track records nothing), and only a positive
    /// time is believed.
    pub fn update(&mut self, lap: i32, sector: i32, last_sector_ms: i32) -> [Option<u32>; 2] {
        if lap != self.lap {
            self.lap = lap;
            self.sector = None;
            self.done = [None; 2];
        }
        if let Some(before) = self.sector {
            if sector == before + 1 && (0..2).contains(&before) && (1..=3_600_000).contains(&last_sector_ms) {
                self.done[before as usize] = Some(last_sector_ms as u32);
            }
        }
        self.sector = Some(sector);
        self.done
    }
}

/// An open door into one game.
pub trait Source {
    /// The id written into lap files (`"ac"`, `"acc"`, ...): lower case, no spaces.
    fn game_id(&self) -> &'static str;
    /// The name people know, for the tray menu and the log.
    fn game_name(&self) -> &'static str;
    /// Waits up to `timeout` for a new reading. `None`: nothing new yet (the game is paused, or in a menu).
    fn next(&mut self, timeout: Duration) -> Option<Frame>;
    /// False once the game has gone away (its door closed); the engine then goes back to looking.
    fn alive(&self) -> bool;
    /// True for a source that is only a socket waiting for packets: its game may send nothing at all (the person has
    /// not switched its telemetry output on), so opening it proves nothing and the game counts as connected only once
    /// the first frame arrives. False (the default) for shared memory, where finding the memory means the game shares.
    fn listens(&self) -> bool {
        false
    }
    /// A last touch on a finished lap before it is written (iRacing closes its estimated path). Nothing by default.
    fn finish_lap(&self, _lap: &mut crate::lapfile::Lap) {}
}

/// A text field of a game's memory: UTF-16 or ASCII up to the first zero, trimmed.
pub fn text_of_utf16(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end]).trim().to_owned()
}

pub fn text_of_ascii(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_with_nothing_in_it_says_nothing() {
        let frame = Frame::empty();
        assert!(!frame.driving && frame.lap_time_s.is_none() && frame.dist_m.is_none());
        assert!(frame.speed_ms.is_nan() && frame.x.is_nan());
    }

    #[test]
    fn a_frame_gives_no_sectors_session_or_weather_until_a_game_says() {
        let frame = Frame::empty();
        assert_eq!(frame.sectors_ms, [None; 2]);
        assert!(frame.session_kind.is_none() && frame.weather.is_none() && frame.tyre_compound.is_none());
        assert!(frame.air_temp_c.is_none() && frame.track_temp_c.is_none());
        assert!(frame.g_lat.is_none() && frame.g_long.is_none());
    }

    #[test]
    fn keeps_the_time_of_each_sector_when_the_car_goes_into_the_next() {
        let mut sectors = SectorTracker::default();
        assert_eq!(sectors.update(1, 0, 0), [None, None]);
        assert_eq!(sectors.update(1, 0, 0), [None, None]);
        // Into sector 2: the last sector (the first) took 31.2 s.
        assert_eq!(sectors.update(1, 1, 31_200), [Some(31_200), None]);
        assert_eq!(sectors.update(1, 1, 31_200), [Some(31_200), None]);
        assert_eq!(sectors.update(1, 2, 28_900), [Some(31_200), Some(28_900)]);
        // Into the next lap: forgotten, and the wrap from sector 3 to sector 1 records nothing.
        assert_eq!(sectors.update(2, 0, 30_000), [None, None]);
        assert_eq!(sectors.update(2, 1, 30_500), [Some(30_500), None]);
    }

    #[test]
    fn a_reading_that_jumps_or_has_no_time_records_no_sector() {
        let mut sectors = SectorTracker::default();
        sectors.update(3, 0, 0);
        // Sector 0 straight to sector 2: the first one's time cannot be told from this.
        assert_eq!(sectors.update(3, 2, 20_000), [None, None]);
        let mut sectors = SectorTracker::default();
        sectors.update(3, 0, 0);
        assert_eq!(sectors.update(3, 1, 0), [None, None], "no time yet");
        assert_eq!(sectors.update(3, 2, -1), [None, None]);
        // The first reading of a lap is not a change of sector, whatever sector it shows (joined in the middle).
        let mut joined = SectorTracker::default();
        assert_eq!(joined.update(5, 2, 25_000), [None, None]);
    }

    #[test]
    fn reads_text_up_to_the_first_zero() {
        assert_eq!(text_of_utf16(&[0x50, 0x6f, 0x72, 0, 0x78]), "Por");
        assert_eq!(text_of_utf16(&[0x20, 0x41, 0x20]), "A");
        assert_eq!(text_of_ascii(b"Monza\0junk"), "Monza");
        assert_eq!(text_of_ascii(b"no zero"), "no zero");
        assert_eq!(text_of_ascii(b""), "");
    }
}
