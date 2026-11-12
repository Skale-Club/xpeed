//! What every game other than Le Mans Ultimate gives Xpeed Sim, in one shape.
//!
//! Each game has its own door (shared memory, UDP) and its own units. A `Source` opens one of them and turns what it
//! reads into `Frame`s with the units of the lap file (metres, seconds, metres per second, 0..1 pedals), so the lap
//! cutter (`lapcut.rs`) and the engine do not need to know which game it is. A value the game does not give is `NaN`
//! (or `None` for the lap fields): the lap file keeps a column only when the game gives that value.

use std::time::Duration;

/// One tyre as the game tells it; `NaN` for what it does not give.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tyre {
    /// Temperature in °C: the tread where the game gives it, else the core.
    pub temp_c: f32,
    pub pressure_kpa: f32,
    /// How much of the tread is left, 0..1 (1 = new).
    pub left: f32,
}

impl Tyre {
    /// True when the game said anything about this tyre.
    pub fn known(&self) -> bool {
        self.temp_c.is_finite() || self.pressure_kpa.is_finite() || self.left.is_finite()
    }
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
    pub car: String,
    pub car_class: Option<String>,
    pub track: String,
    pub track_variant: Option<String>,
    pub track_length_m: Option<f64>,
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
            throttle: f32::NAN,
            brake: f32::NAN,
            clutch: f32::NAN,
            steer: f32::NAN,
            x: f32::NAN,
            y: f32::NAN,
            z: f32::NAN,
            fuel_l: f32::NAN,
            tyres: None,
            car: String::new(),
            car_class: None,
            track: String::new(),
            track_variant: None,
            track_length_m: None,
        }
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
    fn reads_text_up_to_the_first_zero() {
        assert_eq!(text_of_utf16(&[0x50, 0x6f, 0x72, 0, 0x78]), "Por");
        assert_eq!(text_of_utf16(&[0x20, 0x41, 0x20]), "A");
        assert_eq!(text_of_ascii(b"Monza\0junk"), "Monza");
        assert_eq!(text_of_ascii(b"no zero"), "no zero");
        assert_eq!(text_of_ascii(b""), "");
    }
}
